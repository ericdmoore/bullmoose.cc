import { describe, expect, it } from "vitest";
import { MethodRegistry } from "@bullmoose/jmap-core";
import { fakeEnv } from "@bullmoose/test-fakes";
import { registerActionProposalMethods } from "./actionProposal";
import type { RequestContext } from "./common";

/**
 * s26 T3 — the `floor-request` DECISION half (devPlan rule 1): "may this agent
 * read mail back to <date>?" The provision worker minted the ask
 * (backfill.test.ts proves that side, and the fixture here is that exact
 * shape); approving must write `config_json.historyFloor` on the binding —
 * the bound the backfill verb reads — while preserving the blob's remainder,
 * and record the move in `binding_lifecycle` with the proposal as the WHY.
 *
 * Declining is a PREFERENCE, never a fault: the kind joins NO_FAULT_KINDS, so
 * a reject reason is refused on the write path and nothing negative about the
 * agent can ever be recorded from a floor decline.
 */

const ACCOUNT = "a_floor";
const TENANT = "t_bm";
const BINDING = "bind_crm";
const CREATED = 1_700_000_000_000; // the binding's birth (default floor)
const TO = 1_600_000_000_000; // the asked-for floor, well behind the birth

interface SetResult {
  updated: Record<string, null>;
  notUpdated: Record<string, { type: string; description?: string }>;
}

function harness(config: Record<string, unknown> = { createdAt: CREATED, persona: "the CRM", maxTokens: 512 }) {
  const w = fakeEnv();
  const registry = new MethodRegistry<RequestContext>();
  registerActionProposalMethods(registry);
  const ctx: RequestContext = {
    env: w.env,
    principal: {
      username: "eric@login.example",
      scopes: ["mail"],
      accounts: [{ accountId: ACCOUNT, tenantId: TENANT, name: "Eric" }],
    },
  };
  w.db.seed("agent_bindings", [
    { id: BINDING, account_id: ACCOUNT, name: "crm", enabled: 1, config_json: JSON.stringify(config) },
  ]);
  const call = <T = Record<string, unknown>>(method: string, args: Record<string, unknown>) =>
    registry.get(method)!({ accountId: ACCOUNT, ...args }, ctx) as Promise<T>;
  const set = (args: Record<string, unknown>) => call<SetResult>("ActionProposal/set", args);
  return { w, set };
}

/** The ask, exactly as `POST /agent-bindings/{id}/floor-request` mints it:
 * a done, cost-0 carrier invocation + the tier-1 proposal keyed to it. */
function seedAsk(
  w: ReturnType<typeof fakeEnv>,
  id: string,
  payload: Record<string, unknown> = { bindingId: BINDING, bindingName: "crm", toEpochMs: TO, currentFloorMs: null },
): void {
  w.db.seed("agent_invocations", [
    {
      id,
      account_id: ACCOUNT,
      binding_id: BINDING,
      binding_name: "crm",
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
      kind: "floor-request",
      tier: 1,
      subject_json: JSON.stringify({ realm: "AgentBinding", objectId: BINDING }),
      payload_json: JSON.stringify(payload),
      rationale: `"crm" asks to read mail back to 2020-09-13.`,
      evidence_json: JSON.stringify([{ realm: "AgentBinding", objectId: BINDING }]),
      status: "pending",
      created_at: 3,
    },
  ]);
}

const bindingConfig = (w: ReturnType<typeof fakeEnv>): Record<string, unknown> =>
  JSON.parse(
    w.db.query<{ config_json: string }>(`SELECT config_json FROM agent_bindings WHERE id = ?`, BINDING)[0]!.config_json,
  ) as Record<string, unknown>;

