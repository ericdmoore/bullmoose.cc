import { describe, expect, it } from "vitest";
import {
  CHECKPOINT_CLASSES,
  GOAL_DEFAULT_MAX_NODES,
  GRADUABLE_CLASSES,
  attenuateContract,
  checkpointClassOf,
  compileContract,
  contactAllowed,
  contractRefusals,
  defaultCheckpoints,
  deriveGoalStatus,
  parseGoalContract,
  microsToUsd,
  sketchFromContract,
  usdToMicros,
  type GoalContract,
} from "./goalContract.js";
import { attenuatePlan } from "./attenuation.js";

/**
 * s20 T6 — the delegation contract, as arithmetic.
 *
 * The load-bearing claim of this file is the one the sprint asks to be PROVEN
 * rather than asserted: **a sub-task can never exceed the goal.** It is proven
 * twice, on purpose — once at the contract layer (a sub-goal against its
 * parent) and once where it actually bites (a task list against the aggregate
 * budget the contract compiled to) — because a face that showed a tighter
 * bound than the envelope enforces would teach a person to trust a limit the
 * system does not hold, which is worse than showing no limit at all.
 */

const CONTRACT: GoalContract = {
  may: { tools: ["files.read"], contact: ["ana@structural.example", "@structural.example"] },
  mayNot: ["commit me to a date"],
  escalateWhen: null,
  doneWhen: "three engineers have said yes",
  budgetUsd: 750,
};

