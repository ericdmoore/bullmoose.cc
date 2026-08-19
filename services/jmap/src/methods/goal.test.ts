import { describe, expect, it } from "vitest";
import { MethodRegistry } from "@bullmoose/jmap-core";
import { fakeEnv } from "@bullmoose/test-fakes";
import { usdToMicros } from "@bullmoose/scheduling";
import { registerGoalMethods } from "./goal";
import type { RequestContext } from "./common";

/**
 * s20 T6 — `Goal/*`, the thin face over a Job.
 *
 * What this file holds to:
 *   • a goal COMPILES: the $750 bound becomes the aggregate budget, the reach
 *     becomes the envelope, escalate-when becomes a Watch, and the root node
 *     is a planner with no plan (progressive revelation — the decomposition is
 *     produced at runtime, inside the work);
 *   • every number a client reads is DERIVED — status, progress, milestones;
 *   • an open plan checkpoint reads `awaiting-plan`, never `done`;
 *   • checkpoints thin by CLASS, and a class nothing enforces REFUSES to
 *     graduate rather than rendering as autonomy it does not have;
 *   • cancelling revokes: pending nodes stop;
 *   • a contract is immutable, and a goal is never destroyed.
 */

const ACCOUNT = "a_eric";
const TENANT = "t_bm";
const OWNER = "eric@login.example";
const ENG_A = "ana@structural.example";
const ENG_B = "bo@structural.example";
const ATTIC = "get three structural engineers willing to evaluate the attic";

const CONTRACT = {
  may: { tools: [], contact: [ENG_A, ENG_B] },
  mayNot: ["commit me to a date"],
  doneWhen: "three engineers have said yes",
  budgetUsd: 750,
};

interface SetResult {
  created: Record<string, Record<string, unknown>>;
  notCreated: Record<string, { type: string; description?: string }>;
  updated: Record<string, null>;
  notUpdated: Record<string, { type: string; description?: string }>;
  notDestroyed: Record<string, { type: string; description?: string }>;
}

function harness() {
  const w = fakeEnv();
  const registry = new MethodRegistry<RequestContext>();
  registerGoalMethods(registry);
  w.db.seedAccount({
    accountId: ACCOUNT,
    tenantId: TENANT,
    principalId: "p_eric",
    loginEmail: OWNER,
    displayName: "Eric",
  });
  w.db.seed("agent_bindings", [{ id: "bind_cj", account_id: ACCOUNT, name: "cj" }]);
  const ctx: RequestContext = {
    env: w.env,
    principal: {
      username: OWNER,
      scopes: ["mail"],
      accounts: [{ accountId: ACCOUNT, tenantId: TENANT, name: "Eric" }],
    },
  };
  const call = <T = Record<string, unknown>>(method: string, args: Record<string, unknown> = {}) =>
    registry.get(method)!({ accountId: ACCOUNT, ...args }, ctx) as Promise<T>;
  const set = (args: Record<string, unknown>) => call<SetResult>("Goal/set", args);

  const create = async (over: Record<string, unknown> = {}) => {
    const res = await set({ create: { g: { bindingId: "bind_cj", statement: ATTIC, contract: CONTRACT, ...over } } });
    return res;
  };
  return { w, ctx, call, set, create };
}

const goalId = (res: SetResult) => res.created.g!.id as string;

