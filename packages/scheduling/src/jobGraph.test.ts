import { describe, expect, it } from "vitest";
import { fakeD1, type FakeD1 } from "@bullmoose/test-fakes";
import { budgetMonthStartMs, claimGateBinds, claimGateSql } from "./claimGate.js";
import {
  deriveJobStatus,
  jobBudgetExhausted,
  jobBudgetExhaustedSql,
  jobView,
  needsSatisfied,
  needsSatisfiedSql,
  parseNeeds,
  type JobNodeState,
} from "./jobGraph.js";
import type { ClaimantIdentity } from "./mayClaim.js";

/**
 * s11 T7 — the DAG half of the claim gate, and the status nobody stores.
 *
 * Same discipline as `claimGateAgreement.test.ts`: each predicate is stated
 * once as SQL (folded into every claim statement) and once as a pure function
 * (read by surfaces and by the derived view), and this file runs BOTH over one
 * table of real rows and requires identical verdicts. Comment-level agreement
 * is not agreement.
 *
 * Then the second half: Job status is DERIVED. The last describe block is the
 * one that bites if anyone ever stores it — it changes the nodes and requires
 * the view to move with them, with no write to the `jobs` row anywhere.
 */

const NOW = Date.UTC(2026, 7, 13, 12, 0, 0);
const ACCOUNT = "a_dag";

interface Dep {
  id: string;
  status: string;
  /** An open needsInfo question on this node's proposal (s10 T3). */
  infoRequested?: boolean;
  /** A pending proposal — awaiting a verdict, which does NOT pause. */
  proposalPending?: boolean;
  /** Seed the row on a DIFFERENT account (scoping check). */
  otherAccount?: boolean;
}

let n = 0;

/** Seed one node with `needs`, plus its dependency rows. Returns the node id. */
function seedGraph(db: FakeD1, needsJson: string | null, deps: readonly Dep[]): string {
  n += 1;
  const bindingId = `b_${n}`;
  const nodeId = `inv_node_${n}`;
  db.seed("agent_bindings", [{ id: bindingId, account_id: ACCOUNT, name: `bind${n}`, config_json: "{}" }]);
  for (const d of deps) {
    db.seed("agent_invocations", [
      {
        id: d.id,
        account_id: d.otherAccount ? "a_other" : ACCOUNT,
        binding_id: bindingId,
        binding_name: `bind${n}`,
        status: d.status,
        created_at: 1,
        done_at: d.status === "done" ? NOW - 1000 : null,
      },
    ]);
    if (d.infoRequested || d.proposalPending) {
      db.seed("agent_proposals", [
        {
          id: d.id,
          account_id: d.otherAccount ? "a_other" : ACCOUNT,
          kind: "reply-draft",
          tier: 2,
          rationale: "because",
          status: d.infoRequested ? "info-requested" : "pending",
          created_at: 1,
        },
      ]);
    }
  }
  db.seed("agent_invocations", [
    {
      id: nodeId,
      account_id: ACCOUNT,
      binding_id: bindingId,
      binding_name: `bind${n}`,
      status: "pending",
      created_at: 2,
      needs_json: needsJson,
      job_id: `job_${n}`,
      depth: 1,
    },
  ]);
  return nodeId;
}

