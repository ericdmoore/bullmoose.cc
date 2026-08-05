import type { StateChange } from "@bullmoose/jmap-core";
import { Mailstore } from "@bullmoose/mailstore";
import { buildMime } from "@bullmoose/mime";

/**
 * AccountDO — the single-writer actor for one JMAP account.
 *
 * Owns:
 *  - the monotonic per-account `state` sequence (JMAP state strings are
 *    opaque; we use one global sequence and filter the changelog per
 *    collection, which is spec-conformant)
 *  - a bounded changelog powering `/changes` methods
 *  - live hibernatable WebSocket connections for StateChange push (RFC 8887)
 *
 * Every state-visible mutation (ingest delivery, Email/set, submission)
 * MUST route through POST /commit. Reads (Email/get, Email/query) go
 * straight to D1/R2 and never touch this object.
 *
 * Internal HTTP API (Worker → DO only, never public):
 *   GET  /state                      → { state }
 *   POST /commit                     → { oldState, newState }
 *   GET  /changes?collection&since   → RFC 8620 §5.2 shape, or 409
 *   GET  /ws                         → WebSocket upgrade
 */

export interface ChangeEntry {
  collection: string;
  created: string[];
  updated: string[];
  destroyed: string[];
}

export interface CommitBody {
  accountId: string;
  entries: Array<Partial<ChangeEntry> & { collection: string }>;
}

/** How many changelog entries to retain before /changes forces a resync. */
const LOG_WINDOW = 4096;
const MAX_CHANGES_DEFAULT = 1024;

const logKey = (seq: number) => `log:${seq.toString().padStart(12, "0")}`;
const pendingKey = (fireAt: number, id: string) =>
  `pending:${fireAt.toString().padStart(14, "0")}:${id}`;

/**
 * An armed response (agent-integration.md §8): fire at fireAt unless the
 * cancel condition holds by then. Suppression + enablement are
 * re-checked at fire time; the responder row is the source of truth.
 */
export interface PendingResponse {
  responderId: string;
  accountId: string;
  tenantId: string;
  /** The account's own address (From + envelope mailFrom of the reply). */
  accountAddress: string;
  /** Who triggered it — the reply's recipient. */
  sender: string;
  /** Original message id (bare) for In-Reply-To threading. */
  origMessageId: string | null;
  origSubject: string;
  /** Watchdog cancel: the delivered email whose invocation we watch. */
  emailId: string | null;
  cancelIf: "never" | "invocation-active";
  fireAt: number;
}

/** Bindings the DO needs for responder firing (jmap worker's env). */
interface DOEnv {
  DB?: D1Database;
  BLOBS?: R2Bucket;
  SUBMIT?: Fetcher;
  INTERNAL_TOKEN?: string;
}

export class AccountDO implements DurableObject {
  private ctx: DurableObjectState;
  private env: DOEnv;

  constructor(ctx: DurableObjectState, env: unknown) {
    this.ctx = ctx;
    this.env = (env ?? {}) as DOEnv;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;

    switch (route) {
      case "GET /state":
        return json({ state: String(await this.seq()) });
      case "POST /commit":
        return this.commit((await request.json()) as CommitBody);
      case "GET /changes":
        return this.changes(url);
      case "GET /ws":
        return this.upgradeWebSocket(request);
      case "POST /arm":
        return this.arm((await request.json()) as PendingResponse);
      default:
        return json({ error: `no such route: ${route}` }, 404);
    }
  }

  // ---- armed responders --------------------------------------------

  private async arm(pending: PendingResponse): Promise<Response> {
    await this.ctx.storage.put(pendingKey(pending.fireAt, crypto.randomUUID()), pending);
    const current = await this.ctx.storage.getAlarm();
    if (current === null || pending.fireAt < current) {
      await this.ctx.storage.setAlarm(pending.fireAt);
    }
    return json({ armed: true, fireAt: pending.fireAt });
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const entries = await this.ctx.storage.list<PendingResponse>({ prefix: "pending:" });
    let nextFire: number | null = null;

    for (const [key, pending] of entries) {
      if (pending.fireAt > now) {
        nextFire = nextFire === null ? pending.fireAt : Math.min(nextFire, pending.fireAt);
        continue;
      }
      try {
        await this.fireResponder(pending);
      } catch (err) {
        console.error(`responder fire failed (${pending.responderId}):`, err);
      }
      await this.ctx.storage.delete(key);
    }
    if (nextFire !== null) await this.ctx.storage.setAlarm(nextFire);
  }

