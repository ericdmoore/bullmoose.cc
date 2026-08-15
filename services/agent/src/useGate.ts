import {
  JOB_MAX_DEPTH_CEILING,
  describeDenial,
  foldChain,
  intersectAuthority,
  isPrivacyClass,
  mayUse,
  type AuthorityDenial,
  type NodeAuthority,
  type NodeCeiling,
  type Use,
} from "@bullmoose/scheduling";
import type { Env } from "./models.js";

/**
 * THE USE-TIME AUTHORITY GATE — one function, one answer, every axis.
 *
 * `jobs.ts` is where a delegation is WRITTEN and attenuated. This is where a
 * delegation is SPENT. It exists because the two were the same check for one
 * release too long: `authority_json` was validated on the way into the row and
 * then never read as a bound again, which makes it a record of an intention
 * rather than a control. A capability that is checked once, at issue, is a
 * capability the holder keeps forever regardless of what anyone above them
 * later decides.
 *
 * ── ONE CHOKE POINT, AND WHY IT IS ONLY REACHABLE FROM HERE ────────────────
 * `authorizeNodeUse` is the single entry point, deliberately: N enforcement
 * sites is N chances to forget one, and the whole value of the pattern is that
 * a new consumer inherits the rule by calling one function rather than by
 * remembering a policy.
 *
 * It is in `services/agent` rather than somewhere more central because this is
 * the only worker that can answer the question at all. Enforcing a delegation
 * requires knowing WHICH INVOCATION IS ASKING, and today exactly one code path
 * knows: the drain, which claimed the row. The MCP tool surface
 * (`mcp.ts:544`, `authorizeAccount`) and the Bureau's credential gate
 * (`services/bureau/src/grants.ts:96`, `resolveBureauGrant`) both authorize a
 * BEARER — a principal, not an invocation — so neither can consult an envelope
 * it has no way to name. Closing those two requires per-invocation tokens
 * (`agent-integration.md` §4: "minted at invocation time, scoped to exactly the
 * context ∪ the agent's standing grants"), which is a token-minting change, not
 * a gate change. Until that exists, this gate covers every site that CAN name
 * the invocation, and the two that cannot are named here so the gap is a
 * documented boundary rather than an oversight.
 *
 * A THIRD member of that family, added here because it is the same shape and
 * was found the same way: `AgentInvocation/set` create
 * (`services/jmap/src/methods/agent.ts`) mints a fresh `pending` invocation for
 * any enabled binding on the account, gated on the `draft` scope alone. A
 * delegated node that holds a `draft`-scoped token could therefore cause an
 * invocation carrying no envelope. It is NOT fixable by propagation: nothing on
 * that request names the causing invocation (`ctx.agent.invocation` is
 * populated only where a proposal is applied), so there is no envelope to copy
 * — it authorizes a BEARER, exactly like the two above, and closes with the
 * same per-invocation tokens.
 *
 * ── WHAT IS NOT IN THAT FAMILY, AND SO WAS CLOSED ──────────────────────────
 * The needsInfo answer round (`ActionProposal/set`, status `info-requested`)
 * looked like the same gap and was not: the row it acts on IS the delegated
 * node (a proposal's id is its invocation's id), so the causing invocation is
 * nameable, and the round is now minted `INSERT … SELECT` FROM that node with
 * `job_id`/`parent_id`/`depth`/`authority_json`/`privacy` inherited. Before
 * that it copied `binding_id` and nothing else, which meant one human question
 * turned a narrowed node into an ordinary, ungated invocation — the fold below
 * never ran on it, because `job_id IS NULL` is precisely how this gate is told
 * "there is no delegation here". Attenuation was not exceeded, it was
 * SIDESTEPPED, and that is the harder failure to see. The rule the fix states:
 * an invocation CAUSED by a delegated node carries that node's envelope, or the
 * site is one that cannot name it and says so here.
 *
 * ── THE COMPUTATION ────────────────────────────────────────────────────────
 *   effective = (⋂ bindings the chain passes through)
 *               ∩ env(root) ∩ … ∩ env(this node)
 * folded root-first by `foldChain` (@bullmoose/scheduling). The bindings are
 * the first term, so nothing below them can hold what they do not; every hop
 * intersects, so no hop can widen what an ancestor gave up; and an unreadable
 * hop denies the fold outright.
 *
 * EVERY binding in the chain is a term, not just the acting node's. Today that
 * distinction is invisible — `attenuateChild` (attenuation.ts §identity)
 * refuses a child on any binding but its parent's, so every chain that exists
 * is single-binding and the intersection has exactly one member. It stops
 * being invisible the moment `agents:invoke` is un-deferred, because
 * agent→agent delegation is precisely a chain that spans bindings: fold only
 * the LEAF's binding and a chain A→B holds B's ceiling with A's silently
 * dropped, which is the widest hop winning instead of the narrowest. A chain
 * can only ever be as wide as the narrowest binding it passes through — that
 * is the property that has to survive the un-deferring, and it has to be
 * arithmetic here rather than a promise made by the write path, for the same
 * reason the envelopes are re-folded rather than trusted.
 *
 * Recomputed from the rows on every call rather than trusted from the node's
 * own column. That is the point: the node's column is one term of the answer,
 * not the answer. It is also what makes `bullmoose admin agent` narrowing a
 * binding's `jobs` ceiling take effect on work ALREADY IN THE QUEUE, instead of
 * only on Jobs started afterwards.
 */

