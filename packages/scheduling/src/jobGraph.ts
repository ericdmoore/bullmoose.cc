// THE JOB DAG — claimability, and the status that is never stored (s11 T7).
//
// Two halves, and both are the same idea from jobs-and-facets.md §5:
//
//   NO NEW QUEUES — states and views over ONE table.
//
//   claimability   `status='pending' AND NOT EXISTS (unmet needs)`, computed
//                  IN the claim query. There is no `pending_task_queue`, no
//                  `blocked` column and no sweep that sets one: a stored
//                  derived flag drifts the first time a runner dies mid-claim,
//                  and then you own a reconciliation problem forever. This is
//                  the membership-chain lesson (fold-vs-book) applied forward.
//   Job status     a VIEW over the nodes (`deriveJobStatus`). The `jobs` row
//                  has no status column at all — see data-plane.sql.
//
// The SQL fragments here are folded into `claimGateSql` (claimGate.ts) so every
// claim path gets them without asking, and each is exported alone because the
// s11 T3 overdue backstop takes a strict SUBSET of the gate's terms: it drops
// the money terms (a backstop that refused out-of-budget overdue work would be
// decorative) and KEEPS `needsSatisfiedSql`, because claiming a node whose
// inputs do not exist yet is not a liveness rescue — it is a run that must
// fail, burning the deadline it was meant to save.
//
// Every fragment below returns a BARE boolean expression (parenthesized, no
// leading ` AND`) and takes ZERO placeholders — the graph is entirely in the
// rows — so folding them in disturbs no existing bind order.

/** The node statuses a Job's view folds over (`agent_invocations.status`). */
export type NodeStatus = "pending" | "running" | "done" | "failed";

/**
 * WHEN IS A DEPENDENCY SETTLED? — `done`, AND not holding an open question.
 *
 * The second half is how "`needsInfo` pauses only its subtree" falls out with
 * no new column. A node that emitted a proposal is `done` the moment the
 * proposal exists; if a human then answers with needsInfo, the proposal goes
 * `info-requested` and an answer round is enqueued — the node's WORK is not
 * actually finished, so its dependents must keep waiting. They are exactly its
 * subtree; every other branch of the DAG stays claimable, which is the "only"
 * in "pauses only its subtree".
 *
 * A merely `pending` proposal (awaiting a verdict) deliberately does NOT pause:
 * the node's work IS done, the human's decision is the egress step, and
 * `/approvals` is where it belongs. Only an open QUESTION means the agent still
 * owes an answer.
 */
export function nodeSettledSql(dep: string): string {
  return (
    `(${dep}.status = 'done'` +
    `\n                       AND NOT EXISTS (SELECT 1 FROM agent_proposals pause` +
    `\n                                        WHERE pause.account_id = ${dep}.account_id` +
    `\n                                          AND pause.id = ${dep}.id` +
    `\n                                          AND pause.status = 'info-requested'))`
  );
}

/**
 * CLAIMABILITY, the DAG half — "every need is settled", 0 placeholders.
 *
 * `needs_json IS NULL` is the DefaultCase and comes first: an ordinary
 * invocation (and every row written before T7) has no needs and claims exactly
 * as today. An empty array claims too — `json_each('[]')` yields no rows.
 *
 * Three fail-CLOSED details, each deliberate:
 *   - a need whose row does not exist counts as UNMET (the NOT EXISTS is over
 *     "a settled dep row", not over "an unsettled one"), so a plan that named a
 *     ghost blocks rather than runs;
 *   - a `failed` need is never settled, so **a failed node blocks its
 *     dependents** — derived, permanently, with nothing to write;
 *   - malformed `needs_json` blocks. Everywhere else in this package garbage
 *     degrades to "no constraint" (see `fit`), and the asymmetry is the point:
 *     `requires_json` is a claimant-facing HINT written at the boundary, while
 *     `needs_json` is written only by the harness, server-side. Garbage there
 *     is corruption, not a stale writer, and unblocking work on corruption is
 *     the failure you cannot undo. `json_valid` also has to be checked before
 *     `json_each` regardless — an invalid document would throw inside the claim
 *     statement, and one poison row must not take every claim down with it.
 */
