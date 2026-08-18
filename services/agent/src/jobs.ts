import { commitChanges } from "@bullmoose/account-do";
import {
  JOB_MAX_DEPTH_CEILING,
  JOB_MAX_NODES_CEILING,
  attenuateChild,
  attenuatePlan,
  bindingCeiling,
  describeRefusals,
  effectiveNodeCeiling,
  type AttenuatedChild,
  type BindingJobConfig,
  type ChildRequest,
  type JobNodeRow,
  type Refusal,
} from "@bullmoose/scheduling";
import type { Env } from "./models.js";

export type { BindingJobConfig, JobNodeRow };
export { bindingCeiling };

/**
 * s11 T7 — THE JOB HARNESS: a Job's creation, and a planner's output becoming
 * rows.
 *
 * The design in one line (jobs-and-facets.md §3): **nodes are ordinary
 * invocations**. There is no execution machinery here at all — no dispatcher,
 * no worker pool, no second queue. A Job is a `jobs` row plus `agent_invocations`
 * rows carrying three columns; every unblocked node is simultaneously claimable
 * by whichever runtime the s11 T2 gate lets take it, which is how "parallel
 * subagents" falls out for free. Alpaca takes three cheap summarize nodes while
 * the cloud takes the near-due synthesis node, and neither loop changed.
 *
 * This module owns exactly two things, and they are both about SAFETY:
 *
 *   startJob()    mints the Job and its root node, with the root's authority
 *                 ATTENUATED against the binding's declared ceiling. The
 *                 binding is the parent of the root — literally: it is passed
 *                 to `attenuateChild` as a depth −1 ceiling, so the same
 *                 function that guards every other level guards this one.
 *   expandPlan()  takes a planner node's OUTPUT — untrusted data, today a
 *                 fixed decomposition and tomorrow a model's — and creates the
 *                 tasks it asked for, if and only if every one of them
 *                 attenuates. This is the confused-deputy chokepoint that s17
 *                 (CJ) needs to exist before `agents:invoke` can be un-deferred.
 *
 * PROGRESSIVE REVELATION, not front matter: a Job starts as ONE node carrying
 * a goal. Its plan is produced at runtime, INSIDE the work, and `has_sub_steps`
 * is not declared — it happens. Which is exactly why the plan is treated as
 * data and validated on the way in.
 *
 * ── The two enforcement points, and why there are two ──────────────────────
 * `attenuatePlan` (pure, in @bullmoose/scheduling) is the readable one: every
 * axis, every refusal, fully table-tested. The guarded INSERT below re-checks
 * maxNodes/maxDepth/budget IN SQL, in ONE statement, because the pure check
 * reads state that a concurrently-expanding sibling planner could invalidate
 * between the read and the write. Belt and braces, and the braces are the ones
 * that hold under a race.
 */

/** A plan, as a planner node emits it. Every field is untrusted. */
export interface PlanSpec {
  tasks?: unknown;
}

export type ExpandResult =
  | { ok: true; created: Array<{ key: string; id: string }> }
  | { ok: false; refusals: Refusal[] };

/** Read one node row by id — the whole graph slice, in one query. */
export async function getJobNode(env: Env, accountId: string, id: string): Promise<JobNodeRow | null> {
  return env.DB.prepare(
    `SELECT id, account_id, binding_id, binding_name, job_id, parent_id, needs_json, depth,
            authority_json, privacy, due_at, context_json, email_id, status
       FROM agent_invocations WHERE account_id = ? AND id = ?`,
  )
    .bind(accountId, id)
    .first<JobNodeRow>();
}

/**
 * NOTE — `parseAuthority`, `ceilingOf` and `bindingCeiling` used to live here.
 * The first two are GONE and the third MOVED, and both facts are the point of
 * the s17 use-time gate.
 *
 * `parseAuthority`/`ceilingOf` read a node's OWN `authority_json` and returned
 * it as that node's ceiling: the column believed verbatim, with no reference to
 * the binding above it or to any ancestor. That is a fair description of what
 * the harness wrote, and a bad bound on what the node may spend — a delegation
 * checked only where it is created is not a delegation. Everything that needs a
 * node's ceiling now goes through `effectiveNodeCeiling` (`nodeAuthority.ts` (@bullmoose/scheduling)), which
 * recomputes `binding ∩ root ∩ … ∩ node` from the rows on every use. If you
 * find yourself reaching for "just parse this row's envelope", that is the
 * mistake this comment exists to interrupt.
 *
 * `bindingCeiling` moved to `nodeAuthority.ts` (@bullmoose/scheduling) because the binding is the FIRST TERM
 * of that fold — the top of every chain (jobs-and-facets §5) — and one reading
 * of `config_json.jobs` shared by the write path and the use path is the only
 * way the two cannot drift. It is re-exported above so this module's existing
 * callers are unchanged.
 */

