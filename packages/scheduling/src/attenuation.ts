// MONOTONIC ATTENUATION (s11 T7) — the invariant that makes decomposition safe.
//
//   A sub-task's tools, credentials and budget are always a SUBSET of its
//   parent's. Delegation attenuates, never amplifies.
//
// This is the object-capability discipline applied to decomposition
// (jobs-and-facets.md §5), and it is the reason `agents:invoke` can ever be
// un-deferred: `agent-integration.md` §4 defers agent→agent pipelines until
// there is a chain-depth cap and a shared budget, and s17 (CJ, the chief of
// staff) is the consumer — the ONE agent whose failure mode is systemic, one
// prompt injection away from being a confused deputy for the whole household.
// So this module is written to BITE, not to document: every axis is a refusal
// with a reason, and `attenuation.test.ts` walks each of them at every depth.
//
// ── Three rules that shape every decision below ────────────────────────────
//
// 1. REFUSE, NEVER TRUNCATE. A child that asks for more than its parent holds
//    is rejected outright — its request is not silently clamped to the
//    ceiling. Truncation would let an amplifying planner's output SUCCEED,
//    which hides the attempt, teaches nothing, and makes the invariant
//    untestable (every test would pass whatever the planner asked for). A
//    refusal is visible, recorded on the planner node's result, and provable.
//
// 2. ABSENCE IS THE MOST ATTENUATED VALUE, never the parent's. Omitting
//    `tools` yields the EMPTY set, not an inherited one: least privilege is
//    what an unstated permission should mean, and "inherit on omission" is
//    amplification-by-omission — the quiet way capability systems leak. The
//    one deliberate exception is BUDGET (and the two facet axes), where the
//    unstated value inherits the parent's CEILING: equal is still a subset, a
//    ceiling is not a grant, and the aggregate reservation (Σ children ≤ the
//    Job's budget) is what actually bounds the fan-out there.
//
// 3. A CEILING IS NOT A GRANT. `authority_json` can only ever NARROW what the
//    binding's principal already holds — the Bureau still checks
//    `bureau_grants` at use time, and the governing book still gates outbound.
//    Nothing here can hand a node authority its binding does not have; that is
//    what "decomposition cannot mint authority" means (§3), and it is why the
//    tools axis is safe to express as plain strings.

import type { PrivacyClass } from "./mayClaim.js";

/** Privacy as an ORDER, tightest last. A child may raise, never lower. */
const PRIVACY_RANK: Record<PrivacyClass, number> = { open: 0, internal: 1, pinned: 2 };

/** Is this an authored privacy class at all? (An unknown string is refused.) */
export function isPrivacyClass(v: unknown): v is PrivacyClass {
  return v === "open" || v === "internal" || v === "pinned";
}

/**
 * What a node MAY use — its ceiling, inherited down the chain by narrowing.
 *
 * `tools: null` (and `credentials: null`) = unrestricted, and is producible
 * ONLY by a binding-level ceiling — a binding with no `jobs` config declared,
 * where "unset" must not silently mean "nothing" or no Job could ever run.
 * A child request has no syntax for it: a task that omits `tools` gets `[]`,
 * and one that names them gets exactly the named subset. That asymmetry is
 * rule 2 above, and it is the difference between "the ceiling is unset" and
 * "the child asked for everything". An unrestricted ceiling is not a licence
 * either — rule 3: the Bureau still checks every credential use.
 *
 * `budgetMicros: null` = no money ceiling of this node's own. A child may only
 * hold null if its parent does (an unbounded child under a bounded parent is
 * amplification, and it is the exact shape a planner would reach for).
 */
export interface NodeAuthority {
  tools: readonly string[] | null;
  credentials: readonly string[] | null;
  budgetMicros: number | null;
}

/** The parent a child is attenuated against — authority plus the two facet axes. */
export interface NodeCeiling {
  accountId: string;
  bindingId: string;
  jobId: string;
  /** The parent's depth. A child's is always exactly this + 1. */
  depth: number;
  authority: NodeAuthority;
  /** The parent's privacy class, or null (unstamped = DefaultCase). */
  privacy: PrivacyClass | null;
  /** The parent's `due_at`, or null = never-urgent (the WEAKEST urgency). */
  dueAt: number | null;
}

/**
 * ONE TASK AS A PLANNER EMITTED IT — UNTRUSTED INPUT, in every field.
 *
 * Today the plan is a fixed decomposition carried in the planner node's
 * context; tomorrow a model writes it from untrusted email. Nothing about this
 * module changes on that day, which is the point: the harness treats the plan
 * as data either way, and every field below is validated rather than believed.
 */
