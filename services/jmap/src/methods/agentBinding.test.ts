import { describe, expect, it } from "vitest";
import { MethodRegistry } from "@bullmoose/jmap-core";
import { fakeEnv, type FakeWorker } from "@bullmoose/test-fakes";
import { mintToken } from "@bullmoose/auth-core";
import { verifyBearer } from "@bullmoose/auth-core/principal";
import { SUPERVISORY_GRANT_SCOPES } from "../../../provision/src/index";
import { describeBindingConfig, describeBindingEconomics } from "../console";
import { registerAgentBindingMethods } from "./agentBinding";
import type { RequestContext } from "./common";

/**
 * s26 T2 — the session-reachable kill switch (`AgentBinding/set`), and the two
 * holes this round closes: `AgentBinding/get` (nothing enumerated an account's
 * bindings, so `extractor` was a convention standing in for an API in two
 * shipped surfaces) and `/set`'s economics half (budget + model menu had no
 * session door at all, only the INTERNAL_TOKEN provisioning plane).
 *
 * The authz design under test, in one sentence each:
 *
 *   SCOPE     writes are gated on `send` — the capability wall's own scope
 *             (actionProposal.ts tier-3) — which a plain `mail` token covers
 *             and a supervisory grant (read+annotate+draft) does not, for the
 *             MONEY and the MENU exactly as for the switch. The grant half
 *             runs against the REAL resolution path (minted token →
 *             verifyBearer → token ∩ grant), with the grant scopes imported
 *             from provision so a widening there fails HERE, loudly. Reads are
 *             gated on `read`, the scope every sibling /get uses.
 *   MARKER    no agent hand on the switch, the money, or even the roster —
 *             whatever scopes the token holds.
 *   OWNERSHIP a binding on another account answers exactly like one that
 *             never existed; an unreachable account is accountNotFound.
 *   AUDIT     a real change writes one `binding_lifecycle` row PER moved
 *             property, old→new in the read projection's own vocabulary,
 *             atomically with the write; a no-op writes neither.
 *   SECRETS   nothing credential-shaped can leave through /get — asserted
 *             against the whole serialized response, not field by field.
 *   PRESERVE  a targeted write keeps every unmentioned config key: budget →
 *             menu intact, menu → budget intact, and BYOK credRefs survive a
 *             menu rewrite that cannot even name them.
 */

const TENANT = "t_bm";
const ERIC = "a_eric"; //     the human, owns his own account + one agent account
const OWNED_AGENT = "a_allen"; // agent account Eric's principal OWNS
const SUPERVISED = "a_emily"; // agent account reached ONLY via the supervisory grant
const STRANGER = "a_stranger"; // same tenant, no path at all

interface GetResult {
  accountId: string;
  principal: string | null;
  list: Array<Record<string, unknown>>;
  notFound: string[];
}

interface SetResult {
  accountId: string;
  /** Server-confirmed values for the properties the patch NAMED — `enabled`
   *  alone in v1, and now whichever of the economics knobs was written. */
  updated: Record<string, Record<string, unknown>>;
  notUpdated: Record<string, { type: string; description?: string; properties?: string[] }>;
}

function seedBinding(
  w: FakeWorker,
  account: string,
  id: string,
  name: string,
  enabled: 0 | 1,
  config?: Record<string, unknown> | string,
): void {
  w.db.seed("agent_bindings", [
    {
      id,
      account_id: account,
      name,
      enabled,
      ...(config === undefined ? {} : { config_json: typeof config === "string" ? config : JSON.stringify(config) }),
    },
  ]);
}

