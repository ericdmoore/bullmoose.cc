import { extractDueAt } from "@bullmoose/scheduling";
import type { EmailRow } from "@bullmoose/mailstore";
import type { Env } from "./models.js";

/**
 * remind@ — the mail-native door to Watches (s20 wave 2).
 *
 * A Watch is `condition + deadline + action` (watches.ts). Wave 1 arms one
 * from webmail (the star on-ramp) and JMAP `Watch/set`; this is the door a
 * human — or an agent drafting on their behalf — reaches with nothing but an
 * email. CC `remind@<your-domain>` on a thread, or write it fresh, with a
 * deadline in plain words ("remind me to follow up with Sergio by Friday"),
 * and a Watch is armed on YOUR account. When it comes due the ordinary sweep
 * fires it into your approvals — never a place you have to remember to check.
 *
 * ## Why a dedicated agent account, not a plus-tag
 *
 * `remind@` is provisioned as its own agent account with a `mailbox-delivery`
 * binding (provisionRemind, services/provision). So ONLY mail actually sent to
 * it mints an invocation — a `+remind` tag on a human's own box would fire a
 * pipeline on every message they receive. The binding's `allowedSenders` (the
 * household's human principals) and its governing book (the same list) are the
 * two safety bounds: a stranger is skipped silently before this module runs
 * (no backscatter, no existence oracle — the bouncer's gate, reused), and the
 * confirmation reply can only ever reach a household human.
 *
 * ## Deterministic, model-free — the Watches posture, held
 *
 * The deadline is read by the SAME conservative parser ingest stamps `due_at`
 * with (`extractDueAt`, @bullmoose/scheduling): a cue word must introduce the
 * date, and anything vague ("soon", "next week", a bare "tomorrow") returns
 * null. A wrong reminder is worse than none, so a request we cannot pin gets a
 * teaching reply, not a guessed time. No token is ever spent here.
 *
 * ## Arms a Watch on the HUMAN's account — nothing egresses
 *
 * The watch is written to the SENDER's account, not remind@'s, so the fired
 * proposal lands in the human's own queue (sweepWatches keys the carrier
 * invocation to the watch's `account_id`). v1 arms a `deadline`/`notify` watch
 * — a pure reminder (tier 1, reversible; clearing it touches nothing in the
 * world). Waiting-on-a-reply (`no-reply-from`) and agent-composed follow-up
 * bodies are later slices; this door sets the promise, the sweep keeps it.
 */

/** The invocation coordinates remind needs — the structural subset of `Job`
 *  the reply closure and the finish callback are already built around. */
export interface RemindJob {
  id: string;
  account_id: string;
  binding_name: string;
  tenant_id: string;
}

type Finish = (status: "done" | "failed", result: Record<string, unknown>) => Promise<void>;
/** Sends one reply-only message to the sender; returns the stored emailId. */
type Reply = (text: string) => Promise<string>;

export type RemindParse =
  | { ok: true; deadlineAt: number; note: string }
  | { ok: false; reason: "no-deadline" };

/**
 * Read a reminder request from a message: the deadline (via the shared
 * conservative parser) and the note — WHAT to be reminded of. Pure and
 * deterministic, so the whole parse is unit-testable without an env.
 */
export function parseRemindRequest(input: { subject: string; text: string; now: number }): RemindParse {
  const deadlineAt = extractDueAt({ subject: input.subject, text: input.text, now: input.now });
  if (deadlineAt === null) return { ok: false, reason: "no-deadline" };
  return { ok: true, deadlineAt, note: deriveNote(input.subject, input.text) };
}

/**
 * The human-readable "what" of the reminder. The subject is the strongest
 * signal (minus the Re:/Fwd: scaffolding a reply accretes); an empty subject
 * falls back to the first non-empty line of the body. Bounded so a runaway
 * body cannot bloat the stored note.
 */
