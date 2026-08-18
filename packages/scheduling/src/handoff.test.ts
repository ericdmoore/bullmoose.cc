import { describe, expect, it } from "vitest";
import { attenuateChild, type NodeAuthority, type NodeCeiling, type Refusal } from "./attenuation.js";
import { intersectAuthority } from "./useAuthority.js";
import {
  HANDOFF_MAX_HOPS,
  HANDOFF_REASON_MAX,
  describeHandoff,
  parseHandoffPolicy,
  parseHandoffProvenance,
  planHandoff,
  stampHandoff,
  type HandoffArgs,
  type HandoffReceiver,
  type HandoffSender,
} from "./handoff.js";

/**
 * s17 — THE HANDOFF, as arithmetic.
 *
 * What is being proven here, in the order the PR argues it:
 *
 *   1. ATTENUATION IS MONOTONIC AND PROVABLE — a handoff is an INTERSECTION.
 *      The receiver cannot lend reach it holds and the sender does not; the
 *      sender cannot borrow reach the receiver holds and it does not. Proven
 *      transitively (A→B→C never exceeds A) over an exhaustive table, not on
 *      one hand-picked example.
 *   2. THE OPERATOR PLANE IS FAIL-CLOSED AND RECIPROCAL — no config, no
 *      handoff; one side only, no handoff.
 *   3. LOOPS AND DEPTH REFUSE LOUDLY — a cycle and a crossing too many both
 *      come back as a refusal with an axis, never as a silently dropped hop.
 *   4. PROVENANCE IS THE HARNESS'S — a task cannot forge the chain it rode.
 */

const AUTH = (tools: string[] | null, credentials: string[] | null, budgetMicros: number | null): NodeAuthority => ({
  tools,
  credentials,
  budgetMicros,
});

const senderCeiling = (over: Partial<NodeCeiling> = {}): NodeCeiling => ({
  accountId: "a_1",
  bindingId: "bind_cj",
  jobId: "job_1",
  depth: 0,
  authority: AUTH(["files.read", "mail.draft"], ["aws-mcp"], 100_000),
  privacy: null,
  dueAt: null,
  ...over,
});

const SENDER: HandoffSender = {
  bindingId: "bind_cj",
  bindingName: "cj",
  policy: { mayHandTo: ["allen"], acceptsFrom: [] },
};

const receiver = (over: Partial<HandoffReceiver> = {}): HandoffReceiver => ({
  bindingId: "bind_allen",
  bindingName: "allen",
  authority: AUTH(null, null, null),
  privacyFloor: null,
  policy: { mayHandTo: [], acceptsFrom: ["cj"] },
  enabled: true,
  ...over,
});

const args = (over: Partial<HandoffArgs> = {}): HandoffArgs => ({
  sender: SENDER,
  senderCeiling: senderCeiling(),
  receiver: receiver(),
  chain: { bindingIds: ["bind_cj"] },
  reason: "Allen owns spend questions",
  fromInvocationId: "inv_cj",
  now: 1_700_000_000_000,
  ...over,
});

const axes = (refusals: Refusal[]): string[] => refusals.map((r) => r.axis);

// ---------------------------------------------------------------------------

