import { describe, expect, it } from "vitest";
import {
  JOB_MAX_DEPTH_CEILING,
  JOB_MAX_NODES_CEILING,
  attenuateChild,
  attenuatePlan,
  describeRefusals,
  type ChildRequest,
  type JobCaps,
  type JobUsage,
  type NodeCeiling,
  type Refusal,
} from "./attenuation.js";

/**
 * s11 T7 — MONOTONIC ATTENUATION, the invariant, axis by axis.
 *
 * This file is the reason the task exists. `.plans/s17-chief-of-staff` makes it
 * explicit: CJ is the only agent whose failure mode is systemic, and
 * `agent-integration.md` §4 will not un-defer `agents:invoke` until the
 * chain-depth cap, the shared budget and the attenuation invariant are REAL
 * CODE WITH TESTS THAT BITE. So this is not a smoke test of the happy path —
 * it is the adversary's test suite: for every axis, a child that asks for MORE
 * than its parent holds must be REFUSED, and the refusal must survive being
 * asked at depth 1, at depth 3, in a batch, and behind a legal sibling.
 *
 * The property under test, stated once:
 *
 *   ∀ parent, ∀ child: child.authority ⊆ parent.authority, on every axis, and
 *   no sequence of legal delegations reconstitutes what an ancestor gave up.
 */

const NOW = 1_800_000_000_000;

/** A parent that holds two tools, one credential, $1.00, internal, due in 1h. */
function parent(over: Partial<NodeCeiling> = {}): NodeCeiling {
  return {
    accountId: "a_1",
    bindingId: "bind_1",
    jobId: "job_1",
    depth: 0,
    authority: { tools: ["email.draft", "files.read"], credentials: ["aws-mcp"], budgetMicros: 1_000_000 },
    privacy: "internal",
    dueAt: NOW + 3_600_000,
    ...over,
  };
}

const CAPS: JobCaps = { maxNodes: 8, maxDepth: 3, budgetMicros: 1_000_000 };
const FRESH: JobUsage = { nodeCount: 1, reservedMicros: 0 };

/** Attenuate one child; return the refused axes (empty = allowed). */
function axes(p: NodeCeiling, req: ChildRequest, seen: string[] = []): string[] {
  const r = attenuateChild(p, { key: "t", ...req }, seen);
  return r.ok ? [] : r.refusals.map((x) => x.axis);
}

function refusals(p: NodeCeiling, req: ChildRequest): Refusal[] {
  const r = attenuateChild(p, { key: "t", ...req });
  return r.ok ? [] : r.refusals;
}