describe("a goal compiles onto machinery that already runs", () => {
  it("the $750 bound becomes the aggregate budget, divided per node", async () => {
    const h = harness();
    const res = await h.create();
    expect(res.notCreated).toEqual({});
    const id = goalId(res);

    const job = h.w.db.query<{ id: string; budget_micros: number; max_nodes: number; root_invocation_id: string }>(
      `SELECT id, budget_micros, max_nodes, root_invocation_id FROM jobs WHERE account_id = ? AND id = ?`,
      ACCOUNT,
      id,
    )[0]!;
    // A Goal's id IS its Job's id — one row, no join key to keep in sync.
    expect(job.id).toBe(id);
    expect(job.budget_micros).toBe(usdToMicros(750));

    const root = h.w.db.query<{ context_json: string; authority_json: string; depth: number }>(
      `SELECT context_json, authority_json, depth FROM agent_invocations WHERE account_id = ? AND id = ?`,
      ACCOUNT,
      job.root_invocation_id,
    )[0]!;
    // The root is a PLANNER WITH NO PLAN: the decomposition is produced at
    // runtime, inside the work, never declared as front matter.
    expect(JSON.parse(root.context_json)).toEqual({ kind: "job-node", op: "plan" });
    expect(JSON.parse(root.authority_json).budgetMicros).toBe(Math.floor(usdToMicros(750) / job.max_nodes));
  });

  it("escalate-when arms a Watch on the JOB — s20 T1's engine, not new machinery", async () => {
    const h = harness();
    const res = await h.create({ contract: { ...CONTRACT, escalateWhen: { afterMs: 86_400_000, note: "chase it" } } });
    const id = goalId(res);

    const watchId = h.w.db.query<{ escalation_watch_id: string }>(
      `SELECT escalation_watch_id FROM goals WHERE account_id = ? AND id = ?`,
      ACCOUNT,
      id,
    )[0]!.escalation_watch_id;
    const watch = h.w.db.query<{
      condition_type: string;
      action_type: string;
      condition_json: string;
      source_ref: string | null;
      status: string;
    }>(
      `SELECT condition_type, action_type, condition_json, source_ref, status FROM watches
        WHERE account_id = ? AND id = ?`,
      ACCOUNT,
      watchId,
    )[0]!;
    expect(watch.condition_type).toBe("deadline");
    // `source_ref` stays NULL: the fire path reads a present one as an EMAIL id,
    // so a goal id there would mint a proposal pointing at a message that does
    // not exist. The goal rides the condition instead.
    expect(watch.source_ref).toBeNull();
    expect(JSON.parse(watch.condition_json).goalId).toBe(id);
    // `notify`, not `draft-followup`: "this goal has been running a while" is
    // an FYI to the delegator, and a follow-up drafted to nobody in particular
    // would be the agent inventing a recipient.
    expect(watch.action_type).toBe("notify");
    expect(watch.status).toBe("armed");
  });

  it("refuses a contract it cannot read, and a goal with no statement", async () => {
    const h = harness();
    expect((await h.create({ contract: { may: {} } })).notCreated.g!.description).toContain("doneWhen");
    expect((await h.create({ statement: "  " })).notCreated.g!.description).toContain("statement");
    expect((await h.create({ bindingId: "bind_nope" })).notCreated.g!.description).toContain("no such binding");
  });

  it("refuses a goal on a DISABLED binding (the 008 kill switch, honoured at creation)", async () => {
    const h = harness();
    h.w.db.query(`UPDATE agent_bindings SET enabled = 0 WHERE account_id = ? AND id = ?`, ACCOUNT, "bind_cj");
    expect((await h.create()).notCreated.g!.description).toContain("disabled");
  });
});

