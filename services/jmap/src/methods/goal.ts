import { commitChanges, type ChangeEntry } from "@bullmoose/account-do";
import { MethodError, type MethodRegistry } from "@bullmoose/jmap-core";
import {
  CHECKPOINT_CLASSES,
  GOAL_DEFAULT_MAX_DEPTH,
  GOAL_DEFAULT_MAX_NODES,
  GOAL_PLAN_KIND,
  GRADUABLE_CLASSES,
  checkpointClassOf,
  compileContract,
  defaultCheckpoints,
  deriveGoalStatus,
  deriveJobStatus,
  describeRefusals,
  isCheckpointClass,
  parseGoalContract,
  parseNeeds,
  startJobRows,
  type CheckpointClass,
  type CheckpointPolicy,
  type GoalContract,
  type JobNodeState,
} from "@bullmoose/scheduling";
import { accountState, requireAccount, type RequestContext } from "./common";

/**
 * Goal (urn:bullmoose:params:jmap:agent) — s20 T6, and the thinnest possible
 * face over machinery that already runs.
 *
 * A Goal is not a container of related stuff (that is about-ness, and it is
 * deliberately deferred). It is a **contract with done-ness**: a sentence the
 * human wants to be true, four clauses bounding how it may be pursued, and a
 * workflow that stops for a human at named checkpoints. All of which compiles
 * onto s11 T7's substrate without adding a scheduler, a queue, or a second
 * store:
 *
 *   the Goal's id IS its Job's id   `agent_proposals` ↔ `agent_invocations`,
 *                                   applied again. One id, no join key to keep
 *                                   in sync, and every derived number read off
 *                                   the nodes rather than mirrored beside them.
 *   status                          DERIVED (`deriveJobStatus` over the nodes,
 *                                   plus the three facts a Job cannot know:
 *                                   cancelled, accepted, and a plan checkpoint
 *                                   still open).
 *   progress                        DERIVED, counted from the same rows.
 *   milestones                      DERIVED: the goal's own proposals, in time
 *                                   order. Never store what can be derived.
 *
 * ── WHAT IS STORED, AND WHY EACH ITEM CANNOT BE DERIVED ────────────────────
 *   statement       the human's sentence.
 *   contract_json   what they bounded it with. Kept as AUTHORED, never as the
 *                   compiled form, so the face and the enforcement can be
 *                   compared rather than assumed equal.
 *   checkpoints     which classes still stop for a person.
 *   cancelled/accepted  the two judgments a machine must not make for itself.
 *
 * ── THE VERBS ──────────────────────────────────────────────────────────────
 *   create   compile the contract, start the Job, arm the escalation Watch.
 *   update   graduate/demote ONE checkpoint class, or cancel the goal.
 *   get/query  read.
 *   destroy  refused. A goal is a record of authority you handed over; the
 *            answer to "I am done with this" is `cancelled`, which keeps the
 *            history. Deleting it would erase the one thing an audit needs.
 */

interface GoalRow {
  id: string;
  account_id: string;
  statement: string;
  contract_json: string;
  checkpoints_json: string;
  escalation_watch_id: string | null;
  created_by: string;
  created_at: number;
  cancelled_at: number | null;
  cancelled_by: string | null;
  accepted_at: number | null;
  accepted_by: string | null;
}

/** A goal's derived timeline entry: one proposal, as a milestone. */
interface MilestoneRow {
  id: string;
  kind: string;
  status: string;
  created_at: number;
  decided_at: number | null;
  rationale: string;
}