/** The SQL verdict for one node. */
async function sqlSatisfied(db: FakeD1, nodeId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS hit FROM agent_invocations inv
        WHERE inv.account_id = ? AND inv.id = ? AND ${needsSatisfiedSql("inv")}`,
    )
    .bind(ACCOUNT, nodeId)
    .first<{ hit: number }>();
  return row !== null;
}

/** The pure verdict, over the same fixture. */
function pureSatisfied(needsJson: string | null, deps: readonly Dep[]): boolean {
  const settled = (id: string) => {
    const d = deps.find((x) => x.id === id && !x.otherAccount);
    return d !== undefined && d.status === "done" && d.infoRequested !== true;
  };
  return needsSatisfied(parseNeeds(needsJson), settled);
}

// ---- claimability: `needs` -------------------------------------------------

describe("claimability = pending AND every need settled (SQL ≡ pure)", () => {
  const DONE: Dep = { id: "inv_a", status: "done" };
  const PENDING: Dep = { id: "inv_b", status: "pending" };
  const RUNNING: Dep = { id: "inv_c", status: "running" };
  const FAILED: Dep = { id: "inv_d", status: "failed" };
  const PAUSED: Dep = { id: "inv_e", status: "done", infoRequested: true };
  const AWAITING: Dep = { id: "inv_f", status: "done", proposalPending: true };
  const FOREIGN: Dep = { id: "inv_g", status: "done", otherAccount: true };

  const CASES: Array<{ name: string; needs: string | null; deps: Dep[]; expected: boolean }> = [
    {
      name: "DefaultCase — no needs at all (an ordinary invocation)",
      needs: null,
      deps: [],
      expected: true,
    },
    { name: "an empty needs array", needs: "[]", deps: [], expected: true },
    { name: "one done need", needs: '["inv_a"]', deps: [DONE], expected: true },
    { name: "one pending need", needs: '["inv_b"]', deps: [PENDING], expected: false },
    { name: "one running need", needs: '["inv_c"]', deps: [RUNNING], expected: false },
    {
      name: "one FAILED need — a failed node blocks its dependents",
      needs: '["inv_d"]',
      deps: [FAILED],
      expected: false,
    },
    {
      name: "a need that does not exist at all",
      needs: '["inv_ghost"]',
      deps: [],
      expected: false,
    },
    {
      name: "two needs, one unfinished (a join waits for ALL)",
      needs: '["inv_a","inv_b"]',
      deps: [DONE, PENDING],
      expected: false,
    },
    {
      name: "two needs, both done (the join releases)",
      needs: '["inv_a","inv_f"]',
      deps: [DONE, AWAITING],
      expected: true,
    },
    {
      name: "a done need with an OPEN needsInfo question — paused",
      needs: '["inv_e"]',
      deps: [PAUSED],
      expected: false,
    },
    {
      name: "a done need with a merely PENDING proposal — not paused",
      needs: '["inv_f"]',
      deps: [AWAITING],
      expected: true,
    },
    {
      name: "a done need on ANOTHER account does not settle it",
      needs: '["inv_g"]',
      deps: [FOREIGN],
      expected: false,
    },
    {
      name: "malformed needs_json blocks (fail closed)",
      needs: "not json",
      deps: [],
      expected: false,
    },
    {
      name: "a JSON object rather than an array blocks",
      needs: '{"a":1}',
      deps: [],
      expected: false,
    },
    { name: "a non-string element blocks", needs: "[1,2]", deps: [], expected: false },
  ];

  for (const c of CASES) {
    it(`${c.name} → ${c.expected ? "claimable" : "blocked"}, and both formulations agree`, async () => {
      const db = fakeD1();
      const nodeId = seedGraph(db, c.needs, c.deps);
      const sql = await sqlSatisfied(db, nodeId);
      const pure = pureSatisfied(c.needs, c.deps);
      expect(sql).toBe(c.expected);
      expect(pure).toBe(sql);
    });
  }

  it("the fragment takes NO placeholders — folding it disturbs no bind order", () => {
    expect(needsSatisfiedSql("inv").includes("?")).toBe(false);
  });
});

// ---- claimability: the aggregate budget ------------------------------------

describe("the Job's aggregate budget (SQL ≡ pure)", () => {
  interface Node {
    cost: number | null;
    done: boolean;
    otherJob?: boolean;
  }

  async function seedJob(
    db: FakeD1,
    budgetMicros: number | null,
    nodes: readonly Node[],
  ): Promise<{ id: string; jobId: string }> {
    n += 1;
    const jobId = `job_b_${n}`;
    const bindingId = `b_b_${n}`;
    db.seed("agent_bindings", [{ id: bindingId, account_id: ACCOUNT, name: `bb${n}`, config_json: "{}" }]);
    db.seed("jobs", [
      {
        id: jobId,
        account_id: ACCOUNT,
        binding_id: bindingId,
        binding_name: `bb${n}`,
        root_invocation_id: `inv_root_${n}`,
        budget_micros: budgetMicros,
        max_nodes: 8,
        max_depth: 3,
        created_at: 1,
      },
    ]);
    nodes.forEach((node, i) => {
      db.seed("agent_invocations", [
        {
          id: `inv_spend_${n}_${i}`,
          account_id: ACCOUNT,
          binding_id: bindingId,
          binding_name: `bb${n}`,
          status: node.done ? "done" : "running",
          created_at: 1,
          done_at: node.done ? NOW - 1 : null,
          cost_micros: node.cost,
          job_id: node.otherJob ? `job_other_${n}` : jobId,
        },
      ]);
    });
    const id = `inv_next_${n}`;
    db.seed("agent_invocations", [
      {
        id,
        account_id: ACCOUNT,
        binding_id: bindingId,
        binding_name: `bb${n}`,
        status: "pending",
        created_at: 2,
        job_id: jobId,
      },
    ]);
    return { id, jobId };
  }

  const CASES: Array<{ name: string; budget: number | null; nodes: Node[]; expected: boolean }> = [
    {
      name: "no aggregate cap",
      budget: null,
      nodes: [{ cost: 9_000_000, done: true }],
      expected: false,
    },
    {
      name: "under the cap",
      budget: 1_000_000,
      nodes: [{ cost: 400_000, done: true }],
      expected: false,
    },
    {
      name: "one micro under",
      budget: 1_000_000,
      nodes: [{ cost: 999_999, done: true }],
      expected: false,
    },
    {
      name: "exactly at the cap",
      budget: 1_000_000,
      nodes: [{ cost: 1_000_000, done: true }],
      expected: true,
    },
    {
      name: "over, summed across nodes",
      budget: 1_000_000,
      nodes: [
        { cost: 600_000, done: true },
        { cost: 600_000, done: true },
      ],
      expected: true,
    },
    {
      name: "an unfinished node's cost is not spend yet",
      budget: 1_000_000,
      nodes: [{ cost: 9_000_000, done: false }],
      expected: false,
    },
    {
      name: "a NULL cost counts as nothing (undetermined, not a zero claim)",
      budget: 1_000_000,
      nodes: [{ cost: null, done: true }],
      expected: false,
    },
    {
      name: "another Job's spend does not count",
      budget: 1_000_000,
      nodes: [{ cost: 9_000_000, done: true, otherJob: true }],
      expected: false,
    },
    {
      name: "a zero aggregate budget is exhausted from the first moment",
      budget: 0,
      nodes: [],
      expected: true,
    },
  ];

  for (const c of CASES) {
    it(`${c.name} → ${c.expected ? "exhausted" : "spendable"}, and both formulations agree`, async () => {
      const db = fakeD1();
      const seeded = await seedJob(db, c.budget, c.nodes);
      const row = await db
        .prepare(
          `SELECT 1 AS hit FROM agent_invocations inv
            WHERE inv.account_id = ? AND inv.id = ? AND ${jobBudgetExhaustedSql("inv")}`,
        )
        .bind(ACCOUNT, seeded.id)
        .first<{ hit: number }>();
      const sql = row !== null;
      const spent = c.nodes.filter((x) => x.done && !x.otherJob).reduce((sum, x) => sum + (x.cost ?? 0), 0);
      expect(sql).toBe(c.expected);
      expect(jobBudgetExhausted({ budgetMicros: c.budget, spentMicros: spent })).toBe(sql);
    });
  }

  it("an invocation with no job_id is never job-budget-exhausted (DefaultCase)", async () => {
    const db = fakeD1();
    db.seed("agent_bindings", [{ id: "b_plain", account_id: ACCOUNT, name: "plain", config_json: "{}" }]);
    db.seed("agent_invocations", [
      {
        id: "inv_plain",
        account_id: ACCOUNT,
        binding_id: "b_plain",
        binding_name: "plain",
        status: "pending",
        created_at: 1,
      },
    ]);
    const row = await db
      .prepare(
        `SELECT 1 AS hit FROM agent_invocations inv
          WHERE inv.account_id = ? AND inv.id = ? AND ${jobBudgetExhaustedSql("inv")}`,
      )
      .bind(ACCOUNT, "inv_plain")
      .first<{ hit: number }>();
    expect(row).toBeNull();
  });
});

// ---- where the two terms sit in the gate -----------------------------------

describe("the two DAG terms inside the whole claim gate", () => {
  const FREE: ClaimantIdentity = { isFree: true, capabilities: null };
  const PAID: ClaimantIdentity = { isFree: false, capabilities: null };

  async function claimable(db: FakeD1, id: string, claimant: ClaimantIdentity): Promise<boolean> {
    const row = await db
      .prepare(
        `SELECT 1 AS hit FROM agent_invocations
          WHERE account_id = ? AND id = ? AND status = 'pending'${claimGateSql("agent_invocations")}`,
      )
      .bind(
        ACCOUNT,
        id,
        ...claimGateBinds({
          now: NOW,
          claimant,
          escalationWindowMs: 60 * 60_000,
          monthStartMs: budgetMonthStartMs(NOW),
        }),
      )
      .first<{ hit: number }>();
    return row !== null;
  }

  it("a BLOCKED node is refused to BOTH runtimes — execution order is structural, not policy", async () => {
    const db = fakeD1();
    const nodeId = seedGraph(db, '["inv_pending_dep"]', [{ id: "inv_pending_dep", status: "pending" }]);
    expect(await claimable(db, nodeId, PAID)).toBe(false);
    expect(await claimable(db, nodeId, FREE)).toBe(false);
  });

  it("the same node is claimable by both once its need is done", async () => {
    const db = fakeD1();
    const nodeId = seedGraph(db, '["inv_done_dep"]', [{ id: "inv_done_dep", status: "done" }]);
    expect(await claimable(db, nodeId, PAID)).toBe(true);
    expect(await claimable(db, nodeId, FREE)).toBe(true);
  });

  it("a job-budget-exhausted node is refused to the PAID cloud and still claimable by a FREE runtime", async () => {
    // Exhaustion narrows the claimant set; it never fails the work. A free
    // claimant stamps cost 0, so letting it finish spends nothing.
    const db = fakeD1();
    db.seed("agent_bindings", [{ id: "b_x", account_id: ACCOUNT, name: "bx", config_json: "{}" }]);
    db.seed("jobs", [
      {
        id: "job_x",
        account_id: ACCOUNT,
        binding_id: "b_x",
        binding_name: "bx",
        root_invocation_id: "inv_x_root",
        budget_micros: 100,
        max_nodes: 8,
        max_depth: 3,
        created_at: 1,
      },
    ]);
    db.seed("agent_invocations", [
      {
        id: "inv_x_root",
        account_id: ACCOUNT,
        binding_id: "b_x",
        binding_name: "bx",
        status: "done",
        created_at: 1,
        done_at: NOW - 1,
        cost_micros: 100,
        job_id: "job_x",
      },
      {
        id: "inv_x_task",
        account_id: ACCOUNT,
        binding_id: "b_x",
        binding_name: "bx",
        status: "pending",
        created_at: 2,
        job_id: "job_x",
      },
    ]);
    expect(await claimable(db, "inv_x_task", PAID)).toBe(false);
    expect(await claimable(db, "inv_x_task", FREE)).toBe(true);
  });
});

// ---- the derived view ------------------------------------------------------

describe("Job status is DERIVED from its nodes", () => {
  const node = (id: string, status: string, needs: string[] | null = null, paused = false): JobNodeState => ({
    id,
    status: status as JobNodeState["status"],
    needs,
    paused,
  });

  it("all pending → pending", () => {
    expect(deriveJobStatus([node("a", "pending"), node("b", "pending", ["a"])])).toBe("pending");
  });

  it("anything running → running", () => {
    expect(deriveJobStatus([node("a", "running"), node("b", "pending", ["a"])])).toBe("running");
  });

  it("any progress at all → running", () => {
    expect(deriveJobStatus([node("a", "done"), node("b", "pending", ["a"])])).toBe("running");
  });

  it("all done → done", () => {
    expect(deriveJobStatus([node("a", "done"), node("b", "done", ["a"])])).toBe("done");
  });

  it("a failure among BLOCKERS → stalled", () => {
    expect(deriveJobStatus([node("a", "failed"), node("b", "pending", ["a"])])).toBe("stalled");
  });

  it("stalled TRANSITIVELY — a node two hops below a failure is blocked forever too", () => {
    const nodes = [node("a", "failed"), node("b", "pending", ["a"]), node("c", "pending", ["b"])];
    expect(deriveJobStatus(nodes)).toBe("stalled");
  });

  it("a failed LEAF nobody depended on still stalls — a Job does not launder a failure", () => {
    expect(deriveJobStatus([node("a", "done"), node("b", "failed")])).toBe("stalled");
  });

  it("a failure alongside work that can still progress reads running, not stalled", () => {
    const nodes = [node("a", "failed"), node("b", "running"), node("c", "pending")];
    expect(deriveJobStatus(nodes)).toBe("running");
  });

  it("an open needsInfo question with nothing else able to move → paused", () => {
    const nodes = [node("a", "done", null, true), node("b", "pending", ["a"])];
    expect(deriveJobStatus(nodes)).toBe("paused");
  });

  it("needsInfo pauses only its SUBTREE: a sibling branch still moving reads running", () => {
    const nodes = [
      node("a", "done", null, true),
      node("b", "pending", ["a"]), // paused subtree
      node("c", "pending"), // an unrelated branch, claimable
    ];
    expect(deriveJobStatus(nodes)).toBe("running");
  });

  it("a paused node is not 'done' even when every node is done", () => {
    expect(deriveJobStatus([node("a", "done", null, true)])).toBe("paused");
  });

  it("no nodes → pending (total function)", () => {
    expect(deriveJobStatus([])).toBe("pending");
  });
});

describe("jobView — the progress surface reads the SAME rows, and drifts from nothing", () => {
  async function scaffold(): Promise<{ db: FakeD1; jobId: string }> {
    const db = fakeD1();
    db.seed("agent_bindings", [{ id: "b_v", account_id: ACCOUNT, name: "bv", config_json: "{}" }]);
    db.seed("jobs", [
      {
        id: "job_v",
        account_id: ACCOUNT,
        binding_id: "b_v",
        binding_name: "bv",
        root_invocation_id: "inv_v_root",
        budget_micros: 1_000_000,
        max_nodes: 8,
        max_depth: 3,
        created_at: 1,
      },
    ]);
    const seedNode = (id: string, status: string, needs: string | null, cost: number | null = null) =>
      db.seed("agent_invocations", [
        {
          id,
          account_id: ACCOUNT,
          binding_id: "b_v",
          binding_name: "bv",
          status,
          created_at: 1,
          done_at: status === "done" ? NOW : null,
          cost_micros: cost,
          job_id: "job_v",
          needs_json: needs,
        },
      ]);
    seedNode("inv_v_root", "done", null, 200_000);
    seedNode("inv_v_a", "pending", '["inv_v_root"]');
    seedNode("inv_v_b", "pending", '["inv_v_root"]');
    seedNode("inv_v_join", "pending", '["inv_v_a","inv_v_b"]');
    return { db, jobId: "job_v" };
  }

  it("renders progress, spend and the blocked count from the invocation rows", async () => {
    const { db } = await scaffold();
    const view = (await jobView(db, ACCOUNT, "job_v"))!;
    expect(view.status).toBe("running");
    expect(view.nodes).toMatchObject({ total: 4, done: 1, pending: 3, blocked: 1 });
    expect(view.spentMicros).toBe(200_000);
    expect(view.budgetMicros).toBe(1_000_000);
  });

  it("THE DERIVED-STATUS PROOF: finishing the nodes moves the view with ZERO writes to the jobs row", async () => {
    const { db } = await scaffold();
    const jobsRowBefore = db.query("SELECT * FROM jobs WHERE account_id = ? AND id = ?", ACCOUNT, "job_v")[0];

    await db
      .prepare(`UPDATE agent_invocations SET status = 'done', done_at = ?, cost_micros = 100000
                 WHERE account_id = ? AND id IN ('inv_v_a','inv_v_b')`)
      .bind(NOW, ACCOUNT)
      .run();
    const mid = (await jobView(db, ACCOUNT, "job_v"))!;
    expect(mid.status).toBe("running");
    expect(mid.nodes).toMatchObject({ done: 3, blocked: 0 });
    expect(mid.spentMicros).toBe(400_000);

    await db
      .prepare(`UPDATE agent_invocations SET status = 'done', done_at = ? WHERE account_id = ? AND id = 'inv_v_join'`)
      .bind(NOW, ACCOUNT)
      .run();
    expect((await jobView(db, ACCOUNT, "job_v"))!.status).toBe("done");

    // The Job row was never touched. If a `status` column is ever added and
    // written at creation, this assertion is what catches the drift: the row
    // says one thing and the nodes say another, and only one of them can be
    // the source of truth.
    const jobsRowAfter = db.query("SELECT * FROM jobs WHERE account_id = ? AND id = ?", ACCOUNT, "job_v")[0];
    expect(jobsRowAfter).toEqual(jobsRowBefore);
  });

  it("a failed node turns the view stalled — again with no write to the Job", async () => {
    const { db } = await scaffold();
    await db
      .prepare(`UPDATE agent_invocations SET status = 'failed', done_at = ? WHERE account_id = ? AND id = 'inv_v_a'`)
      .bind(NOW, ACCOUNT)
      .run();
    const view = (await jobView(db, ACCOUNT, "job_v"))!;
    expect(view.status).toBe("stalled");
    expect(view.nodes).toMatchObject({ failed: 1, blocked: 1 });
  });

  it("an unknown Job is null, never an empty-looking view", async () => {
    const { db } = await scaffold();
    expect(await jobView(db, ACCOUNT, "job_nope")).toBeNull();
  });
});
