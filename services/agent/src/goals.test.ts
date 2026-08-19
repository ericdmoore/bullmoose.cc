import { describe, expect, it } from "vitest";
import { fakeEnv } from "@bullmoose/test-fakes";
import { GOAL_OUTREACH_KIND, GOAL_PLAN_KIND, GOAL_SUMMARY_KIND, usdToMicros } from "@bullmoose/scheduling";
import agentWorker from "./index";
import { startJob } from "./jobs";
import { compileSummary, outreachBody, outreachSubject, readCheckpoints, resolvePlan } from "./goals";
import type { Env } from "./models";

/**
 * s20 T6 — GOALS, driven through the REAL cloud drain.
 *
 * Nothing here calls a node handler directly: every assertion is a consequence
 * of `POST /drain` running the same loop production runs, over rows the same
 * schema holds. What is being proven, in order:
 *
 *   1. THE PLAN-APPROVAL CHECKPOINT — a planner under a goal proposes its
 *      decomposition and creates NOTHING. The new class of approval: today's
 *      approvals gate egress, this one gates execution.
 *   2. the DefaultCase survives — a Job with no goal row expands exactly as
 *      s11 T7 left it, and so does a goal whose `plan` class has graduated.
 *   3. the contract bites BEFORE a human is asked: a sketch addressed outside
 *      the goal's reach fails the planner rather than becoming a proposal
 *      somebody would approve into a refusal.
 *   4. a cancelled goal produces neither work nor a proposal asking to.
 *   5. the outreach leaf and the summarize join emit ordinary proposals —
 *      a Goal reorganizes work, it never changes how the work gets out.
 */

const ACCOUNT = "t_bm__a_goal";
const TENANT = "t_bm";
const OWNER = "eric@bullmoose.cc";
const ENG_A = "ana@structural.example";
const ENG_B = "bo@structural.example";
const ENG_C = "cy@structural.example";

const ATTIC = "get three structural engineers willing to evaluate the attic";

const CONTRACT = {
  may: { tools: [], contact: [ENG_A, ENG_B, ENG_C] },
  mayNot: ["commit me to a date", "share the insurance claim number"],
  escalateWhen: null,
  doneWhen: "three engineers have said yes",
  budgetUsd: 750,
};

interface Scaffold {
  w: ReturnType<typeof fakeEnv>;
  env: Env;
  drain: () => Promise<{ handled: number }>;
  nodes: () => Array<{
    id: string;
    status: string;
    context_json: string;
    result_json: string | null;
    parent_id: string | null;
    job_id: string | null;
  }>;
  proposals: () => Array<{ id: string; kind: string; tier: number; status: string; payload_json: string }>;
}

function scaffold(): Scaffold {
  const w = fakeEnv();
  w.db.seedAccount({ accountId: ACCOUNT, tenantId: TENANT, displayName: "Eric" });
  w.db.seed("identities", [{ id: "id_eric", account_id: ACCOUNT, email: OWNER }]);
  w.db.seed("agent_bindings", [
    {
      id: "bind_cj",
      account_id: ACCOUNT,
      name: "cj",
      config_json: JSON.stringify({ pipeline: "reply", persona: "You are CJ." }),
    },
  ]);

  const drain = async () => {
    const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
    const res = await agentWorker.fetch!(
      new Request("https://agent.internal/drain", {
        method: "POST",
        headers: { "x-internal-token": w.env.INTERNAL_TOKEN },
      }),
      w.env as never,
      execCtx,
    );
    return (await res.json()) as { handled: number };
  };

  return {
    w,
    env: w.env as unknown as Env,
    drain,
    nodes: () =>
      w.db.query(
        `SELECT id, status, context_json, result_json, parent_id, job_id
           FROM agent_invocations WHERE account_id = ? AND job_id IS NOT NULL ORDER BY created_at, id`,
        ACCOUNT,
      ),
    proposals: () =>
      w.db.query(
        `SELECT id, kind, tier, status, payload_json FROM agent_proposals WHERE account_id = ? ORDER BY created_at`,
        ACCOUNT,
      ),
  };
}

/** Start a goal's Job the way `Goal/set` does: a planner root, no fixed plan. */
async function startGoalJob(
  s: Scaffold,
  o: { contract?: Record<string, unknown>; checkpoints?: Record<string, unknown>; cancelled?: boolean } = {},
) {
  const started = await startJob(s.env, {
    accountId: ACCOUNT,
    bindingId: "bind_cj",
    budgetMicros: usdToMicros(750),
    maxNodes: 8,
    maxDepth: 2,
    authority: { tools: [], credentials: [], budgetMicros: Math.floor(usdToMicros(750) / 8) },
    rootContext: { kind: "job-node", op: "plan" },
  });
  if (!started.ok) throw new Error(`could not start: ${JSON.stringify(started.refusals)}`);
  s.w.db.seed("goals", [
    {
      id: started.jobId,
      account_id: ACCOUNT,
      statement: ATTIC,
      contract_json: JSON.stringify(o.contract ?? CONTRACT),
      checkpoints_json: JSON.stringify(o.checkpoints ?? { plan: { mode: "manual" } }),
      created_by: OWNER,
      created_at: 1,
      cancelled_at: o.cancelled ? 2 : null,
    },
  ]);
  return started;
}

