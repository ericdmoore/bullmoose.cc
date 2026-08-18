import { commitChanges } from "@bullmoose/account-do";
import {
  attenuatePlan,
  bindingCeiling,
  delegationPath,
  describeRefusals,
  effectiveNodeCeiling,
  isPrivacyClass,
  parseHandoffPolicy,
  planHandoff,
  stampHandoff,
  type BindingJobConfig,
  type ChildRequest,
  type HandoffProvenance,
  type Refusal,
} from "@bullmoose/scheduling";
import { getJobNode, insertJobChildren, startJob } from "./jobs.js";
import type { Env } from "./models.js";

/**
 * s17 — AGENT-TO-AGENT HANDOFF, the DB-backed half. The machinery by which one
 * agent hands work to another.
 *
 * `packages/scheduling/src/handoff.ts` is the arithmetic — the reciprocal
 * allowlists, the cycle rule, the crossing cap, the intersection. This module
 * is the rows: it reads the chain, resolves the colleague, and writes ONE node
 * through the SAME guarded INSERT a plan expansion uses.
 *
 * ── WHY A HANDOFF IS A JOB NODE AND NOT A NEW KIND OF THING ────────────────
 *
 * `.plans/s17-chief-of-staff/readme.md` says the Job DAG is CJ's spine, and
 * §4's two conditions for un-deferring `agents:invoke` are a chain-depth cap
 * and a shared budget — both of which a Job already has. Making a handoff
 * anything OTHER than a node would mean re-deriving:
 *
 *   the depth cap        `jobs.max_depth`, re-checked inside the guarded INSERT
 *   the shared budget    `jobs.budget_micros`, reserved at create and enforced
 *                        at claim (`jobBudgetExhaustedSql`)
 *   the attenuation      `attenuatePlan` → `attenuateChild`, every axis
 *   the use-time fold    `effectiveNodeAuthority`, which already intersects
 *                        EVERY binding a chain crosses (#138) — written for
 *                        this day, and dormant until it
 *   the kill switch      `bindingDisabledSql` holds a pending row on a disabled
 *                        binding, for handed-off work exactly as for any other
 *   the egress rule      `job_id` non-NULL is what makes a leaf's reply PROPOSE
 *                        instead of send (index.ts, the respond-only rule)
 *
 * Six controls, none of them re-implemented. That is the argument, and it is
 * also the reason this file is short.
 *
 * ── NO EGRESS LAUNDERING ───────────────────────────────────────────────────
 *
 * s11 T7's sentence governs and is not weakened here: *"side-effectful leaves
 * still exit via /approvals — a Job reorganizes work, never its egress."* Every
 * node this module creates carries a non-NULL `job_id`, and `runInvocation`
 * reads exactly that column to decide that a reply must become a `reply-draft`
 * PROPOSAL rather than a send — including in a `send`-mode binding whose
 * governing book already contains the recipient. So a handoff cannot become a
 * way for work to reach the outside world without the approval it would
 * otherwise need, and the approval path re-checks the outbound bound against
 * the ROW's binding (`actionProposal.ts`: `assertOutboundAllowed(..., {
 * binding_id: row.binding_id })`) — the RECEIVER's book, with a human in the
 * loop. That is the answer to `agents-invoke.md`'s sharpest question ("whose
 * governing book bounds a cross-binding send?"): the receiver's, and a human's.
 * Neither binding's book is silently lent to the other, because no delegated
 * send happens without a person pressing approve.
 *
 * ── THE SEAM ───────────────────────────────────────────────────────────────
 *
 * `delegate()` is the one function the Delegate VERB should call. The verb
 * itself is not built here (its apply case lives in `actionProposal.ts`); this
 * is the machinery underneath it, shipped working and tested with no button.
 */