/** What a caller asks for when starting a Job. Server-side callers only. */
export interface JobSpec {
  accountId: string;
  bindingId: string;
  /** The aggregate spend cap for the whole DAG, micro-USD. null = none. */
  budgetMicros?: number | null;
  /** Fan-out cap. Clamped to JOB_MAX_NODES_CEILING and the binding's. */
  maxNodes: number;
  /** Chain-depth cap — s17/§4's condition. Clamped the same way. */
  maxDepth: number;
  /** The root node's requested authority (attenuated against the binding). */
  authority?: Pick<ChildRequest, "tools" | "credentials" | "budgetMicros">;
  /** Facets the Job (and therefore every node) is created with. */
  facets?: { privacy?: string | null; dueAt?: number | null; requires?: unknown };
  /** The root node's context — `{kind: "job-node", op: "plan", plan}` for a planner. */
  rootContext: Record<string, unknown>;
  emailId?: string | null;
}

export type StartJobResult = { ok: true; jobId: string; rootId: string } | { ok: false; refusals: Refusal[] };

/**
 * Create a Job and its root node.
 *
 * Trusted-caller API: today the callers are server-side (a test harness, and
 * whatever s17 builds on top). It is written as if the caller were not trusted
 * anyway — the root goes through the same attenuation as any child — because
 * the day a JMAP `Job/set` exists is the day that assumption changes, and a
 * ceiling that only applies below the root is not a ceiling.
 */
export async function startJob(env: Env, spec: JobSpec): Promise<StartJobResult> {
  const binding = await env.DB.prepare(
    `SELECT id, name, enabled, COALESCE(config_json, '{}') AS config_json
       FROM agent_bindings WHERE account_id = ? AND id = ?`,
  )
    .bind(spec.accountId, spec.bindingId)
    .first<{ id: string; name: string; enabled: number; config_json: string }>();
  if (!binding) {
    return {
      ok: false,
      refusals: [refusal("identity", spec.bindingId, "(none)", "no such binding on this account")],
    };
  }
  // The 008 kill switch, honored at creation exactly as AgentInvocation/set
  // honors it: a Job against a disabled binding would be a DAG of rows no
  // drain will ever touch.
  if (binding.enabled !== 1) {
    return {
      ok: false,
      refusals: [refusal("identity", binding.name, "an enabled binding", "the binding is disabled (008 kill switch)")],
    };
  }

  let cfg: { jobs?: BindingJobConfig } = {};
  try {
    cfg = JSON.parse(binding.config_json) as { jobs?: BindingJobConfig };
  } catch {
    /* an unparseable config is an unset ceiling — same as absent */
  }

  const jobId = `job_${crypto.randomUUID()}`;
  const rootId = `inv_${crypto.randomUUID()}`;
  const ceiling = bindingCeiling(spec.accountId, spec.bindingId, jobId, cfg.jobs, spec.facets ?? {});

  // Caps: the caller's ask, narrowed by the binding's and by the absolute
  // ceilings. `Math.min` and not a refusal, because these are the caller's own
  // safety rails rather than a claim about authority — asking for 1000 nodes
  // gets you JOB_MAX_NODES_CEILING, which is the answer that keeps the Job
  // runnable AND bounded.
  const maxNodes = Math.max(
    1,
    Math.min(spec.maxNodes, JOB_MAX_NODES_CEILING, numberOr(cfg.jobs?.maxNodes, JOB_MAX_NODES_CEILING)),
  );
  const maxDepth = Math.max(
    0,
    Math.min(spec.maxDepth, JOB_MAX_DEPTH_CEILING, numberOr(cfg.jobs?.maxDepth, JOB_MAX_DEPTH_CEILING)),
  );
  const budgetMicros =
    spec.budgetMicros === undefined || spec.budgetMicros === null
      ? typeof cfg.jobs?.budgetMicros === "number"
        ? cfg.jobs.budgetMicros
        : null
      : typeof cfg.jobs?.budgetMicros === "number"
        ? Math.min(spec.budgetMicros, cfg.jobs.budgetMicros)
        : spec.budgetMicros;

  // The root, attenuated against the binding. `key` and `context` ride the
  // same request shape a planner's tasks use — one code path, one set of rules.
  const rooted = attenuateChild(ceiling, {
    key: "root",
    ...(spec.authority ?? {}),
    privacy: spec.facets?.privacy ?? undefined,
    dueAt: spec.facets?.dueAt ?? undefined,
    context: spec.rootContext,
    ...(spec.emailId ? { emailId: spec.emailId } : {}),
  });
  if (!rooted.ok) return { ok: false, refusals: rooted.refusals };

  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO jobs (id, account_id, binding_id, binding_name, root_invocation_id,
                         budget_micros, max_nodes, max_depth, facets_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      jobId,
      spec.accountId,
      binding.id,
      binding.name,
      rootId,
      budgetMicros,
      maxNodes,
      maxDepth,
      JSON.stringify(spec.facets ?? {}),
      now,
    ),
    env.DB.prepare(
      `INSERT INTO agent_invocations
         (id, account_id, binding_id, binding_name, status, email_id, context_json, created_at,
          due_at, privacy, requires_json, job_id, parent_id, needs_json, depth, authority_json)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?)`,
    ).bind(
      rootId,
      spec.accountId,
      binding.id,
      binding.name,
      rooted.child.emailId,
      JSON.stringify(rooted.child.context),
      now,
      rooted.child.dueAt,
      rooted.child.privacy,
      spec.facets?.requires !== undefined ? JSON.stringify(spec.facets.requires) : null,
      jobId,
      JSON.stringify(rooted.child.authority),
    ),
  ]);

  await commitChanges(env.ACCOUNT_DO, spec.accountId, [
    { collection: "AgentInvocation", created: [rootId], updated: [], destroyed: [] },
  ]);
  return { ok: true, jobId, rootId };
}

