import {
  GOAL_OUTREACH_KIND,
  GOAL_PLAN_KIND,
  GOAL_SUMMARY_KIND,
  contractRefusals,
  defaultCheckpoints,
  describeRefusals,
  parseGoalContract,
  sketchFromContract,
  type CheckpointClass,
  type CheckpointPolicy,
  type ContractTask,
  type GoalContract,
  type JobNodeRow,
  type Refusal,
} from "@bullmoose/scheduling";
import { emitProposal } from "./proposals.js";
import type { Env } from "./models.js";

/**
 * s20 T6 — GOALS: the agent-side half of the delegation contract.
 *
 * The apex of the agent-native arc, and it adds almost no machinery — which is
 * the claim. Verbs are atoms; an intent is a sentence; a **Goal is standing
 * authority**: a sentence with done-ness, a contract, and a workflow that stops
 * for a human at named checkpoints. Everything under it already ran before this
 * file existed (s11 T7's jobs DAG, planner node, monotonic attenuation,
 * aggregate budgets). What T6 adds is a CHECKPOINT on top of that substrate.
 *
 * ── THE NEW CLASS OF APPROVAL ──────────────────────────────────────────────
 * Every approval shipped so far gates EGRESS: may this leave the building?
 * This one gates EXECUTION: may these tasks exist at all? The planner already
 * emits a task list; `planCheckpoint` below intercepts output that already
 * exists and lands it as a proposal whose payload IS that list. Approve → the
 * tasks are created (`ActionProposal/set`, `case "goal-plan"`), through the
 * same `expandPlanRows` a planner's own output goes through, so an approved
 * plan and an auto-expanded one are the same rows created by the same code.
 *
 * Cheap by construction, and TIER 1 on purpose: creating pending task rows
 * egresses nothing (a side-effectful leaf still exits via /approvals — a Job
 * reorganizes work, never its egress), and the undo handle names a call that
 * really exists — `Goal/set { status: "cancelled" }` stops every pending node.
 *
 * ── WHAT THIS FILE DELIBERATELY DOES NOT DO ────────────────────────────────
 * No model calls. The planner's decomposition is still the fixed plan s11 T7
 * carries in `context.plan`, and an outreach node's body is a deterministic
 * template. That is the same honesty `jobNode.ts` already states: what is being
 * proven here is that a decomposition CANNOT ESCAPE ITS CONTRACT, and a model
 * in the loop would prove nothing about that while making every test a
 * fixture. The day a model writes the plan, the attenuation chain, the caps,
 * the aggregate budget and this checkpoint are already the things standing
 * between it and the household.
 */

/** The `goals` row, as this worker reads it. */
export interface GoalRow {
  id: string;
  account_id: string;
  statement: string;
  contract_json: string;
  checkpoints_json: string;
  cancelled_at: number | null;
  accepted_at: number | null;
}

/** A goal, parsed. `contract` is null when the stored blob cannot be read. */
export interface Goal {
  row: GoalRow;
  contract: GoalContract | null;
  checkpoints: CheckpointPolicy;
}

/**
 * Read the Goal a node belongs to, or null when the node's Job has none.
 *
 * NULL IS THE DEFAULTCASE, and it is load-bearing: every Job created before
 * T6 (and every Job a test or a future caller starts directly) has no `goals`
 * row, and those planners must keep expanding exactly as they did. A Goal is
 * a FACE over a Job; a Job without one is not broken, it is unnamed.
 *
 * Fail-open on a missing TABLE (a shard that has not run `goals-table`), for
 * the `watches.ts` reason: the alternative is every planner in the fleet
 * failing on a migration that was never a deploy blocker.
 */
export async function getGoal(env: Env, accountId: string, jobId: string): Promise<Goal | null> {
  let row: GoalRow | null = null;
  try {
    row = await env.DB.prepare(
      `SELECT id, account_id, statement, contract_json, checkpoints_json, cancelled_at, accepted_at
         FROM goals WHERE account_id = ? AND id = ?`,
    )
      .bind(accountId, jobId)
      .first<GoalRow>();
  } catch (err) {
    console.warn(`goals: cannot read the goals table (${err instanceof Error ? err.message : String(err)})`);
    return null;
  }
  if (!row) return null;
  const parsed = parseGoalContract(safeParse(row.contract_json));
  return {
    row,
    contract: parsed.ok ? parsed.contract : null,
    checkpoints: readCheckpoints(row.checkpoints_json),
  };
}

