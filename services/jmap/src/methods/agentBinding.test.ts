import { describe, expect, it } from "vitest";
import { MethodRegistry } from "@bullmoose/jmap-core";
import { fakeEnv, type FakeWorker } from "@bullmoose/test-fakes";
import { mintToken } from "@bullmoose/auth-core";
import { verifyBearer } from "@bullmoose/auth-core/principal";
import { SUPERVISORY_GRANT_SCOPES } from "../../../provision/src/index";
import { registerAgentBindingMethods } from "./agentBinding";
import type { RequestContext } from "./common";

/**
 * s26 T2 — the session-reachable kill switch (`AgentBinding/set`).
 *
 * The authz design under test, in one sentence each:
 *
 *   SCOPE     the flip is gated on `send` — the capability wall's own scope
 *             (actionProposal.ts tier-3) — which a plain `mail` token covers
 *             and a supervisory grant (read+annotate+draft) does not. The
 *             grant half runs against the REAL resolution path (minted token
 *             → verifyBearer → token ∩ grant), with the grant scopes imported
 *             from provision so a widening there fails HERE, loudly.
 *   MARKER    no agent hand on the switch, whatever scopes the token holds.
 *   OWNERSHIP a binding on another account answers exactly like one that
 *             never existed; an unreachable account is accountNotFound.
 *   AUDIT     a real flip writes `binding_lifecycle` (`enabled-changed`,
 *             prior/next state, the acting principal) atomically with the
 *             UPDATE; a no-op writes neither.
 */

const TENANT = "t_bm";
const ERIC = "a_eric"; //     the human, owns his own account + one agent account
const OWNED_AGENT = "a_allen"; // agent account Eric's principal OWNS
const SUPERVISED = "a_emily"; // agent account reached ONLY via the supervisory grant
const STRANGER = "a_stranger"; // same tenant, no path at all

interface SetResult {
  accountId: string;
  updated: Record<string, { enabled: boolean }>;
  notUpdated: Record<string, { type: string; description?: string; properties?: string[] }>;
}

function seedBinding(w: FakeWorker, account: string, id: string, name: string, enabled: 0 | 1): void {
  w.db.seed("agent_bindings", [{ id, account_id: account, name, enabled }]);
}

function lifecycleRows(w: FakeWorker, account: string, binding: string) {
  return w.db.query<{ event: string; old_value: string; new_value: string; actor: string; via_proposal_id: null }>(
    `SELECT event, old_value, new_value, actor, via_proposal_id FROM binding_lifecycle
      WHERE account_id = ? AND binding_id = ? ORDER BY id`,
    account,
    binding,
  );
}

function enabledOf(w: FakeWorker, account: string, binding: string): number {
  return w.db.query<{ enabled: number }>(
    `SELECT enabled FROM agent_bindings WHERE account_id = ? AND id = ?`,
    account,
    binding,
  )[0]!.enabled;
}

/** The simple harness: a hand-built principal (the annotation.test.ts shape). */
function harness(opts: { scopes?: string[]; agent?: { binding?: string; invocation?: string } } = {}) {
  const w = fakeEnv();
  w.db.seedAccount({
    accountId: ERIC,
    tenantId: TENANT,
    principalId: "p_eric",
    loginEmail: "eric@bullmoose.cc",
    displayName: "Eric",
  });
  seedBinding(w, ERIC, "bind_extractor", "extractor", 1);
  seedBinding(w, ERIC, "bind_off", "off", 0);

  const registry = new MethodRegistry<RequestContext>();
  registerAgentBindingMethods(registry);
  const ctx: RequestContext = {
    env: w.env,
    principal: {
      username: "eric@bullmoose.cc",
      scopes: opts.scopes ?? ["mail"],
      accounts: [{ accountId: ERIC, tenantId: TENANT, name: "Eric" }],
    },
    ...(opts.agent ? { agent: opts.agent } : {}),
  };
  const call = <T = Record<string, unknown>>(args: Record<string, unknown>) =>
    registry.get("AgentBinding/set")!(args, ctx) as Promise<T>;
  const set = (args: Record<string, unknown>, account: string = ERIC) =>
    call<SetResult>({ accountId: account, ...args });
  return { w, set };
}