export function registerGoalMethods(registry: MethodRegistry<RequestContext>): void {
  registry.register("Goal/get", async (args, ctx) => {
    const access = await requireAccount(ctx, args, "read");
    const ids = args.ids === null || args.ids === undefined ? undefined : (args.ids as string[]);

    let rows: GoalRow[];
    if (ids === undefined) {
      rows = (
        await ctx.env.DB.prepare(`SELECT * FROM goals WHERE account_id = ? ORDER BY created_at DESC LIMIT 256`)
          .bind(access.accountId)
          .all<GoalRow>()
      ).results;
    } else if (ids.length === 0) {
      rows = [];
    } else {
      const marks = ids.map(() => "?").join(",");
      rows = (
        await ctx.env.DB.prepare(`SELECT * FROM goals WHERE account_id = ? AND id IN (${marks})`)
          .bind(access.accountId, ...ids)
          .all<GoalRow>()
      ).results;
    }

    const facts = await goalFacts(
      ctx,
      access.accountId,
      rows.map((r) => r.id),
    );
    const list = rows.map((row) => project(row, facts));
    const found = new Set(rows.map((r) => r.id));
    return {
      accountId: access.accountId,
      state: await accountState(ctx, access.accountId),
      list,
      notFound: (ids ?? []).filter((id) => !found.has(id)),
    };
  });

  registry.register("Goal/query", async (args, ctx) => {
    const access = await requireAccount(ctx, args, "read");
    const filter = (args.filter as Record<string, unknown> | null | undefined) ?? null;
    if (filter) {
      for (const key of Object.keys(filter)) {
        if (key !== "open") throw new MethodError("unsupportedFilter", `unknown filter property "${key}"`);
      }
    }
    // `open` is the only filter, and it is a filter over AUTHORED facts
    // (cancelled/accepted) rather than over derived status — the derived
    // status is computed per goal from its nodes, and a SQL filter over it
    // would be a second implementation of `deriveJobStatus` in a WHERE clause.
    const open = filter?.open;
    const sql =
      open === true
        ? `SELECT id FROM goals WHERE account_id = ? AND cancelled_at IS NULL AND accepted_at IS NULL
             ORDER BY created_at DESC LIMIT 256`
        : `SELECT id FROM goals WHERE account_id = ? ORDER BY created_at DESC LIMIT 256`;
    const { results } = await ctx.env.DB.prepare(sql).bind(access.accountId).all<{ id: string }>();
    return {
      accountId: access.accountId,
      queryState: await accountState(ctx, access.accountId),
      canCalculateChanges: false,
      position: 0,
      ids: results.map((r) => r.id),
    };
  });

  registry.register("Goal/changes", async () => {
    throw new MethodError("cannotCalculateChanges");
  });

  registry.register("Goal/set", async (args, ctx) => {
    // `draft` + `mail`, the AgentInvocation/set gate: creating a goal creates
    // an invocation, which causes an agent to draft. Deliberately NOT `send`
    // — a goal cannot egress anything by itself, and every message it produces
    // meets the capability wall on its own account.
    const access = await requireAccount(ctx, args, "draft", "mail");
    const oldState = await accountState(ctx, access.accountId);
    if (typeof args.ifInState === "string" && args.ifInState !== oldState) {
      throw new MethodError("stateMismatch");
    }

    const created: Record<string, Record<string, unknown>> = {};
    const notCreated: Record<string, { type: string; description?: string }> = {};
    const updated: Record<string, null> = {};
    const notUpdated: Record<string, { type: string; description?: string }> = {};
    const notDestroyed: Record<string, { type: string; description?: string }> = {};
    const entries: ChangeEntry[] = [];
    const goalEntry: ChangeEntry = { collection: "Goal", created: [], updated: [], destroyed: [] };

    for (const [cid, spec] of Object.entries((args.create as Record<string, Record<string, unknown>>) ?? {})) {
      const outcome = await createGoal(ctx, access.accountId, spec);
      if (!outcome.ok) {
        notCreated[cid] = { type: outcome.type, description: outcome.description };
        continue;
      }
      created[cid] = outcome.goal;
      goalEntry.created.push(outcome.id);
      entries.push({ collection: "AgentInvocation", created: [outcome.rootId], updated: [], destroyed: [] });
      if (outcome.watchId) {
        entries.push({ collection: "Watch", created: [outcome.watchId], updated: [], destroyed: [] });
      }
    }

    for (const [id, patch] of Object.entries((args.update as Record<string, Record<string, unknown>>) ?? {})) {
      const outcome = await updateGoal(ctx, access.accountId, id, patch);
      if (!outcome.ok) {
        notUpdated[id] = { type: outcome.type, description: outcome.description };
        continue;
      }
      updated[id] = null;
      goalEntry.updated.push(id);
      if (outcome.stoppedNodes.length > 0) {
        entries.push({
          collection: "AgentInvocation",
          created: [],
          updated: outcome.stoppedNodes,
          destroyed: [],
        });
      }
    }

    for (const id of (args.destroy as string[] | undefined) ?? []) {
      // A goal is the record of authority you handed over. "I am done with
      // this" is `cancelled` — which keeps the record — and deleting one would
      // erase exactly what an audit is for.
      notDestroyed[id] = {
        type: "forbidden",
        description: "a goal is cancelled, never destroyed — the record of what you delegated is the point",
      };
    }

    const all = [goalEntry, ...entries].filter((e) => e.created.length + e.updated.length + e.destroyed.length > 0);
    let newState = oldState;
    if (all.length > 0) ({ newState } = await commitChanges(ctx.env.ACCOUNT_DO, access.accountId, all));

    return {
      accountId: access.accountId,
      oldState,
      newState,
      created,
      notCreated,
      updated,
      notUpdated,
      destroyed: [],
      notDestroyed,
    };
  });
}

