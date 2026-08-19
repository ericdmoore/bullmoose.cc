import { describe, expect, it } from "vitest";
import { fakeD1, type FakeD1 } from "@bullmoose/test-fakes";
import { expandPlanRows, getJobNodeRow, joinContextRows, startJobRows } from "./jobWrite.js";
import type { JobNodeRow } from "./nodeAuthority.js";

/**
 * The attenuated WRITE paths, at their edges.
 *
 * `services/agent/src/jobs.test.ts` drives these through the real drain, which
 * is where the interesting behaviour lives — a planner's siblings claimed by
 * two runtimes, the aggregate budget stopping a runaway fan-out. What that
 * cannot reach is the set of refusals that only a MALFORMED caller produces,
 * and those matter more since s20 T6 gave this module a second caller: the
 * plan-approval checkpoint runs it from inside `ActionProposal/set`, over a
 * payload a human just hand-edited. Every "this is not a plan" path below is
 * one an approval can now take.
 */

const ACCOUNT = "a_job";

function db(): FakeD1 {
  const d = fakeD1();
  d.seed("agent_bindings", [{ id: "bind_a", account_id: ACCOUNT, name: "planner", config_json: "{}" }]);
  return d;
}

const env = (d: FakeD1) => ({ DB: d as unknown as D1Database });

const node = (over: Partial<JobNodeRow> = {}): JobNodeRow =>
  ({
    id: "inv_root",
    account_id: ACCOUNT,
    binding_id: "bind_a",
    binding_name: "planner",
    job_id: "job_1",
    parent_id: null,
    needs_json: null,
    depth: 0,
    authority_json: JSON.stringify({ tools: [], credentials: [], budgetMicros: 1000 }),
    privacy: null,
    due_at: null,
    context_json: "{}",
    email_id: null,
    status: "done",
    ...over,
  }) as JobNodeRow;

