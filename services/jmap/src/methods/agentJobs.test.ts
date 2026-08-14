import { describe, expect, it } from "vitest";
import { MethodRegistry } from "@bullmoose/jmap-core";
import { fakeEnv } from "@bullmoose/test-fakes";
import { registerAgentMethods } from "./agent";
import type { RequestContext } from "./common";

/**
 * s11 T7 — the DAG through the REAL claim path (`AgentInvocation/set`), which
 * is where a fleet host and the cloud both arrive.
 *
 * What this file proves that the drain tests cannot: **two DIFFERENT runtimes
 * process a planner's siblings in parallel**. The homelab (isFree, a declared
 * capability vector) takes one; the paid cloud takes the other; both succeed in
 * the same instant against the same rows, because claimability is a WHERE
 * clause and unblocked siblings are simply two rows that satisfy it.
 *
 * And the other half: a node whose `needs` are unfinished is refused by the
 * guarded UPDATE itself — to BOTH of them, since execution order is structural
 * rather than policy — with the same `forbidden` a policy refusal gets, and
 * the row still `pending` afterwards.
 */

const ACCOUNT = "a_jobs";
const TENANT = "t_bm";

interface SetResult {
  updated: Record<string, null>;
  notUpdated: Record<string, { type: string; description?: string }>;
}

const FLEET = { isFree: true, capabilities: { tools: true, contextTokens: 128_000 } };
const CLOUD = { isFree: false };

function harness(jobBudgetMicros: number | null = null) {
  const w = fakeEnv();
  const registry = new MethodRegistry<RequestContext>();
  registerAgentMethods(registry);
  const ctx: RequestContext = {
    env: w.env,
    principal: {
      username: "runtime@login.example",
      scopes: ["read", "draft"],
      accounts: [{ accountId: ACCOUNT, tenantId: TENANT, name: "Jobs" }],
    },
  };
  w.db.seed("agent_bindings", [{ id: "bind_j", account_id: ACCOUNT, name: "jobbed" }]);
  w.db.seed("jobs", [
    {
      id: "job_1",
      account_id: ACCOUNT,
      binding_id: "bind_j",
      binding_name: "jobbed",
      root_invocation_id: "inv_root",
      budget_micros: jobBudgetMicros,
      max_nodes: 8,
      max_depth: 3,
      created_at: 1,
    },
  ]);

  const seedNode = (id: string, extra: Record<string, unknown> = {}) =>
    w.db.seed("agent_invocations", [
      {
        id,
        account_id: ACCOUNT,
        binding_id: "bind_j",
        binding_name: "jobbed",
        status: "pending",
        context_json: JSON.stringify({ kind: "job-node", op: "echo" }),
        created_at: 1,
        // Due in 5 minutes — inside the no-history escalation window, so the
        // T2 policy gate admits BOTH runtimes and what these tests observe is
        // the DAG term rather than sit-free (a free claim makes the homelab
        // "live", which would hold the paid cloud off NULL-due work).
        due_at: Date.now() + 5 * 60_000,
        job_id: "job_1",
        depth: 1,
        authority_json: JSON.stringify({ tools: [], credentials: [], budgetMicros: 100_000 }),
        ...extra,
      },
    ]);

  const call = (args: Record<string, unknown>) =>
    registry.get("AgentInvocation/set")!({ accountId: ACCOUNT, ...args }, ctx) as unknown as Promise<SetResult>;

  const claim = (id: string, claimant: Record<string, unknown>) =>
    call({ claimant, update: { [id]: { status: "running" } } });

  const complete = (id: string, status: "done" | "failed") =>
    call({ update: { [id]: { status, result: { text: id } } } });

  const rowOf = (id: string) =>
    w.db.query<{ status: string; claimant_free: number | null }>(
      `SELECT status, claimant_free FROM agent_invocations WHERE account_id = ? AND id = ?`,
      ACCOUNT,
      id,
    )[0]!;

  return { w, seedNode, claim, complete, rowOf };
}

describe("two different runtimes process a planner's siblings in parallel", () => {
  it("the fleet host and the cloud each claim a sibling, and both succeed", async () => {
    const h = harness();
    h.seedNode("inv_a", { needs_json: "[]" });
    h.seedNode("inv_b", { needs_json: "[]" });

    const [byFleet, byCloud] = await Promise.all([h.claim("inv_a", FLEET), h.claim("inv_b", CLOUD)]);
    expect(byFleet.updated).toEqual({ inv_a: null });
    expect(byCloud.updated).toEqual({ inv_b: null });
    // Trust-but-audit: each row records who took it (s11 T2).
    expect(h.rowOf("inv_a")).toMatchObject({ status: "running", claimant_free: 1 });
    expect(h.rowOf("inv_b")).toMatchObject({ status: "running", claimant_free: 0 });
  });

  it("the second claimant on the SAME node still loses the optimistic race", async () => {
    const h = harness();
    h.seedNode("inv_a", { needs_json: "[]" });
    expect((await h.claim("inv_a", FLEET)).updated).toEqual({ inv_a: null });
    const second = await h.claim("inv_a", CLOUD);
    expect(second.notUpdated.inv_a!.type).toBe("notFound"); // already claimed, not a gate refusal
  });
});