describe("parsing a contract — an unreadable clause refuses, it never defaults", () => {
  it("reads the four clauses", () => {
    const parsed = parseGoalContract({
      may: { tools: ["a"], contact: ["x@y.example"] },
      mayNot: ["no dates"],
      escalateWhen: { afterMs: 86_400_000, note: "chase it" },
      doneWhen: "they said yes",
      budgetUsd: 750,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.contract.escalateWhen).toEqual({ afterMs: 86_400_000, note: "chase it" });
    expect(parsed.contract.budgetUsd).toBe(750);
  });

  it("requires done-when: a delegation with no done-ness never ends", () => {
    const parsed = parseGoalContract({ may: {}, doneWhen: "  " });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.why).toContain("doneWhen");
  });

  it("an absent `may` is EMPTY, never permissive — least privilege on omission", () => {
    const parsed = parseGoalContract({ doneWhen: "done" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.contract.may.tools).toEqual([]);
    expect(parsed.contract.may.contact).toEqual([]);
  });

  it("refuses a malformed clause rather than dropping it", () => {
    expect(parseGoalContract({ doneWhen: "x", may: { tools: "files.read" } }).ok).toBe(false);
    expect(parseGoalContract({ doneWhen: "x", may: { contact: [7] } }).ok).toBe(false);
    expect(parseGoalContract({ doneWhen: "x", mayNot: "no dates" }).ok).toBe(false);
    expect(parseGoalContract({ doneWhen: "x", may: ["files.read"] }).ok).toBe(false);
    expect(parseGoalContract({ doneWhen: "x", budgetUsd: -5 }).ok).toBe(false);
    expect(parseGoalContract({ doneWhen: "x", budgetUsd: "lots" }).ok).toBe(false);
    expect(parseGoalContract({ doneWhen: "x", escalateWhen: { afterMs: 0 } }).ok).toBe(false);
    expect(parseGoalContract({ doneWhen: "x", escalateWhen: { afterMs: "Friday" } }).ok).toBe(false);
    expect(parseGoalContract({ doneWhen: "x", escalateWhen: [3] }).ok).toBe(false);
    expect(parseGoalContract("a goal").ok).toBe(false);
  });
});

describe("the per-node share — the arithmetic that makes a $750 goal runnable", () => {
  it("compiles the dollar bound to the aggregate, and divides it by the fan-out cap", () => {
    const compiled = compileContract(CONTRACT, 8);
    expect(compiled.budgetMicros).toBe(usdToMicros(750));
    expect(compiled.perNodeMicros).toBe(usdToMicros(750) / 8);
    expect(compiled.authority.budgetMicros).toBe(compiled.perNodeMicros);
  });

  it("converts both ways, because a surface has to say $750 to a person", () => {
    expect(usdToMicros(750)).toBe(750_000_000);
    expect(microsToUsd(750_000_000)).toBe(750);
  });

  it("a Job that fills its node cap exactly exhausts its purse, and can never exceed it", () => {
    // The reservation system: every declared budget counts the moment the row
    // exists. This is why the root cannot declare the whole purse — it would
    // refuse its own first task for money nothing had spent.
    for (const maxNodes of [1, 2, 5, 8, 13, 64]) {
      const compiled = compileContract(CONTRACT, maxNodes);
      expect(compiled.perNodeMicros! * maxNodes).toBeLessThanOrEqual(compiled.budgetMicros!);
    }
  });

  it("PROVES the sub-task bound where it bites: N children under the aggregate", () => {
    const maxNodes = 8;
    const compiled = compileContract(CONTRACT, maxNodes);
    const ceiling = {
      accountId: "a",
      bindingId: "b",
      jobId: "j",
      depth: 0,
      authority: { tools: ["files.read"], credentials: [], budgetMicros: compiled.perNodeMicros },
      privacy: null,
      dueAt: null,
    };
    // Seven siblings under a root that already reserved one share: exactly the
    // cap, and it fits.
    const seven = Array.from({ length: 7 }, (_, i) => ({ key: `t${i}` }));
    const fits = attenuatePlan(
      ceiling,
      seven,
      { maxNodes, maxDepth: 2, budgetMicros: compiled.budgetMicros },
      {
        nodeCount: 1,
        reservedMicros: compiled.perNodeMicros!,
      },
    );
    expect(fits.ok).toBe(true);

    // One child asking for the whole purse is refused — not truncated to the
    // share, REFUSED, so the attempt is visible and the invariant testable.
    const greedy = attenuatePlan(
      ceiling,
      [{ key: "greedy", budgetMicros: compiled.budgetMicros }],
      { maxNodes, maxDepth: 2, budgetMicros: compiled.budgetMicros },
      { nodeCount: 1, reservedMicros: compiled.perNodeMicros! },
    );
    expect(greedy.ok).toBe(false);
    if (greedy.ok) return;
    expect(greedy.refusals[0]!.axis).toBe("budget");
  });
});

describe("may.contact — the recipient bound the node envelope does not carry", () => {
  it("matches an exact address or a whole @domain, and nothing clever", () => {
    expect(contactAllowed(["ana@structural.example"], "ana@structural.example")).toBe(true);
    expect(contactAllowed(["ana@structural.example"], "ANA@Structural.Example")).toBe(true);
    expect(contactAllowed(["@structural.example"], "bo@structural.example")).toBe(true);
    expect(contactAllowed(["@structural.example"], "bo@notstructural.example")).toBe(false);
    // No substring matching: the near-miss here is an email to a stranger.
    expect(contactAllowed(["ana@structural.example"], "ana@structural.example.attacker.test")).toBe(false);
    expect(contactAllowed([], "anyone@anywhere.test")).toBe(false);
    expect(contactAllowed(["@x.test"], "not-an-address")).toBe(false);
  });

  it("refuses a task addressed outside the contract, and names the ceiling", () => {
    const refusals = contractRefusals(CONTRACT, [
      { key: "ok", context: { to: "bo@structural.example" } },
      { key: "sneak", context: { to: "stranger@elsewhere.example" } },
      { key: "no-recipient", context: { op: "summarize" } },
    ]);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.key).toBe("sneak");
    expect(refusals[0]!.axis).toBe("identity");
    expect(refusals[0]!.ceiling).toContain("@structural.example");
  });
});