describe("the plan-approval checkpoint — approvals gate egress; this one gates EXECUTION", () => {
  it("a planner under a goal PROPOSES its decomposition and creates nothing", async () => {
    const s = scaffold();
    await startGoalJob(s);

    expect(s.nodes()).toHaveLength(1); // progressive revelation: one node so far
    await s.drain();

    // The whole claim, in two assertions: a proposal exists, and the DAG did
    // not grow. The tasks are what approval CREATES.
    const proposals = s.proposals();
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.kind).toBe(GOAL_PLAN_KIND);
    expect(proposals[0]!.tier).toBe(1);
    expect(s.nodes()).toHaveLength(1);

    // The payload IS the task list — the thing the human redlines.
    const payload = JSON.parse(proposals[0]!.payload_json) as {
      goalId: string;
      statement: string;
      tasks: Array<{ key: string; context: { op: string; to?: string } }>;
    };
    expect(payload.statement).toBe(ATTIC);
    expect(payload.tasks.map((t) => t.key)).toEqual(["reach-1", "reach-2", "reach-3", "compile"]);
    expect(payload.tasks.filter((t) => t.context.op === "outreach").map((t) => t.context.to)).toEqual([
      ENG_A,
      ENG_B,
      ENG_C,
    ]);

    // The planner node is `done` — its work, producing a decomposition, IS
    // finished; what remains is a human decision, which is what /approvals is.
    const root = s.nodes()[0]!;
    expect(root.status).toBe("done");
    const result = JSON.parse(root.result_json!) as { created: string[]; checkpoint: string };
    expect(result.checkpoint).toBe("plan");
    // Said out loud, so anything counting cannot mistake "I asked" for "I did".
    expect(result.created).toEqual([]);
  });

  it("a goal whose `plan` class has GRADUATED expands directly — no proposal", async () => {
    const s = scaffold();
    await startGoalJob(s, { checkpoints: { plan: { mode: "auto", by: OWNER, at: 5 } } });
    await s.drain();

    expect(s.proposals().filter((p) => p.kind === GOAL_PLAN_KIND)).toHaveLength(0);
    // Four tasks created, exactly as the checkpoint route would have created
    // them once approved — the same expansion, reached without the stop.
    expect(s.nodes()).toHaveLength(5);
  });

  it("the DefaultCase is untouched: a Job with NO goal row expands as s11 T7 left it", async () => {
    const s = scaffold();
    const started = await startJob(s.env, {
      accountId: ACCOUNT,
      bindingId: "bind_cj",
      budgetMicros: 1_000_000,
      maxNodes: 8,
      maxDepth: 2,
      authority: { tools: [], credentials: [], budgetMicros: 100_000 },
      rootContext: {
        kind: "job-node",
        op: "plan",
        plan: { tasks: [{ key: "a", budgetMicros: 10_000, context: { kind: "job-node", op: "echo", text: "x" } }] },
      },
    });
    expect(started.ok).toBe(true);
    await s.drain();

    expect(s.proposals()).toHaveLength(0);
    expect(s.nodes()).toHaveLength(2);
  });
});

describe("the contract bites before a human is ever asked", () => {
  it("a sketch addressed outside the goal's reach FAILS the planner rather than becoming a proposal", async () => {
    const s = scaffold();
    // A goal whose reach is one engineer, but whose planner was handed a fixed
    // plan naming a stranger — the shape a model-written plan will one day
    // have, and the shape a compromised one certainly will.
    const started = await startJob(s.env, {
      accountId: ACCOUNT,
      bindingId: "bind_cj",
      budgetMicros: usdToMicros(750),
      maxNodes: 8,
      maxDepth: 2,
      authority: { tools: [], credentials: [], budgetMicros: Math.floor(usdToMicros(750) / 8) },
      rootContext: {
        kind: "job-node",
        op: "plan",
        plan: {
          tasks: [{ key: "sneak", context: { kind: "job-node", op: "outreach", to: "stranger@elsewhere.example" } }],
        },
      },
    });
    if (!started.ok) throw new Error("setup");
    s.w.db.seed("goals", [
      {
        id: started.jobId,
        account_id: ACCOUNT,
        statement: ATTIC,
        contract_json: JSON.stringify({ ...CONTRACT, may: { tools: [], contact: [ENG_A] } }),
        checkpoints_json: JSON.stringify({ plan: { mode: "manual" } }),
        created_by: OWNER,
        created_at: 1,
      },
    ]);
    await s.drain();

    expect(s.proposals()).toHaveLength(0);
    const root = s.nodes()[0]!;
    expect(root.status).toBe("failed");
    expect(JSON.parse(root.result_json!).note).toContain("contract refuses");
  });

  it("a CANCELLED goal produces neither work nor a proposal asking to", async () => {
    const s = scaffold();
    await startGoalJob(s, { cancelled: true });
    await s.drain();

    expect(s.proposals()).toHaveLength(0);
    expect(s.nodes()).toHaveLength(1);
    expect(s.nodes()[0]!.status).toBe("failed");
    expect(JSON.parse(s.nodes()[0]!.result_json!).note).toContain("cancelled");
  });
});