/**
 * THE PLANNER'S OUTPUT BECOMES TASKS — the chokepoint.
 *
 * Every task is attenuated against the PLANNER NODE (not against the Job, not
 * against the binding): the chain is what makes depth 3 as safe as depth 1,
 * because a node that already gave up a tool cannot hand it to its child. Then
 * one guarded INSERT creates them all or none.
 *
 * `needs` are plan-local keys and are rewritten here to the generated
 * invocation ids — a planner never sees or names a row id, which is why it
 * cannot wire a dependency onto an unrelated invocation, and why forward
 * references (and therefore cycles) are unrepresentable.
 *
 * The children do NOT `need` their parent, deliberately: `parent_id` is context
 * and authority, `needs` is execution ordering, and conflating the two is the
 * mistake jobs-and-facets §5 names. A task is claimable the instant it exists —
 * by a DIFFERENT runtime, while the planner is still writing its own result row.
 */
export async function expandPlan(env: Env, parent: JobNodeRow, plan: unknown): Promise<ExpandResult> {
  if (!parent.job_id) {
    return {
      ok: false,
      refusals: [refusal("job", "(none)", "a job id", "this invocation is not part of a Job")],
    };
  }
  const job = await env.DB.prepare(
    `SELECT id, budget_micros, max_nodes, max_depth FROM jobs WHERE account_id = ? AND id = ?`,
  )
    .bind(parent.account_id, parent.job_id)
    .first<{ id: string; budget_micros: number | null; max_nodes: number; max_depth: number }>();
  if (!job) {
    return {
      ok: false,
      refusals: [refusal("job", parent.job_id, "an existing Job", "no such Job row")],
    };
  }

  const tasks = (plan as PlanSpec | null)?.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return {
      ok: false,
      refusals: [
        refusal(
          "needs",
          JSON.stringify(plan ?? null) ?? "null",
          "{ tasks: [...] }",
          "a plan must be a non-empty task list",
        ),
      ],
    };
  }

  // THE USE-TIME BOUND, and it comes FIRST. Not `ceilingOf(parent)` — that read
  // the parent's stored envelope and believed it. Re-delegation is a USE of the
  // delegated authority, so the ceiling a plan is checked against is recomputed
  // here from the binding down through every hop (`nodeAuthority.ts` (@bullmoose/scheduling)):
  // binding ∩ root ∩ … ∩ parent. A row that claims more than its ancestors held
  // delegates the intersection rather than the claim, and a binding narrowed
  // after this Job started bites the plan being expanded right now.
  //
  // Before the usage read, deliberately — authorize, then measure. A caller
  // whose delegation chain cannot be read gets a refusal without this function
  // touching another row on its behalf.
  const effective = await effectiveNodeCeiling(env, parent);
  if (!effective.ok) {
    return {
      ok: false,
      refusals: [
        refusal(effective.denial.axis, effective.denial.requested, effective.denial.ceiling, effective.denial.why),
      ],
    };
  }

  // Usage: what the Job has already committed. `reservedMicros` sums the
  // DECLARED budgets of existing nodes rather than their spend — a plan is
  // refused for over-committing before a cent is spent, which is the only
  // moment at which refusing it is free.
  //
  // `json_valid` guards the sum because SQLite's `json_extract` THROWS on
  // malformed JSON rather than returning NULL — so one corrupt envelope on any
  // sibling would take down the whole expansion with a SQLite error instead of
  // a refusal. A corrupt sibling reserves 0 here and is refused on its own
  // account when IT tries to act (`nodeAuthority.ts` (@bullmoose/scheduling)); it must not be able to make
  // another node's plan unanswerable.
  const usage = await env.DB.prepare(
    `SELECT COUNT(*) AS n,
            COALESCE(SUM(CASE WHEN json_valid(authority_json)
                              THEN COALESCE(json_extract(authority_json, '$.budgetMicros'), 0)
                              ELSE 0 END), 0) AS reserved
       FROM agent_invocations WHERE account_id = ? AND job_id = ?`,
  )
    .bind(parent.account_id, parent.job_id)
    .first<{ n: number; reserved: number }>();

  const result = attenuatePlan(
    effective.ceiling,
    tasks as ChildRequest[],
    { maxNodes: job.max_nodes, maxDepth: job.max_depth, budgetMicros: job.budget_micros },
    { nodeCount: usage?.n ?? 0, reservedMicros: usage?.reserved ?? 0 },
  );
  if (!result.ok) return { ok: false, refusals: result.refusals };

  const ids = new Map(result.children.map((c) => [c.key, `inv_${crypto.randomUUID()}`]));
  const now = Date.now();
  const changes = await insertJobChildren(env, parent, job, result.children, ids, now);
  if (changes !== result.children.length) {
    // The pure check passed and the SQL guard still refused: a sibling planner
    // expanded the same Job between the two. Nothing was written (one
    // statement, all-or-nothing), so this is a clean refusal, not a repair.
    return {
      ok: false,
      refusals: [
        refusal(
          "fanout",
          String((usage?.n ?? 0) + result.children.length),
          `${job.max_nodes} nodes / depth ${job.max_depth} / ${job.budget_micros ?? "unbounded"}µ$`,
          "the Job's caps were reached by a concurrent expansion; nothing was created",
        ),
      ],
    };
  }

  const created = result.children.map((c) => ({ key: c.key, id: ids.get(c.key)! }));
  await commitChanges(env.ACCOUNT_DO, parent.account_id, [
    {
      collection: "AgentInvocation",
      created: created.map((c) => c.id),
      updated: [],
      destroyed: [],
    },
  ]);
  return { ok: true, created };
}