/** The node row the harness and this gate read. */
export interface JobNodeRow {
  id: string;
  account_id: string;
  binding_id: string;
  binding_name: string;
  job_id: string | null;
  parent_id: string | null;
  needs_json: string | null;
  depth: number | null;
  authority_json: string | null;
  privacy: string | null;
  due_at: number | null;
  context_json: string;
  email_id: string | null;
  status: string;
}

/**
 * THE BINDING's ceiling — the top of every chain (§5: "the Job's ceiling is the
 * binding, and every level below only lowers it").
 *
 * Read from `config_json.jobs`, which is optional and additive:
 *   { tools?: string[], credentials?: string[], budgetMicros?: number,
 *     maxNodes?: number, maxDepth?: number }
 * Absent keys mean UNSET, not empty — a binding that never heard of Jobs must
 * not be unable to run one (the same DefaultCase reasoning as the facet
 * columns). Present keys bind hard: a binding that declares two tools caps
 * every node of every Job it originates at those two, root included.
 *
 * It lives in this module, beside the gate, because it is the FIRST TERM of the
 * fold as well as the ceiling `startJob` attenuates the root against. One
 * reading of `config_json.jobs`, shared by the write path and the use path, is
 * what stops the two developing different ideas of what a binding allows.
 */
export interface BindingJobConfig {
  tools?: unknown;
  credentials?: unknown;
  budgetMicros?: unknown;
  maxNodes?: unknown;
  maxDepth?: unknown;
}

export function bindingCeiling(
  accountId: string,
  bindingId: string,
  jobId: string,
  cfg: BindingJobConfig | undefined,
  facets: { privacy?: string | null; dueAt?: number | null },
): NodeCeiling {
  const strings = (v: unknown): string[] | null =>
    Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null;
  return {
    accountId,
    bindingId,
    jobId,
    // The binding sits at depth −1 so the root lands at 0 through exactly the
    // same `parent.depth + 1` every other level uses.
    depth: -1,
    authority: {
      tools: strings(cfg?.tools),
      credentials: strings(cfg?.credentials),
      budgetMicros: typeof cfg?.budgetMicros === "number" ? cfg.budgetMicros : null,
    },
    privacy: isPrivacyClass(facets.privacy) ? facets.privacy : null,
    dueAt: typeof facets.dueAt === "number" ? facets.dueAt : null,
  };
}

/** What the gate answers. `delegated: false` = no chain to enforce (see below). */
export type NodeUseDecision =
  | { ok: true; delegated: boolean; effective: NodeAuthority }
  | { ok: false; denial: AuthorityDenial; note: string };

/**
 * A chain longer than this is corrupt, not deep.
 *
 * `JOB_MAX_DEPTH_CEILING` is the absolute cap the harness enforces on every
 * `parent.depth + 1`, so a legitimate chain is at most that many hops plus the
 * root. Anything longer means `parent_id` points somewhere it should not — a
 * cycle, or a graft onto another Job — and the walk must stop rather than spin.
 * A bounded walk that denies beats an unbounded one that is correct in theory:
 * this runs inside a request.
 */
const MAX_CHAIN_HOPS = JOB_MAX_DEPTH_CEILING + 2;

