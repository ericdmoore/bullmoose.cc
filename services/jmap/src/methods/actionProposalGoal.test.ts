import { describe, expect, it } from "vitest";
import { MethodRegistry } from "@bullmoose/jmap-core";
import { fakeEnv } from "@bullmoose/test-fakes";
import { usdToMicros } from "@bullmoose/scheduling";
import { registerActionProposalMethods } from "./actionProposal";
import type { RequestContext } from "./common";

/**
 * s20 T6 — THE PLAN-APPROVAL CHECKPOINT, applied through the REAL method.
 *
 * A new class of approval: every other case in `applyProposal` gates EGRESS —
 * may this leave the building? This one gates EXECUTION — may these tasks
 * exist at all? So the whole file drives `ActionProposal/set { status:
 * "approved" }` and looks at what appeared in `agent_invocations`.
 *
 * The rule it exists to keep is the one three wedges this month taught: a kind
 * whose producer exists and whose apply case does not (or does not do the
 * thing) is a wedge. Approve→apply is therefore proven end to end here, and so
 * is every way it must REFUSE:
 *
 *   • an approved plan creates the tasks, in the same transaction;
 *   • EDIT IS APPROVAL — an inline redline is the ordinary `editedPayload`
 *     approve, writing the identical proposal/decision rows;
 *   • …and a redline is UNTRUSTED: an amplifying edit is refused with nothing
 *     created and the row still pending. Monotonic attenuation has no "but a
 *     human typed it" exception;
 *   • a cancelled goal cannot have its plan started after the fact.
 */

const ACCOUNT = "a_eric";
const TENANT = "t_bm";
const APPROVER = "eric@login.example";
const ENG_A = "ana@structural.example";
const ENG_B = "bo@structural.example";
const ATTIC = "get three structural engineers willing to evaluate the attic";

const CONTRACT = {
  may: { tools: [], contact: [ENG_A, ENG_B] },
  mayNot: ["commit me to a date"],
  escalateWhen: null,
  doneWhen: "three engineers have said yes",
  budgetUsd: 750,
};

/** Eight nodes share $750, so one node's ceiling is $93.75 (compileContract). */
const PER_NODE = Math.floor(usdToMicros(750) / 8);

interface SetResult {
  updated: Record<string, null>;
  notUpdated: Record<string, { type: string; description?: string; properties?: string[] }>;
}

const SKETCH = [
  { key: "reach-1", context: { kind: "job-node", op: "outreach", to: ENG_A } },
  { key: "reach-2", context: { kind: "job-node", op: "outreach", to: ENG_B } },
  { key: "compile", needs: ["reach-1", "reach-2"], context: { kind: "job-node", op: "summarize" } },
];

