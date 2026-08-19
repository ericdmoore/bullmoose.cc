// EDIT IS APPROVAL, INLINE (s20 T6, readme principle 6) — the pure half.
//
// The sketch is redlined WHERE THE GOAL WAS EXPRESSED, and:
//
//   **an edit that leaves nothing unresolved IS the approval** — there is no
//   second "…and do you approve?" after a hand-edit;
//   **an edit that leaves open questions is the needsInfo cycle**, back to the
//   planner.
//
// Either way the SAME proposal, decision and provenance rows are written as if
// it had gone through the queue. That sentence is a claim about the DATA MODEL,
// and it is kept by doing nothing clever: this module decides which of the two
// ordinary `ActionProposal/set` verbs a redline is, and the caller sends that
// verb with the payload the queue would have sent. The venue moves; the ledger
// does not.
//
// Which is why the interesting logic here is one question — *is anything still
// open?* — and why it is answered from the redline itself rather than from a
// checkbox. Asking a person to classify their own edit ("was that a question or
// an approval?") is exactly the second dialog principle 6 is deleting.

import { contactAllowed } from "./contract";
import type { GoalContract, PlanPayload, SketchTask } from "./types";

/** One task, as the redline surface edits it. */
export interface RedlineRow {
  /** The plan-local key. Not editable: the harness rewrites keys to row ids,
   *  and renaming one would silently orphan another task's `needs`. */
  key: string;
  /** `outreach`, `summarize`, … — what this task DOES. */
  op: string;
  /** The recipient, for the tasks that write to somebody. Editable: fixing a
   *  wrong address is the single most common redline there is. */
  to: string;
  /** Plan-local keys this task waits on. */
  needs: string[];
  /** Struck through — "not this one". The other common redline. */
  dropped: boolean;
}

