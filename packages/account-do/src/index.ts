import type { StateChange } from "@bullmoose/jmap-core";

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

export class AccountDO implements DurableObject {
  private ctx: DurableObjectState;

  constructor(ctx: DurableObjectState, _env: unknown) {
    this.ctx = ctx;
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
      default:
        return json({ error: `no such route: ${route}` }, 404);
    }
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
