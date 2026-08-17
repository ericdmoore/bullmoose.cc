import { emitProposal } from "./proposals.js";
import type { Env } from "./models.js";

/**
 * Watches (s20 T1) — the sweep that turns a star into a kept promise.
 *
 * A Watch is `condition + deadline + action + escalation`. A star is a human
 * telling their future self "something about this is important"; a Watch is a
 * contract the system can execute, so the human can stop checking and hear
 * about it only when it fires. This is the "agent consumes the firehose, human
 * gets exceptions" principle made into a primitive.
 *
 * ## Deterministic in v1, on purpose
 *
 * Every condition here is a plain predicate the cron can decide without a
 * model call. An LLM-judged condition ("tell me only if the shipment won't
 * arrive by Friday") is v2, and it enters as a CLASSIFIER over new mail that
 * flips a deterministic watch — never a free-running agent loop. The sweep
 * stays a state machine; nothing here spends a token.
 *
 * ## Firing produces a PROPOSAL, never a direct action
 *
 * A fired watch mints a carrier invocation (finished on arrival, cost 0 — no
 * model ran) and emits a proposal on it, exactly as `budgetOverrun` and
 * `midBandProposal` do. So the s03.D tier rules and the respond-only rule
 * apply unchanged: a `draft-followup` targets a THIRD PARTY (whoever we are
 * waiting on), which is agent-INITIATED egress and therefore proposes; a
 * `notify` is an FYI. Nothing a watch does escapes the approvals machinery.
 *
 * ## Fail-open, idempotent, bounded
 *
 * A shard missing the `watches` table (pre-migration) reads as "no watches"
 * and the sweep is a logged no-op — same posture as the boundary reads. The
 * status flip is a GUARDED UPDATE (`WHERE status='armed'`), so two overlapping
 * sweeps cannot double-fire one watch: the second changes zero rows and skips.
 * A bounded batch keeps one pathological account from starving the cron.
 */

const SWEEP_BATCH = 50;

interface WatchRow {
  id: string;
  account_id: string;
  owner: string;
  condition_type: string;
  condition_json: string;
  deadline_at: number;
  action_type: string;
  action_json: string;
  source_ref: string | null;
  created_at: number;
}

/** How long a fired watch's proposal waits for a human before expiring. */
const WATCH_PROPOSAL_EXPIRY_MS = 7 * 24 * 3600_000;

export async function sweepWatches(env: Env, now: number = Date.now()): Promise<void> {
  let rows: WatchRow[];
  try {
    const res = await env.DB.prepare(
      `SELECT id, account_id, owner, condition_type, condition_json, deadline_at,
              action_type, action_json, source_ref, created_at
       FROM watches
       WHERE status = 'armed' AND deadline_at <= ?
       ORDER BY deadline_at ASC LIMIT ?`,
    )
      .bind(now, SWEEP_BATCH)
      .all<WatchRow>();
    rows = res.results;
  } catch {
    // No table yet (pre-migration): a watch nobody can fire is the degraded
    // state, said out loud, not a crash.
    console.warn("watch sweep degraded to no-op (missing watches table?)");
    return;
  }

  for (const w of rows) {
    try {
      const verdict = await evaluate(env, w);
      if (verdict === "not-yet") continue; // condition failed cleanly (e.g. a reply arrived)
      if (verdict === "expire") {
        await closeWatch(env, w.id, "expired", now, null);
        continue;
      }
      // verdict === "fire"
      const proposalId = await fire(env, w, now);
      await closeWatch(env, w.id, "fired", now, proposalId);
    } catch (err) {
      // A watch whose evaluation or firing throws stays armed and is retried
      // next sweep — the row, not the attempt, is the source of truth.
      console.error(`watch ${w.id} failed to fire: ${String(err).slice(0, 160)} (stays armed)`);
    }
  }
}

type Verdict = "fire" | "not-yet" | "expire";

/**
 * Deterministic condition evaluation. The deadline has already passed (the
 * SELECT guaranteed it); this decides whether the condition HOLDS.
 */
async function evaluate(env: Env, w: WatchRow): Promise<Verdict> {
  const cond = safeJson(w.condition_json);
  switch (w.condition_type) {
    case "deadline":
      // The pure reminder: the clock is the whole condition.
      return "fire";
    case "no-reply-from": {
      // Fires ONLY IF no inbound message from `sender` arrived since the watch
      // was set. If one did, the thing we were waiting for happened — the
      // watch expires clean, no follow-up, no noise.
      const sender = typeof cond.sender === "string" ? cond.sender : null;
      if (!sender) return "expire"; // malformed watch — do not fire blind
      const threadId = typeof cond.threadId === "string" ? cond.threadId : null;
      const replied = await hasInboundSince(env, w.account_id, sender, threadId, w.created_at);
      return replied ? "expire" : "fire";
    }
    default:
      // Unknown condition type: expire rather than fire, so a future
      // condition shipped to an old worker degrades to silence, not a wrong
      // action. (The reverse — firing an unrecognized condition — is the
      // dangerous default.)
      console.warn(`watch ${w.id}: unknown condition "${w.condition_type}" — expiring`);
      return "expire";
  }
}