function harness(o: { cancelled?: boolean; contractJson?: string } = {}) {
  const w = fakeEnv();
  const registry = new MethodRegistry<RequestContext>();
  registerActionProposalMethods(registry);
  w.db.seedAccount({
    accountId: ACCOUNT,
    tenantId: TENANT,
    principalId: "p_eric",
    loginEmail: APPROVER,
    displayName: "Eric",
  });
  const ctx: RequestContext = {
    env: w.env,
    principal: {
      username: APPROVER,
      scopes: ["mail"],
      accounts: [{ accountId: ACCOUNT, tenantId: TENANT, name: "Eric" }],
    },
  };
  const call = <T = Record<string, unknown>>(method: string, args: Record<string, unknown>) =>
    registry.get(method)!({ accountId: ACCOUNT, ...args }, ctx) as Promise<T>;
  const set = (args: Record<string, unknown>) => call<SetResult>("ActionProposal/set", args);

  w.db.seed("agent_bindings", [{ id: "bind_cj", account_id: ACCOUNT, name: "cj" }]);
  w.db.seed("jobs", [
    {
      id: "job_attic",
      account_id: ACCOUNT,
      binding_id: "bind_cj",
      binding_name: "cj",
      root_invocation_id: "inv_planner",
      budget_micros: usdToMicros(750),
      max_nodes: 8,
      max_depth: 2,
      created_at: 1,
    },
  ]);
  w.db.seed("goals", [
    {
      id: "job_attic",
      account_id: ACCOUNT,
      statement: ATTIC,
      contract_json: o.contractJson ?? JSON.stringify(CONTRACT),
      checkpoints_json: JSON.stringify({ plan: { mode: "manual" } }),
      created_by: APPROVER,
      created_at: 1,
      cancelled_at: o.cancelled ? 2 : null,
    },
  ]);
  // The planner node. A proposal's id IS its invocation's id, so this row is
  // both the node the plan expands from and the row the proposal projects over.
  w.db.seed("agent_invocations", [
    {
      id: "inv_planner",
      account_id: ACCOUNT,
      binding_id: "bind_cj",
      binding_name: "cj",
      status: "done",
      context_json: JSON.stringify({ kind: "job-node", op: "plan" }),
      created_at: 1,
      done_at: 2,
      cost_micros: 0,
      job_id: "job_attic",
      depth: 0,
      authority_json: JSON.stringify({ tools: [], credentials: [], budgetMicros: PER_NODE }),
    },
  ]);
  const seedPlan = (tasks: unknown[] = SKETCH) =>
    w.db.seed("agent_proposals", [
      {
        id: "inv_planner",
        account_id: ACCOUNT,
        kind: "goal-plan",
        tier: 1,
        subject_json: JSON.stringify({ realm: "Goal", objectId: "job_attic" }),
        payload_json: JSON.stringify({ goalId: "job_attic", statement: ATTIC, contract: CONTRACT, tasks }),
        rationale: "here is how I would do it",
        evidence_json: JSON.stringify([{ realm: "Goal", objectId: "job_attic" }]),
        status: "pending",
        created_at: 1,
      },
    ]);

  const tasks = () =>
    w.db.query<{ id: string; context_json: string; needs_json: string | null; authority_json: string }>(
      `SELECT id, context_json, needs_json, authority_json FROM agent_invocations
        WHERE account_id = ? AND job_id = ? AND parent_id IS NOT NULL ORDER BY created_at, id`,
      ACCOUNT,
      "job_attic",
    );
  const proposal = () =>
    w.db.query<{
      status: string;
      payload_json: string;
      edited_payload_json: string | null;
      decision_json: string | null;
    }>(
      `SELECT status, payload_json, edited_payload_json, decision_json FROM agent_proposals
        WHERE account_id = ? AND id = ?`,
      ACCOUNT,
      "inv_planner",
    )[0]!;

  return { w, ctx, set, seedPlan, tasks, proposal };
}

describe("approve → the tasks are created", () => {
  it("creates every task in the sketch, wired and attenuated", async () => {
    const h = harness();
    h.seedPlan();
    expect(h.tasks()).toHaveLength(0);

    const res = await h.set({ update: { inv_planner: { status: "approved" } } });
    expect(res.notUpdated).toEqual({});
    expect(res.updated).toHaveProperty("inv_planner");

    const created = h.tasks();
    expect(created).toHaveLength(3);
    // The plan-local keys became invocation ids: a planner never names a row.
    const byKey = new Map(created.map((t) => [(JSON.parse(t.context_json) as { jobKey: string }).jobKey, t]));
    expect([...byKey.keys()].sort()).toEqual(["compile", "reach-1", "reach-2"]);
    expect(JSON.parse(byKey.get("compile")!.needs_json!)).toEqual([byKey.get("reach-1")!.id, byKey.get("reach-2")!.id]);
    // Every child inherits the goal's per-node share — never more.
    for (const t of created) {
      expect((JSON.parse(t.authority_json) as { budgetMicros: number }).budgetMicros).toBeLessThanOrEqual(PER_NODE);
    }
    expect(h.proposal().status).toBe("approved");
  });

  it("records an undo handle that names a call which EXISTS", async () => {
    const h = harness();
    h.seedPlan();
    await h.set({ update: { inv_planner: { status: "approved" } } });
    const decision = JSON.parse(h.proposal().decision_json!) as { undo?: { action: string; goalId: string } };
    // `Goal/set { status: "cancelled" }` fails every pending node — which is
    // exactly "un-create the tasks I just authorized". Never a handle for an
    // action nothing implements (the watch-notify rule).
    expect(decision.undo).toEqual({ action: "cancel-goal", goalId: "job_attic" });
  });
});