/** The verdict, and the one call that carries it. */
export interface RedlineDecision {
  /** Things that must be fixed before anything can be sent. Non-empty means
   *  no round trip: the server would only refuse, and it is cheaper to say so
   *  here than to spend an approval discovering it. */
  problems: string[];
  /** Which ordinary `ActionProposal/set` verb this redline is. */
  verb: "approve" | "needsInfo";
  /** Present for `needsInfo` — the human's question, verbatim. */
  question?: string;
  /** Present for `approve` ONLY when the redline actually changed something:
   *  "approved clean" and "approved after edit" are different outcomes with
   *  different meanings, and opening an editor must not move a row between
   *  them (the lib/approvals/edit.ts rule, applied to a workflow). */
  editedPayload?: Record<string, unknown>;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Read a planner's sketch into editable rows. Tolerant: a payload this cannot
 *  read yields no rows, and the caller shows the raw payload instead of
 *  pretending to have parsed it. */
export function sketchToRows(payload: PlanPayload | null | undefined): RedlineRow[] {
  const tasks = Array.isArray(payload?.tasks) ? (payload!.tasks as SketchTask[]) : [];
  return tasks.map((t) => {
    const ctx = (typeof t.context === "object" && t.context !== null ? t.context : {}) as Record<string, unknown>;
    return {
      key: str(t.key),
      op: str(ctx.op),
      to: str(ctx.to),
      needs: Array.isArray(t.needs) ? (t.needs as unknown[]).filter((n): n is string => typeof n === "string") : [],
      dropped: false,
    };
  });
}

/**
 * Rows back to a task list — the shape the server expands.
 *
 * Dropped tasks disappear, and so do `needs` that pointed at them: a join left
 * waiting on a task nobody will create is a node that blocks forever, and the
 * human who struck one message out did not mean to wedge the summary.
 */
export function rowsToTasks(rows: readonly RedlineRow[], original: PlanPayload | null | undefined): SketchTask[] {
  const kept = rows.filter((r) => !r.dropped);
  const live = new Set(kept.map((r) => r.key));
  const byKey = new Map<string, SketchTask>();
  if (Array.isArray(original?.tasks)) {
    for (const t of original!.tasks as SketchTask[]) if (typeof t.key === "string") byKey.set(t.key, t);
  }
  return kept.map((row) => {
    const source = byKey.get(row.key) ?? {};
    const ctx = (typeof source.context === "object" && source.context !== null ? source.context : {}) as Record<
      string,
      unknown
    >;
    return {
      // Everything the agent wrote rides through untouched except the two
      // fields this surface edits — the `editedPayload` discipline: a redline
      // amends, it does not re-author.
      ...source,
      key: row.key,
      needs: row.needs.filter((n) => live.has(n)),
      context: { ...ctx, ...(row.to ? { to: row.to } : {}) },
    };
  });
}

/** Did the redline change anything at all? */
export function rowsChanged(rows: readonly RedlineRow[], payload: PlanPayload | null | undefined): boolean {
  const before = sketchToRows(payload);
  if (before.length !== rows.length) return true;
  return rows.some((row, i) => {
    const was = before[i]!;
    return row.dropped || row.to !== was.to || row.key !== was.key;
  });
}

/**
 * THE DECISION. One question — is anything still open? — asked of the redline.
 *
 * `problems` are things the server would refuse, said here so an approval is
 * never spent discovering them: an empty plan, a task with no recipient, a
 * recipient outside the goal's contract. They are deliberately NOT open
 * questions: "you struck every task" is not something to ask the planner, it is
 * something to undo.
 *
 * A question the human typed makes it `needsInfo` — that IS the open question,
 * stated by the only party who knows what is missing — and everything else is
 * an approval, with or without an edit riding along.
 */
export function redlineDecision(o: {
  rows: readonly RedlineRow[];
  payload: PlanPayload | null | undefined;
  contract: GoalContract | null;
  /** What the human typed into the "still unclear?" box, if anything. */
  question?: string;
}): RedlineDecision {
  const problems: string[] = [];
  const kept = o.rows.filter((r) => !r.dropped);
  if (kept.length === 0) {
    problems.push("Every task is struck out — there would be no workflow left to approve.");
  }
  for (const row of kept) {
    if (row.op === "outreach" && !isAddress(row.to)) {
      problems.push(`“${row.key}” has no address to write to.`);
      continue;
    }
    if (row.to && o.contract && !contactAllowed(o.contract.may.contact, row.to)) {
      // The bound the server will re-check anyway. Said here because a person
      // who typed the wrong address deserves to hear it from the field they
      // typed it into, not from a failed approval a minute later.
      problems.push(`${row.to} is outside this goal’s contract — it may write to ${describeReach(o.contract)}.`);
    }
  }

  const question = (o.question ?? "").trim();
  if (question.length > 0) {
    // The needsInfo cycle: back to the planner, no decision recorded, and
    // deliberately no editedPayload — a question is not a verdict, and the
    // server refuses the combination for exactly that reason.
    return { problems, verb: "needsInfo", question };
  }

  const changed = rowsChanged(o.rows, o.payload);
  return {
    problems,
    verb: "approve",
    ...(changed
      ? {
          editedPayload: {
            ...(o.payload ?? {}),
            tasks: rowsToTasks(o.rows, o.payload),
          },
        }
      : {}),
  };
}

/** The button's own label, so the surface never grows a second confirm step. */
export function redlineActionLabel(decision: RedlineDecision): string {
  if (decision.verb === "needsInfo") return "Ask the planner";
  return decision.editedPayload ? "Approve these changes" : "Approve the plan";
}

/**
 * The sentence under the button. It has one job: say what the click DOES, so
 * "edit is approval" is a promise the surface makes out loud rather than a
 * behaviour a person discovers.
 */
export function redlineActionNote(decision: RedlineDecision): string {
  if (decision.verb === "needsInfo") {
    return "Your question goes back to the planner. Nothing is created, and the plan waits for its answer.";
  }
  if (decision.editedPayload) {
    return "Your edit IS the approval — the tasks below are created as you have them, and the planner's original is kept beside your version.";
  }
  return "The tasks below are created. Nothing is sent: every message they produce comes back to you as its own approval.";
}

function isAddress(value: string): boolean {
  const s = value.trim();
  const at = s.indexOf("@");
  return at > 0 && at < s.length - 1 && !/\s/.test(s);
}

function describeReach(contract: GoalContract): string {
  return contract.may.contact.length > 0 ? contract.may.contact.join(", ") : "nobody yet";
}