/**
 * Read the checkpoint policy, tolerantly and CONSERVATIVELY: anything this
 * cannot parse reads as `manual`.
 *
 * The asymmetry is the whole point. Everywhere else in this codebase a
 * malformed blob degrades to "no constraint"; here it degrades to "stop and
 * ask", because the failure modes are not symmetrical — a corrupt policy that
 * read as `auto` would silently widen autonomy on the strength of a JSON parse
 * error, and silently-widening autonomy is the one failure the whole product
 * exists to prevent.
 */
export function readCheckpoints(raw: string | null | undefined): CheckpointPolicy {
  const out = defaultCheckpoints();
  const parsed = safeParse(raw ?? "");
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return out;
  for (const cls of Object.keys(out) as CheckpointClass[]) {
    const v = (parsed as Record<string, unknown>)[cls];
    if (typeof v !== "object" || v === null || Array.isArray(v)) continue;
    const setting = v as Record<string, unknown>;
    if (setting.mode !== "auto") continue;
    out[cls] = {
      mode: "auto",
      ...(typeof setting.by === "string" ? { by: setting.by } : {}),
      ...(typeof setting.at === "number" ? { at: setting.at } : {}),
    };
  }
  return out;
}

/** What the planner should do with its decomposition. */
export type PlanGate =
  /** Expand it now — no goal, or the `plan` class has graduated. */
  | { checkpoint: false; goal: Goal | null }
  /** Land it as a proposal first. */
  | { checkpoint: true; goal: Goal }
  /** Refuse: the goal is cancelled, or its contract cannot be read. */
  | { checkpoint: "refuse"; why: string };

/**
 * THE PLAN-APPROVAL DECISION, in one place.
 *
 * Three answers, and the order matters: a cancelled goal refuses before
 * anything else looks at a checkpoint, because a revoked delegation must not
 * be able to produce work OR a proposal asking to.
 */
export async function planCheckpoint(env: Env, node: JobNodeRow): Promise<PlanGate> {
  if (!node.job_id) return { checkpoint: false, goal: null };
  const goal = await getGoal(env, node.account_id, node.job_id);
  if (!goal) return { checkpoint: false, goal: null };
  if (goal.row.cancelled_at) {
    return { checkpoint: "refuse", why: "the goal was cancelled — its standing authority is revoked" };
  }
  if (!goal.contract) {
    // An unreadable contract is an UNKNOWN bound, and an unknown bound is not
    // a permissive one (the `effectiveNodeAuthority` rule, one level up).
    return { checkpoint: "refuse", why: "the goal's contract cannot be read, so its bounds are unknown" };
  }
  return goal.checkpoints.plan.mode === "auto" ? { checkpoint: false, goal } : { checkpoint: true, goal };
}

/**
 * The contract's refusals over a sketch, as a PRE-FLIGHT.
 *
 * Run at emit time so a human is never shown a plan that could not run if they
 * approved it — the same courtesy `expandPlan` extends by refusing an
 * amplifying plan outright rather than truncating it. It is NOT the
 * enforcement: that runs again inside `ActionProposal/set`, over whatever the
 * human's redline actually says, because an edit is exactly as untrusted as
 * the model output it edits.
 */
export function sketchRefusals(contract: GoalContract, tasks: readonly ContractTask[]): Refusal[] {
  return contractRefusals(contract, tasks);
}

/**
 * THE DECOMPOSITION THIS PLANNER WILL PROPOSE.
 *
 * A planner node that was handed a fixed plan uses it (s11 T7's shape, and
 * every existing Job keeps working). A goal's planner that was handed none
 * derives one from its contract — the reach the human granted, one message
 * each, and a join that compiles the answers.
 *
 * Resolved HERE rather than at goal-creation time on purpose: s11 T7's
 * progressive revelation says the plan is produced at runtime, inside the
 * work, and is treated as untrusted data on the way back regardless of who
 * wrote it. Deriving it in `Goal/set` would have made the plan front matter
 * and quietly retired that property — and it is the property that makes the
 * arrival of a model-written planner a one-line change.
 */
export function resolvePlan(raw: unknown, goal: Goal | null): unknown {
  const tasks = (raw as { tasks?: unknown } | null)?.tasks;
  if (Array.isArray(tasks) && tasks.length > 0) return raw;
  if (goal?.contract) return sketchFromContract(goal.contract);
  return raw;
}

/**
 * LAND THE SKETCH AS A PROPOSAL — the plan-approval checkpoint's emit side.
 *
 * The payload is the task list, verbatim, because the payload is the thing the
 * human redlines: `editedPayload` on the approve verb carries their version
 * beside the agent's retained original, which is the highest-signal feedback
 * this system collects (s07 §T4) and, here, the literal diff between the
 * workflow the agent proposed and the workflow the human authorized.
 *
 * The contract rides along so the checkpoint can be READ where it is decided —
 * "may not commit to a date" is prose the human has to see at the moment they
 * are handing over authority, not a setting buried on another screen.
 */