function deriveNote(subject: string, text: string): string {
  // Strip STACKED reply/forward scaffolding — "Re: Fwd: Re: …" is one accretion.
  const cleaned = subject.replace(/^\s*(?:(?:re|fwd|fw)\s*:\s*)+/i, "").trim();
  if (cleaned) return cleaned.slice(0, 200);
  const firstLine = (text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return (firstLine ?? "your reminder").slice(0, 200);
}

/** The date a fired reminder will read as, in the confirmation. UTC — the
 *  parser resolves date-only deadlines at 17:00 UTC (see dueDate's timezone
 *  note); showing the calendar day is the honest, un-fussy rendering. */
function humanDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The remind pipeline. Reached from runInvocation ONLY after the shared
 * `humanOriginated` and `allowedSenders` gates (index.ts) have passed, so the
 * sender is a listed household human — but we still resolve them to a live
 * account, because the watch has to be written somewhere and a reminder for a
 * non-account is meaningless. If they do not resolve, we skip silently (no
 * reply): the same no-oracle posture the gates upstream enforce.
 */
export async function runRemind(
  env: Env,
  job: RemindJob,
  email: EmailRow,
  parsed: { text?: string },
  reply: Reply,
  finish: Finish,
): Promise<void> {
  const sender = (email.from[0]?.email ?? "").toLowerCase();
  if (!sender) return finish("done", { note: "skipped: no sender address" });

  // Whose reminder is this? The watch must live on the human's account so the
  // fired proposal reaches THEIR queue. deleted_at filter: a tombstoned
  // account is not a live target (accounts schema).
  const account = await env.DB.prepare(
    `SELECT a.id FROM accounts a JOIN identities i ON i.account_id = a.id
     WHERE i.email = ? AND a.deleted_at IS NULL LIMIT 1`,
  )
    .bind(sender)
    .first<{ id: string }>();
  if (!account) {
    // A listed sender with no bullmoose account (or a tombstoned one): nowhere
    // to arm the watch, and replying to an unresolved address is exactly the
    // backscatter the gates avoid. Silent skip.
    return finish("done", { note: `skipped: ${sender} is not a live bullmoose account` });
  }

  const parse = parseRemindRequest({
    subject: email.subject ?? "",
    text: parsed.text ?? email.preview ?? "",
    now: Date.now(),
  });
  if (!parse.ok) {
    // No deadline we trust. The reply is the teaching surface — it names the
    // cue the parser needs rather than silently doing nothing.
    await reply(
      "I couldn't find a deadline I'm sure about, so I didn't set a reminder.\n\n" +
        'Tell me *when* with a cue like "by Friday", "by end of day", or ' +
        '"by 2026-08-20", and I\'ll set it. I don\'t guess at vague times ' +
        '("soon", "next week", a bare "tomorrow") — a wrong reminder is worse ' +
        "than none.",
    );
    return finish("done", { note: "no deadline parsed — sent teaching reply" });
  }

  // Idempotent on the invocation id: a run reaped mid-flight and retried
  // (index.ts's stuck-'running' reaper) produces the SAME watch id, so OR
  // IGNORE dedups it — one remind@ message can arm at most one watch.
  const watchId = `w_${job.id}`;
  const now = Date.now();
  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO watches
       (id, account_id, owner, condition_type, condition_json, deadline_at,
        action_type, action_json, status, source_ref, created_at)
     VALUES (?, ?, ?, 'deadline', ?, ?, 'notify', ?, 'armed', NULL, ?)`,
  )
    .bind(
      watchId,
      account.id,
      sender,
      JSON.stringify({ note: parse.note }),
      parse.deadlineAt,
      JSON.stringify({ note: parse.note, bindingName: "remind@" }),
      now,
    )
    .run();

  // changes === 0 means the row already existed: a retry of a run that armed
  // then died before confirming. Don't re-confirm (no double reply); the watch
  // is safely in place either way.
  if ((res.meta?.changes ?? 0) === 0) {
    return finish("done", { note: "already armed (retry) — no duplicate", watchId });
  }

  await reply(
    `Reminder set for ${humanDay(parse.deadlineAt)}.\n\n` +
      `When it comes due I'll surface it in your approvals as:\n  "${parse.note}"\n\n` +
      "Nothing was sent to anyone — a reminder just nudges you.",
  );
  return finish("done", { note: "watch armed", watchId, deadlineAt: parse.deadlineAt, account: account.id });
}
