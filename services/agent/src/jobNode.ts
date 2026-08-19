import { describeRefusals, effectiveNodeAuthority, type JobNodeRow } from "@bullmoose/scheduling";
import { expandPlan, getJobNode, joinContext } from "./jobs.js";
import {
  getGoal,
  planCheckpoint,
  proposeOutreach,
  proposePlan,
  proposeSummary,
  resolvePlan,
  sketchRefusals,
  type Goal,
} from "./goals.js";
import type { Env, InvocationCost } from "./models.js";

/**
 * s11 T7 — the harness side of a Job node, dispatched by CONTEXT KIND from
 * `runInvocation` exactly as `answer-info-request` and `bouncer-classify` are.
 *
 * That dispatch point is the whole integration: a Job node is an ORDINARY
 * invocation, so a node whose context carries no `kind` runs the binding's
 * ordinary pipeline (reply, ledger, bouncer) and egresses through
 * `/approvals` like every other invocation — a Job reorganizes work, it never
 * changes how the work gets out (§8.3). Only the two structural node types
 * need machinery, and this is it.
 *
 * ── What a planner is, and is deliberately not ─────────────────────────────
 * `op: "plan"` reads its decomposition from `context.plan` — a FIXED plan,
 * supplied when the Job was created. There is no prompt here and no model call:
 * the model-driven planner is a later task, and building it now would prove
 * nothing this file can prove. What matters is that `expandPlan` treats the
 * plan as UNTRUSTED DATA regardless of who wrote it, so the day a model writes
 * one, the attenuation chain, the caps and the aggregate budget are already the
 * things standing between it and the household. The only line that changes is
 * where `plan` comes from.
 *
 * A planner whose plan is REFUSED fails its node. It does not proceed with a
 * truncated plan (rule 1 of attenuation.ts: refuse, never truncate), and the
 * failure propagates by derivation — its dependents are permanently blocked and
 * the Job reads `stalled` — with the refused axes recorded on the row for the
 * human who wants to know what the planner tried to do.
 */

/** No model was called, so the cost is KNOWN and it is zero (not "unrecorded"). */
const FREE: InvocationCost = {
  provider: "harness",
  model: "job-node",
  tokensIn: null,
  tokensOut: null,
  costMicros: 0,
};

/** The `Job` shape services/agent's drain hands to a pipeline. */
interface DrainJob {
  id: string;
  account_id: string;
  binding_name: string;
}

type Done = (status: "done" | "failed", result: Record<string, unknown>, cost?: InvocationCost) => Promise<void>;

/**
 * Run one structural node. Four ops, each the minimum that makes a DAG
 * property observable end-to-end:
 *
 *   plan   expand this node's fixed decomposition into tasks (the planner).
 *   join   synthesize the results of this node's `needs` (the join step). Its
 *          inputs arrive as context because the DAG says they are done — the
 *          claim gate would not have released this node otherwise.
 *   echo   a leaf that does deterministic work.
 *   fail   a leaf that fails, so "a failed node blocks its dependents" can be
 *          proven rather than asserted.
 */
export async function runJobNode(env: Env, job: DrainJob, context: Record<string, unknown>, done: Done): Promise<void> {
  const node = await getJobNode(env, job.account_id, job.id);
  if (!node) return done("failed", { note: "job node vanished mid-claim" }, FREE);

  // THE PRE-FLIGHT (s17). Before a delegated node does ANY work, its effective
  // authority must be resolvable: `binding ∩ root ∩ … ∩ this node`, every hop
  // present and readable (`nodeAuthority.ts`). A node whose chain cannot be read has
  // an UNKNOWN bound, and an unknown bound is not a permissive one — so it
  // fails here rather than running and discovering the problem only if it
  // happened to try to delegate.
  //
  // This is the fail-closed edge, not a capability check: what it refuses is a
  // corrupt, absent, grafted or cyclic delegation chain. The per-axis checks
  // (may this node use THIS tool / THIS credential / THIS much money) are
  // `authorizeNodeUse`, called by whichever consumer is spending — the same
  // resolved authority, asked a narrower question.
  const authority = await effectiveNodeAuthority(env, job.account_id, node);
  if (!authority.ok) {
    console.warn(`job ${node.job_id}: node ${node.id} refused — ${authority.note}`);
    return done(
      "failed",
      {
        kind: "job-node",
        note: `authority refused: ${authority.note}`.slice(0, 500),
        // Structured beside the sentence, for the same reason a planner's
        // refusals are: an audit counts by axis, it does not grep prose.
        denial: authority.denial,
      },
      FREE,
    );
  }

  const op = typeof context.op === "string" ? context.op : "";
  switch (op) {
    case "plan":
      return runPlanner(env, node, context, done);
    case "join":
      return runJoin(env, node, context, done);
    // s20 T6 — the two GOAL-shaped node types. Both are ordinary leaves whose
    // output is an ordinary proposal, which is exactly the point: a Goal
    // reorganizes work and never changes how it gets out.
    case "outreach":
      return runOutreach(env, node, context, done);
    case "summarize":
      return runSummarize(env, node, context, done);
    case "echo":
      return done("done", { kind: "job-node", op, text: String(context.text ?? "") }, FREE);
    case "fail":
      return done("failed", { kind: "job-node", op, note: String(context.note ?? "planned failure") }, FREE);
    default:
      return done("failed", { kind: "job-node", note: `unknown job-node op: ${op || "(none)"}` }, FREE);
  }
}