/** Did a message from `sender` (optionally on `threadId`) land in an inbound
 *  mailbox after `since`? Read-only, deterministic. Exported so the Waiting-on
 *  detector (waitingOn.ts) reuses the SAME "has a reply arrived" predicate the
 *  fire path uses — one definition of "answered", two callers. */
export async function hasInboundSince(
  env: Env,
  accountId: string,
  sender: string,
  threadId: string | null,
  since: number,
): Promise<boolean> {
  // The sender lives in `from_json` (a JSON EmailAddress[]); a LIKE over the
  // serialized array is enough for a deterministic "did this address send"
  // check without parsing every row. `received_at > since` bounds it to mail
  // that arrived AFTER the watch was armed.
  const where = threadId
    ? `account_id = ? AND thread_id = ? AND received_at > ? AND from_json LIKE ?`
    : `account_id = ? AND received_at > ? AND from_json LIKE ?`;
  const binds = threadId
    ? [accountId, threadId, since, `%${sender}%`]
    : [accountId, since, `%${sender}%`];
  const row = await env.DB.prepare(`SELECT 1 AS hit FROM emails WHERE ${where} LIMIT 1`)
    .bind(...binds)
    .first<{ hit: number }>();
  return !!row;
}

/**
 * Mint the carrier invocation and emit the fired watch's proposal. The carrier
 * is `done` on arrival with cost 0 — no model ran — the same shape every
 * proposal's invocation is in by the time a human sees it (budgetOverrun.ts).
 */
async function fire(env: Env, w: WatchRow, now: number): Promise<string> {
  const action = safeJson(w.action_json);
  const carrierId = `inv_${crypto.randomUUID()}`;
  const bindingId = typeof action.bindingId === "string" ? action.bindingId : "watch";
  const bindingName = typeof action.bindingName === "string" ? action.bindingName : "remind@";

  await env.DB.prepare(
    `INSERT INTO agent_invocations
       (id, account_id, binding_id, binding_name, status, context_json,
        created_at, claimed_at, done_at, cost_micros, result_json)
     VALUES (?, ?, ?, ?, 'done', ?, ?, ?, ?, 0, ?)`,
  )
    .bind(
      carrierId,
      w.account_id,
      bindingId,
      bindingName,
      JSON.stringify({ kind: "watch-fired", watchId: w.id }),
      now,
      now,
      now,
      JSON.stringify({ kind: "watch-fired", watchId: w.id }),
    )
    .run();

  const isFollowup = w.action_type === "draft-followup";
  const cond = safeJson(w.condition_json);
  const evidence = w.source_ref
    ? [{ realm: "Email" as const, objectId: w.source_ref, note: "the message this watch was set on" }]
    : [];

  await emitProposal(
    env,
    { id: carrierId, account_id: w.account_id },
    {
      // A follow-up is a real send (tier 2, agent-initiated → the queue holds
      // it). A notify is an FYI marker (tier 1, reversible — clearing it
      // touches nothing in the world).
      kind: isFollowup ? "watch-followup" : "watch-notify",
      tier: isFollowup ? 2 : 1,
      subject: w.source_ref
        ? { realm: "Email", objectId: w.source_ref }
        : { realm: "Watch", objectId: w.id },
      payload: {
        watchId: w.id,
        conditionType: w.condition_type,
        // For a follow-up, the recipient and the note the human wrote when
        // arming it. The actual draft text is composed at approval time or by
        // the human — v1 carries the intent, not a model-generated body
        // (drafting-on-fire is a v2 refinement once cost history exists).
        to: typeof action.to === "string" ? action.to : (typeof cond.sender === "string" ? cond.sender : null),
        note: typeof action.note === "string" ? action.note : null,
      },
      rationale: watchRationale(w, cond),
      evidence,
      expiresInMs: WATCH_PROPOSAL_EXPIRY_MS,
    },
  );
  return carrierId;
}

function watchRationale(w: WatchRow, cond: Record<string, unknown>): string {
  const who = typeof cond.sender === "string" ? cond.sender : "someone";
  if (w.condition_type === "no-reply-from") {
    return (
      `You asked to be watched: ${who} had not replied by the deadline you set, so this ` +
      `${w.action_type === "draft-followup" ? "proposes a follow-up" : "is your reminder"}.`
    );
  }
  return `Your reminder came due — the watch you set on ${new Date(w.deadline_at).toISOString().slice(0, 10)}.`;
}

async function closeWatch(
  env: Env,
  id: string,
  status: "fired" | "expired",
  now: number,
  proposalId: string | null,
): Promise<void> {
  // Guarded on 'armed': if a concurrent sweep already moved it, this changes
  // nothing and the double-fire is prevented at the write.
  await env.DB.prepare(
    `UPDATE watches SET status = ?, fired_at = ?, proposal_id = ? WHERE id = ? AND status = 'armed'`,
  )
    .bind(status, now, proposalId, id)
    .run();
}

function safeJson(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