// ---- create ---------------------------------------------------------------

type CreateOutcome =
  | { ok: true; id: string; rootId: string; watchId: string | null; goal: Record<string, unknown> }
  | { ok: false; type: string; description: string };

/**
 * Start a goal: compile the contract, mint the Job with a PLANNER root, write
 * the goals row, arm the escalation Watch.
 *
 * The order matters. `startJobRows` runs FIRST because it is the thing that can
 * refuse — the binding's ceiling, the kill switch, the caps — and a goals row
 * describing a Job that was never created would be a contract with nothing
 * under it. Everything after it is bookkeeping that cannot fail on authority.
 */
async function createGoal(
  ctx: RequestContext,
  accountId: string,
  spec: Record<string, unknown>,
): Promise<CreateOutcome> {
  const statement = typeof spec.statement === "string" ? spec.statement.trim() : "";
  if (statement.length === 0) {
    return {
      ok: false,
      type: "invalidProperties",
      description: "a goal needs a `statement` — what do you want to be true?",
    };
  }
  const bindingId = typeof spec.bindingId === "string" ? spec.bindingId : "";
  if (!bindingId) {
    return {
      ok: false,
      type: "invalidProperties",
      description: "a goal needs a `bindingId` — which agent holds this delegation",
    };
  }
  const parsed = parseGoalContract(spec.contract);
  if (!parsed.ok) return { ok: false, type: "invalidProperties", description: parsed.why };
  const contract = parsed.contract;

  const maxNodes = clamp(spec.maxNodes, GOAL_DEFAULT_MAX_NODES);
  const maxDepth = clamp(spec.maxDepth, GOAL_DEFAULT_MAX_DEPTH);
  const compiled = compileContract(contract, maxNodes);

  const started = await startJobRows(ctx.env, {
    accountId,
    bindingId,
    budgetMicros: compiled.budgetMicros,
    maxNodes,
    maxDepth,
    // The root is the PLANNER. Its authority is the contract's — narrowed
    // again by the binding inside `startJobRows`, because a contract is a
    // human's ask and the binding's ceiling is the fact.
    authority: {
      tools: compiled.authority.tools,
      credentials: compiled.authority.credentials,
      budgetMicros: compiled.authority.budgetMicros,
    },
    // No `plan` in the root context: the decomposition is produced at runtime,
    // inside the planner node, from this contract (s11 T7's progressive
    // revelation — the plan is not front matter).
    rootContext: { kind: "job-node", op: "plan" },
  });
  if (!started.ok) {
    return { ok: false, type: "forbidden", description: describeRefusals(started.refusals) };
  }

  const now = Date.now();
  const checkpoints = defaultCheckpoints();
  await ctx.env.DB.prepare(
    `INSERT INTO goals (id, account_id, statement, contract_json, checkpoints_json,
                        escalation_watch_id, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
  )
    .bind(
      started.jobId,
      accountId,
      statement,
      JSON.stringify(contract),
      JSON.stringify(checkpoints),
      ctx.principal.username,
      now,
    )
    .run();

  // ESCALATE-WHEN, compiled: a Watch on the Job itself. Not new machinery —
  // s20 T1's engine, armed on a goal instead of on a message, firing into the
  // same approvals queue as everything else. `notify` and not `draft-followup`
  // deliberately: "this goal has been running a while" is an FYI to the person
  // who delegated it, and a follow-up drafted to nobody in particular would be
  // the agent inventing a recipient.
  //
  // `source_ref` is left NULL ON PURPOSE, and it is the one place this compile
  // does not reuse a column: the fire path reads a present `source_ref` as an
  // EMAIL id (`watches.ts` stamps `subject: { realm: "Email", … }` from it), so
  // putting a goal id there would mint a proposal whose subject pointed at a
  // message that does not exist. The goal rides `condition_json` instead, and
  // the link that a surface actually needs — goal → watch — is the
  // `escalation_watch_id` column below.
  let watchId: string | null = null;
  if (contract.escalateWhen) {
    watchId = `w_${crypto.randomUUID()}`;
    try {
      await ctx.env.DB.prepare(
        `INSERT INTO watches
           (id, account_id, owner, condition_type, condition_json, deadline_at,
            action_type, action_json, status, source_ref, created_at)
         VALUES (?, ?, ?, 'deadline', ?, ?, 'notify', ?, 'armed', NULL, ?)`,
      )
        .bind(
          watchId,
          accountId,
          ctx.principal.username,
          JSON.stringify({ goalId: started.jobId }),
          now + contract.escalateWhen.afterMs,
          JSON.stringify({
            goalId: started.jobId,
            note: contract.escalateWhen.note ?? `Goal still open: ${statement}`,
          }),
          now,
        )
        .run();
      await ctx.env.DB.prepare(`UPDATE goals SET escalation_watch_id = ? WHERE account_id = ? AND id = ?`)
        .bind(watchId, accountId, started.jobId)
        .run();
    } catch (err) {
      // A shard without the watches table (or a watch that will not arm) must
      // not lose the goal — the escalation is a courtesy, the delegation is
      // the artifact. Loud in the log, absent in the projection, so the goal
      // view shows no escalation rather than a promised one that does not exist.
      console.warn(`goal ${started.jobId}: escalation watch not armed — ${err instanceof Error ? err.message : err}`);
      watchId = null;
    }
  }

  const row: GoalRow = {
    id: started.jobId,
    account_id: accountId,
    statement,
    contract_json: JSON.stringify(contract),
    checkpoints_json: JSON.stringify(checkpoints),
    escalation_watch_id: watchId,
    created_by: ctx.principal.username,
    created_at: now,
    cancelled_at: null,
    cancelled_by: null,
    accepted_at: null,
    accepted_by: null,
  };
  const facts = await goalFacts(ctx, accountId, [started.jobId]);
  return { ok: true, id: started.jobId, rootId: started.rootId, watchId, goal: project(row, facts) };
}

// ---- update ---------------------------------------------------------------

type UpdateOutcome = { ok: true; stoppedNodes: string[] } | { ok: false; type: string; description: string };

/**
 * Two verbs, and neither of them edits the contract.
 *
 *   checkpoints  graduate or demote ONE class. Per class, never globally.
 *   status       `cancelled` — revoke the standing authority.
 *
 * A contract is deliberately IMMUTABLE. Widening one after the fact would be a
 * delegation nobody approved wearing the id of one they did, and every node
 * already running under it re-reads it at use time — so an edit would
 * retroactively re-authorize work in flight. Want different bounds? That is a
 * different goal, and starting one costs a sentence.
 */
async function updateGoal(
  ctx: RequestContext,
  accountId: string,
  id: string,
  patch: Record<string, unknown>,
): Promise<UpdateOutcome> {
  const row = await ctx.env.DB.prepare(`SELECT * FROM goals WHERE account_id = ? AND id = ?`)
    .bind(accountId, id)
    .first<GoalRow>();
  if (!row) return { ok: false, type: "notFound", description: "no such goal on this account" };

  if (patch.contract !== undefined || patch.statement !== undefined) {
    return {
      ok: false,
      type: "invalidProperties",
      description:
        "a goal's statement and contract are immutable — nodes re-read the contract at use time, so an edit " +
        "would retroactively re-authorize work already in flight. Cancel this goal and state a new one.",
    };
  }

  if (patch.status !== undefined) {
    if (patch.status !== "cancelled") {
      return {
        ok: false,
        type: "invalidProperties",
        description: 'the only status a client may write is "cancelled" — every other status is derived',
      };
    }
    if (row.cancelled_at)
      return { ok: false, type: "invalidProperties", description: "this goal is already cancelled" };
    const now = Date.now();
    await ctx.env.DB.prepare(
      `UPDATE goals SET cancelled_at = ?, cancelled_by = ? WHERE account_id = ? AND id = ? AND cancelled_at IS NULL`,
    )
      .bind(now, ctx.principal.username, accountId, id)
      .run();
    // REVOCATION HAS TO BITE, not merely be recorded. Pending nodes are failed
    // with a note; running ones are left alone (they hold a claim, and a
    // status this method wrote under a runtime would be a lie about what is
    // executing) — but nothing they produce can proceed, because every goal
    // node re-checks `cancelled_at` before it proposes anything.
    const { results } = await ctx.env.DB.prepare(
      `SELECT id FROM agent_invocations WHERE account_id = ? AND job_id = ? AND status = 'pending'`,
    )
      .bind(accountId, id)
      .all<{ id: string }>();
    if (results.length > 0) {
      await ctx.env.DB.prepare(
        `UPDATE agent_invocations
            SET status = 'failed', done_at = ?, result_json = ?
          WHERE account_id = ? AND job_id = ? AND status = 'pending'`,
      )
        .bind(now, JSON.stringify({ kind: "job-node", note: "the goal was cancelled" }), accountId, id)
        .run();
    }
    return { ok: true, stoppedNodes: results.map((r) => r.id) };
  }

  if (patch.checkpoints !== undefined) {
    const asked = patch.checkpoints;
    if (typeof asked !== "object" || asked === null || Array.isArray(asked)) {
      return { ok: false, type: "invalidProperties", description: "`checkpoints` must be an object of class → mode" };
    }
    const current = readCheckpoints(row.checkpoints_json);
    const now = Date.now();
    for (const [cls, mode] of Object.entries(asked as Record<string, unknown>)) {
      if (!isCheckpointClass(cls)) {
        return { ok: false, type: "invalidProperties", description: `unknown checkpoint class "${cls}"` };
      }
      if (mode !== "manual" && mode !== "auto") {
        return {
          ok: false,
          type: "invalidProperties",
          description: `a checkpoint is "manual" or "auto", not "${String(mode)}"`,
        };
      }
      if (mode === "auto" && !GRADUABLE_CLASSES.includes(cls)) {
        // THE REFUSAL THAT KEEPS THE TOGGLE HONEST. Recording `auto` on a
        // class with no enforcement point would render as autonomy and deliver
        // none — a setting that lies about how much authority you just handed
        // over, which is the single worst bug this surface could ship. Egress
        // classes still exit via /approvals and still meet the capability wall,
        // so until something wires them, the answer is no and it says why.
        return {
          ok: false,
          type: "invalidProperties",
          description:
            `the "${cls}" checkpoint cannot graduate yet: nothing enforces it — every message a goal produces ` +
            "still leaves through /approvals, and a tier-3 egress still needs a human. Recording it as auto " +
            "would be a widening that does not exist.",
        };
      }
      current[cls] = mode === "auto" ? { mode, by: ctx.principal.username, at: now } : { mode };
    }
    await ctx.env.DB.prepare(`UPDATE goals SET checkpoints_json = ? WHERE account_id = ? AND id = ?`)
      .bind(JSON.stringify(current), accountId, id)
      .run();
    return { ok: true, stoppedNodes: [] };
  }

  return { ok: false, type: "invalidProperties", description: "nothing to update: send `checkpoints` or `status`" };
}

// ---- the projection (everything derived) ---------------------------------

/**
 * Everything the projection needs, for a WHOLE PAGE of goals, in three queries.
 *
 * The obvious shape was three queries per goal, and it was an N+1 the moment
 * `Goal/get { ids: null }` — the roster read every client makes — returned more
 * than a couple of rows. Fanned in on `job_id IN (…)` instead, over the index
 * `invocations_job` already provides, then folded per goal in memory.
 *
 * Still deliberately NOT a stored projection, on `jobView`'s reasoning: at
 * bullmoose scale a goal is tens of rows on an indexed scan, and the reconcile
 * test a materialization would owe costs more than the scan does.
 */
interface GoalFacts {
  nodes: Map<string, JobNodeState[]>;
  spend: Map<string, number>;
  milestones: Map<string, MilestoneRow[]>;
  jobs: Map<string, { budget_micros: number | null; max_nodes: number }>;
}

async function goalFacts(ctx: RequestContext, accountId: string, ids: readonly string[]): Promise<GoalFacts> {
  const facts: GoalFacts = { nodes: new Map(), spend: new Map(), milestones: new Map(), jobs: new Map() };
  if (ids.length === 0) return facts;
  const marks = ids.map(() => "?").join(",");

  const { results: nodeRows } = await ctx.env.DB.prepare(
    `SELECT inv.id, inv.job_id, inv.status, inv.needs_json, inv.cost_micros,
            EXISTS (SELECT 1 FROM agent_proposals p
                     WHERE p.account_id = inv.account_id AND p.id = inv.id
                       AND p.status = 'info-requested') AS paused
       FROM agent_invocations inv
      WHERE inv.account_id = ? AND inv.job_id IN (${marks})`,
  )
    .bind(accountId, ...ids)
    .all<{
      id: string;
      job_id: string;
      status: string;
      needs_json: string | null;
      cost_micros: number | null;
      paused: number;
    }>();
  for (const r of nodeRows) {
    const list = facts.nodes.get(r.job_id) ?? [];
    list.push({
      id: r.id,
      status: r.status as JobNodeState["status"],
      needs: parseNeeds(r.needs_json),
      paused: r.paused === 1,
    });
    facts.nodes.set(r.job_id, list);
    facts.spend.set(r.job_id, (facts.spend.get(r.job_id) ?? 0) + (r.cost_micros ?? 0));
  }

  // The milestones: each goal's own proposals, time-ordered. A goal's timeline
  // IS its proposals — never a second event log, because two logs of the same
  // decisions is one log and one liability.
  const { results: proposals } = await ctx.env.DB.prepare(
    `SELECT p.id, inv.job_id, p.kind, p.status, p.created_at, p.decided_at, p.rationale
       FROM agent_proposals p
       JOIN agent_invocations inv ON inv.account_id = p.account_id AND inv.id = p.id
      WHERE p.account_id = ? AND inv.job_id IN (${marks})
      ORDER BY p.created_at ASC LIMIT 1024`,
  )
    .bind(accountId, ...ids)
    .all<MilestoneRow & { job_id: string }>();
  for (const p of proposals) {
    const list = facts.milestones.get(p.job_id) ?? [];
    list.push(p);
    facts.milestones.set(p.job_id, list);
  }

  const { results: jobs } = await ctx.env.DB.prepare(
    `SELECT id, budget_micros, max_nodes FROM jobs WHERE account_id = ? AND id IN (${marks})`,
  )
    .bind(accountId, ...ids)
    .all<{ id: string; budget_micros: number | null; max_nodes: number }>();
  for (const j of jobs) facts.jobs.set(j.id, { budget_micros: j.budget_micros, max_nodes: j.max_nodes });

  return facts;
}

/**
 * A goal, as a client reads it — a pure fold over the row and the facts above.
 * Nothing here is stored: status, progress and the timeline are all counted
 * from the same nodes and proposals every other surface reads.
 */
function project(row: GoalRow, facts: GoalFacts): Record<string, unknown> {
  const parsed = parseGoalContract(safeJson(row.contract_json));
  const contract: GoalContract | null = parsed.ok ? parsed.contract : null;
  const nodes = facts.nodes.get(row.id) ?? [];
  const milestones = facts.milestones.get(row.id) ?? [];
  const job = facts.jobs.get(row.id);

  const planCheckpointOpen = milestones.some((p) => p.kind === GOAL_PLAN_KIND && p.status === "pending");
  const status = deriveGoalStatus({
    jobStatus: deriveJobStatus(nodes),
    planCheckpointOpen,
    cancelledAt: row.cancelled_at,
    acceptedAt: row.accepted_at,
  });

  const checkpoints = readCheckpoints(row.checkpoints_json);
  return {
    id: row.id,
    statement: row.statement,
    contract,
    // Said out loud rather than left for a client to infer from
    // `contract === null`: a stored blob this server cannot read means the
    // goal's bounds are UNKNOWN, and every node under it will refuse to act.
    contractReadable: contract !== null,
    checkpoints: renderCheckpoints(checkpoints),
    status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    cancelledAt: row.cancelled_at,
    cancelledBy: row.cancelled_by,
    acceptedAt: row.accepted_at,
    acceptedBy: row.accepted_by,
    escalationWatchId: row.escalation_watch_id,
    budgetMicros: job?.budget_micros ?? null,
    maxNodes: job?.max_nodes ?? null,
    spentMicros: facts.spend.get(row.id) ?? 0,
    progress: {
      total: nodes.length,
      pending: nodes.filter((n) => n.status === "pending").length,
      running: nodes.filter((n) => n.status === "running").length,
      done: nodes.filter((n) => n.status === "done").length,
      failed: nodes.filter((n) => n.status === "failed").length,
    },
    milestones: milestones.map((p) => ({
      proposalId: p.id,
      kind: p.kind,
      checkpointClass: checkpointClassOf(p.kind),
      status: p.status,
      createdAt: p.created_at,
      decidedAt: p.decided_at,
      summary: p.rationale,
    })),
  };
}

/**
 * The checkpoint policy, as a client renders it — mode PLUS whether the class
 * could graduate at all.
 *
 * `graduable: false` is the line that keeps the surface honest: a class shown
 * as "manual" with no explanation reads as an unfinished setting, and a person
 * who flips it and sees nothing happen learns that the controls are decorative.
 * Saying "manual, and nothing wires auto yet" is the difference between a
 * product that is unfinished and one that is untrustworthy.
 */
function renderCheckpoints(policy: CheckpointPolicy): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const cls of CHECKPOINT_CLASSES) {
    out[cls] = {
      mode: policy[cls].mode,
      graduable: GRADUABLE_CLASSES.includes(cls),
      ...(policy[cls].by ? { by: policy[cls].by } : {}),
      ...(policy[cls].at ? { at: policy[cls].at } : {}),
    };
  }
  return out;
}

/**
 * Read the stored policy. Anything unparseable reads as `manual` — the one
 * place in this codebase where a malformed blob degrades to MORE caution
 * rather than less, because a corrupt policy that read as `auto` would widen
 * autonomy on the strength of a JSON parse error.
 */
function readCheckpoints(raw: string | null): CheckpointPolicy {
  const out = defaultCheckpoints();
  const parsed = safeJson(raw ?? "");
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return out;
  for (const cls of CHECKPOINT_CLASSES as readonly CheckpointClass[]) {
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

function clamp(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}