/** The columns the chain walk needs — a strict subset of `JobNodeRow`. */
interface ChainRow {
  id: string;
  binding_id: string;
  job_id: string | null;
  parent_id: string | null;
  authority_json: string | null;
}

/** One hop of the walk, as the fold needs it. */
interface ChainHop {
  id: string;
  bindingId: string;
  authorityJson: string | null;
}

/**
 * A binding the chain passes through that is NOT the acting node's own —
 * reachable only once `agents:invoke` allows a child on another binding.
 *
 * `hop`/`hops` use `foldChain`'s numbering (1-based, ROOT-FIRST) so a denial
 * from this term and a denial from an envelope term point at the same row with
 * the same words. `invocationId` is carried because "hop 2 of 4" locates the
 * position and the id locates the ROW, and whoever is debugging wants both.
 */
interface ChainBinding {
  bindingId: string;
  hop: number;
  hops: number;
  invocationId: string;
}

/**
 * Resolve a node's EFFECTIVE authority — the whole computation, once.
 *
 * Returns `delegated: false` for an invocation with no `job_id`. That is not a
 * hole, it is the DefaultCase the Job columns were designed around
 * (`data-plane.sql`: "NULL = no envelope = an ordinary invocation"): an
 * invocation that is not part of a Job is not a delegation, so there is no
 * attenuation to enforce and the binding's own gates — the governing book, the
 * token's scopes, `bureau_grants` — govern it exactly as they did before Jobs
 * existed. Denying here would strand every ordinary agent on the platform to
 * enforce a ceiling nobody ever set.
 *
 * Inside a Job the rule inverts and every envelope is mandatory: the harness
 * writes one on every node it creates (`startJob`, `expandPlan`), so a Job node
 * with a NULL `authority_json` is a row that did not come through the harness,
 * and that is precisely the case fail-closed exists for.
 *
 * The DefaultCase is only safe while nothing INSIDE a Job can produce a
 * job-less invocation — otherwise "not a delegation" becomes a state a
 * delegation can reach, and the branch above stops being a description of the
 * world and becomes a bypass. That is a property of the WRITE sites, not of
 * this function, which is why the header lists them: every site that can name
 * its causing invocation propagates the envelope, and every site that cannot is
 * named as an open boundary.
 */
export async function effectiveNodeAuthority(
  env: Env,
  accountId: string,
  node: Pick<JobNodeRow, "id" | "binding_id" | "job_id" | "parent_id" | "authority_json">,
): Promise<NodeUseDecision> {
  if (!node.job_id) {
    return { ok: true, delegated: false, effective: { tools: null, credentials: null, budgetMicros: null } };
  }

  const chain = await delegationChain(env, accountId, node);
  if (!chain.ok) return chain;

  // The bindings first, the envelopes second. Intersection is commutative and
  // associative, so collapsing every binding into `foldChain`'s single first
  // term computes the same set as interleaving them hop by hop would — but it
  // keeps `foldChain` pure and its "hop i of N" denials unchanged. Order does
  // decide WHICH denial a doubly-broken chain reports, and a missing binding
  // is reported ahead of a corrupt envelope on purpose: the structural fault
  // is the one to fix first.
  const bindings = await chainBindingAuthority(env, accountId, node, chain.crossings);
  if (!bindings.ok) return bindings;

  const folded = foldChain(bindings.authority, chain.envelopes);
  if (!folded.ok) {
    return {
      ok: false,
      denial: folded.denial,
      note: `invocation ${node.id}: ${describeDenial(folded.denial)}`,
    };
  }
  return { ok: true, delegated: true, effective: folded.authority };
}

/**
 * THE GATE. May this invocation do this?
 *
 * The one function a use site calls. Every caller gets the same three
 * properties for free — the intersection, the fail-closed chain, and a denial
 * that names an axis — which is the entire reason it is one function.
 */
