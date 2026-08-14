import { describe, expect, it } from "vitest";
import { MethodRegistry } from "@bullmoose/jmap-core";
import { budgetPeriodKey } from "@bullmoose/scheduling";
import { fakeEnv } from "@bullmoose/test-fakes";
import { registerActionProposalMethods } from "./actionProposal";
import { registerAgentMethods } from "./agent";
import type { RequestContext } from "./common";

/**
 * s11 T9 — the DECISION half: what approving and declining a `budget-overrun`
 * actually do, proved through the real claim gate rather than by inspecting a
 * row and hoping.
 *
 * Both method sets are registered on ONE registry on purpose. The claim
 * (`AgentInvocation/set`) is the only thing that can prove an approval WIDENED
 * the claimant set, and a test that asserted "an overage row exists" would pass
 * just as happily against a gate that never reads it. So every assertion here
 * is a claim attempt:
 *
 *   before approve  the paid claimant is refused — budget exhausted
 *   after approve   the same claim succeeds, up to the BOUND
 *   past the bound  refused again, and the bound is what refuses it
 *
 * Declining is the mirror: nothing moves, and nothing negative is recorded —
 * the taxonomy's excluded-from-negative-signal rule gains its third member
 * (decline-taxonomy.md; the write path enforces it in `NO_FAULT_KINDS`).
 */

const ACCOUNT = "a_budget";
const TENANT = "t_bm";
const CAP = 5_000_000; // $5.00, micro-USD
const OVERAGE = 2_000_000; // $2.00

interface SetResult {
  updated: Record<string, null>;
  notUpdated: Record<string, { type: string; description?: string; properties?: string[] }>;
}

function harness(opts: { capMicros?: number } = {}) {
  const w = fakeEnv();
  const registry = new MethodRegistry<RequestContext>();
  registerActionProposalMethods(registry);
  registerAgentMethods(registry);
  const ctx: RequestContext = {
    env: w.env,
    principal: {
      username: "eric@login.example",
      scopes: ["mail", "read", "draft"],
      accounts: [{ accountId: ACCOUNT, tenantId: TENANT, name: "Eric" }],
    },
  };
  w.db.seed("agent_bindings", [
    {
      id: "bind_photos",
      account_id: ACCOUNT,
      name: "photos",
      config_json: JSON.stringify({ budgets: { spendPerMonth: opts.capMicros ?? CAP } }),
    },
  ]);

  const call = <T = Record<string, unknown>>(method: string, args: Record<string, unknown>) =>
    registry.get(method)!({ accountId: ACCOUNT, ...args }, ctx) as Promise<T>;

  /** A completed run that burned `micros` this month. */
  let spends = 0;
  const spend = (micros: number) => {
    spends += 1;
    w.db.seed("agent_invocations", [
      {
        id: `inv_spent_${spends}`,
        account_id: ACCOUNT,
        binding_id: "bind_photos",
        binding_name: "photos",
        status: "done",
        created_at: 1,
        claimed_at: Date.now() - 2000,
        done_at: Date.now() - 1000,
        cost_micros: micros,
      },
    ]);
  };

  /** A pending invocation waiting on the budget (NULL due, no free runtime). */
  const waiting = (id: string) =>
    w.db.seed("agent_invocations", [
      {
        id,
        account_id: ACCOUNT,
        binding_id: "bind_photos",
        binding_name: "photos",
        status: "pending",
        email_id: "e_x",
        created_at: 2,
      },
    ]);

  /** The ask, as the sweep emits it: its own `done` carrier invocation + the
   * proposal keyed to it. */
  const seedAsk = (id: string, payload: Record<string, unknown>) => {
    w.db.seed("agent_invocations", [
      {
        id,
        account_id: ACCOUNT,
        binding_id: "bind_photos",
        binding_name: "photos",
        status: "done",
        created_at: 3,
        claimed_at: 3,
        done_at: 3,
        cost_micros: 0,
      },
    ]);
    w.db.seed("agent_proposals", [
      {
        id,
        account_id: ACCOUNT,
        kind: "budget-overrun",
        tier: 1,
        subject_json: JSON.stringify({ realm: "AgentBinding", objectId: "bind_photos" }),
        payload_json: JSON.stringify(payload),
        rationale: "photos has spent $5.00 of its $5.00 budget and 3 invocations are waiting.",
        evidence_json: JSON.stringify([{ realm: "AgentBinding", objectId: "bind_photos" }]),
        status: "pending",
        created_at: 3,
        expires_at: Date.now() + 3600_000,
      },
    ]);
    return id;
  };

  const askPayload = (over: Record<string, unknown> = {}) => ({
    bindingId: "bind_photos",
    bindingName: "photos",
    waitingCount: 3,
    monthSpentMicros: CAP,
    capMicros: CAP,
    estimateMicros: 1_600_000,
    overageMicros: OVERAGE,
    periodKey: budgetPeriodKey(Date.now()),
    ...over,
  });

  /** A PAID claim through the real gate — the only honest proof of a widening. */
  const paidClaim = (invId: string) =>
    call<SetResult>("AgentInvocation/set", { update: { [invId]: { status: "running" } } });

  const overages = () =>
    w.db.query<{
      binding_id: string;
      period_key: string;
      amount_micros: number;
      proposal_id: string;
      approved_by: string;
    }>(
      "SELECT binding_id, period_key, amount_micros, proposal_id, approved_by FROM agent_budget_overages WHERE account_id = ?",
      ACCOUNT,
    );

  const proposalRow = (id: string) =>
    w.db.query<{ status: string; decision_json: string | null; payload_json: string; edited_payload_json: string | null }>(
      "SELECT status, decision_json, payload_json, edited_payload_json FROM agent_proposals WHERE account_id = ? AND id = ?",
      ACCOUNT,
      id,
    )[0]!;

  const invRow = (id: string) =>
    w.db.query<{ status: string; note: string | null }>(
      "SELECT status, note FROM agent_invocations WHERE account_id = ? AND id = ?",
      ACCOUNT,
      id,
    )[0]!;

  const bindingConfig = () =>
    w.db.query<{ config_json: string }>(
      "SELECT config_json FROM agent_bindings WHERE account_id = ? AND id = ?",
      ACCOUNT,
      "bind_photos",
    )[0]!.config_json;

  return { w, call, spend, waiting, seedAsk, askPayload, paidClaim, overages, proposalRow, invRow, bindingConfig };
}

