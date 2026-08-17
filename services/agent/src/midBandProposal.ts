import { commitChanges } from "@bullmoose/account-do";
import { QUARANTINE_ROLE } from "@bullmoose/mailstore";
import { emitProposal } from "./proposals.js";
import type { Env } from "./models.js";

/**
 * s12 — the mid-band is a DECISION, not a pile.
 *
 * THE HOLE (Eric, 2026-08-13): *"The JUNK folder seems like a design flaw now —
 * a folder that MAYBE you need to manage."* Anything that is *maybe* your job
 * is actually nobody's job: a folder of held mail has no completion state, no
 * signal when it needs attention, and accrues obligation at a constant rate
 * whether or not it holds anything. Wave 1 shipped that, twice.
 *
 * THE RESOLUTION is s11 T9's line, applied one section over:
 *
 *   **Marker when nothing can be decided; proposal when something can.**
 *
 * Confident spam is decided — 5xx at the edge or a shunt with a chain row, no
 * human involved, nothing to ask. Confident ham is decided — Inbox. The
 * MID-BAND is the one band bouncer definitionally cannot judge, and "is this
 * spam?" is a real question with a real answer, so it earns the queue. This
 * sweep is where the held mail turns into that question.
 *
 * ── Design decisions, and why ──────────────────────────────────────────────
 *
 * BATCH PER ACCOUNT, NEVER PER MESSAGE (T9's lesson, verbatim). One proposal —
 * "3 messages I couldn't judge" — never three. A per-message proposal would be
 * the pile again, wearing the queue's clothes, and the queue's whole value is
 * that it is short.
 *
 * THE MARKER IS THE IDEMPOTENCE KEY, and it is T9's mechanism: a period-scoped
 * `alert_kind` on the classify invocation (the machine fact — "bouncer looked
 * at this message and could not decide"), written with a GUARDED UPDATE. Mark
 * once → ask once. A second sweep in the same period finds every candidate
 * already marked and raises nothing at all.
 *
 * THE PERIOD IS A DAY (UTC), not T9's month. The period does two jobs: it
 * bounds the ask (an unanswered question is re-raised next period, so held
 * mail can never go quiet — the anti-pile property) and it dates the proposal's
 * expiry. Held mail is a faster clock than a budget: a month of silence over a
 * false positive is the failure this section exists to prevent, and a day is
 * the same UTC key `deny_counters` already uses.
 *
 * NEW HOLDS DO NOT WAIT FOR THE NEXT PERIOD. The marker is per MESSAGE, so
 * messages held after this period's proposal went out are unmarked, and the
 * next sweep asks about THEM — a new question, not a re-ask. Batching is
 * per sweep; the period only governs re-asking. Otherwise a message held one
 * minute after the daily ask would sit undiscussed for 24 hours.
 *
 * THE PROPOSAL LIVES ON THE RECIPIENT'S ACCOUNT, not on bouncer@'s, even
 * though the classify invocation lives on bouncer@'s (ingest's `screenDeliver`
 * puts it there — bouncer watches the whole tenant's boundary). The decision
 * is about a human's own mail and has to appear in the queue that human logs
 * into. The carrier invocation therefore names the bouncer BINDING on the
 * recipient's account: the binding row itself lives elsewhere, which is the
 * same seam the classify invocation already crosses. Consequence, said out
 * loud: a `needsInfo` round on this proposal enqueues an invocation the drain
 * (which JOINs bindings on the invocation's account) cannot claim on a
 * multi-account tenant. The proposal is answerable from its own payload —
 * every sender, subject and stage is in it — so the round has nothing to add;
 * closing the seam properly is a cross-account drain change, not this rework.
 */

/** How many held messages ONE proposal may name. A pathological spam storm
 * must not produce a 5,000-line rationale; the remainder stays held and the
 * next sweep asks about it, which the rationale says out loud. */
const MID_BAND_BATCH_MAX = 50;

/** How many candidate invocations one sweep reads. Bounds the fan-out the
 * same way T9's binding limit does. */
const MID_BAND_SCAN_LIMIT = 500;

/** The marker's kind, period-scoped: `mid-band-unsure:2026-08-13`. */
export const MID_BAND_MARKER_PREFIX = "mid-band-unsure";
export function midBandMarkerKind(periodKey: string): string {
  return `${MID_BAND_MARKER_PREFIX}:${periodKey}`;
}

/** The proposal kind. Named for what it holds, not for the band that produced
 * it: the human reading the queue has never heard of a Bayes mid-band. */
export const MID_BAND_KIND = "held-mail-review";

/** UTC day — the same key shape `deny_counters.day` uses. */
export function midBandPeriodKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** The instant that period ends, for the proposal's expiry. An unanswered ask
 * is superseded by the next period's, which names the same still-held mail. */