describe("edit IS approval, inline — and the ledger does not move", () => {
  it("a redline approves through the ordinary editedPayload path, writing the same rows", async () => {
    const h = harness();
    h.seedPlan();
    // The human strikes one outreach and rewords nothing else — the venue is
    // the goal view, the call is the one this method has always taken.
    const redlined = [SKETCH[0], { ...SKETCH[2], needs: ["reach-1"] }];
    const res = await h.set({
      update: {
        inv_planner: {
          status: "approved",
          editedPayload: { goalId: "job_attic", statement: ATTIC, contract: CONTRACT, tasks: redlined },
        },
      },
    });
    expect(res.notUpdated).toEqual({});

    const created = h.tasks();
    expect(created).toHaveLength(2);

    const row = h.proposal();
    expect(row.status).toBe("approved");
    // THE RETENTION THAT MAKES AN EDIT WORTH HAVING: the agent's original
    // survives beside the human's version, so "here is exactly what right
    // looked like" is the diff between them.
    expect((JSON.parse(row.payload_json) as { tasks: unknown[] }).tasks).toHaveLength(3);
    expect((JSON.parse(row.edited_payload_json!) as { tasks: unknown[] }).tasks).toHaveLength(2);
    // Provenance, identical to a queue approval — the venue moved, not the ledger.
    expect((JSON.parse(row.decision_json!) as { by: string }).by).toBe(APPROVER);
  });

  it("an open question is the needsInfo cycle BACK TO THE PLANNER, not a decision", async () => {
    const h = harness();
    h.seedPlan();
    const res = await h.set({
      update: { inv_planner: { status: "info-requested", question: "who is the third engineer?" } },
    });
    expect(res.notUpdated).toEqual({});
    expect(h.proposal().status).toBe("info-requested");
    // Nothing was created: an unresolved redline authorizes nothing.
    expect(h.tasks()).toHaveLength(0);
    // The answer round is a CONTINUATION inside the same Job — s17's rule that
    // an invocation caused by a delegated node carries that node's envelope.
    const round = h.w.db.query<{ job_id: string; parent_id: string | null; depth: number; authority_json: string }>(
      `SELECT job_id, parent_id, depth, authority_json FROM agent_invocations
        WHERE account_id = ? AND id != 'inv_planner' AND context_json LIKE '%answer-info-request%'`,
      ACCOUNT,
    );
    expect(round).toHaveLength(1);
    expect(round[0]!.job_id).toBe("job_attic");
    expect(round[0]!.depth).toBe(0);
    expect(JSON.parse(round[0]!.authority_json).budgetMicros).toBe(PER_NODE);
  });
});

describe("a redline is untrusted input — monotonic attenuation has no human exception", () => {
  it("refuses an edit that raises a task above the goal's per-node bound, creating NOTHING", async () => {
    const h = harness();
    h.seedPlan();
    const greedy = [
      { key: "reach-1", budgetMicros: usdToMicros(750), context: { kind: "job-node", op: "outreach", to: ENG_A } },
    ];
    const res = await h.set({
      update: { inv_planner: { status: "approved", editedPayload: { goalId: "job_attic", tasks: greedy } } },
    });

    expect(res.updated).toEqual({});
    expect(res.notUpdated.inv_planner!.description).toContain("refused");
    expect(h.tasks()).toHaveLength(0);
    // Still pending, so the human can redline again rather than losing the
    // sketch to a failed approval.
    expect(h.proposal().status).toBe("pending");
  });

  it("refuses an edit that points a task outside the contract's reach", async () => {
    const h = harness();
    h.seedPlan();
    const sneak = [{ key: "reach-1", context: { kind: "job-node", op: "outreach", to: "stranger@elsewhere.example" } }];
    const res = await h.set({
      update: { inv_planner: { status: "approved", editedPayload: { goalId: "job_attic", tasks: sneak } } },
    });

    expect(res.updated).toEqual({});
    expect(res.notUpdated.inv_planner!.description).toContain("contract refuses");
    expect(h.tasks()).toHaveLength(0);
    expect(h.proposal().status).toBe("pending");
  });

  it("refuses a plan whose payload names a different goal than its planner", async () => {
    const h = harness();
    h.seedPlan();
    const res = await h.set({
      update: { inv_planner: { status: "approved", editedPayload: { goalId: "job_somebody_else", tasks: SKETCH } } },
    });
    expect(res.notUpdated.inv_planner!.description).toContain("job_attic");
    expect(h.tasks()).toHaveLength(0);
  });
});

describe("revocation has to bite, including after the fact", () => {
  it("a cancelled goal cannot have its plan started", async () => {
    const h = harness({ cancelled: true });
    h.seedPlan();
    const res = await h.set({ update: { inv_planner: { status: "approved" } } });
    expect(res.notUpdated.inv_planner!.description).toContain("cancelled");
    expect(h.tasks()).toHaveLength(0);
  });

  it("an unreadable contract is an UNKNOWN bound, and an unknown bound is not permissive", async () => {
    const h = harness({ contractJson: "{not json" });
    h.seedPlan();
    const res = await h.set({ update: { inv_planner: { status: "approved" } } });
    expect(res.notUpdated.inv_planner!.description).toContain("cannot be read");
    expect(h.tasks()).toHaveLength(0);
  });
});