// ---- approve: a bounded overage the gate honors ----------------------------

describe("approve applies a BOUNDED overage, and the claim gate honors it", () => {
  it("refused → approved → claimable; and NOT one micro-dollar past the bound", async () => {
    const h = harness();
    h.spend(CAP); // the cap, spent
    h.waiting("inv_wait_1");
    h.waiting("inv_wait_2");
    const ask = h.seedAsk("inv_ask", h.askPayload());

    // CONTROL: the gate refuses a paid claim — budget exhausted narrows the
    // claimant set, which is the stranding this proposal exists to resolve.
    const before = await h.paidClaim("inv_wait_1");
    expect(before.updated).toEqual({});
    expect(before.notUpdated.inv_wait_1!.type).toBe("forbidden");
    expect(h.invRow("inv_wait_1").status).toBe("pending");

    // THE DECISION.
    const res = await h.call<SetResult>("ActionProposal/set", {
      update: { [ask]: { status: "approved" } },
    });
    expect(res.notUpdated).toEqual({});
    expect(res.updated).toEqual({ [ask]: null });

    // The grant landed as a record: amount, period, who, and the proposal that
    // argued for it.
    expect(h.overages()).toEqual([
      {
        binding_id: "bind_photos",
        period_key: budgetPeriodKey(Date.now()),
        amount_micros: OVERAGE,
        proposal_id: ask,
        approved_by: "eric@login.example",
      },
    ]);

    // THE WIDENING, proved by the gate: the same claim now succeeds.
    const after = await h.paidClaim("inv_wait_1");
    expect(after.updated).toEqual({ inv_wait_1: null });
    expect(h.invRow("inv_wait_1").status).toBe("running");

    // THE BOUND IS REAL. Spend the granted $2.00 (and a micro-dollar more) and
    // the gate closes again — an approved overage is a ceiling, not a licence.
    h.spend(OVERAGE);
    const past = await h.paidClaim("inv_wait_2");
    expect(past.updated).toEqual({});
    expect(past.notUpdated.inv_wait_2!.type).toBe("forbidden");
    expect(h.invRow("inv_wait_2").status).toBe("pending");
  });

  it("the bound holds at the boundary: one micro-dollar under is claimable, exactly at it is not", async () => {
    const h = harness();
    h.spend(CAP + OVERAGE - 1); // one micro-dollar shy of cap + overage
    h.waiting("inv_a");
    h.waiting("inv_b");
    const ask = h.seedAsk("inv_ask", h.askPayload());
    await h.call("ActionProposal/set", { update: { [ask]: { status: "approved" } } });

    expect((await h.paidClaim("inv_a")).updated).toEqual({ inv_a: null });
    h.spend(1); // now exactly at the ceiling — `>=` closes it
    expect((await h.paidClaim("inv_b")).notUpdated.inv_b!.type).toBe("forbidden");
  });

  it("approving does NOT raise the configured cap — that is a config edit, with its own route", async () => {
    const h = harness();
    const configBefore = h.bindingConfig();
    h.spend(CAP);
    h.waiting("inv_wait");
    const ask = h.seedAsk("inv_ask", h.askPayload());
    await h.call("ActionProposal/set", { update: { [ask]: { status: "approved" } } });

    // The whole point of the kind: one click must never silently become
    // standing policy. `spendPerMonth` is byte-identical.
    expect(h.bindingConfig()).toBe(configBefore);
    // ...and the grant is reversible, which is what makes tier 1 honest: the
    // decision carries an undo handle that revokes it.
    const decision = JSON.parse(h.proposalRow(ask).decision_json!) as Record<string, unknown>;
    expect(decision.undo).toEqual({
      action: "revoke-overage",
      bindingId: "bind_photos",
      periodKey: budgetPeriodKey(Date.now()),
      proposalId: ask,
    });
    expect(decision.by).toBe("eric@login.example");
  });

  it("the human's EDITED bound wins, and the agent's ask is retained beside it", async () => {
    const h = harness();
    h.spend(CAP);
    h.waiting("inv_a");
    h.waiting("inv_b");
    const ask = h.seedAsk("inv_ask", h.askPayload());

    // "Fine, but only fifty cents." The edit is the human's ceiling.
    await h.call("ActionProposal/set", {
      update: { [ask]: { status: "approved", editedPayload: { ...h.askPayload(), overageMicros: 500_000 } } },
    });
    expect(h.overages()[0]!.amount_micros).toBe(500_000);
    // The agent's original payload is NEVER overwritten (the editedPayload
    // discipline) — the diff is the highest-signal feedback in the system.
    expect(JSON.parse(h.proposalRow(ask).payload_json).overageMicros).toBe(OVERAGE);
    expect(JSON.parse(h.proposalRow(ask).edited_payload_json!).overageMicros).toBe(500_000);

    // And the smaller bound is the one the gate enforces.
    expect((await h.paidClaim("inv_a")).updated).toEqual({ inv_a: null });
    h.spend(500_000);
    expect((await h.paidClaim("inv_b")).notUpdated.inv_b!.type).toBe("forbidden");
  });

  it("an UNBOUNDED ask is refused: a missing or non-positive amount is a raised cap by another name", async () => {
    const h = harness();
    h.spend(CAP);
    h.waiting("inv_wait");
    for (const bad of [undefined, 0, -1, "2000000", null]) {
      const ask = h.seedAsk(`inv_ask_${String(bad)}`, h.askPayload({ overageMicros: bad }));
      const res = await h.call<SetResult>("ActionProposal/set", {
        update: { [ask]: { status: "approved" } },
      });
      expect(res.notUpdated[ask]!.type).toBe("invalidProperties");
      expect(res.notUpdated[ask]!.description).toMatch(/overageMicros/);
    }
    expect(h.overages()).toEqual([]);
    expect((await h.paidClaim("inv_wait")).notUpdated.inv_wait!.type).toBe("forbidden");
  });
});

