// s20 T6 — the Goal projection, as `Goal/get` returns it.
//
// Every field below is either AUTHORED (the sentence, the contract, the two
// judgments) or DERIVED on the server from the goal's own nodes and proposals.
// Nothing is mirrored: a goal's id IS its Job's id, so there is no second store
// to keep in sync and no client-side arithmetic that could disagree with it.

/** The delegation primitive: may / may not / escalate when / done when. */
export interface GoalContract {
  may: { tools: string[]; contact: string[] };
  /** Prohibitions in the human's own words — read at every checkpoint, never
   *  compiled into a deny-list the system cannot actually evaluate. */
  mayNot: string[];
  escalateWhen: { afterMs: number; note?: string } | null;
  doneWhen: string;
  /** The aggregate the goal may SPEND. Not "the money you may promise". */
  budgetUsd: number | null;
}

export type CheckpointClass = "plan" | "email" | "summary";

export interface CheckpointView {
  mode: "manual" | "auto";
  /** False when nothing enforces this class yet — the honesty flag that keeps
   *  a toggle from rendering as autonomy it does not have. */
  graduable: boolean;
  by?: string;
  at?: number;
}

/** One proposal, as a milestone on the goal's timeline. */
export interface Milestone {
  proposalId: string;
  kind: string;
  checkpointClass: CheckpointClass | null;
  status: string;
  createdAt: number;
  decidedAt: number | null;
  summary: string;
}

export type GoalStatus =
  | "cancelled"
  | "awaiting-plan"
  | "accepted"
  | "pending"
  | "running"
  | "paused"
  | "stalled"
  | "done";

export interface Goal {
  id: string;
  statement: string;
  contract: GoalContract | null;
  /** False when the stored contract cannot be parsed — every node under it
   *  will refuse to act, so the screen says so rather than showing blanks. */
  contractReadable: boolean;
  checkpoints: Record<CheckpointClass, CheckpointView>;
  status: GoalStatus;
  createdBy: string;
  createdAt: number;
  cancelledAt: number | null;
  cancelledBy: string | null;
  acceptedAt: number | null;
  acceptedBy: string | null;
  escalationWatchId: string | null;
  budgetMicros: number | null;
  maxNodes: number | null;
  spentMicros: number;
  progress: { total: number; pending: number; running: number; done: number; failed: number };
  milestones: Milestone[];
}

/** One task of a planner's sketch, as it rides the `goal-plan` payload. */
export interface SketchTask {
  key?: unknown;
  needs?: unknown;
  budgetMicros?: unknown;
  context?: unknown;
}

/** The `goal-plan` proposal's payload — the thing the human redlines. */
export interface PlanPayload {
  goalId?: unknown;
  statement?: unknown;
  contract?: unknown;
  tasks?: unknown;
}