export async function authorizeNodeUse(
  env: Env,
  accountId: string,
  invocationId: string,
  use: Use,
): Promise<NodeUseDecision> {
  const node = await env.DB.prepare(
    `SELECT id, binding_id, job_id, parent_id, authority_json
       FROM agent_invocations WHERE account_id = ? AND id = ?`,
  )
    .bind(accountId, invocationId)
    .first<Pick<JobNodeRow, "id" | "binding_id" | "job_id" | "parent_id" | "authority_json">>();
  if (!node) {
    // An unknown invocation is not an unbounded one. Same reflex as everywhere
    // else here: the answer to "I cannot find the thing that would bound this"
    // is no.
    const denial: AuthorityDenial = {
      axis: "envelope",
      requested: invocationId,
      ceiling: "an invocation on this account",
      why: "no such invocation — authority cannot be resolved for a row that does not exist",
    };
    return { ok: false, denial, note: `invocation ${invocationId}: ${describeDenial(denial)}` };
  }

  const resolved = await effectiveNodeAuthority(env, accountId, node);
  if (!resolved.ok) return resolved;

  const verdict = mayUse(resolved.effective, use);
  if (verdict.ok) return resolved;
  return {
    ok: false,
    denial: verdict.denial,
    note: `invocation ${invocationId}: ${describeDenial(verdict.denial)}`,
  };
}

/**
 * The node's own ceiling, for the NEXT delegation — the effective authority
 * wearing a `NodeCeiling`, so `attenuateChild`/`attenuatePlan` can go on being
 * the one implementation of the delegation rules.
 *
 * This is what makes re-delegation safe at hop N. `expandPlan` used to build
 * this from the parent row's stored envelope alone, which meant hop 2 was
 * checked against whatever hop 2's column said — and a column is not a proof.
 * Now hop 2's plan is checked against `binding ∩ hop1 ∩ hop2`, so a node whose
 * row claims more than its ancestors held delegates the intersection, not the
 * claim.
 *
 * The facet axes (privacy, dueAt) and the identity fields come from the ROW,
 * unchanged: they are per-node facts the chain does not intersect, and
 * `attenuateChild` already enforces their own monotonicity down the chain.
 */
export async function effectiveNodeCeiling(
  env: Env,
  parent: JobNodeRow,
): Promise<{ ok: true; ceiling: NodeCeiling } | { ok: false; denial: AuthorityDenial; note: string }> {
  const resolved = await effectiveNodeAuthority(env, parent.account_id, parent);
  if (!resolved.ok) return resolved;
  return {
    ok: true,
    ceiling: {
      accountId: parent.account_id,
      bindingId: parent.binding_id,
      jobId: parent.job_id ?? "",
      depth: parent.depth ?? 0,
      authority: resolved.effective,
      privacy: isPrivacyClass(parent.privacy) ? parent.privacy : null,
      dueAt: parent.due_at,
    },
  };
}

/**
 * Walk `parent_id` to the root and return the raw envelopes ROOT-FIRST, plus
 * the bindings the chain CROSSES on the way.
 *
 * Every hop is re-read from the database rather than trusted from the caller,
 * and three things are checked on the way up, each of which is an escape if it
 * is not:
 *
 *   - the walk is BOUNDED (`MAX_CHAIN_HOPS`) — a cycle in `parent_id` must
 *     terminate as a denial, not as a hung request;
 *   - every hop is on the SAME Job — a `parent_id` pointing into another Job
 *     would inherit that Job's ceiling, which is the cheapest way to launder a
 *     wider authority into a narrower Job;
 *   - a missing parent DENIES — half a chain bounds nothing, and the missing
 *     half is exactly the half an attacker would want removed.
 *
 * The query is per-hop rather than one recursive CTE because D1 runs this over
 * chains of at most `JOB_MAX_DEPTH_CEILING` hops on a path that is already
 * doing a model call, and a plain indexed primary-key read is the shape the
 * rest of this worker uses.
 */
async function delegationChain(
  env: Env,
  accountId: string,
  node: Pick<JobNodeRow, "id" | "binding_id" | "job_id" | "parent_id" | "authority_json">,
): Promise<
  | { ok: true; envelopes: Array<string | null>; crossings: ChainBinding[] }
  | { ok: false; denial: AuthorityDenial; note: string }
