// What the goal view SAYS (s20 T6) — the wording, as tested rules.
//
// The screen has one job the rest of the product does not: it renders standing
// authority. Approvals asks "what needs me now?"; a goal is the thing that will
// keep acting in your name after you close the tab. So every sentence here is
// written to answer the two questions that make that safe —
//
//   what did I hand over? (the contract, verbatim, at the top)
//   which checkpoints still stop for me? (per class, with why)
//
// — because **silently-widening autonomy is the one failure the whole product
// exists to prevent**, and the only way a widening stays un-silent is if the
// un-widened state is legible in the first place.

import type { CheckpointClass, CheckpointView, Goal, GoalStatus, Milestone } from "./types";

/** The sub-line under the page title. */
export const GOALS_SUB =
  "A goal is a delegation contract: a sentence you want to be true, the bounds you set on pursuing it, " +
  "and a workflow whose plan you approve before anything runs.";

/** Said on an empty roster — an empty screen that explains itself. */
export const GOALS_EMPTY =
  "No goals yet. A goal is worth stating when the work is more than one message and you want it bounded: " +
  "state what you want to be true, who it may write to, and what done looks like.";

/** Status, as a person reads it. The two authored verdicts read differently
 *  from the derived ones on purpose — somebody DECIDED those. */
export function statusLabel(status: GoalStatus): string {
  switch (status) {
    case "awaiting-plan":
      return "Plan awaiting your approval";
    case "cancelled":
      return "Cancelled";
    case "accepted":
      return "Done — you accepted it";
    case "stalled":
      return "Stalled";
    case "paused":
      return "Waiting on your answer";
    case "running":
      return "Running";
    case "done":
      return "Every task finished";
    default:
      return "Not started";
  }
}

/**
 * The sentence beside the status, and the one place the difference between
 * "every task finished" and "done" is spelled out.
 *
 * A Job's status can say the work ran. It cannot say whether three structural
 * engineers are WILLING, because done-when is a sentence and reading it is a
 * person's job — so a goal whose tasks are all finished is offered for
 * acceptance rather than declared complete.
 */
export function statusNote(goal: Goal): string {
  switch (goal.status) {
    case "awaiting-plan":
      return "Nothing has been created yet. The planner has proposed how it would work; approving that plan is what starts it.";
    case "cancelled":
      return `Cancelled by ${goal.cancelledBy ?? "someone"} — the standing authority is revoked and pending tasks were stopped.`;
    case "accepted":
      return `${goal.acceptedBy ?? "You"} judged the done-when clause met: “${goal.contract?.doneWhen ?? ""}”.`;
    case "stalled":
      return "Something failed and nothing left can run. The milestones below say where it stopped.";
    case "done":
      return `Every task finished. Whether that MEETS “${goal.contract?.doneWhen ?? "done"}” is yours to say — the summary approval is where you say it.`;
    default:
      return "";
  }
}

/** Progress, counted from the nodes — never a stored percentage. */
export function progressLine(goal: Goal): string {
  const p = goal.progress;
  if (p.total === 0) return "No tasks yet.";
  const bits = [`${p.done} of ${p.total} done`];
  if (p.running > 0) bits.push(`${p.running} running`);
  if (p.pending > 0) bits.push(`${p.pending} waiting`);
  if (p.failed > 0) bits.push(`${p.failed} failed`);
  return bits.join(" · ");
}

/**
 * THE CHECKPOINT LINE — the sentence this whole screen exists for.
 *
 * Three states, and the third is the one that keeps the surface honest. A class
 * shown as "manual" with no explanation reads as an unfinished setting, and a
 * person who flips it and sees nothing happen learns that the controls here are
 * decorative. Saying "and nothing wires auto yet" is the difference between a
 * product that is unfinished and one that is untrustworthy.
 */
export function checkpointLine(cls: CheckpointClass, view: CheckpointView): string {
  const what = CLASS_NAMES[cls];
  if (view.mode === "auto") {
    return `${what}: automatic${view.by ? ` — graduated by ${view.by}` : ""}. This class no longer stops for you.`;
  }
  if (!view.graduable) {
    return `${what}: stops for you every time — and it cannot graduate yet, because nothing enforces an automatic ${cls} checkpoint. Every message still leaves through your approvals.`;
  }
  return `${what}: stops for you every time.`;
}

const CLASS_NAMES: Record<CheckpointClass, string> = {
  plan: "The plan",
  email: "Each message",
  summary: "The final summary",
};

/** A milestone, as one line of the timeline. */
export function milestoneLine(m: Milestone): string {
  const what =
    m.kind === "goal-plan"
      ? "the plan"
      : m.kind === "goal-outreach"
        ? "a message"
        : m.kind === "goal-summary"
          ? "the summary"
          : m.kind;
  const verdict =
    m.status === "pending"
      ? "waiting on you"
      : m.status === "approved"
        ? "approved"
        : m.status === "rejected"
          ? "declined"
          : m.status === "info-requested"
            ? "you asked a question"
            : m.status;
  return `${what} — ${verdict}`;
}

/**
 * The goal's timeline is its proposals, time-ordered. Derived on the server and
 * merely ORDERED here: never store what can be derived, and never keep a second
 * event log of the same decisions — two logs of one thing is one log and one
 * liability.
 */
export function orderMilestones(milestones: readonly Milestone[]): Milestone[] {
  return [...milestones].sort((a, b) => a.createdAt - b.createdAt);
}

/** Which goals are still live, newest first — the default reading order. */
export function orderGoals(goals: readonly Goal[]): Goal[] {
  const rank = (g: Goal) => (g.status === "cancelled" || g.status === "accepted" ? 1 : 0);
  return [...goals].sort((a, b) => rank(a) - rank(b) || b.createdAt - a.createdAt);
}

/** The open plan checkpoint on a goal, if there is one — what the redline
 *  surface renders. At most one can be open at a time per planner node. */
export function openPlanCheckpoint(goal: Goal): Milestone | undefined {
  return goal.milestones.find((m) => m.kind === "goal-plan" && m.status === "pending");
}