describe("a goal's outreach applies into your own Drafts — no new egress path", () => {
  it("approving a goal-outreach writes ONE draft, unthreaded, in the owner's voice", async () => {
    const h = harness();
    h.w.db.seed("identities", [
      {
        id: "identity_1",
        account_id: ACCOUNT,
        email: "eric@bullmoose.cc",
        name: "Eric",
        text_signature: "",
        html_signature: "",
        may_delete: 0,
      },
    ]);
    h.w.db.seed("agent_invocations", [
      {
        id: "inv_reach",
        account_id: ACCOUNT,
        binding_id: "bind_cj",
        binding_name: "cj",
        status: "done",
        context_json: JSON.stringify({ kind: "job-node", op: "outreach", to: ENG_A }),
        created_at: 3,
        done_at: 4,
        cost_micros: 0,
        job_id: "job_attic",
        parent_id: "inv_planner",
        depth: 1,
        authority_json: JSON.stringify({ tools: [], credentials: [], budgetMicros: PER_NODE }),
      },
    ]);
    h.w.db.seed("agent_proposals", [
      {
        id: "inv_reach",
        account_id: ACCOUNT,
        kind: "goal-outreach",
        tier: 1,
        // A goal's outreach has no source EMAIL — its subject names the goal —
        // so the shared draft case has to be tolerant of that, and is.
        subject_json: JSON.stringify({ realm: "Goal", objectId: "job_attic" }),
        payload_json: JSON.stringify({
          goalId: "job_attic",
          to: ENG_A,
          subject: "Attic survey",
          body: "Hello,\n\nWould you be willing to evaluate our attic?\n\nThank you,",
          mode: "compose",
        }),
        rationale: "toward the goal: a message",
        evidence_json: "[]",
        status: "pending",
        created_at: 3,
      },
    ]);

    const res = await h.set({ update: { inv_reach: { status: "approved" } } });
    expect(res.notUpdated).toEqual({});

    const drafts = h.w.db.query<{ subject: string; to_json: string; from_json: string; in_reply_to: string | null }>(
      `SELECT subject, to_json, from_json, in_reply_to FROM emails WHERE account_id = ?`,
      ACCOUNT,
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.subject).toBe("Attic survey");
    expect(drafts[0]!.to_json).toContain(ENG_A);
    // The owner's own sending identity signs it, never the binding's name.
    expect(drafts[0]!.from_json).toContain("eric@bullmoose.cc");
    // A goal's outreach STARTS a message; it never threads onto whatever the
    // proposal's subject happened to point at.
    expect(drafts[0]!.in_reply_to).toBeNull();
  });
});

describe("the summary — the one judgment no derivation can make", () => {
  it("approving records the human's verdict that done-when is met", async () => {
    const h = harness();
    h.w.db.seed("agent_invocations", [
      {
        id: "inv_join",
        account_id: ACCOUNT,
        binding_id: "bind_cj",
        binding_name: "cj",
        status: "done",
        context_json: JSON.stringify({ kind: "job-node", op: "summarize" }),
        created_at: 3,
        done_at: 4,
        cost_micros: 0,
        job_id: "job_attic",
        parent_id: "inv_planner",
        depth: 1,
        authority_json: JSON.stringify({ tools: [], credentials: [], budgetMicros: PER_NODE }),
      },
    ]);
    h.w.db.seed("agent_proposals", [
      {
        id: "inv_join",
        account_id: ACCOUNT,
        kind: "goal-summary",
        tier: 1,
        subject_json: JSON.stringify({ realm: "Goal", objectId: "job_attic" }),
        payload_json: JSON.stringify({ goalId: "job_attic", text: "two said yes" }),
        rationale: "here is what came back",
        evidence_json: "[]",
        status: "pending",
        created_at: 3,
      },
    ]);

    const res = await h.set({ update: { inv_join: { status: "approved" } } });
    expect(res.notUpdated).toEqual({});
    const goal = h.w.db.query<{ accepted_at: number | null; accepted_by: string | null }>(
      `SELECT accepted_at, accepted_by FROM goals WHERE account_id = ? AND id = ?`,
      ACCOUNT,
      "job_attic",
    )[0]!;
    expect(goal.accepted_at).toBeGreaterThan(0);
    expect(goal.accepted_by).toBe(APPROVER);
  });
});