/** What the caller asks for. Every field is validated, none is believed. */
export interface DelegateRequest {
  accountId: string;
  /** The invocation doing the handing — a Job node, or any invocation (see below). */
  fromInvocationId: string;
  /** The colleague, BY NAME. Ambiguous or absent refuses; it never guesses. */
  toBindingName: string;
  /** The sender's why. Required — it is the provenance a human reads. */
  reason: string;
  /**
   * The work, in the same `ChildRequest` shape a plan's task uses — so the
   * handed-off task passes through `attenuatePlan` → `attenuateChild` with
   * every axis checked by the one implementation that checks them everywhere
   * else. `bindingId` is supplied by this module and a request that names its
   * own is refused by the identity axis, as it should be.
   */
  task: ChildRequest;
  /**
   * Only read by `delegate()`, and only when the sender is NOT already in a
   * Job: the shape of the Job that gets opened. Absent means the defaults in
   * `openDelegation`, which are deliberately narrow — see there.
   */
  open?: Omit<OpenDelegationRequest, "accountId" | "fromInvocationId" | "reason">;
}

export interface Handoff {
  /** The created node. */
  invocationId: string;
  jobId: string;
  toBindingId: string;
  toBindingName: string;
  /** Which binding crossing this is, 1-based. */
  hop: number;
  /**
   * The receiving binding is switched OFF, so the work is created and WAITS.
   * Not an error and not a refusal — see `HandoffPlan.waiting`. Reported so the
   * caller can say "handed to Allen, who is currently disabled" out loud.
   */
  waiting: boolean;
  provenance: HandoffProvenance;
}

export type DelegateResult = { ok: true; handoff: Handoff } | { ok: false; refusals: Refusal[] };

/** A refusal from this module, in the shape the pure modules emit. */
function refusal(axis: Refusal["axis"], requested: string, ceiling: string, why: string): Refusal {
  return { key: "(handoff)", axis, requested, ceiling, why };
}

/** One binding row, as both halves of the handoff need it. */
interface BindingRow {
  id: string;
  name: string;
  enabled: number;
  config_json: string;
}

function jobsConfig(configJson: string): BindingJobConfig | undefined {
  try {
    return (JSON.parse(configJson) as { jobs?: BindingJobConfig }).jobs;
  } catch {
    // An unparseable config is an UNSET ceiling here, exactly as `startJob` and
    // `configAuthority` treat it — and, separately, NO handoff policy, because
    // `parseHandoffPolicy` degrades garbage to empty. The two readings differ
    // on purpose; see BindingJobConfig.handoff.
    return undefined;
  }
}