describe("a join node is released by the DAG, not by a queue", () => {
  it("REFUSES the join while a need is unfinished — to the free runtime as much as the paid one", async () => {
    const h = harness();
    h.seedNode("inv_a", { needs_json: "[]" });
    h.seedNode("inv_b", { needs_json: "[]" });
    h.seedNode("inv_join", { needs_json: JSON.stringify(["inv_a", "inv_b"]) });

    for (const claimant of [FLEET, CLOUD]) {
      const res = await h.claim("inv_join", claimant);
      expect(res.updated).toEqual({});
      expect(res.notUpdated.inv_join!.type).toBe("forbidden");
      expect(res.notUpdated.inv_join!.description).toMatch(/not eligible/);
      expect(h.rowOf("inv_join").status).toBe("pending");
    }
  });

  it("releases the join the moment the LAST need completes — through the same claim path", async () => {
    const h = harness();
    h.seedNode("inv_a", { needs_json: "[]" });
    h.seedNode("inv_b", { needs_json: "[]" });
    h.seedNode("inv_join", { needs_json: JSON.stringify(["inv_a", "inv_b"]) });

    await h.claim("inv_a", FLEET);
    await h.complete("inv_a", "done");
    expect((await h.claim("inv_join", CLOUD)).notUpdated.inv_join!.type).toBe("forbidden"); // one need to go

    await h.claim("inv_b", CLOUD);
    await h.complete("inv_b", "done");
    expect((await h.claim("inv_join", CLOUD)).updated).toEqual({ inv_join: null });
  });

  it("a FAILED need blocks the dependent permanently — no sweep, no flag, no retry window", async () => {
    const h = harness();
    h.seedNode("inv_a", { needs_json: "[]" });
    h.seedNode("inv_after", { needs_json: JSON.stringify(["inv_a"]) });

    await h.claim("inv_a", CLOUD);
    await h.complete("inv_a", "failed");
    for (let attempt = 0; attempt < 3; attempt++) {
      expect((await h.claim("inv_after", CLOUD)).notUpdated.inv_after!.type).toBe("forbidden");
    }
    expect(h.rowOf("inv_after").status).toBe("pending");
  });

  it("an OPEN needsInfo question on a need pauses the dependent, and answering it resumes", async () => {
    const h = harness();
    h.seedNode("inv_a", { needs_json: "[]" });
    h.seedNode("inv_after", { needs_json: JSON.stringify(["inv_a"]) });
    await h.claim("inv_a", CLOUD);
    await h.complete("inv_a", "done");

    h.w.db.seed("agent_proposals", [
      {
        id: "inv_a",
        account_id: ACCOUNT,
        kind: "reply-draft",
        tier: 2,
        rationale: "r",
        status: "info-requested",
        question: "which quarter?",
        created_at: 1,
      },
    ]);
    expect((await h.claim("inv_after", CLOUD)).notUpdated.inv_after!.type).toBe("forbidden");

    await h.w.env.DB.prepare(
      `UPDATE agent_proposals SET status = 'pending', question = NULL WHERE account_id = ? AND id = ?`,
    )
      .bind(ACCOUNT, "inv_a")
      .run();
    expect((await h.claim("inv_after", CLOUD)).updated).toEqual({ inv_after: null });
  });
});

describe("the aggregate budget narrows the claimant set, it does not fail the work", () => {
  it("an over-budget Job is refused to the cloud and still claimable by the homelab", async () => {
    const h = harness(500_000);
    h.w.db.seed("agent_invocations", [
      {
        id: "inv_spent",
        account_id: ACCOUNT,
        binding_id: "bind_j",
        binding_name: "jobbed",
        status: "done",
        created_at: 1,
        done_at: Date.now() - 1000,
        cost_micros: 500_000,
        job_id: "job_1",
      },
    ]);
    h.seedNode("inv_next", { needs_json: "[]" });

    const paid = await h.claim("inv_next", CLOUD);
    expect(paid.notUpdated.inv_next!.type).toBe("forbidden");
    expect(h.rowOf("inv_next").status).toBe("pending");

    const free = await h.claim("inv_next", FLEET);
    expect(free.updated).toEqual({ inv_next: null });
  });

  it("under the aggregate budget, the cloud claims normally", async () => {
    const h = harness(500_000);
    h.seedNode("inv_next", { needs_json: "[]" });
    expect((await h.claim("inv_next", CLOUD)).updated).toEqual({ inv_next: null });
  });
});

describe("DefaultCase through the same method", () => {
  it("an invocation with no Job columns claims exactly as it did before T7", async () => {
    const h = harness();
    h.w.db.seed("agent_invocations", [
      {
        id: "inv_plain",
        account_id: ACCOUNT,
        binding_id: "bind_j",
        binding_name: "jobbed",
        status: "pending",
        email_id: "e_x",
        created_at: 1,
      },
    ]);
    expect((await h.claim("inv_plain", CLOUD)).updated).toEqual({ inv_plain: null });
    expect(h.rowOf("inv_plain").status).toBe("running");
  });
});
