// Which rung of s36's ladder an invocation stopped on.
//
// ## Why this reads the NOTE, and why that is the only door there is
//
// A skip is not a status. `services/agent/src/extract.ts` ends a pre-filtered
// message with `done("done", { note: "no extraction cues — skipped, no model
// call" })` — status `done`, cost absent, and the ONLY thing separating it from
// a run that made a real model call is the sentence. `agent_invocations` has no
// `outcome` column and never has, because until now nothing needed to tell the
// two apart: the drain does not care, and the queue does not care.
//
// The receipt cares, because the skip rate IS the ladder's economics. So this
// module classifies on the note, and does it in the direction that cannot
// flatter the feature:
//
//   an unrecognised note is a RUN, never a skip.
//
// Getting it wrong that way understates how much the pre-filter saves. Getting
// it wrong the other way would invent savings that did not happen, and the
// number would be quoted in a design decision later. One of those errors is
// recoverable and the other is not.
//
// ⚠️ MIRRORS the note wording written by `services/agent/src/*.ts` (extract.ts
// 269/274/283/326, index.ts 732/737/813, remind.ts 112/127, ledger.ts 70). The
// markers below are matched loosely — a family of phrasings, not a literal set
// — precisely so a reworded skip degrades to "ran" instead of to a crash.

import type { LadderRung } from "./types";

/**
 * A run that ended before ANY model was called: the deterministic pre-filter,
 * the bulk-mail header check, the sender gate, the retry-idempotence guard.
 * All free, all rung 1 or below.
 */
const NO_MODEL_CALL: readonly RegExp[] = [/\bno model call\b/i, /^\s*skipped\b/i, /\balready extracted\b/i] as const;

/**
 * A run a CHEAP model ended before the expensive one ran — s26 T3 v2's scout.
 * Deliberately not folded into `skipped`: a model call happened and its cost
 * was stamped (0 on a free runtime, which is a recorded number, not a missing
 * one). Calling it a skip would misreport both the ladder and the money.
 */
const CHEAP_SCREEN: readonly RegExp[] = [/\bno paid call\b/i, /^\s*scouted\b/i] as const;

export interface ClassifiableInvocation {
  status: string;
  note: string | null;
}

/**
 * One invocation → one rung.
 *
 * Order matters: status decides first (a `failed` row carrying a skip-shaped
 * note failed, whatever it says), then the cheap-screen markers, then the
 * no-model-call markers, then the default.
 */
export function classifyInvocation(inv: ClassifiableInvocation): LadderRung {
  if (inv.status === "pending" || inv.status === "running") return "inflight";
  if (inv.status === "failed") return "failed";
  const note = inv.note ?? "";
  if (CHEAP_SCREEN.some((re) => re.test(note))) return "screened";
  if (NO_MODEL_CALL.some((re) => re.test(note))) return "skipped";
  // `done` with an unrecognised note, and any status this build has not met.
  // Both count as work that happened — see the header.
  return "ran";
}

/** The rung's name, and the one clause that says what it MEANS about money. */
export function rungLabel(rung: LadderRung): string {
  switch (rung) {
    case "skipped":
      return "skipped — no model call";
    case "screened":
      return "screened out by a free model";
    case "ran":
      return "ran a model";
    case "failed":
      return "failed";
    case "inflight":
      return "still in flight";
  }
}

/**
 * The share of finished work the pre-filter took for free — the one number
 * s36's economics argument stands on.
 *
 * In-flight rows are excluded from the denominator on purpose: a run that has
 * not finished has not chosen a rung yet, and counting it as "not skipped"
 * would make the rate sag every time the queue is busy. Null, not 0, when
 * nothing finished — an empty window has no rate.
 */
export function skipShare(counts: Record<LadderRung, number>): number | null {
  const finished = counts.skipped + counts.screened + counts.ran + counts.failed;
  if (finished === 0) return null;
  return ((counts.skipped + counts.screened) / finished) * 100;
}