export interface ChildRequest {
  /** Plan-local name. Siblings reference it in `needs`; never an invocation id. */
  key?: unknown;
  /** Execution ordering — plan-local keys of EARLIER tasks (acyclic by construction). */
  needs?: unknown;
  tools?: unknown;
  credentials?: unknown;
  budgetMicros?: unknown;
  privacy?: unknown;
  dueAt?: unknown;
  /** Refused if present: depth is the harness's to compute (see AXES). */
  depth?: unknown;
  /** Refused if it names anything but the parent's — no cross-binding minting. */
  accountId?: unknown;
  bindingId?: unknown;
  jobId?: unknown;
  /** The child invocation's context_json. Reserved harness kinds are refused. */
  context?: unknown;
  /** The child's email context, if any. */
  emailId?: unknown;
}

/** A resolved, attenuated child — what the harness is allowed to INSERT. */
export interface AttenuatedChild {
  key: string;
  needs: string[];
  accountId: string;
  bindingId: string;
  jobId: string;
  depth: number;
  authority: NodeAuthority;
  privacy: PrivacyClass | null;
  dueAt: number | null;
  context: Record<string, unknown>;
  emailId: string | null;
}

/** One axis, refused. `axis` is stable enough to assert on and to count by. */
export interface Refusal {
  key: string;
  axis:
    | "tools"
    | "credentials"
    | "budget"
    | "depth"
    | "fanout"
    | "privacy"
    | "urgency"
    | "identity"
    | "job"
    | "needs"
    | "context"
    /**
     * s17 — the delegation CHAIN itself could not be read: an absent, corrupt,
     * grafted or cyclic `authority_json` above this request (`useAuthority.ts`).
     * Its own axis rather than "identity" because the fix is different: nothing
     * about the plan is wrong, and rewriting it will not help.
     */
    | "envelope";
  requested: string;
  ceiling: string;
  why: string;
}

/**
 * Context kinds the HARNESS dispatches on, which a planner therefore may not
 * mint. `answer-info-request` resumes a human's needsInfo round on a proposal
 * and `bouncer-classify` runs the boundary classifier over another account's
 * message — either would be a decomposition reaching sideways into machinery
 * it was not delegated. `job-node` is deliberately NOT here: nested planners
 * and join nodes are the whole feature, and they are bounded by maxDepth.
 */
export const RESERVED_CONTEXT_KINDS = ["answer-info-request", "bouncer-classify"] as const;

/** Absolute ceilings on the Job's own caps — a caller cannot ask for unbounded. */
export const JOB_MAX_NODES_CEILING = 64;
export const JOB_MAX_DEPTH_CEILING = 5;

/** The Job-level caps a batch of children is checked against. */
export interface JobCaps {
  maxNodes: number;
  maxDepth: number;
  /** The Job's aggregate spend ceiling, micro-USD; null = no aggregate cap. */
  budgetMicros: number | null;
}

/** What the Job has already committed — the state a fan-out is measured against. */
export interface JobUsage {
  /** Nodes that already exist in this Job (root included). */
  nodeCount: number;
  /** Σ of every existing node's declared `budgetMicros` (the reservation). */
  reservedMicros: number;
}

export type AttenuationResult =
  | { ok: true; children: AttenuatedChild[] }
  | { ok: false; refusals: Refusal[] };

const list = (v: readonly string[] | null): string => (v === null ? "*" : `[${v.join(", ")}]`);
const money = (v: number | null): string => (v === null ? "unbounded" : `${v}µ$`);