export function needsSatisfiedSql(inv: string): string {
  return (
    `(${inv}.needs_json IS NULL` +
    `\n      OR (json_valid(${inv}.needs_json)` +
    `\n          AND NOT EXISTS (` +
    `\n                SELECT 1 FROM json_each(${inv}.needs_json) AS need` +
    `\n                 WHERE NOT EXISTS (` +
    `\n                       SELECT 1 FROM agent_invocations dep` +
    `\n                        WHERE dep.account_id = ${inv}.account_id` +
    `\n                          AND dep.id = need.value` +
    `\n                          AND ${nodeSettledSql("dep")}))))`
  );
}

/**
 * THE AGGREGATE BUDGET, at claim time — 0 placeholders.
 *
 * The Job's `budget_micros` against what its nodes have actually spent
 * (`SUM(cost_micros)` over finished nodes). The harness already RESERVES
 * against the same number when a plan expands (`attenuatePlan`); this is the
 * other end — reservations bound what may be created, actual spend bounds what
 * may still run, and a Job whose nodes each cost more than they declared stops
 * here rather than at the next expansion.
 *
 * It sits INSIDE the gate's `isFree` short-circuit, exactly like the binding's
 * monthly cap: exhaustion NARROWS the claimant set to free runtimes, it never
 * fails the work. A free claimant stamps `cost_micros = 0`, so letting it
 * finish an over-budget Job spends nothing — refusing it would strand the DAG
 * to protect a number it cannot move.
 *
 * `job_id IS NULL` → no matching row → never exhausted: DefaultCase, and the
 * reason an ordinary invocation is unaffected by this term existing.
 *
 * ── How it composes with the BINDING's monthly cap (s11 T2/T9) ─────────────
 * As a CONJUNCTION, and only ever downward. A Job's nodes are ordinary
 * invocations of the same binding, so their `cost_micros` counts toward that
 * binding's monthly spend as well — the Job budget is a SUB-cap, never a
 * super-cap, and a Job with headroom cannot rescue a binding that is out of
 * money for the month (nor the reverse). One consequence worth stating: an
 * approved T9 overage raises the BINDING's ceiling for the period and does
 * nothing to a Job's aggregate, which is why `budgetOverrun.ts` excludes
 * job-budget-held rows from its "stranded by budget" counterfactual — asking a
 * human to approve money that would release nothing is worse than not asking.
 * A Job that runs out of ITS budget is a plan that was bigger than its purse,
 * and that is a different question (an s17 one) than "spend more this month?".
 */
export function jobBudgetExhaustedSql(inv: string): string {
  return (
    `EXISTS (` +
    `\n                SELECT 1 FROM jobs job` +
    `\n                 WHERE job.account_id = ${inv}.account_id AND job.id = ${inv}.job_id` +
    `\n                   AND job.budget_micros IS NOT NULL` +
    `\n                   AND (SELECT COALESCE(SUM(spend.cost_micros), 0) FROM agent_invocations spend` +
    `\n                         WHERE spend.account_id = job.account_id AND spend.job_id = job.id` +
    `\n                           AND spend.done_at IS NOT NULL) >= job.budget_micros)`
  );
}

// ---- the pure twins --------------------------------------------------------
// Same discipline as `mayClaim` vs `claimGateSql`: the predicate is stated
// once as a function and once as SQL, and `jobGraph.test.ts` runs both over
// one table of cases and requires identical verdicts. Comment-level agreement
// is not agreement.

/**
 * Pure twin of `needsSatisfiedSql`. `settled` answers "is this dependency
 * `done` and free of an open question" for one id — the caller supplies it
 * from whatever it has (a map in a test, a query in a surface). An id the
 * callback does not know is UNMET, matching the SQL's fail-closed reading.
 */