describe("startJobRows refuses before it writes", () => {
  it("refuses an unknown binding and a disabled one", async () => {
    const d = db();
    const spec = { accountId: ACCOUNT, maxNodes: 4, maxDepth: 2, rootContext: { kind: "job-node", op: "plan" } };
    const missing = await startJobRows(env(d), { ...spec, bindingId: "bind_nope" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.refusals[0]!.why).toContain("no such binding");

    d.query(`UPDATE agent_bindings SET enabled = 0 WHERE account_id = ? AND id = 'bind_a'`, ACCOUNT);
    const off = await startJobRows(env(d), { ...spec, bindingId: "bind_a" });
    expect(off.ok).toBe(false);
    if (!off.ok) expect(off.refusals[0]!.why).toContain("kill switch");
  });

  it("an unparseable binding config is an UNSET ceiling — same as absent, never permissive-by-crash", async () => {
    const d = db();
    d.query(`UPDATE agent_bindings SET config_json = '{not json' WHERE account_id = ? AND id = 'bind_a'`, ACCOUNT);
    const started = await startJobRows(env(d), {
      accountId: ACCOUNT,
      bindingId: "bind_a",
      maxNodes: 4,
      maxDepth: 2,
      authority: { tools: ["files.read"] },
      rootContext: { kind: "job-node", op: "plan" },
    });
    expect(started.ok).toBe(true);
  });

  it("the binding's own caps narrow the caller's ask, and its budget is a ceiling not a grant", async () => {
    const d = db();
    d.query(
      `UPDATE agent_bindings SET config_json = ? WHERE account_id = ? AND id = 'bind_a'`,
      JSON.stringify({ jobs: { maxNodes: 2, maxDepth: 1, budgetMicros: 500 } }),
      ACCOUNT,
    );
    const started = await startJobRows(env(d), {
      accountId: ACCOUNT,
      bindingId: "bind_a",
      budgetMicros: 9_000_000,
      maxNodes: 64,
      maxDepth: 5,
      rootContext: { kind: "job-node", op: "plan" },
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const job = d.query<{ budget_micros: number; max_nodes: number; max_depth: number }>(
      `SELECT budget_micros, max_nodes, max_depth FROM jobs WHERE account_id = ? AND id = ?`,
      ACCOUNT,
      started.jobId,
    )[0]!;
    expect(job).toMatchObject({ budget_micros: 500, max_nodes: 2, max_depth: 1 });
  });

  it("a caller that names no budget inherits the binding's, when it has one", async () => {
    const d = db();
    d.query(
      `UPDATE agent_bindings SET config_json = ? WHERE account_id = ? AND id = 'bind_a'`,
      JSON.stringify({ jobs: { budgetMicros: 250 } }),
      ACCOUNT,
    );
    const started = await startJobRows(env(d), {
      accountId: ACCOUNT,
      bindingId: "bind_a",
      maxNodes: 4,
      maxDepth: 2,
      rootContext: { kind: "job-node", op: "plan" },
    });
    if (!started.ok) throw new Error("setup");
    expect(
      d.query<{ budget_micros: number }>(
        `SELECT budget_micros FROM jobs WHERE account_id = ? AND id = ?`,
        ACCOUNT,
        started.jobId,
      )[0]!.budget_micros,
    ).toBe(250);
  });

  it("refuses a root that does not attenuate against the binding", async () => {
    const d = db();
    d.query(
      `UPDATE agent_bindings SET config_json = ? WHERE account_id = ? AND id = 'bind_a'`,
      JSON.stringify({ jobs: { tools: ["files.read"] } }),
      ACCOUNT,
    );
    const started = await startJobRows(env(d), {
      accountId: ACCOUNT,
      bindingId: "bind_a",
      maxNodes: 4,
      maxDepth: 2,
      authority: { tools: ["files.write"] },
      rootContext: { kind: "job-node", op: "plan" },
    });
    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.refusals[0]!.axis).toBe("tools");
    // Nothing was written: a refusal is not a half-created Job.
    expect(d.query(`SELECT id FROM jobs WHERE account_id = ?`, ACCOUNT)).toHaveLength(0);
  });

  it("round-trips through getJobNodeRow, and an absent node reads null", async () => {
    const d = db();
    const started = await startJobRows(env(d), {
      accountId: ACCOUNT,
      bindingId: "bind_a",
      maxNodes: 4,
      maxDepth: 2,
      rootContext: { kind: "job-node", op: "plan" },
    });
    if (!started.ok) throw new Error("setup");
    const row = await getJobNodeRow(env(d), ACCOUNT, started.rootId);
    expect(row?.job_id).toBe(started.jobId);
    expect(row?.depth).toBe(0);
    expect(await getJobNodeRow(env(d), ACCOUNT, "inv_ghost")).toBeNull();
  });
});

describe("expandPlanRows refuses anything that is not a plan", () => {
  it("refuses a node that is not part of a Job", async () => {
    const res = await expandPlanRows(env(db()), node({ job_id: null }), { tasks: [{ key: "a" }] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.refusals[0]!.why).toContain("not part of a Job");
  });

  it("refuses a node whose Job row is gone", async () => {
    const res = await expandPlanRows(env(db()), node(), { tasks: [{ key: "a" }] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.refusals[0]!.why).toContain("no such Job row");
  });

  it("refuses an empty, absent or malformed task list", async () => {
    const d = db();
    d.seed("jobs", [
      {
        id: "job_1",
        account_id: ACCOUNT,
        binding_id: "bind_a",
        binding_name: "planner",
        root_invocation_id: "inv_root",
        budget_micros: null,
        max_nodes: 4,
        max_depth: 2,
        created_at: 1,
      },
    ]);
    for (const plan of [null, {}, { tasks: [] }, { tasks: "everything" }]) {
      const res = await expandPlanRows(env(d), node(), plan);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.refusals[0]!.why).toContain("non-empty task list");
    }
  });

  it("refuses when the delegation chain cannot be read — an unknown bound is not a permissive one", async () => {
    const d = db();
    d.seed("jobs", [
      {
        id: "job_1",
        account_id: ACCOUNT,
        binding_id: "bind_a",
        binding_name: "planner",
        root_invocation_id: "inv_root",
        budget_micros: null,
        max_nodes: 4,
        max_depth: 2,
        created_at: 1,
      },
    ]);
    // The node itself is not in the table, so the chain walk cannot resolve it.
    const res = await expandPlanRows(env(d), node({ authority_json: "{not json" }), { tasks: [{ key: "a" }] });
    expect(res.ok).toBe(false);
  });
});

describe("joinContextRows reads its dependencies' results, and fakes none of them", () => {
  it("no needs, malformed needs, and a dependency whose row vanished", async () => {
    const d = db();
    expect(await joinContextRows(env(d), node({ needs_json: null }))).toEqual([]);
    expect(await joinContextRows(env(d), node({ needs_json: "[]" }))).toEqual([]);
    expect(await joinContextRows(env(d), node({ needs_json: "{not json" }))).toEqual([]);
    // A need whose row is gone is SKIPPED, never faked into a null result.
    expect(await joinContextRows(env(d), node({ needs_json: JSON.stringify(["inv_ghost"]) }))).toEqual([]);
  });

  it("returns results in the node's OWN needs order, and passes unparseable JSON through raw", async () => {
    const d = db();
    d.seed("agent_invocations", [
      {
        id: "inv_b",
        account_id: ACCOUNT,
        binding_id: "bind_a",
        binding_name: "planner",
        status: "done",
        created_at: 2,
        result_json: JSON.stringify({ text: "beta" }),
      },
      {
        id: "inv_a",
        account_id: ACCOUNT,
        binding_id: "bind_a",
        binding_name: "planner",
        status: "done",
        created_at: 1,
        result_json: "not json",
      },
    ]);
    const got = await joinContextRows(env(d), node({ needs_json: JSON.stringify(["inv_b", "inv_a"]) }));
    // A synthesis reads its inputs in the order its planner listed them, not
    // in whatever order the database returned.
    expect(got.map((g) => g.id)).toEqual(["inv_b", "inv_a"]);
    expect(got[0]!.result).toEqual({ text: "beta" });
    expect(got[1]!.result).toBe("not json");
  });
});