describe("revocation bites everywhere a goal node could still speak", () => {
  it("a node already claimed when the goal was cancelled proposes NOTHING", async () => {
    const s = scaffold();
    const started = await startGoalJob(s, { checkpoints: { plan: { mode: "auto" } } });
    await s.drain(); // the planner expands: three outreach leaves and a join

    // The human cancels between the plan and the work — the ordinary race, and
    // the one a "recorded but not enforced" revocation would lose.
    s.w.db.query(`UPDATE goals SET cancelled_at = ? WHERE account_id = ? AND id = ?`, 99, ACCOUNT, started.jobId);
    await s.drain();
    await s.drain();

    expect(s.proposals()).toHaveLength(0);
    const ran = s.nodes().filter((n) => n.status === "failed");
    expect(ran.length).toBeGreaterThan(0);
    expect(JSON.parse(ran[ran.length - 1]!.result_json!).note).toContain("cancelled");
  });
});

describe("the goal's leaves are ordinary nodes whose output is an ordinary proposal", () => {
  it("an outreach leaf proposes ONE message, and a summarize join compiles the answers", async () => {
    const s = scaffold();
    await startGoalJob(s, { checkpoints: { plan: { mode: "auto" } } });

    await s.drain(); // the planner expands
    expect(s.nodes()).toHaveLength(5);

    await s.drain(); // the three outreach leaves run (the join still blocked)
    const outreach = s.proposals().filter((p) => p.kind === GOAL_OUTREACH_KIND);
    expect(outreach).toHaveLength(3);
    expect(outreach.map((p) => (JSON.parse(p.payload_json) as { to: string }).to).sort()).toEqual(
      [ENG_A, ENG_B, ENG_C].sort(),
    );
    // Tier 1: approving writes a DRAFT into the owner's own Drafts. Nothing
    // relays — a Job reorganizes work, never its egress.
    expect(outreach.every((p) => p.tier === 1)).toBe(true);

    await s.drain(); // the join is now claimable
    const summary = s.proposals().filter((p) => p.kind === GOAL_SUMMARY_KIND);
    expect(summary).toHaveLength(1);
    const text = (JSON.parse(summary[0]!.payload_json) as { text: string }).text;
    expect(text).toContain(ATTIC);
    expect(text).toContain("three engineers have said yes"); // the done-when clause, verbatim
    expect(text).toContain(ENG_A);
  });
});

describe("the pure helpers", () => {
  it("a malformed checkpoint policy reads as MANUAL — the one blob that degrades to more caution", () => {
    expect(readCheckpoints("not json").plan.mode).toBe("manual");
    expect(readCheckpoints('{"plan":"auto"}').plan.mode).toBe("manual");
    expect(readCheckpoints('{"plan":{"mode":"auto","by":"eric"}}').plan.mode).toBe("auto");
  });

  it("resolvePlan prefers a planner's own plan and derives one only when there is none", () => {
    const goal = {
      row: { statement: ATTIC } as never,
      contract: { ...CONTRACT, may: { tools: [], contact: [ENG_A] } } as never,
      checkpoints: readCheckpoints(null),
    };
    const fixed = { tasks: [{ key: "own" }] };
    expect(resolvePlan(fixed, goal)).toBe(fixed);
    const derived = resolvePlan(undefined, goal) as { tasks: Array<{ key: string }> };
    expect(derived.tasks.map((t) => t.key)).toEqual(["reach-1", "compile"]);
    expect(resolvePlan(undefined, null)).toBeUndefined();
  });

  it("the outreach template invents nothing it was not told", () => {
    const body = outreachBody({ statement: ATTIC });
    expect(body).toContain(ATTIC);
    expect(outreachBody({ statement: ATTIC, ask: "Are you available?" })).toContain("Are you available?");
    expect(outreachSubject({ statement: ATTIC })).toBe("Get three structural engineers willing to evaluate the attic");
    expect(outreachSubject({ statement: ATTIC, subject: "Attic survey" })).toBe("Attic survey");
  });

  it("a summary with no inputs says so rather than implying an answer", () => {
    const text = compileSummary({ statement: ATTIC, doneWhen: "three say yes", inputs: [] });
    expect(text).toContain("No task results to compile");
  });
});
