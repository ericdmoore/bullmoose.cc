import { commitChanges } from "@bullmoose/account-do";
import { emitProposal } from "./proposals.js";
import { hasInboundSince } from "./watches.js";
import type { Env } from "./models.js";

/**
 * Waiting-on (s20 T1↔T4 seam) — the agent-offered Watch. The anti-star.
 *
 * A star made YOU do the classifier's job: notice a thread, mark it, remember
 * to come back. This is the inverse — the sweep notices, and offers. It scans
 * your Sent mail for a QUESTION you asked that has gone unanswered past a
 * threshold, and drops a `watch-offer` proposal into your approvals: *"you
 * emailed Sergio 4 days ago and haven't heard back — want me to watch this and
 * draft a follow-up if it's still quiet?"* You flagged nothing; the chief of
 * staff noticed.
 *
 * ## An offer, not an act (yet)
 *
 * v1 PROPOSES rather than silently arming — the offer renders in the same queue
 * everything else does, and approving it is a reversible tier-1 decision (it
 * arms a Watch, which egresses NOTHING until it fires). "Never even confirm —
 * just watch" is the same detector with the offer step removed, a policy flip
 * to graduate to once this behaviour has earned trust. Declining is remembered:
 * a thread offered once is never offered again (the dedup below), so "no" is a
 * durable answer, not a question re-asked every five minutes.
 *
 * ## Deterministic and conservative — the Watches posture, held
 *
 * No model runs. The "is this a question awaiting a reply" test is a literal
 * `?` in the subject or body head — it misses imperative asks ("send me the
 * calc"), which is the safe direction: a missed offer costs nothing, a spurious
 * one is noise. It offers only inside a silence WINDOW — old enough to be
 * notable (`OFFER_AFTER_MS`), not so old it is moot (`MAX_AGE_MS`) — and only
 * when no reply has actually arrived (the shared `hasInboundSince`). Fail-open
 * on a missing table, bounded batch: the same posture as `sweepWatches`.
 */

const BATCH = 25;
/** How long a sent question must go unanswered before we offer to watch it.
 *  Not instant — most replies land within a day or two; offering only once the
 *  silence is notable is what keeps this from being a second inbox. */
const OFFER_AFTER_MS = 3 * 24 * 3600_000;
/** Past this, a silent thread is more likely moot than pending — don't offer. */
const MAX_AGE_MS = 30 * 24 * 3600_000;
/** If the offer is approved, how long the armed Watch waits (from approval)
 *  before it fires the follow-up — carried as a DURATION so the deadline is
 *  measured from when the human said yes, not from when we asked. */
const WATCH_DURATION_MS = 4 * 24 * 3600_000;
/** An unanswered offer is itself stale after this — the thread has moved on. */
const OFFER_EXPIRY_MS = 14 * 24 * 3600_000;

interface SentRow {
  id: string;
  account_id: string;
  thread_id: string;
  subject: string | null;
  preview: string | null;
  to_json: string;
  from_json: string;
  received_at: number;
  message_id: string | null;
}

export async function sweepWaitingOn(env: Env, now: number = Date.now()): Promise<void> {
  let rows: SentRow[];
  try {
    // Sent questions inside the silence window. `mb.role = 'sent'` is what
    // scopes this to mail YOU sent; the received_at of a sent copy is its send
    // time (sendReply / the submit path stamp it so).
    const res = await env.DB.prepare(
      `SELECT e.id, e.account_id, e.thread_id, e.subject, e.preview, e.to_json,
              e.from_json, e.received_at, e.message_id
       FROM emails e
       JOIN email_mailboxes em ON em.account_id = e.account_id AND em.email_id = e.id
       JOIN mailboxes mb ON mb.account_id = e.account_id AND mb.id = em.mailbox_id AND mb.role = 'sent'
       WHERE e.received_at >= ? AND e.received_at <= ?
         AND (e.subject LIKE '%?%' OR e.preview LIKE '%?%')
       ORDER BY e.received_at DESC LIMIT ?`,
    )
      .bind(now - MAX_AGE_MS, now - OFFER_AFTER_MS, BATCH)
      .all<SentRow>();
    rows = res.results;
  } catch {
    // Missing table (pre-migration) or a shard without mail: a Waiting-on
    // detector with nothing to read is a no-op, said out loud, not a crash.
    console.warn("waiting-on sweep degraded to no-op (missing emails/mailboxes table?)");
    return;
  }

  // One offer per THREAD per sweep — two sent questions on the same thread must
  // not each spawn an offer.
  const seenThreads = new Set<string>();

  for (const e of rows) {
    try {
      if (seenThreads.has(e.thread_id)) continue;
      const to = firstEmail(e.to_json);
      const self = firstEmail(e.from_json);
      if (!to || to === self) continue; // no recipient, or a note to yourself

      // Dedup across sweeps: never offer a thread that already has a watch
      // (human- or agent-armed) or an offer of its own — including a DECLINED
      // one, so "no" sticks. A LIKE over the JSON is enough for an opaque
      // thread id (same shape as hasInboundSince's from_json LIKE).
      if (await threadAlreadyHandled(env, e.account_id, e.thread_id)) {
        seenThreads.add(e.thread_id);
        continue;
      }

      // The reply may have landed since it was sent — then you are not waiting,
      // and there is nothing to offer.
      if (await hasInboundSince(env, e.account_id, to, e.thread_id, e.received_at)) {
        seenThreads.add(e.thread_id);
        continue;
      }

      await offer(env, e, to, self, now);
      seenThreads.add(e.thread_id);
    } catch (err) {
      // One malformed row must not sink the batch — skip it, keep sweeping.
      console.error(`waiting-on: ${e.id} failed to offer: ${String(err).slice(0, 160)}`);
    }
  }
}