> {
  const deny = (why: string, requested: string): { ok: false; denial: AuthorityDenial; note: string } => {
    const denial: AuthorityDenial = {
      axis: "envelope",
      requested,
      ceiling: `a chain of at most ${MAX_CHAIN_HOPS} hops within job ${node.job_id}`,
      why,
    };
    return { ok: false, denial, note: `invocation ${node.id}: ${describeDenial(denial)}` };
  };

  // Leaf-first while walking; reversed once at the end.
  const hops: ChainHop[] = [
    { id: node.id, bindingId: node.binding_id, authorityJson: node.authority_json },
  ];
  const seen = new Set<string>([node.id]);
  let parentId = node.parent_id;

  while (parentId !== null) {
    if (hops.length >= MAX_CHAIN_HOPS) {
      return deny("the delegation chain is longer than the depth cap allows — parent_id is corrupt", node.id);
    }
    if (seen.has(parentId)) {
      return deny(`parent_id cycles back to ${parentId}`, node.id);
    }
    seen.add(parentId);
    const row = await env.DB.prepare(
      `SELECT id, binding_id, job_id, parent_id, authority_json
         FROM agent_invocations WHERE account_id = ? AND id = ?`,
    )
      .bind(accountId, parentId)
      .first<ChainRow>();
    if (!row) {
      return deny(`parent ${parentId} does not exist — the chain's upper bound is unknown`, parentId);
    }
    if (row.job_id !== node.job_id) {
      return deny(
        `parent ${parentId} belongs to job ${row.job_id ?? "(none)"} — a node may not inherit another Job's ceiling`,
        parentId,
      );
    }
    hops.push({ id: row.id, bindingId: row.binding_id, authorityJson: row.authority_json });
    parentId = row.parent_id;
  }

  hops.reverse();

  // The DISTINCT bindings the chain crosses, minus the acting node's own —
  // which `chainBindingAuthority` reads anyway, and which keeps that read
  // byte-for-byte the one this gate has always done. Distinct, because a
  // binding contributes the same ceiling however many hops run under it and
  // `x ∩ x = x`; first (highest) occurrence wins the label, because the
  // ancestor is the hop whose authority is being questioned.
  const crossings: ChainBinding[] = [];
  const seenBinding = new Set<string>([node.binding_id]);
  for (const [i, hop] of hops.entries()) {
    if (seenBinding.has(hop.bindingId)) continue;
    seenBinding.add(hop.bindingId);
    crossings.push({ bindingId: hop.bindingId, hop: i + 1, hops: hops.length, invocationId: hop.id });
  }

  return { ok: true, envelopes: hops.map((h) => h.authorityJson), crossings };
}

/**
 * THE BINDING TERM — every binding the chain passes through, intersected.
 *
 * ── WHY THE ACTING NODE'S BINDING IS READ ON DIFFERENT TERMS ───────────────
 * It is the LENIENT one, exactly as it has always been: a missing row or an
 * unparseable `config_json` reads as an UNSET ceiling (see `bindingAuthority`).
 * That is not an oversight carried forward, it is where the enforcement lives:
 * the drain will not CLAIM an invocation whose own binding is absent or
 * disabled (`index.ts`, `… JOIN agent_bindings b … WHERE b.enabled = 1`), and
 * `startJob` refuses to open a Job under one (`jobs.ts` §008 kill switch). The
 * node's own binding is a checked precondition of getting here at all.
 *
 * NOTHING checks an ANCESTOR's binding. The drain joins the claimed row's
 * `binding_id` and no other, so on a cross-binding chain the hop above is
 * unexamined by every gate upstream of this one — which makes this the only
 * place it can be examined, and therefore the place that must fail closed:
 *
 *   ABSENT   the binding was destroyed. Its ceiling is unknown, and an unknown
 *            ceiling is not an absent one (`useAuthority.ts` rule 3's
 *            corollary). Deny.
 *   DISABLED the 008 kill switch was thrown on it. Contributing "no ceiling"
 *            for a binding an operator has just revoked would make the kill
 *            switch advice for exactly the delegated work it most needs to
 *            stop. Deny.
 *   UNREAD   the read itself failed. Same answer as everywhere else here.
 *
 * A CORRUPT `config_json` on an ancestor is deliberately NOT in that list: it
 * reads as unset, the same as it does for the node's own binding and for
 * `startJob`, because one reading of `config_json.jobs` in the tree is the
 * whole reason `bindingCeiling` is shared. It also buys nothing — anyone who
 * can corrupt that column can rewrite it to a WIDER ceiling instead, so
 * denying on corruption defends against a strictly weaker adversary than the
 * fold already assumes. Absence and the kill switch are different: they are
 * things an OPERATOR does on purpose, and they have to bite.
 *
 * ── ONE ROUND TRIP ─────────────────────────────────────────────────────────
 * The crossings are read with a single `id IN (…)`, not a read per hop: the
 * set is distinct and bounded by `MAX_CHAIN_HOPS`, this runs inside a request
 * that is already doing a model call, and N sequential D1 reads to compute one
 * intersection is the wrong shape. Total cost is 1 binding query for the
 * single-binding chains that exist today (unchanged), 2 for any chain that
 * crosses, at any depth.
 */
