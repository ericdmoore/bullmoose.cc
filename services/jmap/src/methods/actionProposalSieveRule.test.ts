import { describe, expect, it } from "vitest";
import { MethodRegistry } from "@bullmoose/jmap-core";
import { fakeEnv } from "@bullmoose/test-fakes";
import { commitDueHeldProposals, registerActionProposalMethods } from "./actionProposal";
import type { RequestContext } from "./common";

/**
 * s31 rung 2 — the decide side of the [mark junk] machine, through the real
 * method. The properties under test:
 *
 *   1. TIER 2 means the hold tray: approve parks the row `held`, and the rule
 *      reaches the RULEBOOK only when the yank window closes — a standing
 *      filter is standing authority, and the retraction stays real.
 *   2. The rule's id is the PROPOSAL's id: the rulebook carries its own
 *      provenance, and `SieveScript/get`'s state (`updated_at`) moves the
 *      moment the rule lands.
 *   3. (X) close is NOT a decline: no reason is carried or accepted, and it
 *      is legal only for SOLICITED kinds.
 *   4. Retry SUPERSEDES: the old row closes as answered, and a NEW pending
 *      invocation is minted on the same binding, carrying the nudge and the
 *      prior rule.
 */

const ACCOUNT = "a_eric";
const TENANT = "t_bm";
const APPROVER = "eric@login.example";

interface SetResult {
  updated: Record<string, { successorId?: string } | null>;
  notUpdated: Record<string, { type: string; description?: string; properties?: string[] }>;
}

function harness() {
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
      scopes: ["mail", "calendar"],
      accounts: [{ accountId: ACCOUNT, tenantId: TENANT, name: "Eric" }],
    },
  };
  const set = (args: Record<string, unknown>) =>
    registry.get("ActionProposal/set")!({ accountId: ACCOUNT, ...args }, ctx) as unknown as Promise<SetResult>;
  return { w, ctx, set };
}

const RULE = {
  id: "inv_r1",
  all: [{ kind: "contains", field: "from", value: "blast@deals.example" }],
  action: "reject",
};

function seedRuleProposal(h: ReturnType<typeof harness>, over: Record<string, unknown> = {}) {
  h.w.db.seed("agent_invocations", [
    {
      id: "inv_r1",
      account_id: ACCOUNT,
      binding_id: "bind_bouncer",
      binding_name: "bouncer",
      status: "done",
      email_id: "e_noise",
      created_at: 1,
      claimed_at: 1,
      done_at: 1,
      provider: null,
      model: null,
      cost_micros: 0,
    },
  ]);
  h.w.db.seed("agent_proposals", [
    {
      id: "inv_r1",
      account_id: ACCOUNT,
      kind: "sieve-rule",
      tier: 2,
      subject_json: JSON.stringify({ realm: "Email", objectId: "e_noise" }),
      payload_json: JSON.stringify({
        verb: "rule",
        rule: RULE,
        blastRadius: { tested: 4, caught: 3, sampleIds: [], answeredCaught: 0 },
        composed: "model",
      }),
      rationale: "a standing rule",
      evidence_json: "[]",
      status: "pending",
      created_at: 1,
      ...over,
    },
  ]);
}

const rulebook = (h: ReturnType<typeof harness>) =>
  h.w.db.query<{ rules_json: string; updated_at: number }>(
    `SELECT rules_json, updated_at FROM sieve_rules WHERE account_id = '${ACCOUNT}'`,
  );

const proposalRow = (h: ReturnType<typeof harness>, id = "inv_r1") =>
  h.w.db.query<{ status: string; decision_json: string | null; hold_until: number | null }>(
    `SELECT status, decision_json, hold_until FROM agent_proposals WHERE id = '${id}'`,
  )[0]!;

async function commitPastHold(h: ReturnType<typeof harness>) {
  await h.w.env.DB.prepare(`UPDATE agent_proposals SET hold_until = 1 WHERE account_id = ?`).bind(ACCOUNT).run();
  return commitDueHeldProposals(h.ctx);
}