/** Is there already a watch or a watch-offer for this thread? Either means the
 *  thread is spoken for — an armed watch (don't duplicate) or a prior offer in
 *  ANY status (pending = already asked; terminal = already answered, including
 *  a decline we must honour). */
async function threadAlreadyHandled(
  env: Env,
  accountId: string,
  threadId: string,
): Promise<boolean> {
  const like = `%"threadId":"${threadId}"%`;
  const watch = await env.DB.prepare(
    `SELECT 1 AS hit FROM watches WHERE account_id = ? AND condition_json LIKE ? LIMIT 1`,
  )
    .bind(accountId, like)
    .first<{ hit: number }>();
  if (watch) return true;
  const offered = await env.DB.prepare(
    `SELECT 1 AS hit FROM agent_proposals WHERE account_id = ? AND kind = 'watch-offer' AND payload_json LIKE ? LIMIT 1`,
  )
    .bind(accountId, like)
    .first<{ hit: number }>();
  return !!offered;
}

/** Mint the carrier invocation (done-on-arrival, cost 0 — no model ran) and the
 *  `watch-offer` proposal, exactly as a fired watch does. */
async function offer(
  env: Env,
  e: SentRow,
  to: string,
  self: string | null,
  now: number,
): Promise<void> {
  const carrierId = `inv_${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO agent_invocations
       (id, account_id, binding_id, binding_name, status, context_json,
        created_at, claimed_at, done_at, cost_micros, result_json)
     VALUES (?, ?, 'waiting-on', 'waiting-on', 'done', ?, ?, ?, ?, 0, ?)`,
  )
    .bind(
      carrierId,
      e.account_id,
      JSON.stringify({ kind: "waiting-on", threadId: e.thread_id, emailId: e.id }),
      now,
      now,
      now,
      JSON.stringify({ kind: "waiting-on", threadId: e.thread_id }),
    )
    .run();

  const days = Math.max(1, Math.round((now - e.received_at) / 86_400_000));
  const subjectLine = (e.subject ?? "").replace(/^\s*(?:(?:re|fwd|fw)\s*:\s*)+/i, "").trim();

  await emitProposal(
    env,
    { id: carrierId, account_id: e.account_id },
    {
      // Tier 1: approving ARMS a watch, which touches nothing in the world
      // until it fires (and firing is itself only a proposal). Reversible —
      // the undo cancels the watch (actionProposal.ts).
      kind: "watch-offer",
      tier: 1,
      subject: { realm: "Email", objectId: e.id },
      payload: {
        threadId: e.thread_id,
        to,
        self,
        emailId: e.id,
        sentAt: e.received_at,
        sentSubject: subjectLine,
        sentMessageId: e.message_id,
        // A DURATION, resolved to a deadline at approval time — see the const.
        watchDurationMs: WATCH_DURATION_MS,
      },
      rationale:
        `You emailed ${to}${subjectLine ? ` about "${subjectLine}"` : ""} ${days} ` +
        `day${days === 1 ? "" : "s"} ago and haven't heard back. Approve and I'll watch the ` +
        `thread and draft a follow-up if it's still quiet in a few days; if ${to} replies first, ` +
        `the watch closes itself and you hear nothing.`,
      evidence: [
        { realm: "Email", objectId: e.id, note: "the message you're waiting on a reply to" },
      ],
      expiresInMs: OFFER_EXPIRY_MS,
    },
  );

  // s18 A2 — graduate the detector into an Annotation. The waiting-on is not
  // just a queue row; it is a `task` claim about the sent message ("you're
  // waiting on a reply"), so the Commitments/Waiting-on views (A4) and the
  // margin (A3) see it. Confidence NULL: this is a DETERMINISTIC finding, not a
  // model estimate — it is true because the mailbox says so. source_ref ties it
  // to the same message the offer cites.
  const annId = `an_${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO annotations
       (id, account_id, author_kind, author, anchor_json, class, body,
        confidence, status, rationale, source_ref, created_at, updated_at)
     VALUES (?, ?, 'agent', 'waiting-on', ?, 'task', ?, NULL, 'open', NULL, ?, ?, ?)`,
  )
    .bind(
      annId,
      e.account_id,
      JSON.stringify({ realm: "Email", objectId: e.id }),
      `Waiting on ${to}'s reply${subjectLine ? ` to "${subjectLine}"` : ""}`,
      e.id,
      now,
      now,
    )
    .run();
  await commitChanges(env.ACCOUNT_DO, e.account_id, [
    { collection: "Annotation", created: [annId], updated: [], destroyed: [] },
  ]);
}

/** First address of a JSON EmailAddress[] column, lowercased, or null. */
function firstEmail(json: string): string | null {
  try {
    const arr = JSON.parse(json) as Array<{ email?: string }>;
    const email = Array.isArray(arr) ? arr[0]?.email : undefined;
    return typeof email === "string" ? email.toLowerCase() : null;
  } catch {
    return null;
  }
}
