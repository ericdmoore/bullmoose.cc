import type { StateChange } from "@bullmoose/jmap-core";
import { Mailstore, normalizeMessageId, type EmailRow } from "@bullmoose/mailstore";
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
 *   POST /arm                        → queue an armed auto-response (alarm)
 *   POST /delay                      → queue a held EmailSubmission (alarm)
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
const pendingKey = (fireAt: number, id: string) => `pending:${fireAt.toString().padStart(14, "0")}:${id}`;
const delayedKey = (fireAt: number, id: string) => `delayed:${fireAt.toString().padStart(14, "0")}:${id}`;

/** Spacing between relay retries for a delayed send that failed transiently. */
const RELAY_RETRY_MS = 60_000;
/**
 * How many relay attempts a delayed send gets before the DO stops trying and
 * marks the submission `canceled`. `canceled` rather than a stuck `pending`:
 * it is the one wire value that truthfully tells the client "this will not
 * send" (there is no failure surface on EmailSubmission — deliveryStatus is
 * honestly null, see services/jmap submission.ts), and the draft itself is
 * untouched — deferred onSuccess actions only run after a successful relay —
 * so the user can simply send again.
 */
const MAX_RELAY_ATTEMPTS = 10;

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

/**
 * A held EmailSubmission (RFC 8621 delayed send): relay at `fireAt` unless the
 * client cancels first. The D1 row's `undo_status` is the single source of
 * truth for the cancel-vs-relay race — this record is only the WORK ITEM (what
 * to relay, and what the client asked to happen to the draft afterwards); the
 * alarm's first act is a `pending → final` compare-and-swap on the row, and a
 * cancel that won that swap means this record is discarded unfired.
 *
 * Everything needed at fire time is captured at accept time, because the
 * accept-time request is long gone when the alarm runs: the envelope (already
 * identity-verified by EmailSubmission/set), the tenant for blob access, the
 * acting principal for write provenance, and the deferred onSuccess actions.
 * The blobId is deliberately NOT captured — the email row is re-read at fire
 * time, so a draft destroyed during the hold turns into a clean cancel instead
 * of relaying bytes whose owner deleted them.
 */
export interface DelayedSubmission {
  submissionId: string;
  accountId: string;
  tenantId: string;
  emailId: string;
  envelope: { mailFrom: string; rcptTo: string[] };
  /** Epoch ms the hold expires — the row's `send_at`. */
  fireAt: number;
  /** Acting principal at accept time, stamped as write provenance at fire time. */
  principal: string;
  /**
   * Deferred `onSuccessUpdateEmail` patch / `onSuccessDestroyEmail` flag —
   * applied at RELAY time, not accept time, so the draft stays a draft for as
   * long as the send can still be canceled (see submission.ts for the spec
   * tension this resolves).
   */
  onSuccessPatch: Record<string, unknown> | null;
  onSuccessDestroy: boolean;
  /** Relay attempts so far; bumped on transient-failure retries. */
  attempts?: number;
}