describe("AgentBinding/set — the flip, and its audit", () => {
  it("disables an enabled binding and appends the lifecycle row atomically", async () => {
    const h = harness();
    const res = await h.set({ update: { bind_extractor: { enabled: false } } });

    expect(res.updated.bind_extractor).toEqual({ enabled: false });
    expect(res.notUpdated).toEqual({});
    expect(enabledOf(h.w, ERIC, "bind_extractor")).toBe(0);

    const rows = lifecycleRows(h.w, ERIC, "bind_extractor");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event: "enabled-changed",
      old_value: "1",
      new_value: "0",
      // WHO flipped it — the same value grant_audit records for delegated calls.
      actor: "eric@bullmoose.cc",
      // NULL = a direct human decision, exactly as the s10 T4 chain reads.
      via_proposal_id: null,
    });
  });

  it("re-enables and the chain now reads disable-then-enable, in order", async () => {
    const h = harness();
    await h.set({ update: { bind_extractor: { enabled: false } } });
    const res = await h.set({ update: { bind_extractor: { enabled: true } } });

    expect(res.updated.bind_extractor).toEqual({ enabled: true });
    expect(enabledOf(h.w, ERIC, "bind_extractor")).toBe(1);
    const rows = lifecycleRows(h.w, ERIC, "bind_extractor");
    expect(rows.map((r) => `${r.old_value}->${r.new_value}`)).toEqual(["1->0", "0->1"]);
  });

  it("a no-op succeeds but writes NOTHING — no UPDATE, no chain row", async () => {
    const h = harness();
    const res = await h.set({ update: { bind_off: { enabled: false } } });
    expect(res.updated.bind_off).toEqual({ enabled: false });
    expect(enabledOf(h.w, ERIC, "bind_off")).toBe(0);
    // A chain that records non-events is a chain nobody can read.
    expect(lifecycleRows(h.w, ERIC, "bind_off")).toHaveLength(0);
  });
});

describe("AgentBinding/set — one property, everything else refused by name", () => {
  it("refuses non-enabled keys and names where each verb lives", async () => {
    const h = harness();
    const res = await h.set({ update: { bind_extractor: { enabled: false, replyMode: "send" } } });
    const err = res.notUpdated.bind_extractor!;
    expect(err.type).toBe("invalidProperties");
    expect(err.properties).toEqual(["replyMode"]);
    expect(err.description).toContain("PATCH /agent-bindings/{id}");
    // Refused whole — the enabled half of the patch must not half-apply.
    expect(enabledOf(h.w, ERIC, "bind_extractor")).toBe(1);
  });

  it("refuses a non-boolean enabled", async () => {
    const h = harness();
    const res = await h.set({ update: { bind_extractor: { enabled: "off" } } });
    expect(res.notUpdated.bind_extractor).toMatchObject({
      type: "invalidProperties",
      properties: ["enabled"],
    });
  });

  it("has no create and no destroy — provisioning is the operator plane's", async () => {
    const h = harness();
    await expect(h.set({ create: { c: { name: "new" } } })).rejects.toMatchObject({ type: "invalidArguments" });
    await expect(h.set({ destroy: ["bind_extractor"] })).rejects.toMatchObject({ type: "invalidArguments" });
  });
});

describe("AgentBinding/set — the capability wall (scope: send)", () => {
  it("a read+annotate+draft token — the supervisory scope set — is refused", async () => {
    // The exact effective-scope set a supervisory grant yields. On the TOKEN
    // side here; the grant side is proven below against real resolution.
    const h = harness({ scopes: [...SUPERVISORY_GRANT_SCOPES] });
    await expect(h.set({ update: { bind_extractor: { enabled: false } } })).rejects.toMatchObject({
      type: "forbidden",
    });
    expect(enabledOf(h.w, ERIC, "bind_extractor")).toBe(1);
  });

  it("a token with the six mail verbs spelled out passes — the bundle literal is not required", async () => {
    const h = harness({ scopes: ["read", "annotate", "draft", "move", "send", "delete"] });
    const res = await h.set({ update: { bind_extractor: { enabled: false } } });
    expect(res.updated.bind_extractor).toEqual({ enabled: false });
  });
});

describe("AgentBinding/set — no agent hand on the kill switch", () => {
  it("refuses an agent-MARKED token even when it holds send", async () => {
    // The marker only narrows, so a marked token CAN hold `send` — the
    // unconditional refusal is what stops a disabled agent re-enabling itself.
    const h = harness({ scopes: ["mail", "agent"] });
    await expect(h.set({ update: { bind_off: { enabled: true } } })).rejects.toMatchObject({ type: "forbidden" });
    expect(enabledOf(h.w, ERIC, "bind_off")).toBe(0);
  });

  it("refuses agent PROVENANCE (ctx.agent) on an otherwise human token", async () => {
    const h = harness({ agent: { binding: "extractor", invocation: "inv_1" } });
    await expect(h.set({ update: { bind_off: { enabled: true } } })).rejects.toMatchObject({ type: "forbidden" });
  });
});

describe("AgentBinding/set — ownership: cross-account is indistinguishable from not-found", () => {
  it("a binding on another account and a binding that never existed answer identically", async () => {
    const h = harness();
    // A real binding — on someone else's account.
    h.w.db.seedAccount({
      accountId: STRANGER,
      tenantId: TENANT,
      principalId: "p_stranger",
      loginEmail: "stranger@bullmoose.cc",
    });
    seedBinding(h.w, STRANGER, "bind_theirs", "theirs", 1);

    const res = await h.set({
      update: { bind_theirs: { enabled: false }, bind_never_existed: { enabled: false } },
    });
    expect(res.notUpdated.bind_theirs).toEqual(res.notUpdated.bind_never_existed);
    expect(res.notUpdated.bind_theirs).toMatchObject({ type: "notFound" });
    expect(enabledOf(h.w, STRANGER, "bind_theirs")).toBe(1);
  });

  it("an accountId the principal cannot reach is accountNotFound before any binding is consulted", async () => {
    const h = harness();
    await expect(h.set({ update: { bind_theirs: { enabled: false } } }, STRANGER)).rejects.toMatchObject({
      type: "accountNotFound",
    });
  });
});