describe("axis: tools — a child may hold a SUBSET, never more", () => {
  it("a subset is allowed and lands exactly as asked", () => {
    const r = attenuateChild(parent(), { key: "t", tools: ["files.read"] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.child.authority.tools).toEqual(["files.read"]);
  });

  it("REFUSES a tool the parent does not hold", () => {
    expect(axes(parent(), { tools: ["email.send"] })).toEqual(["tools"]);
  });

  it("REFUSES a superset even when most of it is legal (no partial grant)", () => {
    const r = refusals(parent(), { tools: ["files.read", "email.send"] });
    expect(r).toHaveLength(1);
    expect(r[0]!.axis).toBe("tools");
    expect(r[0]!.why).toContain("email.send");
  });

  it("REFUSES, never truncates — the child is not silently clamped to the ceiling", () => {
    const r = attenuateChild(parent(), { key: "t", tools: ["files.read", "email.send"] });
    expect(r.ok).toBe(false);
  });

  it("an OMITTED tools list yields the EMPTY set, never the parent's (least privilege)", () => {
    const r = attenuateChild(parent(), { key: "t" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.child.authority.tools).toEqual([]);
  });

  it("a parent holding NO tools admits no child that asks for one", () => {
    expect(axes(parent({ authority: { tools: [], credentials: [], budgetMicros: 1 } }), { tools: ["x"] })).toEqual(["tools"]);
  });

  it("an UNRESTRICTED ceiling (binding with no jobs config) admits any named subset", () => {
    const p = parent({ authority: { tools: null, credentials: null, budgetMicros: null } });
    const r = attenuateChild(p, { key: "t", tools: ["anything"], credentials: ["any-cred"] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.child.authority.tools).toEqual(["anything"]);
  });

  it("a child cannot ASK for unrestricted — a non-array is refused, not read as 'all'", () => {
    expect(axes(parent(), { tools: null })).toEqual(["tools"]);
    expect(axes(parent(), { tools: "*" })).toEqual(["tools"]);
    expect(axes(parent(), { tools: [1, 2] })).toEqual(["tools"]);
  });
});

describe("axis: credentials — the same inclusion, over vault handles", () => {
  it("a held handle is allowed", () => {
    const r = attenuateChild(parent(), { key: "t", credentials: ["aws-mcp"] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.child.authority.credentials).toEqual(["aws-mcp"]);
  });

  it("REFUSES a handle the parent does not hold", () => {
    expect(axes(parent(), { credentials: ["stripe-live"] })).toEqual(["credentials"]);
  });

  it("an omitted list yields the empty set", () => {
    const r = attenuateChild(parent(), { key: "t" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.child.authority.credentials).toEqual([]);
  });

  it("REFUSES garbage rather than reading it as 'no constraint'", () => {
    expect(axes(parent(), { credentials: { aws: true } })).toEqual(["credentials"]);
    expect(axes(parent(), { credentials: [""] })).toEqual(["credentials"]);
  });
});

describe("axis: budget — a child may spend no more than its parent", () => {
  it("less is allowed", () => {
    const r = attenuateChild(parent(), { key: "t", budgetMicros: 250_000 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.child.authority.budgetMicros).toBe(250_000);
  });

  it("equal is allowed (a ceiling, not a claim on the money)", () => {
    expect(axes(parent(), { budgetMicros: 1_000_000 })).toEqual([]);
  });

  it("REFUSES one micro-dollar more", () => {
    expect(axes(parent(), { budgetMicros: 1_000_001 })).toEqual(["budget"]);
  });

  it("REFUSES an UNBOUNDED child under a bounded parent (the amplification by omission)", () => {
    const r = refusals(parent(), { budgetMicros: null });
    expect(r.map((x) => x.axis)).toEqual(["budget"]);
    expect(r[0]!.requested).toBe("unbounded");
  });

  it("allows unbounded only when the parent is unbounded", () => {
    const p = parent({ authority: { tools: null, credentials: null, budgetMicros: null } });
    expect(axes(p, { budgetMicros: null })).toEqual([]);
  });

  it("REFUSES negative and non-finite budgets rather than clamping them", () => {
    expect(axes(parent(), { budgetMicros: -1 })).toEqual(["budget"]);
    expect(axes(parent(), { budgetMicros: Number.POSITIVE_INFINITY })).toEqual(["budget"]);
    expect(axes(parent(), { budgetMicros: Number.NaN })).toEqual(["budget"]);
    expect(axes(parent(), { budgetMicros: "1000000" })).toEqual(["budget"]);
  });

  it("an omitted budget inherits the parent's CEILING — equal, never greater", () => {
    const r = attenuateChild(parent(), { key: "t" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.child.authority.budgetMicros).toBe(1_000_000);
  });
});

describe("axis: depth — the harness computes it; naming it is an escape attempt", () => {
  it("a child is always exactly parent.depth + 1", () => {
    const r = attenuateChild(parent({ depth: 2 }), { key: "t" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.child.depth).toBe(3);
  });

  it("REFUSES a request that names its own depth — even the correct one", () => {
    expect(axes(parent({ depth: 2 }), { depth: 3 })).toEqual(["depth"]);
    expect(axes(parent({ depth: 2 }), { depth: 0 })).toEqual(["depth"]);
  });

  it("REFUSES a whole plan that would exceed the Job's maxDepth", () => {
    const r = attenuatePlan(parent({ depth: 3 }), [{ key: "a" }], { ...CAPS, maxDepth: 3 }, FRESH);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusals.map((x) => x.axis)).toContain("depth");
  });

  it("a planner AT the depth limit may still plan nothing, and is refused the moment it plans", () => {
    const atLimit = parent({ depth: 3 });
    expect(attenuatePlan(atLimit, [], { ...CAPS, maxDepth: 3 }, FRESH).ok).toBe(true);
    expect(attenuatePlan(atLimit, [{ key: "a" }], { ...CAPS, maxDepth: 3 }, FRESH).ok).toBe(false);
  });
});

describe("axis: fan-out — maxNodes counts what already exists", () => {
  const cheap = (key: string) => ({ key, budgetMicros: 100_000 });

  it("allows a plan that fits", () => {
    const r = attenuatePlan(parent(), [cheap("a"), cheap("b")], CAPS, { nodeCount: 6, reservedMicros: 0 });
    expect(r.ok).toBe(true);
  });

  it("REFUSES the plan that would cross maxNodes, counting existing nodes", () => {
    const r = attenuatePlan(parent(), [cheap("a"), cheap("b")], CAPS, { nodeCount: 7, reservedMicros: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.refusals[0]!.axis).toBe("fanout");
      expect(r.refusals[0]!.requested).toBe("9");
      expect(r.refusals[0]!.ceiling).toBe("8");
    }
  });

  it("a runaway planner asking for a hundred tasks is refused as ONE plan, creating nothing", () => {
    const many = Array.from({ length: 100 }, (_, i) => cheap(`t${i}`));
    const r = attenuatePlan(parent(), many, CAPS, FRESH);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusals.map((x) => x.axis)).toContain("fanout");
  });
});

describe("axis: privacy — a class may be raised, never lowered", () => {
  it("internal → pinned is allowed (tightening)", () => {
    const r = attenuateChild(parent(), { key: "t", privacy: "pinned" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.child.privacy).toBe("pinned");
  });

  it("REFUSES internal → open (the leak: open work may transit a paid cloud model)", () => {
    expect(axes(parent(), { privacy: "open" })).toEqual(["privacy"]);
  });

  it("REFUSES pinned → internal and pinned → open at any depth", () => {
    const pinned = parent({ privacy: "pinned", depth: 2 });
    expect(axes(pinned, { privacy: "internal" })).toEqual(["privacy"]);
    expect(axes(pinned, { privacy: "open" })).toEqual(["privacy"]);
  });

  it("REFUSES an unknown class rather than ignoring it", () => {
    expect(axes(parent(), { privacy: "secret" })).toEqual(["privacy"]);
    expect(axes(parent(), { privacy: 7 })).toEqual(["privacy"]);
  });

  it("an unstamped parent admits any real class, and omission inherits", () => {
    const un = parent({ privacy: null });
    expect(axes(un, { privacy: "pinned" })).toEqual([]);
    const r = attenuateChild(parent(), { key: "t" });
    if (r.ok) expect(r.child.privacy).toBe("internal");
  });
});

describe("axis: urgency — a child may not be due before its parent", () => {
  it("later is allowed", () => {
    expect(axes(parent(), { dueAt: NOW + 7_200_000 })).toEqual([]);
  });

  it("REFUSES an earlier deadline — urgency BUYS the paid cloud (the T2 escalation)", () => {
    expect(axes(parent(), { dueAt: NOW })).toEqual(["urgency"]);
  });

  it("REFUSES inventing a deadline under a never-urgent parent", () => {
    expect(axes(parent({ dueAt: null }), { dueAt: NOW })).toEqual(["urgency"]);
  });

  it("REFUSES a non-numeric deadline", () => {
    expect(axes(parent(), { dueAt: "friday" })).toEqual(["urgency"]);
  });

  it("omission inherits the parent's deadline", () => {
    const r = attenuateChild(parent(), { key: "t" });
    if (r.ok) expect(r.child.dueAt).toBe(NOW + 3_600_000);
  });
});

describe("axis: identity — decomposition decides structure, never permission", () => {
  it("REFUSES a child on another binding (that is agents:invoke, still deferred)", () => {
    const r = refusals(parent(), { bindingId: "bind_cj" });
    expect(r.map((x) => x.axis)).toEqual(["identity"]);
    expect(r[0]!.why).toContain("agents:invoke");
  });

  it("REFUSES a child on another account", () => {
    expect(axes(parent(), { accountId: "a_victim" })).toEqual(["identity"]);
  });

  it("REFUSES a child that moves itself into another Job (another Job's budget)", () => {
    expect(axes(parent(), { jobId: "job_rich" })).toEqual(["job"]);
  });

  it("naming its OWN account/binding/job is fine, and inheriting is the norm", () => {
    expect(axes(parent(), { accountId: "a_1", bindingId: "bind_1", jobId: "job_1" })).toEqual([]);
    const r = attenuateChild(parent(), { key: "t" });
    if (r.ok) expect([r.child.accountId, r.child.bindingId, r.child.jobId]).toEqual(["a_1", "bind_1", "job_1"]);
  });
});

describe("axis: needs — plan-local, backward-only, so a cycle is unrepresentable", () => {
  it("a backward reference is allowed", () => {
    expect(axes(parent(), { needs: ["a"] }, ["a", "b"])).toEqual([]);
  });

  it("REFUSES a forward reference (the only way to build a cycle)", () => {
    expect(axes(parent(), { needs: ["z"] }, ["a"])).toEqual(["needs"]);
  });

  it("REFUSES a self-reference", () => {
    expect(axes(parent(), { key: "t", needs: ["t"] }, ["t"])).toEqual(["needs"]);
  });

  it("REFUSES a raw invocation id — a planner never names a row", () => {
    expect(axes(parent(), { needs: ["inv_0e1f"] }, ["a"])).toEqual(["needs"]);
  });

  it("REFUSES duplicate plan keys (needs would be ambiguous)", () => {
    const r = attenuatePlan(parent(), [{ key: "a" }, { key: "a" }], CAPS, FRESH);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusals[0]!.axis).toBe("needs");
  });

  it("REFUSES a task with no key at all", () => {
    const r = attenuatePlan(parent(), [{}], CAPS, FRESH);
    expect(r.ok).toBe(false);
  });
});

describe("axis: context — a plan may not mint a reserved harness kind", () => {
  it("REFUSES answer-info-request (hijacking a human's needsInfo round)", () => {
    expect(axes(parent(), { context: { kind: "answer-info-request", proposalId: "p_1" } })).toEqual(["context"]);
  });

  it("REFUSES bouncer-classify (reaching into the boundary's machinery)", () => {
    expect(axes(parent(), { context: { kind: "bouncer-classify" } })).toEqual(["context"]);
  });

  it("ALLOWS job-node (nested planners are the feature — maxDepth is their bound)", () => {
    expect(axes(parent(), { context: { kind: "job-node", op: "plan" } })).toEqual([]);
  });

  it("ALLOWS an ordinary pipeline context (no kind) — nodes are ordinary invocations", () => {
    expect(axes(parent(), { context: { emailId: "e_1" } })).toEqual([]);
  });

  it("REFUSES a non-object context", () => {
    expect(axes(parent(), { context: "kind=answer-info-request" })).toEqual(["context"]);
  });
});

describe("the aggregate budget — the shared budget §4 asks for", () => {
  it("allows a fan-out that fits inside the Job's budget", () => {
    const plan = [
      { key: "a", budgetMicros: 300_000 },
      { key: "b", budgetMicros: 300_000 },
      { key: "c", budgetMicros: 300_000 },
    ];
    expect(attenuatePlan(parent(), plan, CAPS, FRESH).ok).toBe(true);
  });

  it("REFUSES a fan-out of individually-LEGAL children that together outspend the Job", () => {
    // Each child asks for exactly its parent's ceiling — every one of them is a
    // legal delegation on the budget axis, and four of them are not.
    const plan = Array.from({ length: 4 }, (_, i) => ({ key: `t${i}`, budgetMicros: 1_000_000 }));
    const r = attenuatePlan(parent(), plan, CAPS, FRESH);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const agg = r.refusals.find((x) => x.axis === "budget")!;
      expect(agg.key).toBe("(plan)");
      expect(agg.requested).toBe("4000000µ$");
      expect(agg.ceiling).toBe("1000000µ$");
    }
  });

  it("counts what earlier nodes already RESERVED, so a second planner cannot spend it twice", () => {
    const plan = [{ key: "a", budgetMicros: 400_000 }];
    expect(attenuatePlan(parent(), plan, CAPS, { nodeCount: 3, reservedMicros: 500_000 }).ok).toBe(true);
    expect(attenuatePlan(parent(), plan, CAPS, { nodeCount: 3, reservedMicros: 700_000 }).ok).toBe(false);
  });

  it("OMITTING a budget reserves the parent's FULL ceiling — so two silent children do not fit", () => {
    // The deliberate exception to "absence is the most attenuated value": an
    // omitted budget inherits the ceiling, which is legal per-child (equal ⊆
    // equal) and caught HERE, by the reservation, exactly as §3 intends —
    // "N nodes cannot each spend the per-invocation cap".
    expect(attenuatePlan(parent(), [{ key: "a" }], CAPS, FRESH).ok).toBe(true);
    const two = attenuatePlan(parent(), [{ key: "a" }, { key: "b" }], CAPS, FRESH);
    expect(two.ok).toBe(false);
    if (!two.ok) expect(two.refusals.map((x) => x.axis)).toEqual(["budget"]);
  });

  it("no aggregate cap → no aggregate refusal (DefaultCase)", () => {
    const plan = Array.from({ length: 4 }, (_, i) => ({ key: `t${i}`, budgetMicros: 1_000_000 }));
    expect(attenuatePlan(parent(), plan, { ...CAPS, budgetMicros: null }, FRESH).ok).toBe(true);
  });
});

describe("ALL-OR-NOTHING: one bad task refuses the plan", () => {
  it("a legal sibling does not smuggle an amplifying one through", () => {
    const r = attenuatePlan(
      parent(),
      [
        { key: "honest", tools: ["files.read"] },
        { key: "greedy", tools: ["email.send"] },
      ],
      CAPS,
      FRESH,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusals.map((x) => x.key)).toEqual(["greedy"]);
  });

  it("reports EVERY violated axis of a request, not just the first", () => {
    const r = refusals(parent(), {
      tools: ["email.send"],
      credentials: ["stripe-live"],
      budgetMicros: 9_000_000,
      privacy: "open",
      dueAt: NOW - 1,
      bindingId: "bind_cj",
      depth: 0,
    });
    expect(new Set(r.map((x) => x.axis))).toEqual(
      new Set(["tools", "credentials", "budget", "privacy", "urgency", "identity", "depth"]),
    );
    expect(describeRefusals(r)).toContain("ceiling");
  });
});

describe("MONOTONIC DOWN THE CHAIN: what an ancestor gave up cannot come back", () => {
  /** Delegate once, and keep the child as the next parent. */
  function delegate(p: NodeCeiling, req: ChildRequest): NodeCeiling {
    const r = attenuateChild(p, { key: "k", ...req });
    if (!r.ok) throw new Error(`unexpected refusal: ${describeRefusals(r.refusals)}`);
    return {
      accountId: r.child.accountId,
      bindingId: r.child.bindingId,
      jobId: r.child.jobId,
      depth: r.child.depth,
      authority: r.child.authority,
      privacy: r.child.privacy,
      dueAt: r.child.dueAt,
    };
  }

  it("a grandchild cannot regain a tool its parent dropped", () => {
    const child = delegate(parent(), { tools: ["files.read"], credentials: [], budgetMicros: 500_000 });
    expect(child.authority.tools).toEqual(["files.read"]);
    // `email.draft` is still the GRANDparent's; the child never held it.
    expect(axes(child, { tools: ["email.draft"] })).toEqual(["tools"]);
    expect(axes(child, { tools: ["files.read"] })).toEqual([]);
  });

  it("a grandchild cannot regain a credential, a budget, a privacy class or a deadline", () => {
    const child = delegate(parent(), {
      tools: [],
      credentials: [],
      budgetMicros: 100_000,
      privacy: "pinned",
      dueAt: NOW + 86_400_000,
    });
    expect(axes(child, { credentials: ["aws-mcp"] })).toEqual(["credentials"]);
    expect(axes(child, { budgetMicros: 200_000 })).toEqual(["budget"]);
    expect(axes(child, { privacy: "internal" })).toEqual(["privacy"]);
    expect(axes(child, { dueAt: NOW + 3_600_000 })).toEqual(["urgency"]);
  });

  it("holds at EVERY depth: a 4-level chain narrows monotonically and never widens", () => {
    let node = parent();
    const budgets: Array<number | null> = [];
    for (let d = 0; d < 4; d++) {
      node = delegate(node, {
        tools: node.authority.tools!.slice(0, Math.max(0, node.authority.tools!.length - 1)),
        credentials: [],
        budgetMicros: Math.floor((node.authority.budgetMicros ?? 0) / 2),
      });
      budgets.push(node.authority.budgetMicros);
      // At every level, asking for the ORIGINAL ceiling is refused.
      expect(axes(node, { tools: ["email.draft", "files.read"] })).toEqual(["tools"]);
      expect(axes(node, { budgetMicros: 1_000_000 })).toEqual(["budget"]);
      expect(node.depth).toBe(d + 1);
    }
    expect(budgets).toEqual([500_000, 250_000, 125_000, 62_500]);
  });

  it("the absolute ceilings exist so a caller cannot ask for an unbounded Job", () => {
    expect(JOB_MAX_NODES_CEILING).toBeGreaterThan(0);
    expect(JOB_MAX_DEPTH_CEILING).toBeGreaterThan(0);
    expect(Number.isFinite(JOB_MAX_NODES_CEILING)).toBe(true);
    expect(Number.isFinite(JOB_MAX_DEPTH_CEILING)).toBe(true);
  });
});