/** Strings only, no duplicates, deterministic order — a set, spelled as JSON. */
function asStringSet(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string" || item.length === 0) return null;
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

/**
 * ATTENUATE ONE CHILD — the invariant, axis by axis.
 *
 * Returns EVERY violated axis rather than the first, because a planner that
 * over-reaches usually over-reaches on several at once and an audit that says
 * "refused: tools" while the same request also doubled its budget has told
 * half the story. Callers surface the whole list on the planner's result row.
 *
 * ── THE AXES ───────────────────────────────────────────────────────────────
 *
 *   tools        child ⊆ parent (set inclusion). A parent with `null`
 *                (unrestricted, binding-level only) admits any subset. Omitted
 *                → [] (rule 2).
 *   credentials  child ⊆ parent, same shape. These are `vault_credentials.name`
 *                HANDLES — the `credentialRef` an agent config carries — so the
 *                axis lines up exactly with what the Bureau grants per verb, and
 *                narrowing here can never widen there.
 *   budget       child.budgetMicros ≤ parent.budgetMicros, and an unbounded
 *                child under a bounded parent is refused (the amplification a
 *                planner would actually reach for). Negative/non-finite is
 *                refused rather than clamped. The BATCH also reserves against
 *                the Job's aggregate (see `attenuatePlan`).
 *   depth        the harness computes parent.depth + 1; a request that NAMES a
 *                depth is refused outright, because the only reason to name one
 *                is to escape `maxDepth`. The cap itself is checked in
 *                `attenuatePlan` and again in the guarded INSERT.
 *   privacy      class(child) ≥ class(parent) in open < internal < pinned. A
 *                stamp may raise, never lower — the floor rule of
 *                jobs-and-facets §6, applied down the chain instead of across
 *                the boundary. Lowering it would route private work to a paid
 *                cloud model, which is the one facet mistake that leaks data.
 *   urgency      child.dueAt ≥ parent.dueAt, and a parent with NULL (never
 *                urgent) admits only NULL. This axis exists because urgency IS
 *                spend authority here: the T2 gate escalates near-due work to
 *                the PAID cloud, so a child that minted `due_at = now` would
 *                buy itself a cloud model its parent was told to wait for.
 *   identity     accountId/bindingId must equal the parent's. A child on
 *                another binding is agent→agent delegation — `agents:invoke`,
 *                still deferred (s17 step 2). Refusing it here is what keeps
 *                this task from quietly shipping that.
 *   job          jobId must equal the parent's: a node cannot escape into
 *                another Job's budget.
 *   needs        plan-local keys only, and only keys of EARLIER tasks — which
 *                makes a cycle unrepresentable rather than merely unlikely. A
 *                cycle in `needs` is a deadlock no sweep can clear.
 *   context      a plan may not mint a RESERVED harness kind (see above).
 */
export function attenuateChild(
  parent: NodeCeiling,
  req: ChildRequest,
  seenKeys: readonly string[] = [],
): { ok: true; child: AttenuatedChild } | { ok: false; refusals: Refusal[] } {
  const key = typeof req.key === "string" && req.key.length > 0 ? req.key : "";
  const refusals: Refusal[] = [];
  const refuse = (axis: Refusal["axis"], requested: string, ceiling: string, why: string) =>
    refusals.push({ key: key || "(unnamed)", axis, requested, ceiling, why });

  if (key === "") {
    refuse("needs", "(unnamed)", "a non-empty string key", "every task needs a plan-local key");
  }

  // ---- identity: the same account, the same binding, the same Job ----------
  if (req.accountId !== undefined && req.accountId !== parent.accountId) {
    refuse("identity", String(req.accountId), parent.accountId, "a child runs on its parent's account");
  }
  if (req.bindingId !== undefined && req.bindingId !== parent.bindingId) {
    refuse(
      "identity",
      String(req.bindingId),
      parent.bindingId,
      "a child runs under its parent's binding — cross-binding delegation is agents:invoke, deferred",
    );
  }
  if (req.jobId !== undefined && req.jobId !== parent.jobId) {
    refuse("job", String(req.jobId), parent.jobId, "a node cannot move itself into another Job");
  }

  // ---- depth: the harness's to compute ------------------------------------
  if (req.depth !== undefined) {
    refuse(
      "depth",
      String(req.depth),
      String(parent.depth + 1),
      "depth is computed by the harness; naming it is an attempt to escape maxDepth",
    );
  }

  // ---- tools ⊆ parent.tools ------------------------------------------------
  let tools: readonly string[] = [];
  if (req.tools !== undefined) {
    const asked = asStringSet(req.tools);
    if (asked === null) {
      refuse("tools", JSON.stringify(req.tools) ?? "?", list(parent.authority.tools), "tools must be an array of non-empty strings");
    } else {
      const over = parent.authority.tools === null ? [] : asked.filter((t) => !parent.authority.tools!.includes(t));
      if (over.length > 0) {
        refuse("tools", list(asked), list(parent.authority.tools), `not held by the parent: ${over.join(", ")}`);
      } else {
        tools = asked;
      }
    }
  }

  // ---- credentials ⊆ parent.credentials -----------------------------------
  let credentials: readonly string[] = [];
  if (req.credentials !== undefined) {
    const asked = asStringSet(req.credentials);
    if (asked === null) {
      refuse("credentials", JSON.stringify(req.credentials) ?? "?", list(parent.authority.credentials), "credentials must be an array of non-empty handles");
    } else {
      const held = parent.authority.credentials;
      const over = held === null ? [] : asked.filter((c) => !held.includes(c));
      if (over.length > 0) {
        refuse("credentials", list(asked), list(parent.authority.credentials), `not held by the parent: ${over.join(", ")}`);
      } else {
        credentials = asked;
      }
    }
  }

  // ---- budget ≤ parent.budget ---------------------------------------------
  // Omitted inherits the parent's ceiling: equal is a subset, and the Job's
  // aggregate reservation is what stops N children each holding it (§3, "N
  // nodes cannot each spend the per-invocation cap").
  let budgetMicros: number | null = parent.authority.budgetMicros;
  if (req.budgetMicros !== undefined) {
    if (req.budgetMicros === null) {
      if (parent.authority.budgetMicros !== null) {
        refuse("budget", "unbounded", money(parent.authority.budgetMicros), "a child may not drop a ceiling its parent carries");
      }
    } else if (
      typeof req.budgetMicros !== "number" ||
      !Number.isFinite(req.budgetMicros) ||
      req.budgetMicros < 0
    ) {
      refuse("budget", String(req.budgetMicros), money(parent.authority.budgetMicros), "budgetMicros must be a non-negative finite number of micro-USD");
    } else if (
      parent.authority.budgetMicros !== null &&
      req.budgetMicros > parent.authority.budgetMicros
    ) {
      refuse("budget", money(req.budgetMicros), money(parent.authority.budgetMicros), "a child may not spend more than its parent");
    } else {
      budgetMicros = req.budgetMicros;
    }
  }

  // ---- privacy: may tighten, never loosen ---------------------------------
  let privacy: PrivacyClass | null = parent.privacy;
  if (req.privacy !== undefined && req.privacy !== null) {
    if (!isPrivacyClass(req.privacy)) {
      refuse("privacy", String(req.privacy), parent.privacy ?? "(unstamped)", "privacy is a class: open | internal | pinned");
    } else if (parent.privacy !== null && PRIVACY_RANK[req.privacy] < PRIVACY_RANK[parent.privacy]) {
      refuse("privacy", req.privacy, parent.privacy, "a child may raise the privacy class, never lower it");
    } else {
      privacy = req.privacy;
    }
  }

  // ---- urgency: may relax, never advance ----------------------------------
  let dueAt: number | null = parent.dueAt;
  if (req.dueAt !== undefined && req.dueAt !== null) {
    if (typeof req.dueAt !== "number" || !Number.isFinite(req.dueAt)) {
      refuse("urgency", String(req.dueAt), parent.dueAt === null ? "never-urgent" : String(parent.dueAt), "dueAt is epoch ms");
    } else if (parent.dueAt === null) {
      refuse("urgency", String(req.dueAt), "never-urgent", "a child of never-urgent work cannot invent a deadline (urgency buys the paid cloud)");
    } else if (req.dueAt < parent.dueAt) {
      refuse("urgency", String(req.dueAt), String(parent.dueAt), "a child may not be due before its parent (urgency buys the paid cloud)");
    } else {
      dueAt = req.dueAt;
    }
  }

  // ---- needs: plan-local, backward-only -----------------------------------
  const needs: string[] = [];
  if (req.needs !== undefined) {
    const asked = asStringSet(req.needs);
    if (asked === null) {
      refuse("needs", JSON.stringify(req.needs) ?? "?", "[plan-local keys]", "needs must be an array of plan-local keys");
    } else {
      for (const n of asked) {
        if (n === key) {
          refuse("needs", n, "[earlier keys]", "a task cannot need itself");
        } else if (!seenKeys.includes(n)) {
          refuse(
            "needs",
            n,
            `[${seenKeys.join(", ")}]`,
            "needs may only name EARLIER tasks of the same plan — forward or foreign references would admit a cycle, and a cycle is a deadlock no sweep can clear",
          );
        } else {
          needs.push(n);
        }
      }
    }
  }

  // ---- context: no reserved harness kinds ---------------------------------
  let context: Record<string, unknown> = {};
  if (req.context !== undefined) {
    if (typeof req.context !== "object" || req.context === null || Array.isArray(req.context)) {
      refuse("context", String(req.context), "an object", "context must be a JSON object");
    } else {
      context = req.context as Record<string, unknown>;
      const kind = context.kind;
      if (typeof kind === "string" && (RESERVED_CONTEXT_KINDS as readonly string[]).includes(kind)) {
        refuse("context", kind, `not ${RESERVED_CONTEXT_KINDS.join(" | ")}`, "a plan may not mint a reserved harness context kind");
      }
    }
  }

  const emailId = typeof req.emailId === "string" && req.emailId.length > 0 ? req.emailId : null;
  if (req.emailId !== undefined && emailId === null) {
    refuse("context", String(req.emailId), "an email id", "emailId must be a non-empty string when present");
  }

  if (refusals.length > 0) return { ok: false, refusals };
  return {
    ok: true,
    child: {
      key,
      needs,
      accountId: parent.accountId,
      bindingId: parent.bindingId,
      jobId: parent.jobId,
      depth: parent.depth + 1,
      authority: { tools, credentials, budgetMicros },
      privacy,
      dueAt,
      context,
      emailId,
    },
  };
}

/**
 * ATTENUATE A WHOLE PLAN — every child against its parent, plus the two
 * BATCH-level caps that one child alone cannot violate:
 *
 *   maxDepth   the chain-depth cap `agent-integration.md` §4 asks for. Checked
 *              once for the batch (all children share a depth).
 *   maxNodes   the fan-out cap. Counted against nodes that ALREADY exist, so a
 *              second planner in the same Job cannot spend the same headroom
 *              twice — and the guarded INSERT re-counts inside the transaction
 *              so two planners racing cannot either.
 *   budget     the shared budget §4 asks for: Σ (existing reservations + these
 *              children's declared budgets) ≤ the Job's aggregate. This is the
 *              term that stops a runaway fan-out of individually-legal children
 *              — each one is ≤ its parent, and forty of them are not.
 *
 * ALL-OR-NOTHING. One refused child refuses the plan. A partially-applied
 * decomposition is a half-executed plan whose join nodes will wait on tasks
 * that were never created, and "some of what the planner asked for" is not a
 * decomposition anybody authored.
 */
export function attenuatePlan(
  parent: NodeCeiling,
  requests: readonly ChildRequest[],
  caps: JobCaps,
  usage: JobUsage,
): AttenuationResult {
  const refusals: Refusal[] = [];
  const children: AttenuatedChild[] = [];
  const keys: string[] = [];

  const childDepth = parent.depth + 1;
  if (requests.length > 0 && childDepth > caps.maxDepth) {
    refusals.push({
      key: "(plan)",
      axis: "depth",
      requested: String(childDepth),
      ceiling: String(caps.maxDepth),
      why: "the Job's chain-depth cap — a planner that keeps planning stops here",
    });
  }
  if (usage.nodeCount + requests.length > caps.maxNodes) {
    refusals.push({
      key: "(plan)",
      axis: "fanout",
      requested: String(usage.nodeCount + requests.length),
      ceiling: String(caps.maxNodes),
      why: `the Job's node cap — ${usage.nodeCount} node(s) already exist`,
    });
  }

  for (const req of requests) {
    const one = attenuateChild(parent, req, keys);
    if (!one.ok) {
      refusals.push(...one.refusals);
      continue;
    }
    if (keys.includes(one.child.key)) {
      refusals.push({
        key: one.child.key,
        axis: "needs",
        requested: one.child.key,
        ceiling: `[${keys.join(", ")}]`,
        why: "duplicate plan key — needs would be ambiguous",
      });
      continue;
    }
    keys.push(one.child.key);
    children.push(one.child);
  }

  // The shared budget. Declared budgets are RESERVATIONS: a node that has not
  // run yet still commits its slice, which is what makes the check meaningful
  // BEFORE any money is spent. `null` on a child under a null Job budget
  // reserves nothing — there is no aggregate to reserve against.
  if (caps.budgetMicros !== null) {
    const asked = children.reduce((sum, c) => sum + (c.authority.budgetMicros ?? 0), 0);
    if (usage.reservedMicros + asked > caps.budgetMicros) {
      refusals.push({
        key: "(plan)",
        axis: "budget",
        requested: money(usage.reservedMicros + asked),
        ceiling: money(caps.budgetMicros),
        why: `the Job's aggregate budget — ${money(usage.reservedMicros)} is already reserved by existing nodes`,
      });
    }
  }

  if (refusals.length > 0) return { ok: false, refusals };
  return { ok: true, children };
}

/** A refusal list, rendered for a result row / a log line / a test message. */
export function describeRefusals(refusals: readonly Refusal[]): string {
  return refusals
    .map((r) => `${r.key}: ${r.axis} — asked ${r.requested}, ceiling ${r.ceiling} (${r.why})`)
    .join("; ");
}