/**
 * The grant-side proof, against the REAL resolution path: a minted bearer,
 * verifyBearer, real grant rows — nothing hand-assembled. This is the test the
 * task statement names: a session whose reach derives from a supervisory grant
 * must NOT be able to disable a binding on the granting side — including the
 * binding that supervises it.
 */
async function grantHarness() {
  const w = fakeEnv();
  const registry = new MethodRegistry<RequestContext>();
  registerAgentBindingMethods(registry);

  w.db
    .seedAccount({ accountId: ERIC, tenantId: TENANT, principalId: "p_eric", loginEmail: "eric@bullmoose.cc" })
    .seedAccount({
      accountId: OWNED_AGENT,
      tenantId: TENANT,
      principalId: "p_eric", // Eric's principal owns this agent account outright
      loginEmail: "allen@bullmoose.cc",
    })
    .seedAccount({
      accountId: SUPERVISED,
      tenantId: TENANT,
      principalId: "p_emily", // its own principal — reachable only via the grant
      loginEmail: "editor@bullmoose.cc",
    });

  seedBinding(w, OWNED_AGENT, "bind_allen", "allen", 1);
  // The binding on the grant-reached account. From the grant-holder's seat it
  // plays "supervisor of whoever the grant was minted for" — the thing the
  // door must keep out of a grant-derived session's hands.
  seedBinding(w, SUPERVISED, "bind_supervisor", "supervisor", 1);

  const minted = await mintToken();
  w.db.seed("tokens", [
    {
      id: minted.id,
      principal_id: "p_eric",
      kind: "bearer",
      secret_hash: minted.secretHash,
      name: "eric-laptop",
      scopes: JSON.stringify(["mail"]), // the human mint default — covers send
      created_at: 1,
    },
  ]);
  w.db.seed("grants", [
    {
      id: "g_sup",
      tenant_id: TENANT,
      grantee_account_id: ERIC,
      target_account_id: SUPERVISED,
      // Provision's OWN constant: if the supervisory grant ever widens to
      // carry `send`, this suite fails here rather than the door silently
      // opening to every supervisor.
      scopes: JSON.stringify(SUPERVISORY_GRANT_SCOPES),
      created_by: "provision:supervisory",
      created_at: 1,
    },
  ]);

  const invoke = <T = Record<string, unknown>>(args: Record<string, unknown>, ctx: RequestContext) =>
    registry.get("AgentBinding/set")!(args, ctx) as Promise<T>;
  const call = async (account: string, bindingId: string, enabled: boolean): Promise<SetResult> => {
    const principal = await verifyBearer(w.env.DB, minted.token);
    if (!principal) throw new Error("token failed to resolve — fixture bug");
    return invoke<SetResult>({ accountId: account, update: { [bindingId]: { enabled } } }, { env: w.env, principal });
  };
  return { w, call };
}

describe("AgentBinding/set — the supervisory grant, resolved for real", () => {
  it("token ∩ supervisory grant lacks send: the grant-reached flip is refused, nothing written", async () => {
    expect([...SUPERVISORY_GRANT_SCOPES]).not.toContain("send"); // the premise, pinned
    const h = await grantHarness();
    await expect(h.call(SUPERVISED, "bind_supervisor", false)).rejects.toMatchObject({
      type: "forbidden",
    });
    expect(enabledOf(h.w, SUPERVISED, "bind_supervisor")).toBe(1);
    expect(lifecycleRows(h.w, SUPERVISED, "bind_supervisor")).toHaveLength(0);
    // And no grant_audit row either: the refused call exercised no grant.
    expect(h.w.db.query(`SELECT * FROM grant_audit`)).toHaveLength(0);
  });

  it("the SAME token flips a binding on an account its principal OWNS — the refusal above was the grant's, not the token's", async () => {
    const h = await grantHarness();
    const res = await h.call(OWNED_AGENT, "bind_allen", false);
    expect(res.updated.bind_allen).toEqual({ enabled: false });
    expect(lifecycleRows(h.w, OWNED_AGENT, "bind_allen")).toHaveLength(1);
    // Owned-account write: attributable via the lifecycle actor, no grant row.
    expect(h.w.db.query(`SELECT * FROM grant_audit`)).toHaveLength(0);
  });

  it("a grant an operator deliberately widened to carry send DOES pass — and is grant_audited", async () => {
    const h = await grantHarness();
    h.w.db.sqlite
      .prepare(`UPDATE grants SET scopes = ? WHERE id = ?`)
      .run(JSON.stringify(["read", "draft", "send"]), "g_sup");
    const res = await h.call(SUPERVISED, "bind_supervisor", false);
    expect(res.updated.bind_supervisor).toEqual({ enabled: false });
    const audit = h.w.db.query<{ grant_id: string; method: string; principal: string }>(
      `SELECT grant_id, method, principal FROM grant_audit`,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ grant_id: "g_sup", method: "mail:send", principal: "eric@bullmoose.cc" });
  });
});
