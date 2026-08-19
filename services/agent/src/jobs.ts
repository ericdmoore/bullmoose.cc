import { commitChanges } from "@bullmoose/account-do";
import {
  bindingCeiling,
  describeRefusals,
  expandPlanRows,
  getJobNodeRow,
  insertJobChildren,
  joinContextRows,
  startJobRows,
  type BindingJobConfig,
  type ExpandResult,
  type JobNodeRow,
  type JobSpec,
  type PlanSpec,
  type StartJobResult,
} from "@bullmoose/scheduling";
import type { Env } from "./models.js";

export type { BindingJobConfig, ExpandResult, JobNodeRow, JobSpec, PlanSpec, StartJobResult };
// Re-exported for s17 handoff (see handoff.ts), which inserts ONE cross-binding
// child through the same guarded statement a plan expansion uses — the whole
// point of it being one statement.
export { bindingCeiling, insertJobChildren };

/**
 * s11 T7 — THE JOB HARNESS, as this worker sees it: the changelog half.
 *
 * The design in one line (jobs-and-facets.md §3): **nodes are ordinary
 * invocations**. There is no execution machinery here at all — no dispatcher,
 * no worker pool, no second queue. A Job is a `jobs` row plus `agent_invocations`
 * rows carrying three columns; every unblocked node is simultaneously claimable
 * by whichever runtime the s11 T2 gate lets take it, which is how "parallel
 * subagents" falls out for free.
 *
 * ── WHY THIS FILE IS NOW FOUR WRAPPERS ─────────────────────────────────────
 * The attenuated WRITES — `startJobRows` and `expandPlanRows`, the two safety
 * chokepoints — moved to `@bullmoose/scheduling` (`jobWrite.ts`) when s20 T6
 * gave them a second caller: the plan-approval checkpoint creates a planner's
 * tasks from inside `ActionProposal/set`, in the JMAP worker, and an approved
 * (or hand-redlined) plan must meet EXACTLY the checks a planner's own output
 * meets. Sharing the function is the only way that stays true; a copy would be
 * two implementations of the invariant that makes decomposition safe.
 *
 * What stayed is what is genuinely this worker's: `commitChanges`. The agent
 * worker commits its own writes immediately, while `ActionProposal/set` folds
 * its entries into the ONE commit that covers the whole decision — so the
 * shared writer returns ids and lets each caller do its own choreography.
 *
 * ── The two enforcement points, and why there are two ──────────────────────
 * `attenuatePlan` (pure, in @bullmoose/scheduling) is the readable one: every
 * axis, every refusal, fully table-tested. The guarded INSERT re-checks
 * maxNodes/maxDepth/budget IN SQL, in ONE statement, because the pure check
 * reads state that a concurrently-expanding sibling planner could invalidate
 * between the read and the write. Belt and braces, and the braces are the ones
 * that hold under a race.
 */

/** Read one node row by id — the whole graph slice, in one query. */
export async function getJobNode(env: Env, accountId: string, id: string): Promise<JobNodeRow | null> {
  return getJobNodeRow(env, accountId, id);
}

/**
 * Create a Job and its root node, and commit the changelog entry for the root.
 *
 * Trusted-caller API: the callers are server-side (this worker's tests, and
 * s20 T6's `Goal/set`). It is written as if the caller were not trusted anyway
 * — the root goes through the same attenuation as any child — because a
 * ceiling that only applies below the root is not a ceiling.
 */
export async function startJob(env: Env, spec: JobSpec): Promise<StartJobResult> {
  const started = await startJobRows(env, spec);
  if (!started.ok) return started;
  await commitChanges(env.ACCOUNT_DO, spec.accountId, [
    { collection: "AgentInvocation", created: [started.rootId], updated: [], destroyed: [] },
  ]);
  return started;
}

/**
 * THE PLANNER'S OUTPUT BECOMES TASKS — the chokepoint, plus this worker's
 * commit. Every task is attenuated against the PLANNER NODE, then one guarded
 * INSERT creates them all or none (`jobWrite.ts` for the full reasoning).
 */
export async function expandPlan(env: Env, parent: JobNodeRow, plan: unknown): Promise<ExpandResult> {
  const expanded = await expandPlanRows(env, parent, plan);
  if (!expanded.ok) return expanded;
  await commitChanges(env.ACCOUNT_DO, parent.account_id, [
    {
      collection: "AgentInvocation",
      created: expanded.created.map((c) => c.id),
      updated: [],
      destroyed: [],
    },
  ]);
  return expanded;
}

/**
 * A node's dependency results, as CONTEXT — the join step (§3: "join nodes
 * receive their dependencies' results as context").
 */
export async function joinContext(env: Env, node: JobNodeRow): Promise<Array<{ id: string; result: unknown }>> {
  return joinContextRows(env, node);
}

export { describeRefusals };