// ---- the period boundary ---------------------------------------------------

describe("an overage never outlives its period", () => {
  it("approving an ask for a FINISHED period is refused, legibly, and grants nothing", async () => {
    const h = harness();
    h.spend(CAP);
    h.waiting("inv_wait");
    // The proposal's expiresAt is the period end, so a pending one should never
    // survive the roll — but the expiry sweep is a cron, and this is the
    // authoritative check. Writing an inert grant while reporting "approved"
    // would be the lie.
    const ask = h.seedAsk("inv_ask", h.askPayload({ periodKey: "2001-01" }));
    const res = await h.call<SetResult>("ActionProposal/set", {
      update: { [ask]: { status: "approved" } },
    });
    expect(res.notUpdated[ask]!.type).toBe("invalidProperties");
    expect(res.notUpdated[ask]!.description).toMatch(/2001-01, which has ended/);
    expect(h.overages()).toEqual([]);
    expect(h.proposalRow(ask).status).toBe("pending"); // still decidable, not half-applied
  });

  it("a grant for THIS period does not widen the gate in another one", async () => {
    const h = harness();
    h.spend(CAP);
    h.waiting("inv_wait");
    const ask = h.seedAsk("inv_ask", h.askPayload());
    await h.call("ActionProposal/set", { update: { [ask]: { status: "approved" } } });
    expect((await h.paidClaim("inv_wait")).updated).toEqual({ inv_wait: null });

    // Re-key the granted row to a different month, as the month roll does by
    // arithmetic: the gate stops summing it and the ceiling snaps back.
    h.w.db.sqlite.exec(`UPDATE agent_budget_overages SET period_key = '2001-01'`);
    h.waiting("inv_next");
    expect((await h.paidClaim("inv_next")).notUpdated.inv_next!.type).toBe("forbidden");
  });
});