async function chainBindingAuthority(
  env: Env,
  accountId: string,
  node: Pick<JobNodeRow, "id" | "binding_id">,
  crossings: readonly ChainBinding[],
): Promise<{ ok: true; authority: NodeAuthority } | { ok: false; denial: AuthorityDenial; note: string }> {
  let acc = await bindingAuthority(env, accountId, node.binding_id);
  // Every chain alive today. Same one read, same result, no second query.
  const [firstCrossing] = crossings;
  if (firstCrossing === undefined) return { ok: true, authority: acc };

  const deny = (
    at: ChainBinding,
    ceiling: string,
    why: string,
  ): { ok: false; denial: AuthorityDenial; note: string } => {
    const denial: AuthorityDenial = {
      axis: "envelope",
      requested: `hop ${at.hop} of ${at.hops} — binding ${at.bindingId} (invocation ${at.invocationId})`,
      ceiling,
      why,
    };
    return { ok: false, denial, note: `invocation ${node.id}: ${describeDenial(denial)}` };
  };

  const marks = crossings.map(() => "?").join(",");
  let rows: Array<{ id: string; enabled: number; config_json: string }>;
  try {
    const read = await env.DB.prepare(
      `SELECT id, enabled, COALESCE(config_json, '{}') AS config_json
         FROM agent_bindings WHERE account_id = ? AND id IN (${marks})`,
    )
      .bind(accountId, ...crossings.map((c) => c.bindingId))
      .all<{ id: string; enabled: number; config_json: string }>();
    rows = read.results;
  } catch {
    return deny(
      firstCrossing,
      "a readable agent_bindings row",
      "the bindings this chain crosses could not be read — a ceiling that cannot be read is not an absent one",
    );
  }

  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const crossing of crossings) {
    const row = byId.get(crossing.bindingId);
    if (!row) {
      return deny(
        crossing,
        "a binding row on this account",
        "an ancestor of this node runs under a binding that no longer exists — half a ceiling bounds nothing",
      );
    }
    if (row.enabled !== 1) {
      return deny(
        crossing,
        "an enabled binding",
        "an ancestor of this node runs under a DISABLED binding (008 kill switch) — a revoked binding denies the chain, it does not contribute 'no ceiling'",
      );
    }
    acc = intersectAuthority(acc, configAuthority(accountId, crossing.bindingId, row.config_json));
  }
  return { ok: true, authority: acc };
}

/**
 * The binding's declared ceiling — the first term of the fold, and the top of
 * every chain (jobs-and-facets §5: "the Job's ceiling is the binding").
 *
 * Read through `bindingCeiling` so there is ONE reading of `config_json.jobs`
 * in the tree; a second parser here would be the drift `startJob` and this gate
 * must not have between them.
 *
 * An unparseable `config_json` reads as an UNSET ceiling, exactly as
 * `startJob` treats it, and that is safe rather than lax: unset is the identity
 * element of the fold, so it widens nothing — every narrowing below it still
 * applies, and a Job under a binding with a corrupt config is bounded by its
 * own chain rather than stranded. A missing binding row is treated the same
 * way, because the drain has already refused to claim work for one.
 */
async function bindingAuthority(env: Env, accountId: string, bindingId: string): Promise<NodeAuthority> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(config_json, '{}') AS config_json
       FROM agent_bindings WHERE account_id = ? AND id = ?`,
  )
    .bind(accountId, bindingId)
    .first<{ config_json: string }>();
  return configAuthority(accountId, bindingId, row?.config_json);
}

/**
 * `config_json` → the binding's authority ceiling. THE one reading, shared by
 * the acting node's binding and by every binding its chain crosses, so the two
 * cannot develop different ideas of what `jobs` means.
 */
function configAuthority(accountId: string, bindingId: string, configJson: string | undefined): NodeAuthority {
  let cfg: { jobs?: BindingJobConfig } = {};
  try {
    cfg = JSON.parse(configJson ?? "{}") as { jobs?: BindingJobConfig };
  } catch {
    /* an unparseable config is an unset ceiling — same as absent (startJob) */
  }
  return bindingCeiling(accountId, bindingId, "", cfg.jobs, {}).authority;
}

export { describeDenial };