/**
 * THE GUARDED INSERT — every child, or none, in ONE statement.
 *
 * Three guards ride the same WHERE, and they are the SQL twins of the caps
 * `attenuatePlan` already checked:
 *   node count + N ≤ max_nodes      the fan-out cap
 *   child depth   ≤ max_depth       the chain-depth cap
 *   reserved + Σ  ≤ budget_micros   the shared budget (a reservation, so it
 *                                    bites before any money moves)
 *
 * One statement rather than N, deliberately: D1's `batch` is atomic on ERROR,
 * but a guarded INSERT that matches nothing is not an error — it writes zero
 * rows and returns success. N statements could therefore leave half a plan
 * standing, with join nodes waiting forever on tasks that were never created.
 * A single `INSERT … SELECT … WHERE` evaluates the guard once for the whole
 * batch and inserts N rows or 0.
 */
export async function insertJobChildren(
  env: Env,
  parent: JobNodeRow,
  job: { id: string; budget_micros: number | null; max_nodes: number; max_depth: number },
  children: readonly AttenuatedChild[],
  ids: Map<string, string>,
  now: number,
  /**
   * The DISPLAY NAME for a child's binding. s17 fixes a latent lie here: this
   * function used to write `parent.binding_name` onto every child
   * unconditionally, which was correct only because `attenuateChild`'s identity
   * axis made every child same-binding. A HANDOFF child runs on another
   * binding, so an unconditional copy would put the sender's NAME over the
   * receiver's ID — a denormalization lie every progress, audit and Activity
   * surface reads. The resolver is a parameter rather than a lookup here
   * because the caller has already read the row it names.
   */
  nameFor: (bindingId: string) => string = () => parent.binding_name,
): Promise<number> {
  const COLUMNS = 15;
  const rowSelect = `SELECT ${new Array(COLUMNS).fill("?").join(", ")}`;
  const values: unknown[] = [];
  for (const c of children) {
    values.push(
      ids.get(c.key)!,
      c.accountId,
      c.bindingId,
      nameFor(c.bindingId),
      "pending",
      c.emailId,
      // The plan-local key rides the context as `jobKey`: it is how a progress
      // surface names a node ("summarize-b") without inventing a column, and
      // the harness owns that field — a plan that sets its own is overwritten.
      JSON.stringify({ ...c.context, jobKey: c.key }),
      now,
      c.dueAt,
      c.privacy,
      c.jobId,
      parent.id,
      JSON.stringify(c.needs.map((k) => ids.get(k)!)),
      c.depth,
      JSON.stringify(c.authority),
    );
  }
  const reserving = children.reduce((sum, c) => sum + (c.authority.budgetMicros ?? 0), 0);

  const res = await env.DB.prepare(
    `INSERT INTO agent_invocations
       (id, account_id, binding_id, binding_name, status, email_id, context_json, created_at,
        due_at, privacy, job_id, parent_id, needs_json, depth, authority_json)
     SELECT * FROM (${children.map(() => rowSelect).join(" UNION ALL ")})
      WHERE (SELECT COUNT(*) FROM agent_invocations n
              WHERE n.account_id = ? AND n.job_id = ?) + ? <= (SELECT max_nodes FROM jobs WHERE account_id = ? AND id = ?)
        AND ? <= (SELECT max_depth FROM jobs WHERE account_id = ? AND id = ?)
        AND (SELECT COALESCE(SUM(CASE WHEN json_valid(r.authority_json)
                                      THEN COALESCE(json_extract(r.authority_json, '$.budgetMicros'), 0)
                                      ELSE 0 END), 0)
               FROM agent_invocations r WHERE r.account_id = ? AND r.job_id = ?) + ?
            <= COALESCE((SELECT budget_micros FROM jobs WHERE account_id = ? AND id = ?), 9e18)`,
  )
    .bind(
      ...values,
      parent.account_id,
      job.id,
      children.length,
      parent.account_id,
      job.id,
      (parent.depth ?? 0) + 1,
      parent.account_id,
      job.id,
      parent.account_id,
      job.id,
      reserving,
      parent.account_id,
      job.id,
    )
    .run();
  return res.meta.changes ?? 0;
}