function configOf(w: FakeWorker, account: string, binding: string): Record<string, unknown> {
  const raw = w.db.query<{ config_json: string }>(
    `SELECT config_json FROM agent_bindings WHERE account_id = ? AND id = ?`,
    account,
    binding,
  )[0]!.config_json;
  return JSON.parse(raw) as Record<string, unknown>;
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
function harness(
  opts: {
    scopes?: string[];
    agent?: { binding?: string; invocation?: string };
    /** config_json for `bind_extractor` — the economics fixtures set one. */
    config?: Record<string, unknown> | string;
  } = {},
) {
  const w = fakeEnv();
  w.db.seedAccount({
    accountId: ERIC,
    tenantId: TENANT,
    principalId: "p_eric",
    loginEmail: "eric@bullmoose.cc",
    displayName: "Eric",
  });
  seedBinding(w, ERIC, "bind_extractor", "extractor", 1, opts.config);
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
  const get = (args: Record<string, unknown> = {}, account: string = ERIC) =>
    registry.get("AgentBinding/get")!({ accountId: account, ...args }, ctx) as unknown as Promise<GetResult>;
  return { w, set, get };
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
  const patch = async (account: string, bindingId: string, props: Record<string, unknown>): Promise<SetResult> => {
    const principal = await verifyBearer(w.env.DB, minted.token);
    if (!principal) throw new Error("token failed to resolve — fixture bug");
    return invoke<SetResult>({ accountId: account, update: { [bindingId]: props } }, { env: w.env, principal });
  };
  const call = (account: string, bindingId: string, enabled: boolean) => patch(account, bindingId, { enabled });
  const read = async (account: string): Promise<GetResult> => {
    const principal = await verifyBearer(w.env.DB, minted.token);
    if (!principal) throw new Error("token failed to resolve — fixture bug");
    return registry.get("AgentBinding/get")!(
      { accountId: account },
      { env: w.env, principal },
    ) as unknown as Promise<GetResult>;
  };
  return { w, call, patch, read };
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

// ═══════════════════════════════════════════════════════════════════════════
// HOLE 1 — `AgentBinding/get`: the roster read that retires the `extractor`
// convention. `webmail/src/lib/verbs/contract.ts` and
// `packages/cli/src/agentDossier.ts` both hardcode that name because nothing
// listed bindings; these are the calls that let them stop.
// ═══════════════════════════════════════════════════════════════════════════

/** A config with one of EVERY secret-adjacent shape the codebase can put in a
 *  binding: persona prose, an allowlist of third parties' addresses, the s26 T4
 *  BYOK binding→credential map, a per-route credRef, and a stray key that looks
 *  like a raw secret. None of it may reach the wire. */
const LOADED_CONFIG = {
  pipeline: "extract",
  persona: "SECRET-PERSONA: you are Eric's extractor and you know his calendar",
  replyMode: "draft",
  allowedSenders: ["sergio@partner.example", "board@investor.example"],
  providerCredentials: { openrouter: "SECRET-CREDREF-BINDING" },
  modelAliases: {
    extract: [
      { provider: "openrouter", model: "minimax/minimax-m3", credRef: "SECRET-CREDREF-ROUTE" },
      { provider: "workers-ai", model: "@cf/meta/llama-3.1-8b-instruct" },
    ],
  },
  defaultModel: "extract",
  frontier: { exploreRate: 0.2 },
  budgets: { spendPerMonth: 2_000_000 },
  maxTokens: 1024,
  apiKey: "SECRET-INLINE-KEY",
  createdAt: 1_700_000_000_000,
  historyFloor: 1_690_000_000_000,
};

describe("AgentBinding/get — the roster, in the dossier's own words", () => {
  it("lists every binding on the account by name, in the console projection's shape", async () => {
    const h = harness({ config: LOADED_CONFIG });
    const res = await h.get();

    expect(res.accountId).toBe(ERIC);
    // `principal` is the account's ADDRESS under the dossier's own name for it
    // (`GET /console/agents/{id}` returns the owner's login_email as
    // `principal`, and the CLI's `ctx.account.address` falls back to exactly
    // that) — so a client that calls only this method still knows which
    // mailbox these agents sit on.
    expect(res.principal).toBe("eric@bullmoose.cc");
    expect(res.notFound).toEqual([]);
    expect(res.list.map((b) => b.name)).toEqual(["extractor", "off"]);

    const extractor = res.list[0]!;
    expect(extractor.id).toBe("bind_extractor");
    expect(extractor.enabled).toBe(true);
    expect(extractor.triggerOn).toBe("mailbox-delivery");
    expect(extractor.slaSeconds).toBeNull();
    // THE POINT: id, name, address, pipeline, enabled, model menu, budget —
    // everything the CLI's `show` and webmail's dossier panel already render.
    expect((extractor.config as Record<string, unknown>).pipeline).toBe("extract");
    expect(extractor.economics).toEqual({
      budgetMicros: 2_000_000,
      defaultModel: "extract",
      modelMenu: [
        {
          alias: "extract",
          candidates: ["openrouter/minimax/minimax-m3", "workers-ai/@cf/meta/llama-3.1-8b-instruct"],
        },
      ],
      exploreRate: 0.2,
    });
  });

  it("is the console's OWN projection, not a parallel one — driven side by side", async () => {
    // The mirror held honest by a test rather than by discipline: if
    // `describeBindingConfig`/`describeBindingEconomics` ever change shape,
    // this method changes with them because it CALLS them.
    const h = harness({ config: LOADED_CONFIG });
    const raw = JSON.stringify(LOADED_CONFIG);
    const [extractor] = (await h.get()).list;
    expect(extractor!.config).toEqual(describeBindingConfig(raw));
    expect(extractor!.economics).toEqual(describeBindingEconomics(raw));
  });

  it("selects by ids, and a cross-account id is indistinguishable from one that never existed", async () => {
    const h = harness({ config: LOADED_CONFIG });
    h.w.db.seedAccount({ accountId: STRANGER, tenantId: TENANT, principalId: "p_stranger" });
    seedBinding(h.w, STRANGER, "bind_theirs", "theirs", 1, { budgets: { spendPerMonth: 9_000_000 } });

    const res = await h.get({ ids: ["bind_extractor", "bind_theirs", "bind_never_existed"] });
    expect(res.list.map((b) => b.id)).toEqual(["bind_extractor"]);
    // Same bucket, same membership: the stranger's binding is as absent as the
    // one that was never provisioned.
    expect([...res.notFound].sort()).toEqual(["bind_never_existed", "bind_theirs"]);
    // And nothing about it leaked into the payload.
    expect(JSON.stringify(res)).not.toContain("9000000");
  });

  it("an empty ids array asks for nothing and gets nothing", async () => {
    const h = harness();
    const res = await h.get({ ids: [] });
    expect(res.list).toEqual([]);
    expect(res.notFound).toEqual([]);
  });

  it("an accountId the principal cannot reach is accountNotFound", async () => {
    const h = harness();
    await expect(h.get({}, STRANGER)).rejects.toMatchObject({ type: "accountNotFound" });
  });
});

describe("AgentBinding/get — nothing credential-shaped leaves", () => {
  it("returns NO persona, allowlist, BYOK map, credRef or inline secret — asserted on the whole payload", async () => {
    const h = harness({ config: LOADED_CONFIG });
    const wire = JSON.stringify(await h.get());

    // Every marker planted in LOADED_CONFIG, checked against the serialized
    // response rather than field by field: a future field that forwarded the
    // raw config would fail here even if nobody thought to assert on it.
    for (const secret of [
      "SECRET-PERSONA",
      "SECRET-CREDREF-BINDING",
      "SECRET-CREDREF-ROUTE",
      "SECRET-INLINE-KEY",
      "sergio@partner.example",
      "board@investor.example",
      "credRef",
      "providerCredentials",
      "persona",
      "allowedSenders",
    ]) {
      expect(wire).not.toContain(secret);
    }
    // What DOES survive is the derived summary — the fact of a persona and the
    // SIZE of an allowlist, which is what the console has always served.
    const [extractor] = (await h.get()).list;
    expect(extractor!.config).toMatchObject({ hasPersona: true, senderAllowlist: { active: true, count: 2 } });
    // The menu renders as provider/model LABELS — and a label has nowhere to
    // put a credential handle.
    expect(JSON.stringify(extractor!.economics)).toContain("openrouter/minimax/minimax-m3");
  });
});

describe("AgentBinding/get — the read gate", () => {
  it("needs `read`: a token holding no mail scope at all is refused", async () => {
    const h = harness({ scopes: [] });
    await expect(h.get()).rejects.toMatchObject({ type: "forbidden" });
  });

  it("a supervisory-shaped token CAN read — supervision needs to see why an agent went quiet", async () => {
    // read+annotate+draft: enough to read the roster, never enough to write it.
    const h = harness({ scopes: [...SUPERVISORY_GRANT_SCOPES], config: LOADED_CONFIG });
    const res = await h.get();
    expect(res.list.map((b) => b.id)).toEqual(["bind_extractor", "bind_off"]);
    await expect(h.set({ update: { bind_extractor: { budgetMicros: 5_000_000 } } })).rejects.toMatchObject({
      type: "forbidden",
    });
  });

  it("refuses an agent-MARKED token and agent PROVENANCE — `015` Rule 4 holds", async () => {
    // The marker only narrows, so a marked token can hold every mail scope.
    const marked = harness({ scopes: ["mail", "agent"], config: LOADED_CONFIG });
    await expect(marked.get()).rejects.toMatchObject({ type: "forbidden" });
    const viaAgent = harness({ agent: { binding: "extractor", invocation: "inv_1" }, config: LOADED_CONFIG });
    await expect(viaAgent.get()).rejects.toMatchObject({ type: "forbidden" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// HOLE 2 — the economics half of `/set`: budget and model menu get a session
// door, with the same discipline `enabled` established.
// ═══════════════════════════════════════════════════════════════════════════

describe("AgentBinding/set — budget", () => {
  it("writes $.budgets.spendPerMonth and audits old→new", async () => {
    const h = harness({ config: LOADED_CONFIG });
    const res = await h.set({ update: { bind_extractor: { budgetMicros: 5_000_000 } } });

    expect(res.updated.bind_extractor).toEqual({ budgetMicros: 5_000_000 });
    expect(configOf(h.w, ERIC, "bind_extractor").budgets).toEqual({ spendPerMonth: 5_000_000 });

    const rows = lifecycleRows(h.w, ERIC, "bind_extractor");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event: "budget-changed",
      old_value: "2000000",
      new_value: "5000000",
      actor: "eric@bullmoose.cc",
      via_proposal_id: null,
    });
  });

  it("0 is the hard floor and is accepted; the same value again writes nothing", async () => {
    const h = harness({ config: LOADED_CONFIG });
    await h.set({ update: { bind_extractor: { budgetMicros: 0 } } });
    expect(configOf(h.w, ERIC, "bind_extractor").budgets).toEqual({ spendPerMonth: 0 });
    expect(lifecycleRows(h.w, ERIC, "bind_extractor")).toHaveLength(1);

    const again = await h.set({ update: { bind_extractor: { budgetMicros: 0 } } });
    expect(again.updated.bind_extractor).toEqual({ budgetMicros: 0 });
    // A chain that records non-events is a chain nobody can read.
    expect(lifecycleRows(h.w, ERIC, "bind_extractor")).toHaveLength(1);
  });

  it("refuses a negative, a fraction, a string and a null — and there is no door to UNCAP", async () => {
    const h = harness({ config: LOADED_CONFIG });
    for (const bad of [-1, 1.5, "2000000", null, Number.NaN]) {
      const res = await h.set({ update: { bind_extractor: { budgetMicros: bad } } });
      expect(res.notUpdated.bind_extractor).toMatchObject({
        type: "invalidProperties",
        properties: ["budgetMicros"],
      });
    }
    expect(configOf(h.w, ERIC, "bind_extractor").budgets).toEqual({ spendPerMonth: 2_000_000 });
    const res = await h.set({ update: { bind_extractor: { budgetMicros: null } } });
    expect(res.notUpdated.bind_extractor!.description).toContain("never ships uncapped");
  });
});

describe("AgentBinding/set — the model menu", () => {
  const NEW_MENU = [
    { alias: "extract", candidates: ["openrouter/qwen/qwen3-max", "workers-ai/@cf/meta/llama-3.1-8b-instruct"] },
  ];

  it("replaces $.modelAliases and audits the menu in the read's own vocabulary", async () => {
    const h = harness({ config: LOADED_CONFIG });
    const res = await h.set({ update: { bind_extractor: { modelMenu: NEW_MENU } } });

    expect(res.updated.bind_extractor).toEqual({ modelMenu: NEW_MENU });
    expect(configOf(h.w, ERIC, "bind_extractor").modelAliases).toMatchObject({
      extract: [
        { provider: "openrouter", model: "qwen/qwen3-max" },
        { provider: "workers-ai", model: "@cf/meta/llama-3.1-8b-instruct" },
      ],
    });

    const rows = lifecycleRows(h.w, ERIC, "bind_extractor");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.event).toBe("model-menu-changed");
    // old→new are exactly what /get said before and would say after.
    expect(JSON.parse(rows[0]!.new_value)).toEqual(NEW_MENU);
    expect(JSON.parse(rows[0]!.old_value)[0].candidates[0]).toBe("openrouter/minimax/minimax-m3");
  });

  it("candidates[0] is the primary and the rest are the explore arms — the order round-trips", async () => {
    // `chooseArm` rotates one of positions 1+ to the front with P(exploreRate);
    // position 0 is the exploit arm. So "primary alias + explore arms" IS this
    // array, and the order it is stored in must be the order it comes back in.
    const h = harness({ config: LOADED_CONFIG });
    await h.set({ update: { bind_extractor: { modelMenu: NEW_MENU } } });
    const [extractor] = (await h.get()).list;
    expect((extractor!.economics as { modelMenu: unknown }).modelMenu).toEqual(NEW_MENU);
  });

  it("carries a BYOK credRef forward across a menu rewrite that cannot even name it", async () => {
    // The hazard: a label carries no credRef, so a human fixing their menu
    // through this door would otherwise move their tenant's traffic back onto
    // the platform's key — silently, and with a real bill attached.
    const h = harness({ config: LOADED_CONFIG });
    await h.set({
      update: {
        bind_extractor: {
          modelMenu: [
            {
              alias: "extract",
              // Same route, reordered, plus one that never had a key.
              candidates: ["workers-ai/@cf/meta/llama-3.1-8b-instruct", "openrouter/minimax/minimax-m3"],
            },
          ],
        },
      },
    });
    expect(configOf(h.w, ERIC, "bind_extractor").modelAliases).toEqual({
      extract: [
        { provider: "workers-ai", model: "@cf/meta/llama-3.1-8b-instruct" },
        { provider: "openrouter", model: "minimax/minimax-m3", credRef: "SECRET-CREDREF-ROUTE" },
      ],
    });
    // ...and it still never appears on the wire, in either direction.
    expect(JSON.stringify(await h.get())).not.toContain("SECRET-CREDREF-ROUTE");
  });

  it("refuses an unknown provider BY NAME, and lists the hosts that exist", async () => {
    const h = harness({ config: LOADED_CONFIG });
    const res = await h.set({
      update: { bind_extractor: { modelMenu: [{ alias: "extract", candidates: ["anthropic/claude-4"] }] } },
    });
    const err = res.notUpdated.bind_extractor!;
    expect(err).toMatchObject({ type: "invalidProperties", properties: ["modelMenu"] });
    expect(err.description).toContain('no provider named "anthropic"');
    expect(err.description).toContain("workers-ai | gateway | openrouter | mock");
    expect(configOf(h.w, ERIC, "bind_extractor").modelAliases).toEqual(LOADED_CONFIG.modelAliases);
  });

  it("refuses an empty menu, an empty chain, a duplicate alias and a non-label candidate", async () => {
    const h = harness({ config: LOADED_CONFIG });
    const cases: unknown[] = [
      [],
      [{ alias: "extract", candidates: [] }],
      [
        { alias: "extract", candidates: ["mock/x"] },
        { alias: "extract", candidates: ["mock/y"] },
      ],
      [{ alias: "", candidates: ["mock/x"] }],
      [{ alias: "extract", candidates: [{ provider: "mock", model: "x" }] }],
      [{ alias: "extract", candidates: ["mock"] }],
      "not-an-array",
    ];
    for (const bad of cases) {
      const res = await h.set({ update: { bind_extractor: { modelMenu: bad } } });
      expect(res.notUpdated.bind_extractor).toMatchObject({
        type: "invalidProperties",
        properties: ["modelMenu"],
      });
    }
    expect(lifecycleRows(h.w, ERIC, "bind_extractor")).toHaveLength(0);
  });
});

describe("AgentBinding/set — the default alias, refused by name when unknown", () => {
  it("writes $.defaultModel when the alias is on the menu", async () => {
    const h = harness({
      config: {
        ...LOADED_CONFIG,
        modelAliases: { ...LOADED_CONFIG.modelAliases, cheap: [{ provider: "mock", model: "m" }] },
      },
    });
    const res = await h.set({ update: { bind_extractor: { defaultModel: "cheap" } } });
    expect(res.updated.bind_extractor).toEqual({ defaultModel: "cheap" });
    expect(configOf(h.w, ERIC, "bind_extractor").defaultModel).toBe("cheap");
    expect(lifecycleRows(h.w, ERIC, "bind_extractor")[0]).toMatchObject({
      event: "default-model-changed",
      old_value: "extract",
      new_value: "cheap",
    });
  });

  it("refuses an alias the menu does not have, naming it and the ones it does", async () => {
    const h = harness({ config: LOADED_CONFIG });
    const res = await h.set({ update: { bind_extractor: { defaultModel: "premium" } } });
    const err = res.notUpdated.bind_extractor!;
    expect(err).toMatchObject({ type: "invalidProperties", properties: ["defaultModel"] });
    expect(err.description).toContain('no alias named "premium"');
    expect(err.description).toContain('"extract"');
    expect(configOf(h.w, ERIC, "bind_extractor").defaultModel).toBe("extract");
  });

  it("refuses a menu write that would strand the alias the binding already resolves by", async () => {
    const h = harness({ config: LOADED_CONFIG });
    const res = await h.set({
      update: { bind_extractor: { modelMenu: [{ alias: "cheap", candidates: ["mock/m"] }] } },
    });
    expect(res.notUpdated.bind_extractor).toMatchObject({
      type: "invalidProperties",
      properties: ["modelMenu"],
    });
    expect(res.notUpdated.bind_extractor!.description).toContain("send defaultModel in the same patch");
    // ...and the same pair, sent TOGETHER, is accepted.
    const ok = await h.set({
      update: {
        bind_extractor: { modelMenu: [{ alias: "cheap", candidates: ["mock/m"] }], defaultModel: "cheap" },
      },
    });
    expect(ok.notUpdated).toEqual({});
    expect(configOf(h.w, ERIC, "bind_extractor").defaultModel).toBe("cheap");
  });
});

describe("AgentBinding/set — the explore rate", () => {
  it("writes $.frontier.exploreRate and audits it", async () => {
    const h = harness({ config: LOADED_CONFIG });
    const res = await h.set({ update: { bind_extractor: { exploreRate: 0.5 } } });
    expect(res.updated.bind_extractor).toEqual({ exploreRate: 0.5 });
    expect(configOf(h.w, ERIC, "bind_extractor").frontier).toEqual({ exploreRate: 0.5 });
    expect(lifecycleRows(h.w, ERIC, "bind_extractor")[0]).toMatchObject({
      event: "explore-rate-changed",
      old_value: "0.2",
      new_value: "0.5",
    });
  });

  it("0 turns exploration off; 1.5, -0.1 and null are refused", async () => {
    const h = harness({ config: LOADED_CONFIG });
    expect((await h.set({ update: { bind_extractor: { exploreRate: 0 } } })).notUpdated).toEqual({});
    expect(configOf(h.w, ERIC, "bind_extractor").frontier).toEqual({ exploreRate: 0 });
    for (const bad of [1.5, -0.1, null, "0.2"]) {
      const res = await h.set({ update: { bind_extractor: { exploreRate: bad } } });
      expect(res.notUpdated.bind_extractor).toMatchObject({
        type: "invalidProperties",
        properties: ["exploreRate"],
      });
    }
  });
});

// ── THE PRESERVE-UNMENTIONED-KEYS PROOF, both directions ──────────────────
//
// s26 T6 found that `POST /extractor` rewrites the WHOLE config, so a naive
// budget write there wipes the menu and vice-versa. This method must not
// reproduce that, and the proof has to run in BOTH directions.

describe("AgentBinding/set — a targeted write preserves every key it did not name", () => {
  it("budget → the model menu, the persona, the BYOK map and the history floor are all intact", async () => {
    const h = harness({ config: LOADED_CONFIG });
    await h.set({ update: { bind_extractor: { budgetMicros: 7_000_000 } } });
    expect(configOf(h.w, ERIC, "bind_extractor")).toEqual({
      ...LOADED_CONFIG,
      budgets: { spendPerMonth: 7_000_000 },
    });
  });

  it("model menu → the budget, the explore rate and everything else are intact", async () => {
    const h = harness({ config: LOADED_CONFIG });
    const menu = [{ alias: "extract", candidates: ["mock/m"] }];
    await h.set({ update: { bind_extractor: { modelMenu: menu } } });
    const cfg = configOf(h.w, ERIC, "bind_extractor");
    expect(cfg).toEqual({
      ...LOADED_CONFIG,
      modelAliases: { extract: [{ provider: "mock", model: "m" }] },
    });
    expect(cfg.budgets).toEqual({ spendPerMonth: 2_000_000 });
    expect(cfg.frontier).toEqual({ exploreRate: 0.2 });
  });

  it("only the ONE key inside budgets/frontier moves — their siblings survive too", async () => {
    const h = harness({
      config: {
        ...LOADED_CONFIG,
        budgets: { spendPerMonth: 2_000_000, spendPerDay: 100_000 },
        frontier: { exploreRate: 0.2, note: "s26 T5a" },
      },
    });
    await h.set({ update: { bind_extractor: { budgetMicros: 1, exploreRate: 0.9 } } });
    const cfg = configOf(h.w, ERIC, "bind_extractor");
    expect(cfg.budgets).toEqual({ spendPerMonth: 1, spendPerDay: 100_000 });
    expect(cfg.frontier).toEqual({ exploreRate: 0.9, note: "s26 T5a" });
  });

  it("an enabled-only flip does not touch config_json at all — not even to reformat it", async () => {
    const spaced = '{\n  "pipeline": "extract",\n  "budgets": { "spendPerMonth": 2000000 }\n}';
    const h = harness({ config: spaced });
    await h.set({ update: { bind_extractor: { enabled: false } } });
    const raw = h.w.db.query<{ config_json: string }>(
      `SELECT config_json FROM agent_bindings WHERE account_id = ? AND id = ?`,
      ERIC,
      "bind_extractor",
    )[0]!.config_json;
    expect(raw).toBe(spaced);
  });

  it("refuses a config write on an UNPARSEABLE blob rather than clobbering it — but `enabled` still works", async () => {
    const h = harness({ config: "{not json at all" });
    const res = await h.set({ update: { bind_extractor: { budgetMicros: 1 } } });
    expect(res.notUpdated.bind_extractor).toMatchObject({ type: "serverFail" });
    expect(res.notUpdated.bind_extractor!.description).toContain("cannot preserve the");
    expect(
      h.w.db.query<{ config_json: string }>(`SELECT config_json FROM agent_bindings WHERE id = ?`, "bind_extractor")[0]!
        .config_json,
    ).toBe("{not json at all");
    // The kill switch is a COLUMN and must never be hostage to a bad blob.
    const off = await h.set({ update: { bind_extractor: { enabled: false } } });
    expect(off.updated.bind_extractor).toEqual({ enabled: false });
  });
});

describe("AgentBinding/set — several properties in one patch", () => {
  it("flips the switch and moves the money in ONE batch, with one chain row each", async () => {
    const h = harness({ config: LOADED_CONFIG });
    const res = await h.set({
      update: { bind_extractor: { enabled: false, budgetMicros: 0, exploreRate: 0 } },
    });
    expect(res.updated.bind_extractor).toEqual({ enabled: false, budgetMicros: 0, exploreRate: 0 });
    expect(enabledOf(h.w, ERIC, "bind_extractor")).toBe(0);

    const rows = lifecycleRows(h.w, ERIC, "bind_extractor");
    expect(rows.map((r) => r.event).sort()).toEqual(["budget-changed", "enabled-changed", "explore-rate-changed"]);
  });

  it("a patch naming no writable property is refused, not silently accepted", async () => {
    const h = harness();
    const res = await h.set({ update: { bind_extractor: {} } });
    expect(res.notUpdated.bind_extractor).toMatchObject({ type: "invalidProperties" });
  });

  it("`budgets` and `modelAliases` — the config_json spellings — now point HERE", async () => {
    const h = harness({ config: LOADED_CONFIG });
    const res = await h.set({
      update: { bind_extractor: { budgets: { spendPerMonth: 1 }, modelAliases: {} } },
    });
    const err = res.notUpdated.bind_extractor!;
    expect(err.properties).toEqual(["budgets", "modelAliases"]);
    expect(err.description).toContain("`budgetMicros`");
    expect(err.description).toContain("`modelMenu`");
    expect(configOf(h.w, ERIC, "bind_extractor").budgets).toEqual({ spendPerMonth: 2_000_000 });
  });
});

describe("AgentBinding/set — CAS on the FULL pre-image, not just `enabled`", () => {
  it("a config written under the call answers stateMismatch and leaves no chain row", async () => {
    const h = harness({ config: LOADED_CONFIG });
    // Simulate the race precisely: something else writes config_json between
    // this call's SELECT and its batch.
    const db = h.w.env.DB as unknown as { batch: (s: unknown[]) => Promise<unknown[]> };
    const real = db.batch.bind(db);
    db.batch = (statements: unknown[]) => {
      h.w.db.sqlite
        .prepare(`UPDATE agent_bindings SET config_json = ? WHERE id = ?`)
        .run(JSON.stringify({ ...LOADED_CONFIG, budgets: { spendPerMonth: 42 } }), "bind_extractor");
      db.batch = real;
      return real(statements);
    };

    const res = await h.set({ update: { bind_extractor: { budgetMicros: 5_000_000 } } });
    expect(res.notUpdated.bind_extractor).toMatchObject({ type: "stateMismatch" });
    // The OTHER writer's value stands, and no chain row claims a change that
    // never happened.
    expect(configOf(h.w, ERIC, "bind_extractor").budgets).toEqual({ spendPerMonth: 42 });
    expect(lifecycleRows(h.w, ERIC, "bind_extractor")).toHaveLength(0);
  });
});

describe("AgentBinding/set — the economics knobs sit behind the SAME walls as the switch", () => {
  const WRITES: Array<Record<string, unknown>> = [
    { budgetMicros: 9_000_000 },
    { modelMenu: [{ alias: "extract", candidates: ["mock/m"] }] },
    { exploreRate: 1 },
    { defaultModel: "extract" },
  ];

  it("a supervisory-scoped TOKEN cannot move the money or the menu", async () => {
    const h = harness({ scopes: [...SUPERVISORY_GRANT_SCOPES], config: LOADED_CONFIG });
    for (const patch of WRITES) {
      await expect(h.set({ update: { bind_extractor: patch } })).rejects.toMatchObject({ type: "forbidden" });
    }
    expect(configOf(h.w, ERIC, "bind_extractor")).toEqual(LOADED_CONFIG);
  });

  it("an agent-MARKED token cannot either, however wide its scopes", async () => {
    const h = harness({ scopes: ["mail", "agent"], config: LOADED_CONFIG });
    for (const patch of WRITES) {
      await expect(h.set({ update: { bind_extractor: patch } })).rejects.toMatchObject({ type: "forbidden" });
    }
    expect(configOf(h.w, ERIC, "bind_extractor")).toEqual(LOADED_CONFIG);
  });

  it("a binding on ANOTHER account is notFound for a budget write too — nothing written there", async () => {
    const h = harness({ config: LOADED_CONFIG });
    h.w.db.seedAccount({ accountId: STRANGER, tenantId: TENANT, principalId: "p_stranger" });
    seedBinding(h.w, STRANGER, "bind_theirs", "theirs", 1, { budgets: { spendPerMonth: 9_000_000 } });
    const res = await h.set({ update: { bind_theirs: { budgetMicros: 0 } } });
    expect(res.notUpdated.bind_theirs).toMatchObject({ type: "notFound" });
    expect(configOf(h.w, STRANGER, "bind_theirs").budgets).toEqual({ spendPerMonth: 9_000_000 });
  });
});

describe("AgentBinding — the round trip a surface actually makes", () => {
  it("GET the roster, edit ONE field, SET it back, GET it again — no translation layer anywhere", async () => {
    const h = harness({ config: LOADED_CONFIG });
    // 1. The call `webmail/src/lib/verbs/contract.ts` should make instead of
    //    assuming a binding is named `extractor`.
    const roster = await h.get();
    const target = roster.list.find((b) => b.name === "extractor")!;
    const economics = target.economics as { budgetMicros: number; modelMenu: unknown[] };

    // 2. The call `packages/cli` should make instead of `admin init` +
    //    POST /extractor.
    await h.set({ update: { [target.id as string]: { budgetMicros: economics.budgetMicros * 2 } } });

    // 3. The read confirms it, in the same words it was written in.
    const after = (await h.get({ ids: [target.id] })).list[0]!;
    expect(after.economics).toEqual({ ...economics, budgetMicros: 4_000_000 });
  });
});

describe("AgentBinding — the supervisory grant against real resolution, for the ECONOMICS too", () => {
  it("token ∩ supervisory grant lacks send: budget, menu, rate and default are all refused, nothing written", async () => {
    expect([...SUPERVISORY_GRANT_SCOPES]).not.toContain("send"); // the premise, pinned
    const h = await grantHarness();
    for (const props of [
      { budgetMicros: 9_000_000 },
      { modelMenu: [{ alias: "extract", candidates: ["mock/m"] }] },
      { exploreRate: 1 },
      { defaultModel: "extract" },
    ]) {
      await expect(h.patch(SUPERVISED, "bind_supervisor", props)).rejects.toMatchObject({ type: "forbidden" });
    }
    expect(h.w.db.query(`SELECT * FROM binding_lifecycle`)).toHaveLength(0);
    expect(h.w.db.query(`SELECT * FROM grant_audit`)).toHaveLength(0);
  });

  it("but it CAN read that account's roster — supervision sees state, it does not hold custody", async () => {
    const h = await grantHarness();
    const res = await h.read(SUPERVISED);
    expect(res.list.map((b) => b.name)).toEqual(["supervisor"]);
    // The read went through a grant, so it is audited — which the console's
    // owner-only door never had to record.
    const audit = h.w.db.query<{ grant_id: string; method: string }>(`SELECT grant_id, method FROM grant_audit`);
    expect(audit).toEqual([{ grant_id: "g_sup", method: "mail:read" }]);
  });
});