describe("sieve-rule — approve holds, the window closes, the rulebook gains a rule", () => {
  it("approve parks it HELD — a standing filter does not land while the yank is live", async () => {
    const h = harness();
    seedRuleProposal(h);
    const res = await h.set({ update: { inv_r1: { status: "approved" } } });
    expect(res.notUpdated).toEqual({});
    const row = proposalRow(h);
    expect(row.status).toBe("held");
    expect(row.hold_until).toBeGreaterThan(Date.now());
    expect(rulebook(h)).toHaveLength(0); // nothing in the rulebook yet
  });

  it("the commit writes the rule under the PROPOSAL's id, and updated_at moves", async () => {
    const h = harness();
    seedRuleProposal(h);
    await h.set({ update: { inv_r1: { status: "approved" } } });
    const { committed, failed } = await commitPastHold(h);
    expect(failed).toEqual([]);
    expect(committed).toContain("inv_r1");

    const [book] = rulebook(h);
    const rules = JSON.parse(book!.rules_json);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ id: "inv_r1", action: "reject" });
    // SieveScript/get's state IS updated_at — a standards client polling the
    // script sees the new rule the moment it lands.
    expect(book!.updated_at).toBeGreaterThan(0);
    expect(proposalRow(h).status).toBe("approved");
    const decision = JSON.parse(proposalRow(h).decision_json!);
    expect(decision.undo).toEqual({ action: "remove-sieve-rule", ruleId: "inv_r1" });
  });

  it("appends beside existing rules, and replaces-by-id rather than doubling", async () => {
    const h = harness();
    seedRuleProposal(h);
    await h.w.env.DB.prepare(`INSERT INTO sieve_rules (account_id, rules_json, updated_at) VALUES (?, ?, 5)`)
      .bind(
        ACCOUNT,
        JSON.stringify([
          { id: "hand-1", all: [{ kind: "contains", field: "subject", value: "casino" }], action: "reject" },
          { id: "inv_r1", all: [{ kind: "contains", field: "from", value: "stale@old" }], action: "reject" },
        ]),
      )
      .run();
    await h.set({ update: { inv_r1: { status: "approved" } } });
    const { failed } = await commitPastHold(h);
    expect(failed).toEqual([]);
    const rules = JSON.parse(rulebook(h)[0]!.rules_json) as Array<{ id: string; all: Array<{ value: string }> }>;
    expect(rules).toHaveLength(2); // hand-1 kept, inv_r1 replaced not doubled
    expect(rules.find((r) => r.id === "hand-1")).toBeTruthy();
    expect(rules.find((r) => r.id === "inv_r1")!.all[0]!.value).toBe("blast@deals.example");
  });

  it("edit-is-approval: the redlined rule is what lands", async () => {
    const h = harness();
    seedRuleProposal(h);
    const edited = {
      verb: "rule",
      rule: { ...RULE, all: [{ kind: "glob", field: "fromDomain", value: "*.deals.example" }] },
    };
    await h.set({ update: { inv_r1: { status: "approved", editedPayload: edited } } });
    const { failed } = await commitPastHold(h);
    expect(failed).toEqual([]);
    const rules = JSON.parse(rulebook(h)[0]!.rules_json);
    expect(rules[0]!.all[0]).toMatchObject({ kind: "glob", field: "fromDomain", value: "*.deals.example" });
  });

  it("a rule the engine cannot run refuses at the landing, and the row stays held for the human", async () => {
    const h = harness();
    seedRuleProposal(h, {
      payload_json: JSON.stringify({ verb: "rule", rule: { all: [], action: "reject" } }),
    });
    await h.set({ update: { inv_r1: { status: "approved" } } });
    const { committed, failed } = await commitPastHold(h);
    expect(committed).toEqual([]);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.error).toContain("not a rule the boundary engine can run");
    expect(rulebook(h)).toHaveLength(0);
  });
});

describe("(X) close — not now, and NOT a decline", () => {
  it("closes a pending sieve-rule with no reason and no learning signal", async () => {
    const h = harness();
    seedRuleProposal(h);
    const res = await h.set({ update: { inv_r1: { status: "closed" } } });
    expect(res.notUpdated).toEqual({});
    const row = proposalRow(h);
    expect(row.status).toBe("closed");
    const decision = JSON.parse(row.decision_json!);
    expect(decision).toEqual({ by: APPROVER, closed: "dismissed" });
    // Composed-then-closed is directly countable — that is this row.
  });

  it("refuses a close that tries to smuggle a reason — silence is the record", async () => {
    const h = harness();
    seedRuleProposal(h);
    const res = await h.set({ update: { inv_r1: { status: "closed", decision: { reason: "wrongContent" } } } });
    expect(res.notUpdated.inv_r1!.description).toContain("not a decline");
    expect(proposalRow(h).status).toBe("pending");
  });

  it("refuses to close an UNSOLICITED kind — the taxonomy keeps its labels", async () => {
    const h = harness();
    seedRuleProposal(h, { kind: "reply-draft" });
    const res = await h.set({ update: { inv_r1: { status: "closed" } } });
    expect(res.notUpdated.inv_r1!.description).toContain("not closeable");
  });
});

describe("retry with a nudge — supersede, never edit", () => {
  it("closes the old row as answered and mints the successor invocation", async () => {
    const h = harness();
    seedRuleProposal(h);
    const res = await h.set({ update: { inv_r1: { status: "retry", note: "broader — the whole domain" } } });
    expect(res.notUpdated).toEqual({});

    const old = proposalRow(h);
    expect(old.status).toBe("closed");
    const decision = JSON.parse(old.decision_json!);
    expect(decision.closed).toBe("superseded-by-retry");
    expect(decision.nudge).toBe("broader — the whole domain");

    const successors = h.w.db.query<{
      id: string;
      status: string;
      binding_id: string;
      email_id: string | null;
      context_json: string;
    }>(
      `SELECT id, status, binding_id, email_id, context_json FROM agent_invocations
        WHERE account_id = '${ACCOUNT}' AND id != 'inv_r1'`,
    );
    expect(successors).toHaveLength(1);
    const s = successors[0]!;
    // RFC 8620 §5.3 server-set changes: the response NAMES the successor, so
    // the popover can follow the re-composition instead of guessing by query.
    expect(res.updated.inv_r1).toEqual({ successorId: s.id });
    expect(s.status).toBe("pending"); // the drain will claim and re-compose
    expect(s.binding_id).toBe("bind_bouncer"); // same authority as the original
    expect(s.email_id).toBe("e_noise");
    const params = JSON.parse(s.context_json).params;
    expect(params.verb).toBe("rule");
    expect(params.note).toBe("broader — the whole domain");
    expect(params.priorRule).toMatchObject({ id: "inv_r1" });
  });

  it("refuses retry on a kind whose verb row does not carry it", async () => {
    const h = harness();
    seedRuleProposal(h, { kind: "reply-draft" });
    const res = await h.set({ update: { inv_r1: { status: "retry" } } });
    expect(res.notUpdated.inv_r1!.description).toContain("no retry");
  });

  it("a closed row is terminal — the superseded proposal refuses further decisions", async () => {
    const h = harness();
    seedRuleProposal(h);
    await h.set({ update: { inv_r1: { status: "retry" } } });
    const again = await h.set({ update: { inv_r1: { status: "approved" } } });
    expect(again.notUpdated.inv_r1!.description).toContain("closed");
  });
});