/**
 * A node's dependency results, as CONTEXT — the join step (§3: "join nodes
 * receive their dependencies' results as context").
 *
 * Ordered by the node's own `needs` array rather than by the database, so a
 * synthesis reads its inputs in the order its planner listed them; a dependency
 * whose row vanished is skipped rather than faked. Only `done` deps can be here
 * at all — the claim gate would not have let this node be claimed otherwise.
 */
export async function joinContext(env: Env, node: JobNodeRow): Promise<Array<{ id: string; result: unknown }>> {
  let needs: string[] = [];
  try {
    const parsed = JSON.parse(node.needs_json ?? "[]") as unknown;
    if (Array.isArray(parsed)) needs = parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
  if (needs.length === 0) return [];
  const marks = needs.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT id, result_json FROM agent_invocations
      WHERE account_id = ? AND id IN (${marks})`,
  )
    .bind(node.account_id, ...needs)
    .all<{ id: string; result_json: string | null }>();
  const byId = new Map(results.map((r) => [r.id, r.result_json]));
  return needs
    .filter((id) => byId.has(id))
    .map((id) => {
      const raw = byId.get(id) ?? null;
      let result: unknown = null;
      try {
        result = raw ? JSON.parse(raw) : null;
      } catch {
        result = raw;
      }
      return { id, result };
    });
}

/** A refusal from the harness itself, in the same shape the pure module emits. */
function refusal(axis: Refusal["axis"], requested: string, ceiling: string, why: string): Refusal {
  return { key: "(job)", axis, requested, ceiling, why };
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

export { describeRefusals };