export function needsSatisfied(
  needs: readonly string[] | null | undefined,
  settled: (id: string) => boolean,
): boolean {
  if (needs === null || needs === undefined) return true;
  return needs.every((id) => settled(id));
}

/** Pure twin of `jobBudgetExhaustedSql`. No aggregate cap → never exhausted. */
export function jobBudgetExhausted(p: {
  budgetMicros: number | null;
  spentMicros: number;
}): boolean {
  if (p.budgetMicros === null) return false;
  return p.spentMicros >= p.budgetMicros;
}

/** Parse a stored `needs_json`. Malformed reads as BLOCKED (see the SQL note). */
export function parseNeeds(needsJson: string | null | undefined): string[] | null {
  if (needsJson === null || needsJson === undefined) return null;
  try {
    const v = JSON.parse(needsJson) as unknown;
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) return [BLOCKED_SENTINEL];
    return v as string[];
  } catch {
    return [BLOCKED_SENTINEL];
  }
}

/**
 * The id a malformed `needs_json` degrades to. No invocation can carry it
 * (ids are `inv_<uuid>`), so a node that "needs" it is permanently unmet —
 * which is precisely what the SQL does with an invalid document, spelled in a
 * way the pure side can carry through a fold.
 */
export const BLOCKED_SENTINEL = " unparseable-needs";

// ---- the derived view ------------------------------------------------------

/** One node, as the view reads it. `paused` = an open needsInfo question. */
export interface JobNodeState {
  id: string;
  status: NodeStatus;
  needs: readonly string[] | null;
  paused: boolean;
}

/**
 * Job status — DERIVED, never stored (jobs-and-facets §5).
 *
 *   done      every node is done.
 *   stalled   something failed, and it MATTERS: either a pending node can never
 *             become claimable (a need failed, or names a row that does not
 *             exist — a failure among blockers), or nothing is left to run and
 *             a node failed. A Job that ends with a failed leaf nobody depended
 *             on is still not `done`; calling it done would launder a failure.
 *   paused    an open needsInfo question, and nothing else can progress — the
 *             human is the only thing this Job is waiting on. If other branches
 *             are still moving the answer is `running`, because "paused" would
 *             overstate what one paused subtree means (§3: needsInfo pauses
 *             only its subtree).
 *   running   anything is running, or any progress has been made.
 *   pending   every node is pending and at least one is claimable.
 *
 * Total: an empty node set reads `pending` (a Job row whose root INSERT lost a
 * race is pending, not done — the honest answer for "nothing has happened").
 */
export type JobStatus = "pending" | "running" | "paused" | "stalled" | "done";

export function deriveJobStatus(nodes: readonly JobNodeState[]): JobStatus {
  if (nodes.length === 0) return "pending";
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const settled = (id: string) => {
    const n = byId.get(id);
    return n !== undefined && n.status === "done" && !n.paused;
  };

  // Can this pending node EVER run? Walk its needs transitively: a need that
  // failed, or is missing, or is itself blocked forever, blocks it too. Memoized
  // over the walk; a cycle is unrepresentable (attenuateChild refuses forward
  // and foreign references), and a `seen` guard keeps a corrupted row from
  // spinning anyway.
  const forever = new Map<string, boolean>();
  const blockedForever = (node: JobNodeState, seen: Set<string>): boolean => {
    const cached = forever.get(node.id);
    if (cached !== undefined) return cached;
    if (seen.has(node.id)) return true;
    seen.add(node.id);
    let blocked = false;
    for (const need of node.needs ?? []) {
      const dep = byId.get(need);
      if (dep === undefined || dep.status === "failed") {
        blocked = true;
        break;
      }
      if (dep.status === "pending" && blockedForever(dep, seen)) {
        blocked = true;
        break;
      }
    }
    forever.set(node.id, blocked);
    return blocked;
  };

  let anyFailed = false;
  let anyRunning = false;
  let anyDone = false;
  let anyPaused = false;
  let anyClaimable = false;
  let anyBlockedForever = false;
  let allDone = true;
  for (const n of nodes) {
    if (n.status !== "done") allDone = false;
    if (n.status === "failed") anyFailed = true;
    if (n.status === "running") anyRunning = true;
    if (n.status === "done") anyDone = true;
    if (n.paused && n.status === "done") anyPaused = true;
    if (n.status === "pending") {
      if (blockedForever(n, new Set())) anyBlockedForever = true;
      else if (needsSatisfied(n.needs, settled)) anyClaimable = true;
    }
  }

  if (allDone && !anyPaused) return "done";
  const canProgress = anyRunning || anyClaimable;
  if (anyBlockedForever || (anyFailed && !canProgress)) return "stalled";
  if (anyPaused && !canProgress) return "paused";
  if (anyRunning || anyDone) return "running";
  return "pending";
}