describe("the happy path: one hop, both halves declared", () => {
  it("returns a ceiling on the RECEIVER's binding, keeping the sender's account and Job", () => {
    const r = planHandoff(args());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.ceiling.bindingId).toBe("bind_allen");
    expect(r.plan.ceiling.accountId).toBe("a_1");
    expect(r.plan.ceiling.jobId).toBe("job_1");
    // Depth is the SENDER's; `attenuateChild` adds the +1, as it does for every
    // other level — a handoff is not a special case in the depth arithmetic.
    expect(r.plan.ceiling.depth).toBe(0);
    expect(r.plan.hop).toBe(1);
    expect(r.plan.waiting).toBe(false);
  });

  it("records provenance a human can read, with the sender's own words", () => {
    const r = planHandoff(args({ reason: "Allen owns spend questions" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.provenance).toEqual({
      from: { invocationId: "inv_cj", bindingId: "bind_cj", bindingName: "cj" },
      to: { bindingId: "bind_allen", bindingName: "allen" },
      reason: "Allen owns spend questions",
      hop: 1,
      at: 1_700_000_000_000,
    });
    expect(describeHandoff(r.plan.provenance)).toBe("cj handed this to allen — Allen owns spend questions");
  });
});

describe("attenuation: the intersection, in both directions", () => {
  it("the RECEIVER cannot lend reach — an unrestricted receiver does not widen the sender", () => {
    // The shape that matters most: `tools: null` on the receiving binding means
    // UNSET, and unset is the identity of the fold. It must not read as "grant
    // everything" the moment work crosses into it.
    const r = planHandoff(args({ receiver: receiver({ authority: AUTH(null, null, null) }) }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.ceiling.authority).toEqual(AUTH(["files.read", "mail.draft"], ["aws-mcp"], 100_000));
  });

  it("the SENDER cannot borrow reach — a specialist's extra tool is not acquired by being handed to", () => {
    const r = planHandoff({
      ...args(),
      receiver: receiver({ authority: AUTH(["files.read", "payments.charge"], ["stripe"], 9_000_000) }),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // `payments.charge` is the receiver's and stays the receiver's; `aws-mcp` is
    // the sender's and does not survive a receiver that does not hold it.
    expect(r.plan.ceiling.authority).toEqual(AUTH(["files.read"], [], 100_000));
  });

  it("money is the MINIMUM of the two, whichever side is tighter", () => {
    const tighterReceiver = planHandoff({
      ...args(),
      receiver: receiver({ authority: AUTH(null, null, 10_000) }),
    });
    expect(tighterReceiver.ok && tighterReceiver.plan.ceiling.authority.budgetMicros).toBe(10_000);

    const tighterSender = planHandoff({
      ...args(),
      senderCeiling: senderCeiling({ authority: AUTH(null, null, 5_000) }),
      receiver: receiver({ authority: AUTH(null, null, 10_000) }),
    });
    expect(tighterSender.ok && tighterSender.plan.ceiling.authority.budgetMicros).toBe(5_000);
  });

  it("the receiver's PRIVACY FLOOR raises the class; the sender's stamp is never lowered", () => {
    const raised = planHandoff({
      ...args(),
      senderCeiling: senderCeiling({ privacy: "open" }),
      receiver: receiver({ privacyFloor: "pinned" }),
    });
    expect(raised.ok && raised.plan.ceiling.privacy).toBe("pinned");

    const kept = planHandoff({
      ...args(),
      senderCeiling: senderCeiling({ privacy: "pinned" }),
      receiver: receiver({ privacyFloor: "open" }),
    });
    expect(kept.ok && kept.plan.ceiling.privacy).toBe("pinned");
  });

  it("urgency rides across unchanged — a handoff does not buy the paid cloud", () => {
    const r = planHandoff({ ...args(), senderCeiling: senderCeiling({ dueAt: 42 }) });
    expect(r.ok && r.plan.ceiling.dueAt).toBe(42);
  });
});

describe("THE PROOF: a handoff cannot grant what the sender lacked, transitively", () => {
  /**
   * The property, stated once and checked over the whole cross-product:
   *
   *   effective(C) ⊆ effective(B) ⊆ effective(A)
   *
   * on every axis, for every combination of authorities anyone could configure
   * — including the `null` (unset) corners, which are the ones a reader gets
   * wrong, because `null` LOOKS like "everything" and is not.
   *
   * The chain is built the way production builds it: `planHandoff` narrows,
   * `attenuateChild` attenuates the task against that narrowing, and the
   * child's resulting authority is the next hop's sender ceiling — which is
   * exactly what `effectiveNodeCeiling` feeds `handOff` at run time.
   */
  const TOOLSETS: Array<string[] | null> = [
    null,
    [],
    ["files.read"],
    ["files.read", "mail.draft"],
    ["mail.draft", "payments.charge"],
  ];
  const MONEY: Array<number | null> = [null, 0, 10_000, 100_000];

  const subsetOf = (child: readonly string[] | null, parent: readonly string[] | null): boolean =>
    parent === null ? true : child !== null && child.every((t) => parent.includes(t));
  const atMost = (child: number | null, parent: number | null): boolean =>
    parent === null ? true : child !== null && child <= parent;

  /** One hop: route + task, returning the child's authority, or null if refused. */
  function hop(
    ceiling: NodeCeiling,
    toBinding: { id: string; name: string; authority: NodeAuthority },
    chain: string[],
    ask: { tools?: string[]; credentials?: string[]; budgetMicros?: number },
  ): { authority: NodeAuthority; ceiling: NodeCeiling } | null {
    const routed = planHandoff({
      sender: {
        bindingId: ceiling.bindingId,
        bindingName: ceiling.bindingId,
        policy: { mayHandTo: [toBinding.name], acceptsFrom: [] },
      },
      senderCeiling: ceiling,
      receiver: {
        bindingId: toBinding.id,
        bindingName: toBinding.name,
        authority: toBinding.authority,
        privacyFloor: null,
        policy: { mayHandTo: [], acceptsFrom: [ceiling.bindingId] },
        enabled: true,
      },
      chain: { bindingIds: chain },
      reason: "because",
      fromInvocationId: "inv_x",
      now: 0,
    });
    if (!routed.ok) return null;
    const child = attenuateChild(routed.plan.ceiling, { key: "t", ...ask });
    if (!child.ok) return null;
    return {
      authority: child.child.authority,
      ceiling: { ...routed.plan.ceiling, depth: child.child.depth, authority: child.child.authority },
    };
  }

  it("A → B → C: C's authority is a subset of A's on every axis, for every configuration", () => {
    let checked = 0;
    let reachedC = 0;
    for (const aTools of TOOLSETS) {
      for (const bTools of TOOLSETS) {
        for (const cTools of TOOLSETS) {
          for (const money of MONEY) {
            const a: NodeCeiling = {
              accountId: "a",
              bindingId: "A",
              jobId: "j",
              depth: 0,
              authority: AUTH(aTools, aTools, money),
              privacy: null,
              dueAt: null,
            };
            // B asks for everything it could possibly be given.
            const b = hop(a, { id: "B", name: "B", authority: AUTH(bTools, bTools, money) }, ["A"], {
              ...(bTools === null ? {} : { tools: bTools, credentials: bTools }),
              ...(money === null ? {} : { budgetMicros: money }),
            });
            checked += 1;
            if (b === null) continue;
            expect(subsetOf(b.authority.tools, a.authority.tools)).toBe(true);
            expect(subsetOf(b.authority.credentials, a.authority.credentials)).toBe(true);
            expect(atMost(b.authority.budgetMicros, a.authority.budgetMicros)).toBe(true);

            const c = hop(b.ceiling, { id: "C", name: "C", authority: AUTH(cTools, cTools, money) }, ["A", "B"], {
              ...(cTools === null ? {} : { tools: cTools, credentials: cTools }),
              ...(money === null ? {} : { budgetMicros: money }),
            });
            if (c === null) continue;
            reachedC += 1;
            // The transitive claim, stated against A — never against B.
            expect(subsetOf(c.authority.tools, a.authority.tools)).toBe(true);
            expect(subsetOf(c.authority.credentials, a.authority.credentials)).toBe(true);
            expect(atMost(c.authority.budgetMicros, a.authority.budgetMicros)).toBe(true);
            // …and against B, so "narrowing only" holds hop by hop as well.
            expect(subsetOf(c.authority.tools, b.authority.tools)).toBe(true);
            expect(atMost(c.authority.budgetMicros, b.authority.budgetMicros)).toBe(true);
          }
        }
      }
    }
    // The table must actually reach the interesting case, or it proves nothing.
    expect(checked).toBe(TOOLSETS.length ** 3 * MONEY.length);
    expect(reachedC).toBeGreaterThan(50);
  });

  it("the narrowing is exactly `intersectAuthority` — no second implementation", () => {
    // Restated as an identity rather than a walk, so a future edit that adds a
    // clever special case to `planHandoff` fails here by name.
    const ceiling = senderCeiling({ authority: AUTH(["a", "b"], ["c"], 50) });
    const recv = receiver({ authority: AUTH(["b", "z"], null, 30) });
    const r = planHandoff(args({ senderCeiling: ceiling, receiver: recv }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.ceiling.authority).toEqual(intersectAuthority(ceiling.authority, recv.authority));
  });

  it("a task that asks for a tool NEITHER side holds is refused, not truncated", () => {
    const r = planHandoff(args());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const child = attenuateChild(r.plan.ceiling, { key: "t", tools: ["payments.charge"] });
    expect(child.ok).toBe(false);
    if (child.ok) return;
    expect(axes(child.refusals)).toContain("tools");
  });
});

describe("the operator plane: reciprocal, and fail-closed", () => {
  it("no handoff config anywhere refuses BOTH halves at once", () => {
    const r = planHandoff(
      args({
        sender: { ...SENDER, policy: { mayHandTo: [], acceptsFrom: [] } },
        receiver: receiver({ policy: { mayHandTo: [], acceptsFrom: [] } }),
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(axes(r.refusals)).toEqual(["handoff", "handoff"]);
    expect(r.refusals[0]!.why).toContain("mayHandTo");
    expect(r.refusals[1]!.why).toContain("acceptsFrom");
  });

  it("the SENDER naming the receiver is not enough — the receiver must accept", () => {
    const r = planHandoff(args({ receiver: receiver({ policy: { mayHandTo: [], acceptsFrom: ["someone-else"] } }) }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusals).toHaveLength(1);
    expect(r.refusals[0]!.why).toContain("does not accept work from cj");
  });

  it("the RECEIVER accepting is not enough — the sender must be permitted to hand", () => {
    const r = planHandoff(args({ sender: { ...SENDER, policy: { mayHandTo: ["someone-else"], acceptsFrom: [] } } }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusals).toHaveLength(1);
    expect(r.refusals[0]!.why).toContain("may not hand work to allen");
  });

  it("`parseHandoffPolicy` degrades every garbage shape to NO permission", () => {
    for (const junk of [undefined, null, "allen", 7, [], { mayHandTo: "allen" }, { acceptsFrom: [1, 2] }]) {
      expect(parseHandoffPolicy(junk)).toEqual({ mayHandTo: [], acceptsFrom: [] });
    }
    expect(parseHandoffPolicy({ mayHandTo: ["a", "a", "", "b"], acceptsFrom: ["c"] })).toEqual({
      mayHandTo: ["a", "b"],
      acceptsFrom: ["c"],
    });
  });

  it("a handoff to YOURSELF is not a handoff", () => {
    const r = planHandoff(args({ receiver: receiver({ bindingId: "bind_cj", bindingName: "cj" }) }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(axes(r.refusals)).toContain("identity");
  });
});

describe("loops and depth: bounded, and loud", () => {
  it("A → B → A is refused as a cycle, by name", () => {
    const r = planHandoff(
      args({
        sender: { bindingId: "bind_allen", bindingName: "allen", policy: { mayHandTo: ["cj"], acceptsFrom: [] } },
        senderCeiling: senderCeiling({ bindingId: "bind_allen", depth: 1 }),
        receiver: receiver({
          bindingId: "bind_cj",
          bindingName: "cj",
          policy: { mayHandTo: [], acceptsFrom: ["allen"] },
        }),
        chain: { bindingIds: ["bind_cj", "bind_allen"] },
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(axes(r.refusals)).toEqual(["handoff"]);
    expect(r.refusals[0]!.why).toContain("already in the delegation chain");
  });

  it("A → B → C → A is refused too — no binding TWICE, not merely no immediate return", () => {
    const r = planHandoff(
      args({
        sender: { bindingId: "bind_c", bindingName: "c", policy: { mayHandTo: ["cj"], acceptsFrom: [] } },
        senderCeiling: senderCeiling({ bindingId: "bind_c", depth: 2 }),
        receiver: receiver({
          bindingId: "bind_cj",
          bindingName: "cj",
          policy: { mayHandTo: [], acceptsFrom: ["c"] },
        }),
        chain: { bindingIds: ["bind_cj", "bind_allen", "bind_c"] },
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusals[0]!.why).toContain("cycle");
  });

  it("the crossing cap bites at HANDOFF_MAX_HOPS, and the last legal hop still passes", () => {
    const legal = planHandoff(
      args({
        sender: { bindingId: "bind_allen", bindingName: "allen", policy: { mayHandTo: ["emily"], acceptsFrom: [] } },
        senderCeiling: senderCeiling({ bindingId: "bind_allen", depth: 1 }),
        receiver: receiver({
          bindingId: "bind_emily",
          bindingName: "emily",
          policy: { mayHandTo: [], acceptsFrom: ["allen"] },
        }),
        chain: { bindingIds: ["bind_cj", "bind_allen"] },
      }),
    );
    expect(legal.ok).toBe(true);
    expect(legal.ok && legal.plan.hop).toBe(HANDOFF_MAX_HOPS);

    const oneTooFar = planHandoff(
      args({
        sender: { bindingId: "bind_emily", bindingName: "emily", policy: { mayHandTo: ["dana"], acceptsFrom: [] } },
        senderCeiling: senderCeiling({ bindingId: "bind_emily", depth: 2 }),
        receiver: receiver({
          bindingId: "bind_dana",
          bindingName: "dana",
          policy: { mayHandTo: [], acceptsFrom: ["emily"] },
        }),
        chain: { bindingIds: ["bind_cj", "bind_allen", "bind_emily"] },
      }),
    );
    expect(oneTooFar.ok).toBe(false);
    if (oneTooFar.ok) return;
    expect(axes(oneTooFar.refusals)).toEqual(["handoff"]);
    expect(oneTooFar.refusals[0]!.ceiling).toBe(String(HANDOFF_MAX_HOPS));
  });

  it("crossings count BINDINGS, not nodes — six nodes under two bindings is still hop 2", () => {
    const r = planHandoff(
      args({
        sender: { bindingId: "bind_allen", bindingName: "allen", policy: { mayHandTo: ["emily"], acceptsFrom: [] } },
        senderCeiling: senderCeiling({ bindingId: "bind_allen", depth: 4 }),
        receiver: receiver({
          bindingId: "bind_emily",
          bindingName: "emily",
          policy: { mayHandTo: [], acceptsFrom: ["allen"] },
        }),
        // Six hops, two bindings.
        chain: { bindingIds: ["bind_cj", "bind_cj", "bind_cj", "bind_allen", "bind_allen", "bind_allen"] },
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.ok && r.plan.hop).toBe(2);
  });
});

describe("the kill switch composes: a disabled receiver WAITS, it does not refuse", () => {
  it("a disabled receiving binding still produces a plan, marked `waiting`", () => {
    const r = planHandoff(args({ receiver: receiver({ enabled: false }) }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.waiting).toBe(true);
    // …and nothing about the authority changed. The work is created and held by
    // the claim gate, not narrowed or diverted.
    expect(r.plan.ceiling.authority).toEqual(AUTH(["files.read", "mail.draft"], ["aws-mcp"], 100_000));
  });
});

describe("provenance is mandatory, bounded, and the harness's alone", () => {
  it("an empty reason refuses", () => {
    for (const bad of ["", "   "]) {
      const r = planHandoff(args({ reason: bad }));
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(axes(r.refusals)).toContain("handoff");
    }
  });

  it("an essay refuses — the reason is provenance, not payload", () => {
    const r = planHandoff(args({ reason: "x".repeat(HANDOFF_REASON_MAX + 1) }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusals[0]!.ceiling).toContain(String(HANDOFF_REASON_MAX));
  });

  it("`stampHandoff` OVERWRITES a forged context.handoff — a task cannot mint its own chain", () => {
    const r = planHandoff(args());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const child = attenuateChild(r.plan.ceiling, {
      key: "t",
      context: { kind: "job-node", op: "echo", handoff: { from: { bindingName: "the-board" } } },
    });
    expect(child.ok).toBe(true);
    if (!child.ok) return;
    const stamped = stampHandoff(child.child, r.plan.provenance);
    expect(stamped.context.handoff).toEqual(r.plan.provenance);
    // Everything else the task legitimately carried survives.
    expect(stamped.context.op).toBe("echo");
  });

  it("`parseHandoffProvenance` round-trips what `stampHandoff` writes, and rejects everything else", () => {
    const r = planHandoff(args());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const stamped = stampHandoff(
      {
        key: "t",
        needs: [],
        accountId: "a",
        bindingId: "b",
        jobId: "j",
        depth: 1,
        authority: AUTH(null, null, null),
        privacy: null,
        dueAt: null,
        context: {},
        emailId: null,
      },
      r.plan.provenance,
    );
    expect(parseHandoffProvenance(JSON.stringify(stamped.context))).toEqual(r.plan.provenance);

    for (const junk of [
      null,
      "",
      "not json",
      "{}",
      JSON.stringify({ handoff: null }),
      JSON.stringify({
        handoff: {
          from: { bindingId: "b", bindingName: "n" },
          to: { bindingId: "x", bindingName: "y" },
          reason: "r",
          hop: 1,
        },
      }),
      JSON.stringify({ handoff: { ...r.plan.provenance, reason: "" } }),
      JSON.stringify({ handoff: { ...r.plan.provenance, from: { bindingId: "b" } } }),
    ]) {
      expect(parseHandoffProvenance(junk)).toBeNull();
    }
  });
});