describe("everything a client reads is derived", () => {
  it("an OPEN plan checkpoint reads `awaiting-plan`, never `done`", async () => {
    const h = harness();
    const id = goalId(await h.create());
    const rootId = h.w.db.query<{ root_invocation_id: string }>(
      `SELECT root_invocation_id FROM jobs WHERE account_id = ? AND id = ?`,
      ACCOUNT,
      id,
    )[0]!.root_invocation_id;

    // The planner finished and proposed its sketch: every node done, nothing
    // failed — and the goal has done NOTHING. Reporting `done` here would be
    // the most dangerous lie this surface could tell.
    h.w.db.query(`UPDATE agent_invocations SET status = 'done' WHERE account_id = ? AND id = ?`, ACCOUNT, rootId);
    h.w.db.seed("agent_proposals", [
      {
        id: rootId,
        account_id: ACCOUNT,
        kind: "goal-plan",
        tier: 1,
        subject_json: JSON.stringify({ realm: "Goal", objectId: id }),
        payload_json: JSON.stringify({ goalId: id, tasks: [] }),
        rationale: "here is how I would do it",
        evidence_json: "[]",
        status: "pending",
        created_at: 10,
      },
    ]);

    const got = await h.call<{ list: Array<Record<string, unknown>> }>("Goal/get", { ids: [id] });
    const goal = got.list[0]!;
    expect(goal.status).toBe("awaiting-plan");
    expect((goal.progress as { total: number }).total).toBe(1);
    // The timeline is the goal's proposals, time-ordered — never a second log.
    const milestones = goal.milestones as Array<{ kind: string; checkpointClass: string; status: string }>;
    expect(milestones).toHaveLength(1);
    expect(milestones[0]!.checkpointClass).toBe("plan");
    expect(milestones[0]!.status).toBe("pending");
  });

  it("reads a whole roster in one fan-in, and one goal's nodes never leak into another's", async () => {
    // The projection is three queries for the PAGE, not three per goal — an
    // N+1 the moment `Goal/get { ids: null }` (the roster read every client
    // makes) returns more than a couple of rows. What has to survive the
    // batching is the per-goal fold, so: two goals, different node counts.
    const h = harness();
    const first = goalId(await h.create());
    const second = goalId(await h.create({ statement: "find a roofer" }));
    h.w.db.seed("agent_invocations", [
      {
        id: "inv_t1",
        account_id: ACCOUNT,
        binding_id: "bind_cj",
        binding_name: "cj",
        status: "done",
        context_json: "{}",
        created_at: 5,
        cost_micros: 40,
        job_id: first,
        parent_id: "x",
        depth: 1,
      },
      {
        id: "inv_t2",
        account_id: ACCOUNT,
        binding_id: "bind_cj",
        binding_name: "cj",
        status: "pending",
        context_json: "{}",
        created_at: 6,
        cost_micros: 0,
        job_id: first,
        parent_id: "x",
        depth: 1,
      },
    ]);

    const got = await h.call<{ list: Array<Record<string, unknown>> }>("Goal/get", { ids: [first, second] });
    const byId = new Map(got.list.map((g) => [g.id as string, g]));
    // Each goal counts its OWN root plus whatever it actually has.
    expect((byId.get(first)!.progress as { total: number }).total).toBe(3);
    expect((byId.get(second)!.progress as { total: number }).total).toBe(1);
    expect(byId.get(first)!.spentMicros).toBe(40);
    expect(byId.get(second)!.spentMicros).toBe(0);
  });

  it("says which checkpoint classes are still manual AND which could ever graduate", async () => {
    const h = harness();
    const id = goalId(await h.create());
    const got = await h.call<{ list: Array<Record<string, unknown>> }>("Goal/get", { ids: [id] });
    const checkpoints = got.list[0]!.checkpoints as Record<string, { mode: string; graduable: boolean }>;
    expect(checkpoints.plan).toMatchObject({ mode: "manual", graduable: true });
    // "manual, and nothing wires auto yet" is the difference between a product
    // that is unfinished and one that is untrustworthy.
    expect(checkpoints.email).toMatchObject({ mode: "manual", graduable: false });
    expect(checkpoints.summary).toMatchObject({ mode: "manual", graduable: false });
  });

  it("query lists newest first, and `open` filters on the authored facts", async () => {
    const h = harness();
    const first = goalId(await h.create());
    const second = goalId(await h.create({ statement: "find a roofer" }));
    await h.set({ update: { [first]: { status: "cancelled" } } });

    const all = await h.call<{ ids: string[] }>("Goal/query", {});
    expect(new Set(all.ids)).toEqual(new Set([first, second]));
    const open = await h.call<{ ids: string[] }>("Goal/query", { filter: { open: true } });
    expect(open.ids).toEqual([second]);
    await expect(h.call("Goal/query", { filter: { nope: 1 } })).rejects.toThrow();
  });
});