export async function proposePlan(env: Env, node: JobNodeRow, goal: Goal, tasks: readonly unknown[]): Promise<string> {
  const contract = goal.contract!;
  return emitProposal(
    env,
    { id: node.id, account_id: node.account_id },
    {
      kind: GOAL_PLAN_KIND,
      // Tier 1: creating pending task rows egresses nothing, and the undo is a
      // call that exists (`Goal/set { status: "cancelled" }`). The EMAILS the
      // plan describes keep their own tier when they are eventually proposed —
      // approving a workflow is not approving its egress, and this checkpoint
      // deliberately does not pretend otherwise.
      tier: 1,
      subject: { realm: "Goal", objectId: goal.row.id },
      payload: {
        goalId: goal.row.id,
        statement: goal.row.statement,
        contract,
        tasks,
      },
      rationale: planRationale(goal, tasks.length),
      evidence: [{ realm: "Goal", objectId: goal.row.id, note: goal.row.statement }],
    },
  );
}

/** The sentence the checkpoint argues with. Says the size of the ask and the
 *  bound it runs under, because "approve this workflow" with neither is a
 *  question nobody can answer. */
export function planRationale(goal: Goal, taskCount: number): string {
  const c = goal.contract;
  const bound = c?.budgetUsd === null || c === null ? "no aggregate spend bound" : `a $${c.budgetUsd} bound`;
  const reach = c && c.may.contact.length > 0 ? `may write to ${c.may.contact.join(", ")}` : "may write to nobody yet";
  return (
    `To "${goal.row.statement}" I would run ${taskCount} task${taskCount === 1 ? "" : "s"}, under ${bound}; ` +
    `it ${reach}. Done when: ${c?.doneWhen ?? "(unstated)"}. Approving creates the tasks; ` +
    "nothing is sent — every message this produces comes back to you as its own approval."
  );
}

// ---- the two goal-shaped node ops ----------------------------------------

/**
 * An outreach task's message. DETERMINISTIC, and it invents nothing: the goal's
 * own sentence, the human's `ask`, and a signature-free close. The template is
 * the same promise `watchCompose` makes — a verb the human pressed must always
 * come back with something — held one level up, where the "verb" is a workflow
 * the human authorized.
 */
export function outreachBody(o: { statement: string; ask?: string; note?: string }): string {
  const lines = ["Hello,", ""];
  lines.push(o.ask?.trim() || `I am reaching out about: ${o.statement}.`);
  if (o.note?.trim()) lines.push("", o.note.trim());
  lines.push("", "Thank you,");
  return lines.join("\n");
}

export function outreachSubject(o: { statement: string; subject?: string }): string {
  const explicit = o.subject?.trim();
  if (explicit) return explicit;
  // A subject line is a sentence fragment, not an essay: the goal's statement,
  // capitalized and clipped, is the honest default and it names the thing.
  const s = o.statement.trim();
  const clipped = s.length > 72 ? `${s.slice(0, 69)}…` : s;
  return clipped.charAt(0).toUpperCase() + clipped.slice(1);
}

/**
 * An outreach leaf: propose ONE message. It emits a `goal-outreach` proposal,
 * which shares `applyProposal`'s draft case with the mail verbs — approving it
 * writes a draft into the owner's own Drafts, and their composer sends it.
 *
 * A separate KIND from `verb-compose` even though the application is identical,
 * for the reason T3 gave when it added a third label to that case: the kind is
 * how the queue tells a person what they are looking at, and how the decline
 * taxonomy knows what it is learning about. "That is not the reply I wanted"
 * about a goal's outreach is feedback on the GOAL, not on the compose verb.
 */