async function runPlanner(env: Env, node: JobNodeRow, context: Record<string, unknown>, done: Done): Promise<void> {
  // ── s20 T6: THE PLAN-APPROVAL CHECKPOINT — A NEW CLASS OF APPROVAL ────────
  //
  // Every approval before this one gated EGRESS: may this leave the building?
  // This one gates EXECUTION: may these tasks exist at all? It is the cheapest
  // possible feature by construction — the planner ALREADY emits a task list,
  // so this intercepts output that exists rather than producing anything new.
  //
  // The DefaultCase is untouched and comes first: a Job with no `goals` row
  // (every Job that existed before T6) expands exactly as it did, and so does a
  // goal whose `plan` checkpoint class has graduated to auto. Only a goal that
  // is still stopping for a human takes the branch.
  const gate = await planCheckpoint(env, node);
  if (gate.checkpoint === "refuse") {
    return done("failed", { kind: "job-node", op: "plan", note: `plan refused: ${gate.why}` }, FREE);
  }
  // The decomposition: this planner's fixed plan when it carries one, and
  // otherwise the one its goal's contract implies. Resolved once, so the
  // checkpoint proposes exactly the plan the auto route would have expanded.
  const plan = resolvePlan(context.plan, gate.goal);
  if (gate.checkpoint) {
    return proposeSketch(env, node, plan, gate.goal, done);
  }
  const expanded = await expandPlan(env, node, plan);
  if (!expanded.ok) {
    console.warn(`job ${node.job_id}: planner ${node.id} refused — ${describeRefusals(expanded.refusals)}`);
    return done(
      "failed",
      {
        kind: "job-node",
        op: "plan",
        note: `plan refused: ${describeRefusals(expanded.refusals)}`.slice(0, 500),
        // The full list, structured, so an audit can count refusals by axis
        // instead of grepping a sentence.
        refusals: expanded.refusals,
      },
      FREE,
    );
  }
  return done(
    "done",
    {
      kind: "job-node",
      op: "plan",
      created: expanded.created.map((c) => c.id),
      tasks: expanded.created,
    },
    FREE,
  );
}

/**
 * The checkpoint's emit side: the sketch becomes a proposal and NOTHING is
 * created.
 *
 * Two refusals happen before the human ever sees it, and both are courtesies
 * rather than the enforcement (which runs again at apply time, over the
 * human's redline):
 *
 *   the plan must BE a plan     an empty or malformed task list is the
 *                               planner's own bug, and asking a person to
 *                               approve it would be asking them to debug it.
 *   the contract must hold      a task addressed outside the goal's reach
 *                               could not run if it were approved, so showing
 *                               it would be inviting an approval that fails.
 *
 * The node itself finishes `done`: its work — producing a decomposition — IS
 * finished, and what remains is a human decision, which is precisely what
 * `/approvals` is for (the same reading `nodeSettledSql` already applies to a
 * node that emitted a proposal). The goal view does not read that as progress,
 * because `deriveGoalStatus` answers `awaiting-plan` while the checkpoint is
 * open — a goal that has done nothing must never report itself complete.
 */