  private async fireResponder(p: PendingResponse): Promise<void> {
    const { DB, BLOBS, SUBMIT, INTERNAL_TOKEN } = this.env;
    if (!DB || !BLOBS || !SUBMIT) return; // not wired in this worker

    // Responder still enabled (and, for vacation, still in range)?
    const responder = await DB.prepare(
      `SELECT enabled, subject, text_body, from_date, to_date, suppress_seconds
       FROM responders WHERE account_id = ? AND id = ?`,
    )
      .bind(p.accountId, p.responderId)
      .first<{
        enabled: number;
        subject: string | null;
        text_body: string | null;
        from_date: number | null;
        to_date: number | null;
        suppress_seconds: number;
      }>();
    const now = Date.now();
    if (!responder || responder.enabled !== 1) return;
    if (responder.from_date !== null && now < responder.from_date) return;
    if (responder.to_date !== null && now > responder.to_date) return;

    // Cancel condition: the watchdog stands down once any invocation for
    // this email has been claimed or completed.
    if (p.cancelIf === "invocation-active" && p.emailId) {
      const active = await DB.prepare(
        `SELECT 1 FROM agent_invocations
         WHERE account_id = ? AND email_id = ? AND status IN ('running','done') LIMIT 1`,
      )
        .bind(p.accountId, p.emailId)
        .first();
      if (active) return;
    }

    // Once-per-sender-per-window suppression (RFC 3834 etiquette).
    const seen = await DB.prepare(
      `SELECT sent_at FROM responder_log
       WHERE account_id = ? AND responder_id = ? AND sender = ?`,
    )
      .bind(p.accountId, p.responderId, p.sender)
      .first<{ sent_at: number }>();
    if (seen && now - seen.sent_at < responder.suppress_seconds * 1000) return;

    // Build + relay the auto-response.
    const subject = responder.subject ?? `Auto: Re: ${p.origSubject}`;
    const raw = buildMime({
      from: [{ email: p.accountAddress }],
      to: [{ email: p.sender }],
      subject,
      messageId: `${crypto.randomUUID()}@${p.accountAddress.split("@")[1] ?? "localhost"}`,
      inReplyTo: p.origMessageId,
      date: new Date(now),
      text: responder.text_body ?? "This is an automated response.",
      extraHeaders: ["Auto-Submitted: auto-replied", "X-Auto-Response-Suppress: All"],
    });

    const store = new Mailstore(DB, BLOBS);
    const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
    const blobId = await store.putBlob(p.tenantId, p.accountId, buf);

    const res = await SUBMIT.fetch("https://submit.internal/internal/submit", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-token": INTERNAL_TOKEN ?? "",
      },
      body: JSON.stringify({
        accountId: p.accountId,
        tenantId: p.tenantId,
        blobId,
        envelope: { mailFrom: p.accountAddress, rcptTo: [p.sender] },
      }),
    });
    if (!res.ok) {
      console.error(`responder relay failed (${res.status}): ${await res.text()}`);
      return;
    }

    await DB.prepare(
      `INSERT INTO responder_log (account_id, responder_id, sender, sent_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (account_id, responder_id, sender) DO UPDATE SET sent_at = excluded.sent_at`,
    )
      .bind(p.accountId, p.responderId, p.sender, now)
      .run();
  }

  private async seq(): Promise<number> {
    return (await this.ctx.storage.get<number>("seq")) ?? 0;
  }

  private async commit(body: CommitBody): Promise<Response> {
    const oldSeq = await this.seq();
    let seq = oldSeq;

    for (const entry of body.entries) {
      seq += 1;
      const record: ChangeEntry = {
        collection: entry.collection,
        created: entry.created ?? [],
        updated: entry.updated ?? [],
        destroyed: entry.destroyed ?? [],
      };
      await this.ctx.storage.put(logKey(seq), record);
    }
    await this.ctx.storage.put("seq", seq);
    if (body.accountId) await this.ctx.storage.put("accountId", body.accountId);

    await this.prune(seq);
    this.broadcast(body, seq);

    return json({ oldState: String(oldSeq), newState: String(seq) });
  }

  /** Age out changelog entries beyond LOG_WINDOW. */
  private async prune(seq: number): Promise<void> {
    const floor = (await this.ctx.storage.get<number>("floor")) ?? 0;
    const newFloor = Math.max(0, seq - LOG_WINDOW);
    if (newFloor <= floor) return;
    const stale: string[] = [];
    for (let s = floor + 1; s <= newFloor; s++) stale.push(logKey(s));
    await this.ctx.storage.delete(stale);
    await this.ctx.storage.put("floor", newFloor);
  }

  private async changes(url: URL): Promise<Response> {
    const collection = url.searchParams.get("collection");
    const sinceRaw = url.searchParams.get("since");
    const maxChanges = Number(url.searchParams.get("maxChanges") ?? MAX_CHANGES_DEFAULT);
    if (!collection || sinceRaw === null || !/^\d+$/.test(sinceRaw)) {
      return json({ error: "collection and numeric since are required" }, 400);
    }

    const since = Number(sinceRaw);
    const seq = await this.seq();
    const floor = (await this.ctx.storage.get<number>("floor")) ?? 0;

    // Client's state is from the future or aged out of the window:
    // per RFC 8620 the client must do a full resync.
    if (since > seq || since < floor) {
      return json({ type: "cannotCalculateChanges" }, 409);
    }

    const created = new Set<string>();
    const updated = new Set<string>();
    const destroyed = new Set<string>();
    let upTo = since;
    let hasMore = false;

    for (let s = since + 1; s <= seq; s++) {
      const entry = await this.ctx.storage.get<ChangeEntry>(logKey(s));
      upTo = s;
      if (!entry || entry.collection !== collection) continue;

      // Collapse within the window: created→destroyed cancels out,
      // created→updated stays "created", updated→destroyed is "destroyed".
      for (const id of entry.created) created.add(id);
      for (const id of entry.updated) if (!created.has(id)) updated.add(id);
      for (const id of entry.destroyed) {
        if (created.delete(id)) continue;
        updated.delete(id);
        destroyed.add(id);
      }

      if (created.size + updated.size + destroyed.size >= maxChanges && s < seq) {
        hasMore = true;
        break;
      }
    }

    return json({
      oldState: String(since),
      newState: String(upTo),
      hasMoreChanges: hasMore,
      created: [...created],
      updated: [...updated],
      destroyed: [...destroyed],
    });
  }

  private upgradeWebSocket(request: Request): Response {
    if (request.headers.get("Upgrade") !== "websocket") {
      return json({ error: "expected websocket upgrade" }, 426);
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    // Hibernatable accept: the DO can be evicted while sockets stay open.
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Push a StateChange to every connected client. */
  private broadcast(body: CommitBody, seq: number): void {
    const collections: Record<string, string> = {};
    for (const entry of body.entries) collections[entry.collection] = String(seq);
    const push: StateChange = { "@type": "StateChange", changed: { [body.accountId]: collections } };
    const message = JSON.stringify(push);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(message);
      } catch {
        // Socket already closing; hibernation API will reap it.
      }
    }
  }

  // Hibernatable WebSocket callbacks. Full JMAP-over-WS (RFC 8887) request
  // handling is future work; for now the socket is push-only.
  async webSocketMessage(ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {
    ws.send(JSON.stringify({ "@type": "RequestError", type: "urn:ietf:params:jmap:error:notRequest" }));
  }

  async webSocketClose(ws: WebSocket, code: number, _reason: string, _clean: boolean): Promise<void> {
    ws.close(code === 1005 ? 1000 : code);
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Helper for workers: get the DO stub for an account. */
export function accountStub(ns: DurableObjectNamespace, accountId: string): DurableObjectStub {
  return ns.get(ns.idFromName(accountId));
}

/** Helper for workers: arm a pending response on the account's alarm. */
export async function armResponder(
  ns: DurableObjectNamespace,
  pending: PendingResponse,
): Promise<void> {
  const res = await accountStub(ns, pending.accountId).fetch("https://do/arm", {
    method: "POST",
    body: JSON.stringify(pending),
  });
  if (!res.ok) throw new Error(`AccountDO arm failed: ${res.status}`);
}

/** Helper for workers: commit a change set and return the new state. */
export async function commitChanges(
  ns: DurableObjectNamespace,
  accountId: string,
  entries: CommitBody["entries"],
): Promise<{ oldState: string; newState: string }> {
  const res = await accountStub(ns, accountId).fetch("https://do/commit", {
    method: "POST",
    body: JSON.stringify({ accountId, entries } satisfies CommitBody),
  });
  if (!res.ok) throw new Error(`AccountDO commit failed: ${res.status}`);
  return res.json();
}