describe("checkpoints thin by CLASS, and never silently", () => {
  it("graduates the one class that is actually wired, with provenance", async () => {
    const h = harness();
    const id = goalId(await h.create());
    const res = await h.set({ update: { [id]: { checkpoints: { plan: "auto" } } } });
    expect(res.notUpdated).toEqual({});

    const got = await h.call<{ list: Array<Record<string, unknown>> }>("Goal/get", { ids: [id] });
    const plan = (got.list[0]!.checkpoints as Record<string, { mode: string; by?: string }>).plan!;
    expect(plan.mode).toBe("auto");
    expect(plan.by).toBe(OWNER);
  });

  it("REFUSES to graduate a class nothing enforces, and says why", async () => {
    const h = harness();
    const id = goalId(await h.create());
    const res = await h.set({ update: { [id]: { checkpoints: { email: "auto" } } } });
    expect(res.updated).toEqual({});
    // A toggle that lies about how much authority you just handed over is the
    // single worst bug this surface could ship.
    expect(res.notUpdated[id]!.description).toContain("cannot graduate yet");
    expect(res.notUpdated[id]!.description).toContain("/approvals");
  });

  it("refuses an unknown class and an unknown mode", async () => {
    const h = harness();
    const id = goalId(await h.create());
    expect(
      (await h.set({ update: { [id]: { checkpoints: { nope: "auto" } } } })).notUpdated[id]!.description,
    ).toContain("unknown checkpoint class");
    expect(
      (await h.set({ update: { [id]: { checkpoints: { plan: "sometimes" } } } })).notUpdated[id]!.description,
    ).toContain("manual");
  });
});

describe("revocation, immutability, and the record that is the point", () => {
  it("cancelling stops every pending node", async () => {
    const h = harness();
    const id = goalId(await h.create());
    h.w.db.seed("agent_invocations", [
      {
        id: "inv_task",
        account_id: ACCOUNT,
        binding_id: "bind_cj",
        binding_name: "cj",
        status: "pending",
        context_json: JSON.stringify({ kind: "job-node", op: "outreach", to: ENG_A }),
        created_at: 5,
        job_id: id,
        depth: 1,
      },
    ]);

    const res = await h.set({ update: { [id]: { status: "cancelled" } } });
    expect(res.notUpdated).toEqual({});
    const task = h.w.db.query<{ status: string; result_json: string }>(
      `SELECT status, result_json FROM agent_invocations WHERE account_id = ? AND id = 'inv_task'`,
      ACCOUNT,
    )[0]!;
    // Revocation has to BITE, not merely be recorded.
    expect(task.status).toBe("failed");
    expect(JSON.parse(task.result_json).note).toContain("cancelled");

    const got = await h.call<{ list: Array<Record<string, unknown>> }>("Goal/get", { ids: [id] });
    expect(got.list[0]!.status).toBe("cancelled");
    expect(got.list[0]!.cancelledBy).toBe(OWNER);
  });

  it("a contract is immutable — an edit would retroactively re-authorize work in flight", async () => {
    const h = harness();
    const id = goalId(await h.create());
    const res = await h.set({
      update: { [id]: { contract: { ...CONTRACT, may: { tools: [], contact: ["@anywhere.test"] } } } },
    });
    expect(res.notUpdated[id]!.description).toContain("immutable");
  });

  it("a goal is cancelled, never destroyed", async () => {
    const h = harness();
    const id = goalId(await h.create());
    const res = await h.set({ destroy: [id] });
    expect(res.notDestroyed[id]!.type).toBe("forbidden");
    expect(h.w.db.query(`SELECT id FROM goals WHERE account_id = ? AND id = ?`, ACCOUNT, id)).toHaveLength(1);
  });
});