describe("floor-request: approve writes the floor", () => {
  it("writes historyFloor into the binding's config, preserving the remainder", async () => {
    const h = harness();
    seedAsk(h.w, "inv_fr");

    const res = await h.set({ update: { inv_fr: { status: "approved" } } });
    expect(res.updated).toHaveProperty("inv_fr");

    const cfg = bindingConfig(h.w);
    expect(cfg.historyFloor).toBe(TO);
    // The remainder survives the read-modify-write — the blob is one namespace.
    expect(cfg.persona).toBe("the CRM");
    expect(cfg.maxTokens).toBe(512);
    expect(cfg.createdAt).toBe(CREATED);

    const prop = h.w.db.query<{ status: string; decision_json: string }>(
      `SELECT status, decision_json FROM agent_proposals WHERE id = 'inv_fr'`,
    )[0]!;
    expect(prop.status).toBe("approved");
    // Tier 1 keeps its undo handle; null = "had no floor", distinct from 0.
    const decision = JSON.parse(prop.decision_json) as { undo?: { action: string; previousFloorMs: number | null } };
    expect(decision.undo).toMatchObject({ action: "restore-floor", bindingId: BINDING, previousFloorMs: null });
  });

  it("records the move in binding_lifecycle with the proposal as the WHY", async () => {
    const h = harness();
    seedAsk(h.w, "inv_fr");
    await h.set({ update: { inv_fr: { status: "approved" } } });

    const chain = h.w.db.query<{
      event: string;
      old_value: string | null;
      new_value: string;
      via_proposal_id: string;
      actor: string;
    }>(
      `SELECT event, old_value, new_value, via_proposal_id, actor FROM binding_lifecycle WHERE binding_id = ?`,
      BINDING,
    );
    expect(chain).toHaveLength(1);
    expect(chain[0]).toMatchObject({
      event: "history-floor-changed",
      old_value: null, // there WAS no floor key — legible, not "0"
      new_value: String(TO),
      via_proposal_id: "inv_fr",
      actor: "eric@login.example",
    });
  });

  it("moving an EXISTING floor keeps the old value in the chain and in the undo handle", async () => {
    const OLD = 1_650_000_000_000;
    const h = harness({ createdAt: CREATED, historyFloor: OLD, persona: "the CRM" });
    seedAsk(h.w, "inv_fr2", { bindingId: BINDING, toEpochMs: TO, currentFloorMs: OLD });

    const res = await h.set({ update: { inv_fr2: { status: "approved" } } });
    expect(res.updated).toHaveProperty("inv_fr2");
    expect(bindingConfig(h.w).historyFloor).toBe(TO);

    const chain = h.w.db.query<{ old_value: string | null }>(
      `SELECT old_value FROM binding_lifecycle WHERE binding_id = ? AND via_proposal_id = 'inv_fr2'`,
      BINDING,
    );
    expect(chain[0]!.old_value).toBe(String(OLD));
    const decision = JSON.parse(
      h.w.db.query<{ decision_json: string }>(`SELECT decision_json FROM agent_proposals WHERE id = 'inv_fr2'`)[0]!
        .decision_json,
    ) as { undo?: { previousFloorMs: number | null } };
    expect(decision.undo?.previousFloorMs).toBe(OLD);
  });

  it("refuses a payload without bindingId/toEpochMs, and a binding outside the account — nothing written", async () => {
    const h = harness();
    seedAsk(h.w, "inv_bad", { bindingId: BINDING }); // no toEpochMs
    seedAsk(h.w, "inv_ghost", { bindingId: "bind_elsewhere", toEpochMs: TO });

    const res = await h.set({
      update: { inv_bad: { status: "approved" }, inv_ghost: { status: "approved" } },
    });
    expect(res.notUpdated.inv_bad?.type).toBe("invalidProperties");
    expect(res.notUpdated.inv_ghost?.type).toBe("invalidProperties");
    expect(bindingConfig(h.w).historyFloor).toBeUndefined();
    expect(h.w.db.count("binding_lifecycle")).toBe(0);
  });

  it("refuses to rewrite an unparseable config blind — the remainder is worth more than the approval", async () => {
    const h = harness();
    h.w.db.query(`UPDATE agent_bindings SET config_json = 'not json' WHERE id = ?`, BINDING);
    seedAsk(h.w, "inv_fr");

    const res = await h.set({ update: { inv_fr: { status: "approved" } } });
    expect(res.notUpdated.inv_fr?.type).toBe("invalidProperties");
    // Untouched, and still pending — the human can retry after the row is repaired.
    expect(h.w.db.query<{ status: string }>(`SELECT status FROM agent_proposals WHERE id = 'inv_fr'`)[0]!.status).toBe(
      "pending",
    );
  });
});

describe("floor-request: decline is a preference, never a fault", () => {
  it("declining with a reject reason is refused — the kind is NO-FAULT", async () => {
    const h = harness();
    seedAsk(h.w, "inv_fr");

    const res = await h.set({
      update: { inv_fr: { status: "rejected", decision: { reason: "wrongAction" } } },
    });
    expect(res.notUpdated.inv_fr?.type).toBe("invalidProperties");
    expect(res.notUpdated.inv_fr?.description).toContain("no reject reason");
  });

  it("declining with a note records the decision and touches nothing on the binding", async () => {
    const h = harness();
    seedAsk(h.w, "inv_fr");

    const res = await h.set({
      update: { inv_fr: { status: "rejected", decision: { note: "the archive stays closed" } } },
    });
    expect(res.updated).toHaveProperty("inv_fr");

    const prop = h.w.db.query<{ status: string; decision_json: string }>(
      `SELECT status, decision_json FROM agent_proposals WHERE id = 'inv_fr'`,
    )[0]!;
    expect(prop.status).toBe("rejected");
    const decision = JSON.parse(prop.decision_json) as Record<string, unknown>;
    expect(decision.note).toBe("the archive stays closed");
    expect(decision.reason).toBeUndefined(); // nothing negative can land here

    expect(bindingConfig(h.w).historyFloor).toBeUndefined();
    expect(h.w.db.count("binding_lifecycle")).toBe(0);
  });
});