async function proposeSketch(env: Env, node: JobNodeRow, plan: unknown, goal: Goal, done: Done): Promise<void> {
  const tasks = (plan as { tasks?: unknown } | null)?.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return done("failed", { kind: "job-node", op: "plan", note: "a plan must be a non-empty task list" }, FREE);
  }
  const refusals = sketchRefusals(goal.contract!, tasks as Array<Record<string, unknown>>);
  if (refusals.length > 0) {
    console.warn(`goal ${goal.row.id}: sketch refused — ${describeRefusals(refusals)}`);
    return done(
      "failed",
      {
        kind: "job-node",
        op: "plan",
        note: `the goal's contract refuses this plan: ${describeRefusals(refusals)}`.slice(0, 500),
        refusals,
      },
      FREE,
    );
  }
  const proposalId = await proposePlan(env, node, goal, tasks);
  return done(
    "done",
    {
      kind: "job-node",
      op: "plan",
      // `created: []` said out loud. A surface that reads a planner's result
      // must be able to tell "I made these tasks" from "I asked whether I may",
      // and an absent field would read as the former to anything counting.
      created: [],
      checkpoint: "plan",
      proposalId,
      tasks,
    },
    FREE,
  );
}

/**
 * An OUTREACH leaf (s20 T6) — one message the goal wants to send, proposed.
 *
 * The whole of its safety is that it is an ordinary leaf: it emits a proposal
 * and stops. The recipient is re-checked against the goal's contract HERE, not
 * only at the plan checkpoint, because the contract may have been narrowed
 * since the plan was approved and a delegation checked only where it was
 * created is not a delegation.
 */
async function runOutreach(env: Env, node: JobNodeRow, context: Record<string, unknown>, done: Done): Promise<void> {
  const goal = node.job_id ? await getGoal(env, node.account_id, node.job_id) : null;
  const proposed = await proposeOutreach(env, node, goal, context);
  if (!proposed.ok) {
    return done("failed", { kind: "job-node", op: "outreach", note: proposed.why.slice(0, 500) }, FREE);
  }
  return done(
    "done",
    // `to` rides the result so the join node downstream can compile "who did we
    // hear back from" without re-reading a proposal payload — the join reads
    // its dependencies' RESULTS, which is the contract jobs-and-facets states.
    { kind: "job-node", op: "outreach", proposalId: proposed.proposalId, to: proposed.to },
    FREE,
  );
}

/**
 * A SUMMARIZE join (s20 T6) — the compiled answer, as the final proposal.
 *
 * The plain `join` op above synthesizes text and stops; this one synthesizes
 * and ASKS, because the last thing a goal produces is not a string but a
 * question: is the done-when clause met? That judgment is a human's (no
 * derivation can read "three engineers willing"), so approving this proposal is
 * what records it.
 */
async function runSummarize(env: Env, node: JobNodeRow, context: Record<string, unknown>, done: Done): Promise<void> {
  const goal = node.job_id ? await getGoal(env, node.account_id, node.job_id) : null;
  const inputs = await joinContext(env, node);
  const proposed = await proposeSummary(env, node, goal, inputs);
  if (!proposed.ok) {
    return done("failed", { kind: "job-node", op: "summarize", note: proposed.why.slice(0, 500) }, FREE);
  }
  return done(
    "done",
    {
      kind: "job-node",
      op: "summarize",
      proposalId: proposed.proposalId,
      text: proposed.text,
      inputs: inputs.map((i) => i.id),
      ...(typeof context.separator === "string" ? { separator: context.separator } : {}),
    },
    FREE,
  );
}

async function runJoin(env: Env, node: JobNodeRow, context: Record<string, unknown>, done: Done): Promise<void> {
  const inputs = await joinContext(env, node);
  const texts = inputs.map((i) => {
    const r = i.result as { text?: unknown } | null;
    return typeof r?.text === "string" ? r.text : "";
  });
  const separator = typeof context.separator === "string" ? context.separator : "\n";
  return done(
    "done",
    {
      kind: "job-node",
      op: "join",
      // The synthesis. Deterministic on purpose: what is being proven is that
      // a join node SEES its dependencies' results, not that a model can
      // summarize them.
      text: texts.join(separator),
      inputs: inputs.map((i) => i.id),
    },
    FREE,
  );
}