// ---- decline: keep waiting --------------------------------------------------

describe("decline means KEEP WAITING — and records nothing against the agent", () => {
  it("the work stays pending, no status changes, no overage, no fault", async () => {
    const h = harness();
    h.spend(CAP);
    h.waiting("inv_wait_1");
    h.waiting("inv_wait_2");
    const ask = h.seedAsk("inv_ask", h.askPayload());

    const res = await h.call<SetResult>("ActionProposal/set", {
      update: { [ask]: { status: "rejected", decision: { note: "not this month" } } },
    });
    expect(res.updated).toEqual({ [ask]: null });

    // Nothing was cancelled and nothing failed: the work is exactly where it
    // was, which is the whole meaning of the verb here.
    for (const id of ["inv_wait_1", "inv_wait_2"]) {
      expect(h.invRow(id)).toMatchObject({ status: "pending", note: null });
    }
    expect(h.overages()).toEqual([]);
    // ...and the gate is unchanged — declining is not a covert approval either.
    expect((await h.paidClaim("inv_wait_1")).notUpdated.inv_wait_1!.type).toBe("forbidden");

    // THE TAXONOMY INVARIANT: the recorded decision carries WHO and the human's
    // free text, and NO reason. There is no negative signal here for a learning
    // pipeline to find, because none can be written.
    const decision = JSON.parse(h.proposalRow(ask).decision_json!) as Record<string, unknown>;
    expect(decision).toEqual({ by: "eric@login.example", note: "not this month" });
    expect(decision.reason).toBeUndefined();
  });

  it("a reject REASON on this kind is refused — the invariant is enforced, not documented", async () => {
    const h = harness();
    h.spend(CAP);
    h.waiting("inv_wait");
    for (const reason of ["wrongContent", "wrongAction", "unsafe"]) {
      const ask = h.seedAsk(`inv_ask_${reason}`, h.askPayload());
      const res = await h.call<SetResult>("ActionProposal/set", {
        update: { [ask]: { status: "rejected", decision: { reason } } },
      });
      expect(res.notUpdated[ask]!.type).toBe("invalidProperties");
      expect(res.notUpdated[ask]!.description).toMatch(/no reject reason/);
      // Refused whole: the row is still pending and still decidable.
      expect(h.proposalRow(ask).status).toBe("pending");
      expect(h.proposalRow(ask).decision_json).toBeNull();
    }
    // The same reasons remain perfectly valid on a kind that IS about the
    // agent's work — this narrows one kind, not the enum.
    h.w.db.seed("agent_invocations", [
      { id: "inv_reply", account_id: ACCOUNT, binding_id: "bind_photos", binding_name: "photos", status: "done", created_at: 4 },
    ]);
    h.w.db.seed("agent_proposals", [
      {
        id: "inv_reply",
        account_id: ACCOUNT,
        kind: "reply-draft",
        tier: 2,
        payload_json: "{}",
        rationale: "drafted",
        evidence_json: "[]",
        status: "pending",
        created_at: 4,
      },
    ]);
    const ok = await h.call<SetResult>("ActionProposal/set", {
      update: { inv_reply: { status: "rejected", decision: { reason: "wrongContent" } } },
    });
    expect(ok.updated).toEqual({ inv_reply: null });
  });
});

// ---- needsInfo: "what would it cost?" ---------------------------------------