describe("monotonic attenuation at the contract layer — a sub-goal cannot exceed its goal", () => {
  const child = (over: Partial<GoalContract>): GoalContract => ({ ...CONTRACT, ...over });

  it("admits a narrowing on every axis", () => {
    expect(
      attenuateContract(CONTRACT, child({ may: { tools: [], contact: ["bo@structural.example"] }, budgetUsd: 100 })),
    ).toEqual([]);
  });

  it("refuses a tool the parent goal does not hold", () => {
    const refusals = attenuateContract(CONTRACT, child({ may: { tools: ["files.write"], contact: [] } }));
    expect(refusals.map((r) => r.axis)).toEqual(["tools"]);
  });

  it("refuses reach beyond the parent goal's", () => {
    const refusals = attenuateContract(
      CONTRACT,
      child({ may: { tools: [], contact: ["stranger@elsewhere.example"] } }),
    );
    expect(refusals.map((r) => r.axis)).toEqual(["identity"]);
  });

  it("refuses more money — including the unbounded child a planner would reach for", () => {
    expect(attenuateContract(CONTRACT, child({ budgetUsd: 751 })).map((r) => r.axis)).toEqual(["budget"]);
    expect(attenuateContract(CONTRACT, child({ budgetUsd: null })).map((r) => r.axis)).toEqual(["budget"]);
  });
});

describe("the decomposition derived from the contract", () => {
  it("one outreach per named address, plus a join that compiles the answers", () => {
    const { tasks } = sketchFromContract({
      ...CONTRACT,
      may: { tools: [], contact: ["ana@structural.example", "bo@structural.example"] },
    });
    expect(tasks.map((t) => t.key)).toEqual(["reach-1", "reach-2", "compile"]);
    expect(tasks[2]!.needs as string[]).toEqual(["reach-1", "reach-2"]);
  });

  it("a @domain grants reach without naming a person, so it produces NO task", () => {
    // A domain is a permission, not a person; inventing an address inside it
    // would be exactly the confident wrongness approvals exist to catch.
    expect(sketchFromContract({ ...CONTRACT, may: { tools: [], contact: ["@structural.example"] } }).tasks).toEqual([]);
  });
});

describe("checkpoints thin by CLASS, and the goal's status never overstates itself", () => {
  it("every class starts manual, and only the wired one may graduate", () => {
    const policy = defaultCheckpoints();
    expect(CHECKPOINT_CLASSES.every((c) => policy[c].mode === "manual")).toBe(true);
    // The honesty rule: `email` and `summary` have no enforcement point, so
    // recording them as auto would render as autonomy and deliver none.
    expect([...GRADUABLE_CLASSES]).toEqual(["plan"]);
  });

  it("files a proposal under the class it belongs to, and refuses to guess", () => {
    expect(checkpointClassOf("goal-plan")).toBe("plan");
    expect(checkpointClassOf("goal-outreach")).toBe("email");
    expect(checkpointClassOf("verb-compose")).toBe("email");
    expect(checkpointClassOf("goal-summary")).toBe("summary");
    expect(checkpointClassOf("held-mail-review")).toBeNull();
  });

  it("an open plan checkpoint reads `awaiting-plan`, NOT `done`", () => {
    // The most dangerous possible lie: the planner finished, every node is
    // done, nothing failed — and the goal has done nothing at all.
    expect(deriveGoalStatus({ jobStatus: "done", planCheckpointOpen: true })).toBe("awaiting-plan");
    expect(deriveGoalStatus({ jobStatus: "done", planCheckpointOpen: false })).toBe("done");
  });

  it("cancellation and acceptance are AUTHORED facts and outrank the derivation", () => {
    expect(deriveGoalStatus({ jobStatus: "done", planCheckpointOpen: false, cancelledAt: 5 })).toBe("cancelled");
    expect(deriveGoalStatus({ jobStatus: "done", planCheckpointOpen: true, cancelledAt: 5 })).toBe("cancelled");
    expect(deriveGoalStatus({ jobStatus: "running", planCheckpointOpen: false, acceptedAt: 9 })).toBe("accepted");
  });

  it("the default fan-out cap is small: a first delegation that can fan out to 64 is a hope", () => {
    expect(GOAL_DEFAULT_MAX_NODES).toBeLessThanOrEqual(8);
  });
});
