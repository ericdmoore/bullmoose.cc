// needsInfo — the third verb (s10 T3, decline-taxonomy.md), pure rules only,
// the same split as clocks.ts / edit.ts / rows.ts: the island stays markup.
//
// What it encodes, verbatim from the taxonomy: "I'm not ardently opposed — but
// it's pushing against some principle I'm holding. Help me better understand
// why exactly you need to do XYZ." It is an ACTION, not a reject: it carries a
// required human question, moves the row `pending` → `info-requested` (out of
// the human's queue, into the agent's court, decision clock PAUSED), and the
// agent's answer appends a Q&A round and returns the row to `pending`. One
// round per human action — the loop is human-paced by construction.

import type { ActionProposal, ProposalAmendment } from "./types";

// ── availability + validation ─────────────────────────────────────────────

/** The verb exists on pending rows only — everywhere reject is offered. */
export function needsInfoAvailable(p: Pick<ActionProposal, "status">): boolean {
  return p.status === "pending";
}

/**
 * The question is REQUIRED and human-authored — the server refuses an empty
 * one (actionProposal.ts), and refusing locally keeps the refusal a keystroke
 * away instead of a round trip (the applyEdit pattern).
 */
export function questionProblem(question: string): string | null {
  return question.trim().length === 0
    ? "A question is required — needsInfo asks the agent to justify, and an empty ask is a decline in disguise."
    : null;
}

// ── the dialogue ──────────────────────────────────────────────────────────

/**
 * The open (unanswered) round, if any. On an `info-requested` row this is what
 * the agent owes an answer to; the server also mirrors it in `question`, but
 * the amendments list is the durable record so it is the source read here.
 */
export function openQuestion(
  p: Pick<ActionProposal, "question" | "amendments">,
): ProposalAmendment | null {
  const last = p.amendments[p.amendments.length - 1];
  return last && last.answer === null ? last : null;
}

/** The answered rounds — the Q&A dialogue a row renders under its rationale. */
export function answeredRounds(p: Pick<ActionProposal, "amendments">): ProposalAmendment[] {
  return p.amendments.filter((a) => a.answer !== null);
}

// ── wording (the surface is the contract, rows.ts precedent) ──────────────

/** Button label — a question, not a verdict. */
export const NEEDS_INFO_VERB = "Needs info";

/** The hint under the question input: why this verb exists at all. */
export const NEEDS_INFO_HINT =
  "Not a decline: the agent answers your question and the proposal returns to " +
  "the queue with the dialogue attached. The decision deadline pauses while " +
  "the ball is in the agent's court.";

/** The waiting state an `info-requested` row renders instead of clocks. */
export const WAITING_ON_AGENT_NOTE =
  "waiting on the agent to answer — the decision clock is paused";