export function midBandPeriodEndMs(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

interface CandidateRow {
  id: string;
  account_id: string;
  binding_id: string;
  binding_name: string;
  email_id: string | null;
  context_json: string;
  /** The classifier's own note, when it degraded rather than judged ("no
   * model candidates", "every model route failed"). NULL on a real shrug. */
  note: string | null;
}

/** One held message, as the proposal names it. */
interface HeldMessage {
  emailId: string;
  sender: string;
  subject: string;
  stage: string;
  receivedAt: number | null;
  /** Why the classifier could not say, when it was not a judgment at all. */
  note: string | null;
  /** The classify invocation that could not decide — the marker's carrier. */
  invocationId: string;
  invocationAccountId: string;
}

/**
 * The sweep. Runs on the agent worker's cron beside T9's, and is SILENT unless
 * a classifier actually shrugged at something: no bouncer binding, no mid-band
 * mail, or every hold already asked about all produce nothing at all
 * (DefaultCase).
 *
 * @returns how many proposals this sweep raised.
 */
export async function proposeMidBandHolds(env: Env): Promise<{ asked: number }> {
  const now = Date.now();
  const periodKey = midBandPeriodKey(now);
  const markerKind = midBandMarkerKind(periodKey);

  // ---- pass 1: the classifier's shrugs -----------------------------------
  // Driven from the INVOCATION rather than from the mailbox, because that is
  // where both facts live: the verdict (its own recorded result) and the
  // marker column. `json_extract` reads the result the drain froze — the same
  // read T9 makes against config_json.
  let candidates: CandidateRow[];
  try {
    const { results } = await env.DB.prepare(
      `SELECT inv.id, inv.account_id, inv.binding_id, inv.binding_name,
              inv.email_id, inv.context_json,
              json_extract(inv.result_json, '$.note') AS note
         FROM agent_invocations inv
        WHERE inv.status = 'done'
          AND inv.email_id IS NOT NULL
          AND json_extract(inv.result_json, '$.kind') = 'bouncer-classify'
          AND json_extract(inv.result_json, '$.verdict') = 'unsure'
          -- ALREADY ASKED? The marker is the key. A marker from a PREVIOUS
          -- period re-qualifies (a new period is a new question about mail
          -- that is somehow STILL held), and no other alert_kind is touched:
          -- overdue-pinned / overdue-unfit are permanent facts about a
          -- passed deadline and this sweep must not repaint them.
          AND (inv.alert_kind IS NULL
               OR (inv.alert_kind LIKE '${MID_BAND_MARKER_PREFIX}:%' AND inv.alert_kind <> ?))
        ORDER BY inv.done_at, inv.id
        LIMIT ${MID_BAND_SCAN_LIMIT}`,
    )
      .bind(markerKind)
      .all<CandidateRow>();
    candidates = results;
  } catch (err) {
    // A shard that predates the alert columns, or any read failure: no ask.
    // The mail stays held and the next sweep tries again — this runs on a
    // cron, so degrading to silence costs a cycle, never a message.
    console.error(`mid-band sweep degraded to none (${err instanceof Error ? err.message : err})`);
    return { asked: 0 };
  }

  // ---- pass 2: still held, still undecided -------------------------------
  // The invocation says what bouncer thought; the MAILBOX and the CHAIN say
  // what is true now. A human rescue, an approve, or a decline that landed
  // between the classify run and this sweep all disqualify the row — and the
  // chain test is what keeps a CONFIRMED shunt (declined: still sitting in
  // the same mailbox, deliberately) from being asked about a second time.
  const byAccount = new Map<string, HeldMessage[]>();
  for (const c of candidates) {
    const ctx = parseContext(c.context_json);
    const emailId = ctx.emailId ?? c.email_id;
    if (!ctx.accountId || !emailId) continue;
    const state = await holdState(env, ctx.accountId, emailId);
    if (!state.held || state.lastEvent !== "screened") continue;
    const list = byAccount.get(ctx.accountId) ?? [];
    list.push({
      emailId,
      sender: ctx.sender,
      subject: state.subject,
      stage: ctx.stage,
      receivedAt: state.receivedAt,
      note: c.note,
      invocationId: c.id,
      invocationAccountId: c.account_id,
    });
    byAccount.set(ctx.accountId, list);
  }

  let asked = 0;
  for (const [accountId, held] of byAccount) {
    const binding = bindingOf(candidates, held);
    if (await proposeOne(env, accountId, binding, held, now, periodKey, markerKind)) asked += 1;
  }
  return { asked };
}

/** The bouncer binding the batch's holds came from — the carrier invocation
 * has to name one, and every hold in a tenant comes from the same doorman. */
function bindingOf(candidates: CandidateRow[], held: HeldMessage[]): { id: string; name: string } {
  const first = candidates.find((c) => c.id === held[0]?.invocationId);
  return { id: first?.binding_id ?? "bouncer", name: first?.binding_name ?? "bouncer" };
}

/** One account's ask, or nothing. Returns whether a proposal was raised. */
async function proposeOne(
  env: Env,
  accountId: string,
  binding: { id: string; name: string },
  allHeld: HeldMessage[],
  now: number,
  periodKey: string,
  markerKind: string,
): Promise<boolean> {
  const overflow = Math.max(0, allHeld.length - MID_BAND_BATCH_MAX);
  const batch = allHeld.slice(0, MID_BAND_BATCH_MAX);

  // The mailbox the question is ABOUT, looked up before anything is written:
  // no held mailbox contradicts pass 2 (that is where "held" was measured), so
  // this is a race with a destroy rather than a state to invent a subject for.
  // Bailing here leaves the markers unwritten, and the next sweep re-asks.
  const mailboxId = await heldMailboxId(env, accountId);
  if (mailboxId === null) return false;

  // ---- the markers: mark once → ask once ---------------------------------
  // T9's guarded UPDATE, one per message. A row whose UPDATE changed nothing
  // was marked by a racing sweep (or claimed out from under us), so it drops
  // out of THIS proposal rather than being named in two — exactly one sweep
  // can win each message, and the proposal names precisely what it won.
  const marked: HeldMessage[] = [];
  for (const m of batch) {
    const res = await env.DB.prepare(
      `UPDATE agent_invocations SET alert_kind = ?, alert_at = ?
        WHERE account_id = ? AND id = ?
          AND (alert_kind IS NULL
               OR (alert_kind LIKE '${MID_BAND_MARKER_PREFIX}:%' AND alert_kind <> ?))`,
    )
      .bind(markerKind, now, m.invocationAccountId, m.invocationId, markerKind)
      .run();
    if (res.meta.changes === 1) marked.push(m);
  }
  if (marked.length === 0) return false;

  // ---- the proposal ------------------------------------------------------
  // Its own carrier invocation, `done` on arrival with cost 0 (no model was
  // called): a proposal's id IS its invocation's id, and the classify
  // invocations are already spoken for — they carry the markers.
  const carrierId = `inv_${crypto.randomUUID()}`;
  const emailIds = marked.map((m) => m.emailId);
  await env.DB.prepare(
    `INSERT INTO agent_invocations
       (id, account_id, binding_id, binding_name, status, context_json,
        created_at, claimed_at, done_at, cost_micros, result_json)
     VALUES (?, ?, ?, ?, 'done', ?, ?, ?, ?, 0, ?)`,
  )
    .bind(
      carrierId,
      accountId,
      binding.id,
      binding.name,
      JSON.stringify({ kind: MID_BAND_KIND, periodKey, heldCount: marked.length }),
      now,
      now,
      now,
      JSON.stringify({ kind: MID_BAND_KIND, periodKey, emailIds }),
    )
    .run();

  const payload = {
    periodKey,
    heldCount: marked.length,
    // THE EDITABLE FIELD, and the reason partial release needs no new verb:
    // approving with an edited `emailIds` releases exactly those and CONFIRMS
    // the rest of the batch (services/jmap actionProposal.ts). An edit may
    // only narrow — this proposal is about this batch.
    emailIds,
    messages: marked.map((m) => ({
      emailId: m.emailId,
      sender: m.sender,
      subject: m.subject,
      stage: m.stage,
      receivedAt: m.receivedAt,
      ...(m.note ? { note: m.note } : {}),
    })),
  };

  const senders = [...new Set(marked.map((m) => m.sender).filter((s) => s !== ""))];
  const plural = marked.length === 1 ? "" : "s";
  const notes = marked.map((m) => m.note).filter((n): n is string => n !== null);
  const degraded = notes.length;
  const degradedNote = notes[0] ?? "";
  await emitProposal(
    env,
    { id: carrierId, account_id: accountId },
    {
      kind: MID_BAND_KIND,
      // Tier 1: the application moves mail between two of the account's own
      // mailboxes. Nothing egresses, nothing is destroyed, and a release the
      // human regrets is a move back — reversible by construction, which is
      // what tier 1 means.
      tier: 1,
      subject: { realm: "Mailbox", objectId: mailboxId },
      payload,
      rationale:
        `The boundary held ${marked.length} message${plural} it could not classify — ` +
        `Bayes put ${marked.length === 1 ? "it" : "them"} in the mid-band and the classifier ` +
        `answered "unsure", so nothing has judged ${marked.length === 1 ? "it" : "them"} ` +
        `spam${senders.length > 0 ? ` (${senders.slice(0, 5).join(", ")}${senders.length > 5 ? ", …" : ""})` : ""}. ` +
        "Approving releases them to your Inbox and labels them ham for the filter; " +
        "declining confirms the shunt and labels them spam. To release only some, edit " +
        "`emailIds` before approving — the rest of the batch is confirmed. " +
        // Honesty about WHY it could not say: a model outage and a genuine
        // shrug both land here, and they are not the same fact about the mail.
        (degraded > 0
          ? `${
              degraded === marked.length
                ? "None of these got a real classifier verdict at all"
                : `${degraded} of these got no classifier verdict at all`
            } — ${degradedNote} — so that part of the hold is about our plumbing, not about the mail. `
          : "") +
        (overflow > 0
          ? `${overflow} more ${overflow === 1 ? "is" : "are"} held beyond this batch; the next sweep asks about ${overflow === 1 ? "it" : "them"}. `
          : "") +
        "Either answer clears this from your queue: what the doorman cannot decide is a " +
        "question, not a folder to go manage.",
      evidence: marked.map((m) => ({
        realm: "Email",
        objectId: m.emailId,
        note: `${m.sender || "(no envelope sender)"} — "${m.subject}" (held at ${m.stage})`,
      })),
      // The period IS the deadline, T9's discipline: an unanswered ask is
      // superseded by the next period's, which names the same still-held mail
      // plus anything new. Absolute, so it lands exactly on the boundary the
      // marker's period key turns over at.
      expiresAt: midBandPeriodEndMs(now),
    },
  );

  await commitChanges(env.ACCOUNT_DO, accountId, [
    { collection: "AgentInvocation", created: [carrierId], updated: [], destroyed: [] },
  ]);

  console.log(
    `mid-band: asked ${accountId} about ${marked.length} held message${plural} ` +
      `for ${periodKey} (proposal ${carrierId})`,
  );
  return true;
}

interface ParsedContext {
  accountId: string;
  emailId: string | null;
  sender: string;
  stage: string;
}

function parseContext(raw: string): ParsedContext {
  let ctx: Record<string, unknown> = {};
  try {
    ctx = JSON.parse(raw || "{}") as Record<string, unknown>;
  } catch {
    /* unreadable context: the row simply cannot be placed, and is skipped */
  }
  const s = (k: string) => (typeof ctx[k] === "string" ? (ctx[k] as string) : "");
  return {
    accountId: s("accountId"),
    emailId: s("emailId") || null,
    sender: s("sender"),
    stage: s("stage") || "bayes-mid",
  };
}

/**
 * Is this message still held, and has anything decided it since? The mailbox
 * answers the first (that is where "held" physically lives) and the LATEST
 * chain row answers the second: 'screened' is the only undecided state —
 * 'shunted' means a decision landed (the classifier's spam verdict, or a
 * human's decline), 'rescued'/'released' mean it left.
 */
async function holdState(
  env: Env,
  accountId: string,
  emailId: string,
): Promise<{
  held: boolean;
  lastEvent: string | null;
  subject: string;
  receivedAt: number | null;
}> {
  try {
    const row = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM email_mailboxes em
            JOIN mailboxes mb ON mb.account_id = em.account_id AND mb.id = em.mailbox_id
           WHERE em.account_id = ? AND em.email_id = ? AND mb.role = ?) AS held,
         (SELECT event FROM quarantine_events
           WHERE account_id = ? AND email_id = ? ORDER BY id DESC LIMIT 1) AS last_event,
         (SELECT subject FROM emails WHERE account_id = ? AND id = ?) AS subject,
         (SELECT received_at FROM emails WHERE account_id = ? AND id = ?) AS received_at`,
    )
      .bind(
        accountId,
        emailId,
        QUARANTINE_ROLE,
        accountId,
        emailId,
        accountId,
        emailId,
        accountId,
        emailId,
      )
      .first<{
        held: number;
        last_event: string | null;
        subject: string | null;
        received_at: number | null;
      }>();
    return {
      held: (row?.held ?? 0) > 0,
      lastEvent: row?.last_event ?? null,
      subject: row?.subject ?? "(no subject)",
      receivedAt: row?.received_at ?? null,
    };
  } catch (err) {
    console.error(
      `mid-band hold check failed for ${emailId}: ${err instanceof Error ? err.message : err}`,
    );
    return { held: false, lastEvent: null, subject: "", receivedAt: null };
  }
}

async function heldMailboxId(env: Env, accountId: string): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT id FROM mailboxes WHERE account_id = ? AND role = ?`)
    .bind(accountId, QUARANTINE_ROLE)
    .first<{ id: string }>();
  return row?.id ?? null;
}