/** The progress a surface renders — counts from the same rows, no second store. */
export interface JobView {
  jobId: string;
  status: JobStatus;
  nodes: {
    total: number;
    pending: number;
    running: number;
    done: number;
    failed: number;
    /** `done` with an open needsInfo question — waiting on a human. */
    paused: number;
    /** pending with an unmet need — the derived "blocked", never stored. */
    blocked: number;
  };
  /** Actual spend so far, micro-USD (the aggregate budget's other end). */
  spentMicros: number;
  budgetMicros: number | null;
}

/**
 * The whole view in TWO queries — the nodes and the Job's own row. Deliberately
 * not a stored projection: at bullmoose scale a Job is tens of rows on an
 * indexed `(account_id, job_id)` scan, and the reconcile test a materialization
 * would owe costs more than the scan does.
 */
export async function jobView(
  db: D1Database,
  accountId: string,
  jobId: string,
): Promise<JobView | null> {
  const job = await db
    .prepare(`SELECT id, budget_micros FROM jobs WHERE account_id = ? AND id = ?`)
    .bind(accountId, jobId)
    .first<{ id: string; budget_micros: number | null }>();
  if (!job) return null;

  const { results } = await db
    .prepare(
      `SELECT inv.id, inv.status, inv.needs_json, inv.cost_micros,
              EXISTS (SELECT 1 FROM agent_proposals p
                       WHERE p.account_id = inv.account_id AND p.id = inv.id
                         AND p.status = 'info-requested') AS paused
         FROM agent_invocations inv
        WHERE inv.account_id = ? AND inv.job_id = ?`,
    )
    .bind(accountId, jobId)
    .all<{
      id: string;
      status: string;
      needs_json: string | null;
      cost_micros: number | null;
      paused: number;
    }>();

  const nodes: JobNodeState[] = results.map((r) => ({
    id: r.id,
    status: r.status as NodeStatus,
    needs: parseNeeds(r.needs_json),
    paused: r.paused === 1,
  }));
  const settled = (id: string) => {
    const n = nodes.find((x) => x.id === id);
    return n !== undefined && n.status === "done" && !n.paused;
  };

  return {
    jobId,
    status: deriveJobStatus(nodes),
    nodes: {
      total: nodes.length,
      pending: nodes.filter((n) => n.status === "pending").length,
      running: nodes.filter((n) => n.status === "running").length,
      done: nodes.filter((n) => n.status === "done").length,
      failed: nodes.filter((n) => n.status === "failed").length,
      paused: nodes.filter((n) => n.paused && n.status === "done").length,
      blocked: nodes.filter((n) => n.status === "pending" && !needsSatisfied(n.needs, settled)).length,
    },
    spentMicros: results.reduce((sum, r) => sum + (r.cost_micros ?? 0), 0),
    budgetMicros: job.budget_micros,
  };
}