export async function proposeOutreach(
  env: Env,
  node: JobNodeRow,
  goal: Goal | null,
  context: Record<string, unknown>,
): Promise<{ ok: true; proposalId: string; to: string } | { ok: false; why: string }> {
  const to = typeof context.to === "string" ? context.to.trim() : "";
  if (!to.includes("@")) return { ok: false, why: "an outreach task needs a recipient address (`to`)" };
  if (!goal) return { ok: false, why: "an outreach task can only run under a goal" };
  if (goal.row.cancelled_at) return { ok: false, why: "the goal was cancelled — its authority is revoked" };
  if (!goal.contract) return { ok: false, why: "the goal's contract cannot be read, so its bounds are unknown" };

  // THE CONTRACT, AT USE TIME. The recipient was checked when the plan was
  // approved; it is checked AGAIN here, for the reason `effectiveNodeCeiling`
  // re-folds an envelope on every use: the contract may have been narrowed
  // since, and a delegation checked only where it was created is not a
  // delegation. A task outside the contract fails rather than asking.
  const refusals = contractRefusals(goal.contract, [{ key: "(node)", context }]);
  if (refusals.length > 0) return { ok: false, why: describeRefusals(refusals) };

  const statement = goal.row.statement;
  const subject = outreachSubject({ statement, subject: typeof context.subject === "string" ? context.subject : "" });
  const body = outreachBody({
    statement,
    ask: typeof context.ask === "string" ? context.ask : undefined,
    note: typeof context.note === "string" ? context.note : undefined,
  });
  const proposalId = await emitProposal(
    env,
    { id: node.id, account_id: node.account_id },
    {
      kind: GOAL_OUTREACH_KIND,
      // Tier 1 for the same reason a mail verb's draft is: approving writes a
      // DRAFT into the owner's own mailbox. Nothing relays, and their own
      // submission path keeps its own gates — this is the "a Job reorganizes
      // work, never its egress" line, honoured rather than quoted.
      tier: 1,
      subject: { realm: "Goal", objectId: goal.row.id },
      payload: { goalId: goal.row.id, to, subject, body, mode: "compose" },
      rationale:
        `Toward "${statement}": a message to ${to}. Approving puts it in your Drafts — ` +
        "you send it, or you do not.",
      evidence: [{ realm: "Goal", objectId: goal.row.id, note: statement }],
    },
  );
  return { ok: true, proposalId, to };
}

/**
 * The join node's compiled answer — the last milestone before done-ness.
 *
 * It reads its dependencies' results (which are there because the DAG says
 * they are done; the claim gate would not have released this node otherwise)
 * and proposes the summary. Approving it is the human saying the `doneWhen`
 * clause is MET — a judgment no derivation can make, which is why the goal
 * carries an authored `accepted_at` rather than inferring done-ness from "every
 * node finished".
 */
export function compileSummary(o: {
  statement: string;
  doneWhen: string;
  inputs: Array<{ id: string; result: unknown }>;
}): string {
  const lines = [`Goal: ${o.statement}`, `Done when: ${o.doneWhen}`, ""];
  if (o.inputs.length === 0) {
    lines.push("No task results to compile — nothing this join depended on produced one.");
    return lines.join("\n");
  }
  for (const input of o.inputs) {
    const r = input.result as Record<string, unknown> | null;
    const to = typeof r?.to === "string" ? r.to : null;
    const note = typeof r?.text === "string" ? r.text : typeof r?.note === "string" ? r.note : null;
    lines.push(`• ${to ?? input.id}${note ? ` — ${note}` : ""}`);
  }
  return lines.join("\n");
}

export async function proposeSummary(
  env: Env,
  node: JobNodeRow,
  goal: Goal | null,
  inputs: Array<{ id: string; result: unknown }>,
): Promise<{ ok: true; proposalId: string; text: string } | { ok: false; why: string }> {
  if (!goal) return { ok: false, why: "a summary task can only run under a goal" };
  // Revocation has to bite HERE too, not only at the plan checkpoint: a node
  // already running when the human cancelled must not still land a proposal in
  // their queue, which would be a cancelled goal asking for a decision.
  if (goal.row.cancelled_at) return { ok: false, why: "the goal was cancelled — its authority is revoked" };
  if (!goal.contract) return { ok: false, why: "the goal's contract cannot be read, so its bounds are unknown" };
  const text = compileSummary({ statement: goal.row.statement, doneWhen: goal.contract.doneWhen, inputs });
  const proposalId = await emitProposal(
    env,
    { id: node.id, account_id: node.account_id },
    {
      kind: GOAL_SUMMARY_KIND,
      // Tier 1, and the `watch-notify` precedent for what approval DOES: the
      // decision itself is the whole effect, plus the one fact it records —
      // that a human read the answer and called the goal done.
      tier: 1,
      subject: { realm: "Goal", objectId: goal.row.id },
      payload: { goalId: goal.row.id, text, inputs: inputs.map((i) => i.id) },
      rationale:
        `"${goal.row.statement}" — here is what came back. Approving records that you consider it done ` +
        `("${goal.contract.doneWhen}"); declining says it is not, and the goal stays open.`,
      evidence: inputs.map((i) => ({ realm: "AgentInvocation", objectId: i.id })),
    },
  );
  return { ok: true, proposalId, text };
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}