function privacyFloorOf(configJson: string): "open" | "internal" | "pinned" | null {
  try {
    const v = (JSON.parse(configJson) as { privacyFloor?: unknown }).privacyFloor;
    return isPrivacyClass(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a colleague BY NAME, refusing ambiguity rather than picking.
 *
 * `agent_bindings` has no unique index on `(account_id, name)` — the primary
 * key is `(account_id, id)` — so two bindings CAN share a name. Everywhere
 * else in the tree that resolves a binding by name is a convenience
 * (`VERB_BINDING_NAME`, `REPROVISION_BINDING`); here the name is half of a
 * SECURITY control, because `acceptsFrom: ["cj"]` names a party. Picking one
 * of two rows would mean the allowlist authorized a binding the operator did
 * not have in mind, so this refuses and says which name is ambiguous.
 */
async function bindingByName(env: Env, accountId: string, name: string): Promise<BindingRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, name, enabled, COALESCE(config_json, '{}') AS config_json
       FROM agent_bindings WHERE account_id = ? AND name = ? ORDER BY id`,
  )
    .bind(accountId, name)
    .all<BindingRow>();
  return results;
}

async function bindingById(env: Env, accountId: string, id: string): Promise<BindingRow | null> {
  return env.DB.prepare(
    `SELECT id, name, enabled, COALESCE(config_json, '{}') AS config_json
       FROM agent_bindings WHERE account_id = ? AND id = ?`,
  )
    .bind(accountId, id)
    .first<BindingRow>();
}

/**
 * HAND ONE PIECE OF WORK TO A COLLEAGUE.
 *
 * The sender MUST already be a node of a Job: the Job is what carries the
 * depth cap, the aggregate budget and the chain the fold walks, and a handoff
 * without one would be a delegation with no ceiling above it. `delegate()`
 * below is the on-ramp for an ordinary invocation that has no Job yet.
 *
 * The order of operations is the order of the argument:
 *
 *   1. AUTHORIZE, THEN MEASURE. The sender's EFFECTIVE ceiling comes first
 *      (`effectiveNodeCeiling`, which re-folds binding ∩ root ∩ … ∩ sender from
 *      the rows), so a sender whose own chain is corrupt, grafted or cyclic is
 *      refused before this function reads another row on its behalf. A node's
 *      stored `authority_json` is never used as its ceiling — a column is a
 *      claim, the fold is the fact.
 *   2. THE ROUTE. `planHandoff` checks the reciprocal allowlists, the cycle
 *      rule and the crossing cap, and returns the NARROWED ceiling
 *      (sender ∩ receiver, tightest privacy floor).
 *   3. THE TASK. `attenuatePlan` against that ceiling — every axis, plus the
 *      Job's `maxNodes` / `maxDepth` / aggregate-budget reservation. One
 *      implementation of the delegation rules, reused rather than mirrored.
 *   4. THE WRITE. The same guarded INSERT `expandPlan` uses, which re-checks
 *      all three caps inside the statement so a concurrently-expanding sibling
 *      cannot race past them.
 */
export async function handOff(env: Env, req: DelegateRequest): Promise<DelegateResult> {
  const { accountId, fromInvocationId, toBindingName, reason, task } = req;

  const sender = await getJobNode(env, accountId, fromInvocationId);
  if (!sender) {
    return {
      ok: false,
      refusals: [refusal("identity", fromInvocationId, "an invocation on this account", "no such invocation")],
    };
  }
  if (!sender.job_id) {
    return {
      ok: false,
      refusals: [
        refusal(
          "job",
          "(none)",
          "a Job node",
          "a handoff rides a Job — the Job is what carries the depth cap, the aggregate budget and the chain the authority fold walks. Use delegate(), which opens one first",
        ),
      ],
    };
  }

  const job = await env.DB.prepare(
    `SELECT id, budget_micros, max_nodes, max_depth FROM jobs WHERE account_id = ? AND id = ?`,
  )
    .bind(accountId, sender.job_id)
    .first<{ id: string; budget_micros: number | null; max_nodes: number; max_depth: number }>();
  if (!job) {
    return { ok: false, refusals: [refusal("job", sender.job_id, "an existing Job", "no such Job row")] };
  }

  // (1) The use-time bound, first.
  const effective = await effectiveNodeCeiling(env, sender);
  if (!effective.ok) {
    return {
      ok: false,
      refusals: [
        refusal(effective.denial.axis, effective.denial.requested, effective.denial.ceiling, effective.denial.why),
      ],
    };
  }
  // The route the work has already taken, read from the SAME walk the fold
  // does — so the cycle rule and the intersection can never disagree about
  // what this chain is.
  const path = await delegationPath(env, accountId, sender);
  if (!path.ok) {
    return {
      ok: false,
      refusals: [refusal(path.denial.axis, path.denial.requested, path.denial.ceiling, path.denial.why)],
    };
  }

  // The two bindings. The sender's row is read for its POLICY only — its
  // ceiling is already inside `effective` via the fold, and reading it twice
  // would be two chances to read it differently.
  const senderBinding = await bindingById(env, accountId, sender.binding_id);
  if (!senderBinding) {
    return {
      ok: false,
      refusals: [
        refusal(
          "identity",
          sender.binding_id,
          "a binding row on this account",
          "the handing binding no longer exists — a handoff needs a sender whose permissions can be read",
        ),
      ],
    };
  }
  // The 008 kill switch on the SENDER refuses outright — the mirror image of
  // what it does to the receiver, and the asymmetry is the switch's own logic.
  // A disabled RECEIVER holds queued work (nothing is cancelled, the row
  // waits); a disabled SENDER may not create NEW work, exactly as `startJob`
  // refuses to open a Job under one. The chain would fail closed anyway —
  // `chainBindingAuthority` denies a chain whose ancestor binding is disabled —
  // but a row that is guaranteed to fail its pre-flight is a worse answer than
  // a refusal that says why.
  if (senderBinding.enabled !== 1) {
    return {
      ok: false,
      refusals: [
        refusal(
          "identity",
          senderBinding.name,
          "an enabled binding",
          "the handing binding is disabled (008 kill switch) — a switched-off agent may not create work for a colleague",
        ),
      ],
    };
  }
  const candidates = await bindingByName(env, accountId, toBindingName);
  if (candidates.length === 0) {
    return {
      ok: false,
      refusals: [
        refusal("handoff", toBindingName, "a binding on this account", "no colleague by that name on this account"),
      ],
    };
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      refusals: [
        refusal(
          "handoff",
          toBindingName,
          "exactly one binding",
          `${candidates.length} bindings on this account share that name (${candidates.map((c) => c.id).join(", ")}) — an allowlist that names a party must not resolve to a party nobody meant`,
        ),
      ],
    };
  }
  const receiver = candidates[0]!;

  // (2) The route: allowlists, cycle, crossing cap, and the intersection.
  const routed = planHandoff({
    sender: {
      bindingId: senderBinding.id,
      bindingName: senderBinding.name,
      policy: parseHandoffPolicy(jobsConfig(senderBinding.config_json)?.handoff),
    },
    senderCeiling: effective.ceiling,
    receiver: {
      bindingId: receiver.id,
      bindingName: receiver.name,
      authority: bindingCeiling(accountId, receiver.id, sender.job_id, jobsConfig(receiver.config_json), {}).authority,
      privacyFloor: privacyFloorOf(receiver.config_json),
      policy: parseHandoffPolicy(jobsConfig(receiver.config_json)?.handoff),
      // A DISABLED receiver does not refuse — the work is created and waits.
      enabled: receiver.enabled === 1,
    },
    chain: { bindingIds: path.path.map((h) => h.bindingId) },
    reason,
    fromInvocationId: sender.id,
    now: Date.now(),
  });
  if (!routed.ok) return { ok: false, refusals: routed.refusals };

  // (3) The task, against the narrowed ceiling. `attenuatePlan` rather than
  // `attenuateChild` because the Job's batch caps — maxDepth, maxNodes, and
  // the aggregate-budget reservation — are the other half of §4's conditions
  // and belong to the same one implementation.
  const usage = await env.DB.prepare(
    `SELECT COUNT(*) AS n,
            COALESCE(SUM(CASE WHEN json_valid(authority_json)
                              THEN COALESCE(json_extract(authority_json, '$.budgetMicros'), 0)
                              ELSE 0 END), 0) AS reserved
       FROM agent_invocations WHERE account_id = ? AND job_id = ?`,
  )
    .bind(accountId, sender.job_id)
    .first<{ n: number; reserved: number }>();

  const attenuated = attenuatePlan(
    routed.plan.ceiling,
    // The receiving binding is named explicitly so the identity axis CHECKS it
    // rather than defaulting to it: a task that names a third binding is
    // refused, at the same line that refuses one inside a plain plan.
    [{ ...task, bindingId: routed.plan.ceiling.bindingId, key: handoffKey(task) }],
    { maxNodes: job.max_nodes, maxDepth: job.max_depth, budgetMicros: job.budget_micros },
    { nodeCount: usage?.n ?? 0, reservedMicros: usage?.reserved ?? 0 },
  );
  if (!attenuated.ok) return { ok: false, refusals: attenuated.refusals };

  const child = stampHandoff(attenuated.children[0]!, routed.plan.provenance);
  const invocationId = `inv_${crypto.randomUUID()}`;
  const ids = new Map([[child.key, invocationId]]);
  const now = Date.now();

  // (4) The guarded INSERT — the same one, with the binding NAME resolved per
  // child rather than copied from the parent (the denormalization lie a
  // cross-binding row would otherwise carry).
  const changes = await insertJobChildren(env, sender, job, [child], ids, now, (bindingId) =>
    bindingId === receiver.id ? receiver.name : sender.binding_name,
  );
  if (changes !== 1) {
    return {
      ok: false,
      refusals: [
        refusal(
          "fanout",
          String((usage?.n ?? 0) + 1),
          `${job.max_nodes} nodes / depth ${job.max_depth} / ${job.budget_micros ?? "unbounded"}µ$`,
          "the Job's caps were reached by a concurrent expansion; nothing was created",
        ),
      ],
    };
  }

  await commitChanges(env.ACCOUNT_DO, accountId, [
    { collection: "AgentInvocation", created: [invocationId], updated: [], destroyed: [] },
  ]);

  return {
    ok: true,
    handoff: {
      invocationId,
      jobId: sender.job_id,
      toBindingId: receiver.id,
      toBindingName: receiver.name,
      hop: routed.plan.hop,
      waiting: routed.plan.waiting,
      provenance: routed.plan.provenance,
    },
  };
}

/**
 * The plan-local key for a handed-off task. A handoff is a batch of one, so the
 * key names nothing but itself — but `attenuateChild` requires one (a task with
 * no key cannot be referenced by a sibling's `needs`, and an unnamed node is
 * unnameable on a progress surface). A caller-supplied key wins; otherwise the
 * colleague's own name is the honest default.
 */
function handoffKey(task: ChildRequest): string {
  return typeof task.key === "string" && task.key.length > 0 ? task.key : "handoff";
}

/**
 * OPEN A DELEGATION — the on-ramp for an invocation that is not yet in a Job.
 *
 * CJ's actual shape is "a vague email arrives, CJ decides Allen should handle
 * it". That first invocation is an ORDINARY one: no `job_id`, no envelope, no
 * chain. A handoff needs all three, so one has to be opened, and the question
 * is what its ROOT should be.
 *
 * It is a node on the HANDING binding, and that is structural rather than
 * decorative. `effectiveNodeAuthority` folds the bindings it finds ON THE
 * CHAIN; if the first node of the Job were the handed-off work itself, the
 * chain would contain only the RECEIVER's binding and the sender's ceiling
 * would be silently absent from the intersection — the widest hop winning,
 * which is the exact failure `nodeAuthority.ts` warns about. So the root is
 * CJ's own node, under CJ's own binding, and the handoff is its child. The
 * sender's ceiling is then the first term of every fold below it, forever.
 *
 * The root's work is `op: "echo"` — a free, deterministic, model-free node
 * carrying the reason. It IS the delegation record: the decision has already
 * been made by the caller, so there is nothing left for the root to compute,
 * and `runJobNode` completes it at zero cost (`cost_micros = 0`, KNOWN free,
 * never NULL). It is not a placeholder for work that failed to happen.
 *
 * The Job's ceiling is the HANDING binding's `config_json.jobs`, because
 * `startJob` attenuates the root against exactly that. Nothing here can widen
 * it: `budgetMicros`/`maxNodes`/`maxDepth` are the caller's ASK, clamped by the
 * binding's own and by the absolute ceilings.
 *
 * ── OPENING A DELEGATION NARROWS, AND THAT IS THE POINT ────────────────────
 * An ordinary invocation has NO envelope: `effectiveNodeAuthority` returns
 * `{tools: null, …}` for a row with no `job_id`, which is the documented gap in
 * `per-invocation-tokens.md`'s first correction — a `bmi_` token narrows the
 * account, the realm, the verbs and the lifetime of an ordinary invocation, but
 * not its tool set. The moment that invocation delegates, it acquires one:
 * `attenuateChild`'s rule 2 gives an unstated `tools` the EMPTY set, so a
 * delegation whose caller names no authority hands over work that may use
 * nothing. That is the correct direction and it is not a bug to be papered
 * over — a caller that wants the delegate to hold a tool must SAY so, in
 * `authority`, and it can only say things the handing binding's ceiling already
 * allows. The alternative, inheriting "unrestricted" through a hop, is
 * amplification-by-omission, which is the one thing this whole subsystem is
 * built to refuse.
 */
export interface OpenDelegationRequest {
  accountId: string;
  /** The invocation this delegation is on behalf of (its binding, its facets). */
  fromInvocationId: string;
  /** The sender's why — recorded on the root and repeated on the hop. */
  reason: string;
  /** The Job's aggregate spend cap, micro-USD. null/undefined = the binding's. */
  budgetMicros?: number | null;
  maxNodes?: number;
  maxDepth?: number;
  /** The root's requested authority, attenuated against the handing binding. */
  authority?: Pick<ChildRequest, "tools" | "credentials" | "budgetMicros">;
}

export type OpenDelegationResult = { ok: true; jobId: string; rootId: string } | { ok: false; refusals: Refusal[] };

export async function openDelegation(env: Env, req: OpenDelegationRequest): Promise<OpenDelegationResult> {
  const row = await env.DB.prepare(
    `SELECT id, binding_id, job_id, privacy, due_at, requires_json, email_id
       FROM agent_invocations WHERE account_id = ? AND id = ?`,
  )
    .bind(req.accountId, req.fromInvocationId)
    .first<{
      id: string;
      binding_id: string;
      job_id: string | null;
      privacy: string | null;
      due_at: number | null;
      requires_json: string | null;
      email_id: string | null;
    }>();
  if (!row) {
    return {
      ok: false,
      refusals: [refusal("identity", req.fromInvocationId, "an invocation on this account", "no such invocation")],
    };
  }
  if (row.job_id) {
    return {
      ok: false,
      refusals: [
        refusal(
          "job",
          row.job_id,
          "an invocation with no Job",
          "this invocation is already part of a Job — hand off from it directly rather than opening a second one, which would be a chain with no relationship to the first",
        ),
      ],
    };
  }

  let requires: unknown;
  try {
    requires = row.requires_json === null ? undefined : (JSON.parse(row.requires_json) as unknown);
  } catch {
    requires = undefined;
  }

  return startJob(env, {
    accountId: req.accountId,
    bindingId: row.binding_id,
    budgetMicros: req.budgetMicros ?? null,
    maxNodes: req.maxNodes ?? 4,
    maxDepth: req.maxDepth ?? 2,
    ...(req.authority ? { authority: req.authority } : {}),
    // The facets ride across from the invocation that caused the delegation:
    // a `pinned` message does not become an `open` Job by being delegated, and
    // a deadline does not evaporate. `attenuateChild` then holds every node
    // below to them.
    facets: {
      privacy: row.privacy,
      dueAt: row.due_at,
      ...(requires === undefined ? {} : { requires }),
    },
    rootContext: {
      kind: "job-node",
      op: "echo",
      text: req.reason,
      // The root says what it IS, so a progress surface reading `context_json`
      // does not have to infer "delegation record" from an echo node's text.
      delegation: { fromInvocationId: row.id, reason: req.reason },
    },
    emailId: row.email_id,
  });
}

/**
 * THE SEAM. One call: open a Job if there is not one, then hand the work over.
 *
 * This is the function the Delegate verb's apply case should call
 * (`services/jmap/src/methods/actionProposal.ts`, which is deliberately NOT
 * touched by this change — see the PR). It takes the account, the invocation
 * doing the delegating, the colleague's name, the why, and the task; it returns
 * either a `Handoff` or every reason there is not one.
 *
 * Note what it does NOT do, because the verb will want to know: it does not
 * decide WHICH colleague (that is the model's or the human's choice, informed
 * by `AgentBinding/get`'s roster), and it does not send anything. A handoff
 * creates work. Whether that work reaches the outside world is still
 * `/approvals`' question, unchanged.
 */
export async function delegate(env: Env, req: DelegateRequest): Promise<DelegateResult> {
  const row = await env.DB.prepare(`SELECT job_id FROM agent_invocations WHERE account_id = ? AND id = ?`)
    .bind(req.accountId, req.fromInvocationId)
    .first<{ job_id: string | null }>();
  if (!row) {
    return {
      ok: false,
      refusals: [refusal("identity", req.fromInvocationId, "an invocation on this account", "no such invocation")],
    };
  }
  if (row.job_id) return handOff(env, req);

  const opened = await openDelegation(env, {
    ...(req.open ?? {}),
    accountId: req.accountId,
    fromInvocationId: req.fromInvocationId,
    reason: req.reason,
  });
  if (!opened.ok) return { ok: false, refusals: opened.refusals };
  return handOff(env, { ...req, fromInvocationId: opened.rootId });
}

export { describeRefusals };