describe("needsInfo works on this kind unchanged (s10 T3)", () => {
  it('"what would it cost?" pauses the clock and enqueues the same answer round', async () => {
    const h = harness();
    h.spend(CAP);
    h.waiting("inv_wait");
    const ask = h.seedAsk("inv_ask", h.askPayload());

    const res = await h.call<SetResult>("ActionProposal/set", {
      update: { [ask]: { status: "info-requested", question: "What would finishing the queue cost?" } },
    });
    expect(res.updated).toEqual({ [ask]: null });

    const row = h.w.db.query<{
      status: string;
      question: string;
      decision_json: string | null;
      expires_at: number | null;
      expires_remaining_ms: number | null;
    }>(
      "SELECT status, question, decision_json, expires_at, expires_remaining_ms FROM agent_proposals WHERE account_id = ? AND id = ?",
      ACCOUNT,
      ask,
    )[0]!;
    expect(row.status).toBe("info-requested");
    expect(row.question).toBe("What would finishing the queue cost?");
    // Never a rejection record: the question is an ACTION.
    expect(row.decision_json).toBeNull();
    // The clock is banked, not running (the period deadline must not lapse
    // while the ball is in the agent's court).
    expect(row.expires_at).toBeNull();
    expect(row.expires_remaining_ms).toBeGreaterThan(0);

    // The ordinary answer round was enqueued — no forked handler for this kind.
    const answer = h.w.db.query<{ context_json: string; status: string }>(
      "SELECT context_json, status FROM agent_invocations WHERE account_id = ? AND context_json LIKE '%answer-info-request%'",
      ACCOUNT,
    )[0]!;
    expect(answer.status).toBe("pending");
    expect(JSON.parse(answer.context_json)).toMatchObject({
      kind: "answer-info-request",
      proposalId: ask,
    });

    // And the answer is DERIVABLE: the estimate the question asks about is a
    // recorded field on the proposal, so the agent answers from the record
    // rather than guessing (services/agent `composeAnswer` feeds payload_json
    // to the model and forbids invention).
    expect(JSON.parse(h.proposalRow(ask).payload_json).estimateMicros).toBe(1_600_000);

    // The work never moved.
    expect(h.invRow("inv_wait").status).toBe("pending");
  });

  it("THE DEADLOCK: the answer round is stamped past-due, because the budget cannot gate the question about itself", async () => {
    const h = harness();
    h.spend(CAP);
    h.waiting("inv_wait");
    const ask = h.seedAsk("inv_ask", h.askPayload());
    await h.call("ActionProposal/set", {
      update: { [ask]: { status: "info-requested", question: "What would it cost?" } },
    });

    // The round belongs to a binding whose budget is spent, so the gate would
    // hold the paid cloud off it — the answer would never come, with the
    // human's clock paused the whole time. It is stamped past-due so T3's
    // backstop (which claims OUTSIDE the policy gate for exactly this reason)
    // takes it on the next sweep.
    const round = h.w.db.query<{ id: string; due_at: number | null }>(
      "SELECT id, due_at FROM agent_invocations WHERE account_id = ? AND context_json LIKE '%answer-info-request%'",
      ACCOUNT,
    )[0]!;
    expect(round.due_at).not.toBeNull();
    expect(round.due_at!).toBeLessThanOrEqual(Date.now());
  });

  it("...and a binding UNDER its cap is untouched — s10 T3 behaves exactly as before", async () => {
    const h = harness();
    h.spend(1_000_000); // well under the $5.00 cap
    const ask = h.seedAsk("inv_ask", h.askPayload());
    await h.call("ActionProposal/set", {
      update: { [ask]: { status: "info-requested", question: "why?" } },
    });
    const round = h.w.db.query<{ due_at: number | null }>(
      "SELECT due_at FROM agent_invocations WHERE account_id = ? AND context_json LIKE '%answer-info-request%'",
      ACCOUNT,
    )[0]!;
    // NULL = never-urgent = the ordinary answer round. The stamp is guarded by
    // the gate's own budget fragment, so it lands only where it must.
    expect(round.due_at).toBeNull();
  });

  it("an APPROVED overage un-deadlocks the round too — the guard reads the same ceiling the gate does", async () => {
    const h = harness();
    h.spend(CAP);
    h.waiting("inv_wait");
    const grant = h.seedAsk("inv_grant", h.askPayload());
    await h.call("ActionProposal/set", { update: { [grant]: { status: "approved" } } });

    // Under the RAISED ceiling the binding is not exhausted, so a later
    // question's round is an ordinary one again.
    const ask = h.seedAsk("inv_ask2", h.askPayload());
    await h.call("ActionProposal/set", {
      update: { [ask]: { status: "info-requested", question: "and now?" } },
    });
    const rounds = h.w.db.query<{ due_at: number | null }>(
      "SELECT due_at FROM agent_invocations WHERE account_id = ? AND context_json LIKE '%answer-info-request%'",
      ACCOUNT,
    );
    expect(rounds).toHaveLength(1);
    expect(rounds[0]!.due_at).toBeNull();
  });
});
