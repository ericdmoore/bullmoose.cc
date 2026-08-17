// The queue's clocks and its order — pure functions, because the two-clock
// rule is exactly the kind of thing that must live in tested .ts rather than
// in an island (vitest is `environment: "node"`, no jsdom; the s03.C split).
//
// Every row in the queue carries TWO opposed marks (s07 devPlan §T0/§T4):
//
//   waited for   how long this has sat on the HUMAN. Starts at zero and
//                GROWS. Shames the human.
//   expires in   `expiresAt − now`, the pre-decision deadline. SHRINKS.
//                Shames the clock. Past zero, the agent worker's sweep flips
//                the row `pending`→`expired` (services/agent/src/proposals.ts:153).
//
// And one that is NEITHER of those: `holdUntil` is the tier-2 POST-approval
// retraction window (arch.md §2) — how long an already-approved action can
// still be yanked before it commits. The devPlan calls conflating it with
// `expiresAt` "a genuine bug" (s07 §T0), so this module never lets the two
// meet: `rowClocks` sources `expiresIn` from `expiresAt` alone and
// `holdRemaining` from `holdUntil` alone, gated on status, and the tests hold
// a row carrying both to that.
//
// s11 T1 adds a THIRD, `dueAt` — the WORK's own business deadline, inferred
// at the boundary and correctable on the row (`dueLabel` / `dueInputValue` /
// `dueFromInput` below). Same discipline, now three ways: the due clock is
// sourced from `dueAt` alone and its wording names "the work", never the
// decision.

import type { ActionProposal } from "./types";

/** Under an hour left to decide → the row renders urgent. */
export const NEAR_EXPIRY_MS = 60 * 60_000;

/** What each row's clock strip shows. `null` = that clock does not apply. */
export interface RowClocks {
  /** Grows while undecided; frozen at `decidedAt` once a decision landed. */
  waitedMs: number;
  /** Pending only — the decision deadline. Negative = past it, sweep due. */
  expiresInMs: number | null;
  /** Held only — the retraction window. Negative = closed (commit is s03.D T2). */
  holdRemainingMs: number | null;
}

/**
 * How long the proposal has sat (or sat, past tense) on the human. For a
 * decided row the clock froze at `decidedAt` — history must not keep accruing
 * shame for a decision already made. An `expired` row never got a decision
 * (the sweep writes no `decidedAt`, proposals.ts:163-168), but it stopped
 * sitting on the human at its deadline, so it freezes at `expiresAt`.
 */
export function waitedForMs(
  p: Pick<ActionProposal, "createdAt" | "decidedAt" | "status" | "expiresAt">,
  now: number,
): number {
  const created = Date.parse(p.createdAt);
  if (!Number.isFinite(created)) return 0;
  const frozenAt =
    p.decidedAt !== null
      ? Date.parse(p.decidedAt)
      : p.status === "expired" && p.expiresAt !== null
        ? Date.parse(p.expiresAt)
        : now;
  return Math.max(0, (Number.isFinite(frozenAt) ? frozenAt : now) - created);
}

export function rowClocks(p: ActionProposal, now: number): RowClocks {
  const expiresAt = p.expiresAt !== null ? Date.parse(p.expiresAt) : NaN;
  const holdUntil = p.holdUntil !== null ? Date.parse(p.holdUntil) : NaN;
  return {
    waitedMs: waitedForMs(p, now),
    // The decision deadline only governs an undecided row. On held/decided
    // rows it is moot — and rendering it there is how the two clocks get
    // conflated, so it is null rather than merely unstyled.
    expiresInMs: p.status === "pending" && Number.isFinite(expiresAt) ? expiresAt - now : null,
    holdRemainingMs: p.status === "held" && Number.isFinite(holdUntil) ? holdUntil - now : null,
  };
}

export function isNearExpiry(clocks: RowClocks): boolean {
  return clocks.expiresInMs !== null && clocks.expiresInMs < NEAR_EXPIRY_MS;
}

/**
 * Compact duration for the clock strip. Coarse when there is slack, seconds
 * when the interval is short enough that a person watching should see it move
 * — which is also what makes "the clocks run opposite ways" observable in a
 * browser rather than only in this file's tests.
 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(Math.abs(ms) / 1000));
  const d = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m >= 10) return `${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** The growing mark. Present tense while it still sits on the human. */
export function waitedLabel(p: Pick<ActionProposal, "status">, clocks: RowClocks): string {
  return p.status === "pending"
    ? `waiting on you ${formatDuration(clocks.waitedMs)}`
    : `sat with you ${formatDuration(clocks.waitedMs)}`;
}