/** Bindings the DO needs to fire responders and delayed sends (jmap worker's env). */
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
      case "POST /delay":
        return this.delay((await request.json()) as DelayedSubmission);
      default:
        return json({ error: `no such route: ${route}` }, 404);
    }
  }

  // ---- armed responders + delayed sends ----------------------------

  private async arm(pending: PendingResponse): Promise<Response> {
    await this.ctx.storage.put(pendingKey(pending.fireAt, crypto.randomUUID()), pending);
    await this.wakeBy(pending.fireAt);
    return json({ armed: true, fireAt: pending.fireAt });
  }

  private async delay(sub: DelayedSubmission): Promise<Response> {
    await this.ctx.storage.put(delayedKey(sub.fireAt, sub.submissionId), sub);
    await this.wakeBy(sub.fireAt);
    return json({ scheduled: true, fireAt: sub.fireAt });
  }

  /** Pull the alarm earlier if `fireAt` beats whatever is already set. */
  private async wakeBy(fireAt: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || fireAt < current) {
      await this.ctx.storage.setAlarm(fireAt);
    }
  }

  /**
   * One alarm serves both queues — armed responders and delayed sends — so
   * each pass handles every due entry of either kind and then re-arms for the
   * earliest remaining `fireAt` across both. A responder failure is logged and
   * dropped (etiquette mail); a delayed send is a user's real message, so its
   * fire path distinguishes transient from permanent failure and re-queues
   * itself with backoff rather than vanishing (see `fireDelayedSubmission`).
   */
  async alarm(): Promise<void> {
    const now = Date.now();
    let nextFire: number | null = null;
    const consider = (t: number) => {
      nextFire = nextFire === null ? t : Math.min(nextFire, t);
    };

    const responders = await this.ctx.storage.list<PendingResponse>({ prefix: "pending:" });
    for (const [key, pending] of responders) {
      if (pending.fireAt > now) {
        consider(pending.fireAt);
        continue;
      }
      try {
        await this.fireResponder(pending);
      } catch (err) {
        console.error(`responder fire failed (${pending.responderId}):`, err);
      }
      await this.ctx.storage.delete(key);
    }

    const delayed = await this.ctx.storage.list<DelayedSubmission>({ prefix: "delayed:" });
    for (const [key, sub] of delayed) {
      if (sub.fireAt > now) {
        consider(sub.fireAt);
        continue;
      }
      let retryAt: number | null = null;
      try {
        retryAt = await this.fireDelayedSubmission(sub);
      } catch (err) {
        // Unexpected throw (D1 hiccup, ...): treat as transient.
        console.error(`delayed send fire failed (${sub.submissionId}):`, err);
        retryAt = await this.retryOrGiveUp(sub);
      }
      await this.ctx.storage.delete(key);
      if (retryAt !== null) {
        await this.ctx.storage.put(delayedKey(retryAt, sub.submissionId), {
          ...sub,
          fireAt: retryAt,
          attempts: (sub.attempts ?? 0) + 1,
        });
        consider(retryAt);
      }
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

  /**
   * Release one held submission: claim, relay, then the bookkeeping the
   * immediate path does inline (`submitOne` in services/jmap submission.ts) —
   * Message-ID reconcile, deferred onSuccess actions, changelog commit.
   *
   * Returns when to retry (epoch ms), or null when this entry is finished —
   * relayed, canceled, or given up. The structure has one invariant worth
   * stating: NOTHING after a wire-successful relay may route back to the
   * retry path, or a bookkeeping hiccup would resend a human's email. The
   * relay + status check is the pivot; everything after it catches its own
   * errors and only logs.
   */
  private async fireDelayedSubmission(sub: DelayedSubmission): Promise<number | null> {
    const { DB, BLOBS, SUBMIT, INTERNAL_TOKEN } = this.env;
    if (!DB || !BLOBS || !SUBMIT) return null; // not wired in this worker
    const store = new Mailstore(DB, BLOBS, { principal: sub.principal });

    // The email must still exist. Checked BEFORE the claim so a destroyed
    // draft resolves to a clean pending → canceled, visible to clients.
    const email = await store.getEmailRow(sub.accountId, sub.emailId);
    if (!email) {
      const moved = await store.updateSubmissionUndoStatus(sub.accountId, sub.submissionId, "pending", "canceled");
      if (moved) await this.commitSubmissionUpdated(sub);
      return null;
    }

    // The CAS both races go through (see Mailstore.updateSubmissionUndoStatus):
    // a cancel that landed first leaves nothing to do, ever.
    const claimed = await store.updateSubmissionUndoStatus(sub.accountId, sub.submissionId, "pending", "final");
    if (!claimed) return null;

    let res: Response;
    try {
      res = await SUBMIT.fetch("https://submit.internal/internal/submit", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-internal-token": INTERNAL_TOKEN ?? "",
        },
        body: JSON.stringify({
          accountId: sub.accountId,
          tenantId: sub.tenantId,
          blobId: email.blobId,
          envelope: sub.envelope,
        }),
      });
    } catch (err) {
      console.error(`delayed send ${sub.submissionId}: relay unreachable:`, err);
      return this.retryOrGiveUp(sub);
    }

    if (!res.ok) {
      if (res.status >= 500) {
        console.error(`delayed send ${sub.submissionId}: relay returned ${res.status}`);
        return this.retryOrGiveUp(sub);
      }
      // 4xx is permanent — suppression-listed recipient (422), blob gone
      // (404), bad internal token (403). Retrying cannot change the answer,
      // so the submission resolves to canceled (see MAX_RELAY_ATTEMPTS for
      // why canceled and not a stuck pending).
      console.error(`delayed send ${sub.submissionId}: relay refused (${res.status}): ${await res.text()}`);
      await store.updateSubmissionUndoStatus(sub.accountId, sub.submissionId, "final", "canceled");
      await this.commitSubmissionUpdated(sub);
      return null;
    }

    // ---- past the pivot: the message is on the wire. Only bookkeeping now.
    try {
      const { relayMessageId, messageId: relayStamped } = (await res.json()) as {
        relayMessageId?: string;
        messageId?: string;
      };
      await store.setSubmissionRelayMessageId(sub.accountId, sub.submissionId, relayMessageId ?? null);

      const entries: CommitBody["entries"] = [{ collection: "EmailSubmission", updated: [sub.submissionId] }];
      const mailboxesTouched = new Set<string>();
      let emailUpdated = false;

      // stored == wire (same invariant as submitOne: the relay rewrites the
      // Message-ID; replies and self-send copies correlate against the row).
      const wireMessageId = normalizeMessageId(relayStamped);
      if (wireMessageId !== null && wireMessageId !== email.messageId) {
        await store.updateEmailMessageId(sub.accountId, sub.emailId, wireMessageId);
        emailUpdated = true;
      }

      // Deferred onSuccess actions — this is their RELAY-time firing.
      let emailDestroyed = false;
      if (sub.onSuccessDestroy) {
        await store.destroyEmail(sub.accountId, sub.emailId);
        for (const mb of email.mailboxIds) mailboxesTouched.add(mb);
        emailDestroyed = true;
      } else if (sub.onSuccessPatch) {
        emailUpdated = (await applyDeferredEmailPatch(store, sub, email, mailboxesTouched)) || emailUpdated;
      }

      if (emailUpdated || emailDestroyed) {
        entries.push({
          collection: "Email",
          updated: emailUpdated && !emailDestroyed ? [sub.emailId] : [],
          destroyed: emailDestroyed ? [sub.emailId] : [],
        });
      }
      if (mailboxesTouched.size > 0) {
        entries.push({ collection: "Mailbox", updated: [...mailboxesTouched] });
      }
      await this.applyCommit({ accountId: sub.accountId, entries });
    } catch (err) {
      // The send happened; the row says final. A bookkeeping failure here is
      // a logged inconsistency, never a resend.
      console.error(`delayed send ${sub.submissionId}: post-relay bookkeeping failed:`, err);
    }
    return null;
  }

  /**
   * Transient relay failure: put the row back where a cancel can still reach
   * it, and either re-queue with backoff or — attempts exhausted — resolve to
   * canceled so the client learns the message will not send.
   */
  private async retryOrGiveUp(sub: DelayedSubmission): Promise<number | null> {
    const { DB, BLOBS } = this.env;
    if (!DB || !BLOBS) return null;
    const store = new Mailstore(DB, BLOBS, { principal: sub.principal });
    try {
      // Undo the claim (no-op if the failure predated it).
      await store.updateSubmissionUndoStatus(sub.accountId, sub.submissionId, "final", "pending");
      if ((sub.attempts ?? 0) + 1 >= MAX_RELAY_ATTEMPTS) {
        console.error(`delayed send ${sub.submissionId}: giving up after ${MAX_RELAY_ATTEMPTS} attempts`);
        const moved = await store.updateSubmissionUndoStatus(sub.accountId, sub.submissionId, "pending", "canceled");
        if (moved) await this.commitSubmissionUpdated(sub);
        return null;
      }
      return Date.now() + RELAY_RETRY_MS;
    } catch (err) {
      // Even the bookkeeping is failing; keep the entry alive — attempts
      // still climb each pass, so this terminates at MAX_RELAY_ATTEMPTS.
      console.error(`delayed send ${sub.submissionId}: retry bookkeeping failed:`, err);
      return Date.now() + RELAY_RETRY_MS;
    }
  }

  /** Changelog entry for an undoStatus flip with no email side effects. */
  private async commitSubmissionUpdated(sub: DelayedSubmission): Promise<void> {
    await this.applyCommit({
      accountId: sub.accountId,
      entries: [{ collection: "EmailSubmission", updated: [sub.submissionId] }],
    });
  }

  private async seq(): Promise<number> {
    return (await this.ctx.storage.get<number>("seq")) ?? 0;
  }

  private async commit(body: CommitBody): Promise<Response> {
    return json(await this.applyCommit(body));
  }

  /**
   * The commit itself, callable from inside the DO as well as over `/commit` —
   * the alarm path writes its relay-time changes here directly, because this
   * object IS the changelog and a self-fetch would be a hop to nowhere.
   */
  private async applyCommit(body: CommitBody): Promise<{ oldState: string; newState: string }> {
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

    return { oldState: String(oldSeq), newState: String(seq) };
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
    const push: StateChange = {
      "@type": "StateChange",
      changed: { [body.accountId]: collections },
    };
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

/**
 * Apply a deferred `onSuccessUpdateEmail` patch to the just-relayed email.
 * Returns whether the email row changed.
 *
 * This deliberately MIRRORS `applyEmailPatch` in
 * services/jmap/src/methods/email.ts — same two properties (`keywords`,
 * `mailboxIds`), same full-replace vs `path/key: true|null` forms, same
 * "an email must belong to at least one mailbox" floor. It cannot IMPORT it:
 * packages must not depend on services, and the original throws
 * jmap-core MethodErrors meant for a live request, while here the request
 * that supplied the patch ended hours ago — an unusable path is a logged
 * skip, never a failure of the send that already happened. Keep the two in
 * step when patch semantics change.
 */
async function applyDeferredEmailPatch(
  store: Mailstore,
  sub: DelayedSubmission,
  email: EmailRow,
  mailboxesTouched: Set<string>,
): Promise<boolean> {
  const patch = sub.onSuccessPatch ?? {};
  const keywords = new Set(email.keywords);
  const mailboxIds = new Set(email.mailboxIds);
  let touchedKeywords = false;
  let touchedMailboxes = false;

  const applySetOp = (target: Set<string>, sub2: string | undefined, value: unknown): boolean => {
    if (sub2 === undefined) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
      target.clear();
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (v === true) target.add(k);
      }
      return true;
    }
    if (value === true) {
      target.add(sub2);
      return true;
    }
    if (value === null || value === false) {
      target.delete(sub2);
      return true;
    }
    return false;
  };

  for (const [path, value] of Object.entries(patch)) {
    const [head, key, ...rest] = path.split("/");
    const ok =
      rest.length === 0 &&
      (head === "keywords" || head === "mailboxIds") &&
      applySetOp(head === "keywords" ? keywords : mailboxIds, key, value);
    if (!ok) {
      console.error(`delayed send ${sub.submissionId}: skipping unusable onSuccess patch path "${path}"`);
      continue;
    }
    if (head === "keywords") touchedKeywords = true;
    else touchedMailboxes = true;
  }

  if (!touchedKeywords && !touchedMailboxes) return false;
  if (touchedMailboxes && mailboxIds.size === 0) {
    console.error(`delayed send ${sub.submissionId}: onSuccess patch would leave the email in no mailbox; skipped`);
    return false;
  }

  await store.replaceEmailSets(sub.accountId, sub.emailId, {
    ...(touchedMailboxes ? { mailboxIds: [...mailboxIds] } : {}),
    ...(touchedKeywords ? { keywords: [...keywords] } : {}),
  });

  if (touchedMailboxes) {
    for (const mb of email.mailboxIds) mailboxesTouched.add(mb);
    for (const mb of mailboxIds) mailboxesTouched.add(mb);
  } else {
    for (const mb of email.mailboxIds) mailboxesTouched.add(mb);
  }
  return true;
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
export async function armResponder(ns: DurableObjectNamespace, pending: PendingResponse): Promise<void> {
  const res = await accountStub(ns, pending.accountId).fetch("https://do/arm", {
    method: "POST",
    body: JSON.stringify(pending),
  });
  if (!res.ok) throw new Error(`AccountDO arm failed: ${res.status}`);
}

/** Helper for workers: queue a held submission on the account's alarm. */
export async function scheduleDelayedSubmission(ns: DurableObjectNamespace, sub: DelayedSubmission): Promise<void> {
  const res = await accountStub(ns, sub.accountId).fetch("https://do/delay", {
    method: "POST",
    body: JSON.stringify(sub),
  });
  if (!res.ok) throw new Error(`AccountDO delay failed: ${res.status}`);
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