/** The shrinking mark. Null in, honest "no deadline" out — never invented. */
export function expiryLabel(expiresInMs: number | null): string {
  if (expiresInMs === null) return "no deadline";
  if (expiresInMs <= 0) {
    // Still pending: the sweep runs on the agent worker's scheduled hook, so
    // between the deadline and the sweep the row is decidable but overdue.
    return `decision window passed ${formatDuration(-expiresInMs)} ago`;
  }
  return `expires in ${formatDuration(expiresInMs)}`;
}

/**
 * The THIRD clock (s11 T1): the WORK's own deadline, worded so it can never
 * be read as either of the other two — "the work" is due, not the decision
 * ("expires in") and not the retraction window ("retraction window ends").
 * Null in, honest "no due date" out: NULL means never-urgent, and inventing
 * urgency is exactly the mis-read the correctable surface exists to catch.
 */
export function dueLabel(dueAt: string | null, now: number): string {
  if (dueAt === null) return "no due date";
  const due = Date.parse(dueAt);
  if (!Number.isFinite(due)) return "no due date";
  return due - now >= 0 ? `work due in ${formatDuration(due - now)}` : `work was due ${formatDuration(now - due)} ago`;
}

/**
 * ISO instant → `<input type="datetime-local">` value (the viewer's LOCAL
 * wall time, minute precision) — and back. The pair round-trips the instant
 * in any host timezone, which is what the test holds them to; the human sees
 * and edits local time, the server only ever receives the ISO instant.
 */
export function dueInputValue(dueAt: string | null): string {
  const ms = dueAt !== null ? Date.parse(dueAt) : NaN;
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Empty or unparseable input reads as "clear the deadline" (→ null). */
export function dueFromInput(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const ms = new Date(trimmed).getTime(); // datetime-local parses as LOCAL time
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * The tier-2 retraction window, worded so it cannot be read as egress: while
 * the window runs nothing has been sent, and when it lapses the commit STILL
 * has not happened — committing out of the hold tray is s03.D T2 and is not
 * built (actionProposal.ts:41-42, 268-271).
 */
export function holdLabel(holdRemainingMs: number | null): string {
  if (holdRemainingMs === null) return "";
  if (holdRemainingMs <= 0) {
    return "retraction window lapsed — still not sent; committing out of the hold tray is not built yet (s03.D T2)";
  }
  return `retraction window ends in ${formatDuration(holdRemainingMs)} — nothing has been sent`;
}

/**
 * The queue order — "ordered by urgency, pending first" (s07 §T4).
 *
 *   1. `pending`, soonest deadline first (no deadline sorts last), then the
 *      longest-waiting — both clocks agree on who goes on top.
 *   2. `info-requested` (s10 T3), oldest ask first: waiting on the AGENT, not
 *      on the human — watchable, not decidable, and its deadline is paused so
 *      there is no expiry clock to order by.
 *   3. `held`, soonest-closing retraction window first: still watchable, not
 *      still decidable.
 *   4. history (approved / rejected / expired), newest decision first.
 *
 * Pure and stable so the island never re-sorts in markup; `clocks.test.ts`
 * owns the tie-breaks.
 */
export function orderQueue(proposals: readonly ActionProposal[]): ActionProposal[] {
  const rank = (p: ActionProposal): number =>
    p.status === "pending" ? 0 : p.status === "info-requested" ? 1 : p.status === "held" ? 2 : 3;
  const time = (iso: string | null, absent: number): number => {
    const t = iso !== null ? Date.parse(iso) : NaN;
    return Number.isFinite(t) ? t : absent;
  };
  return [...proposals].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    if (a.status === "pending") {
      const byDeadline = time(a.expiresAt, Infinity) - time(b.expiresAt, Infinity);
      if (byDeadline !== 0) return byDeadline;
      const byAge = time(a.createdAt, 0) - time(b.createdAt, 0);
      if (byAge !== 0) return byAge;
    } else if (a.status === "info-requested") {
      // Oldest ask first — the longest-owed answer surfaces on top.
      const byAge = time(a.createdAt, 0) - time(b.createdAt, 0);
      if (byAge !== 0) return byAge;
    } else if (a.status === "held") {
      const byWindow = time(a.holdUntil, Infinity) - time(b.holdUntil, Infinity);
      if (byWindow !== 0) return byWindow;
    } else {
      const byDecided = time(b.decidedAt, 0) - time(a.decidedAt, 0);
      if (byDecided !== 0) return byDecided;
    }
    return a.id.localeCompare(b.id);
  });
}
