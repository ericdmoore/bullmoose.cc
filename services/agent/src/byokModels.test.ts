import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeEnv } from "@bullmoose/test-fakes";
import bureauWorker from "../../bureau/src/index";
import type { Env as BureauEnv } from "../../bureau/src/models";
import {
  callModel,
  callWithFallback,
  credentialFor,
  invocationCost,
  modelCallContext,
  type BindingConfig,
  type Env,
  type ModelCandidate,
  type ModelCallContext,
} from "./models";

/**
 * s26 T4 — **BYOK from the model router's side**, across the real Bureau.
 *
 * The BUREAU binding here is the actual Bureau worker over the same D1, never a
 * stub, for the reason `services/agent/src/vault.test.ts` gives about the same
 * seam: the claim is that a boundary exists, and a faked boundary proves
 * nothing about it. So every test below runs the whole path — resolution order,
 * the hop, the grant, the destination binding, the unseal, the injection — and
 * the only fake is the provider.
 *
 * Two properties are worth more than the rest, and both are asserted as
 * ABSENCES on the wire:
 *
 *   1. a call that names a tenant credential never spends the platform key,
 *      whatever goes wrong;
 *   2. the key is never in this worker: not in a variable, not in an error
 *      string, not in the text a pipeline stamps onto `result_json`.
 */

const MASTER = "test-vault-master-key-0123456789abcdef";
const TENANT_KEY = "sk-or-TENANT-canary-7f21ab";
const PLATFORM_KEY = "sk-or-PLATFORM-canary-000";
const ACCOUNT = "a_ann";
const PRINCIPAL = "p_ann";
const EMAIL = "ann@bullmoose.cc";
const BINDING = "b_extractor";

const OR_MODEL: ModelCandidate = { provider: "openrouter", model: "minimax/minimax-m3" };
const FREE: ModelCandidate = { provider: "workers-ai", model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" };
const messages = [{ role: "user" as const, content: "hi" }];

afterEach(() => vi.unstubAllGlobals());

interface Seen {
  url: string;
  auth: string | null;
}

function upstream(handler: () => Response = () => completion()): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    seen.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
    return handler();
  });
  return seen;
}

const completion = () =>
  Response.json({
    choices: [{ message: { content: "extracted []" } }],
    usage: { prompt_tokens: 40, completion_tokens: 3 },
  });

interface World {
  env: Env;
  ctx: ModelCallContext;
}

/**
 * An account whose extractor binding names a sealed OpenRouter credential, with
 * the platform's own key ALSO configured — because "does the platform key get
 * spent?" is only a real question when there is one to spend.
 */
async function world(
  opts: {
    config?: Record<string, unknown>;
    grant?: boolean;
    enabled?: number;
    platformKey?: string | undefined;
    allow?: string;
  } = {},
): Promise<World> {
  const w = fakeEnv();
  w.db.seedAccount({ accountId: ACCOUNT, principalId: PRINCIPAL, loginEmail: EMAIL });
  const config = opts.config ?? {
    pipeline: "extract",
    modelAliases: { extract: [OR_MODEL] },
    providerCredentials: { openrouter: "openrouter" },
  };
  w.db.seed("agent_bindings", [
    {
      id: BINDING,
      account_id: ACCOUNT,
      name: "extractor",
      trigger_on: "mailbox-delivery",
      sla_seconds: null,
      enabled: opts.enabled ?? 1,
      config_json: JSON.stringify(config),
      recipients_book_id: null,
    },
  ]);
  if (opts.grant !== false) {
    w.db.seed("bureau_grants", [
      {
        id: "bg_ann",
        principal_id: PRINCIPAL,
        cred_name: "openrouter",
        verb: "fetch",
        created_by: "admin",
        created_at: 1,
        expires_at: null,
        revoked_at: null,
      },
    ]);
  }

  const bureauEnv: BureauEnv = {
    DB: w.env.DB,
    VAULT_MASTER_KEY: MASTER,
    INTERNAL_TOKEN: w.env.INTERNAL_TOKEN,
  };
  const sealed = await bureauWorker.fetch(
    new Request("https://bureau.internal/internal/bureau/seal", {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": w.env.INTERNAL_TOKEN },
      body: JSON.stringify({
        mode: "mint",
        principalId: PRINCIPAL,
        name: "openrouter",
        kind: "api-key",
        metaJson: JSON.stringify({
          allow: opts.allow ?? "https://openrouter.ai",
          header: "Authorization: Bearer {}",
          scope: "actor",
        }),
        secret: TENANT_KEY,
      }),
    }),
    bureauEnv,
  );
  expect(sealed.status, "seeding the credential").toBe(200);

  const BUREAU = {
    fetch: (input: RequestInfo | URL, init?: RequestInit) =>
      bureauWorker.fetch(new Request(input as RequestInfo, init), bureauEnv),
  } as unknown as Fetcher;

  const env: Env = { ...w.env, BUREAU };
  env.OPENROUTER_API_TOKEN = "platformKey" in opts ? opts.platformKey : PLATFORM_KEY;
  return {
    env,
    ctx: modelCallContext({ account_id: ACCOUNT, binding_id: BINDING }, config as BindingConfig),
  };
}

describe("credentialFor — the resolution order", () => {
  const ctx: ModelCallContext = {
    accountId: ACCOUNT,
    bindingId: BINDING,
    credentials: { openrouter: "tenant-default", gateway: "gw" },
  };

  it("1. the candidate's own credRef wins", () => {
    expect(credentialFor({ ...OR_MODEL, credRef: "this-route" }, ctx)).toBe("this-route");
  });

  it("2. else the binding's per-provider default", () => {
    expect(credentialFor(OR_MODEL, ctx)).toBe("tenant-default");
  });

  it("3. else nothing — which is what lets env be the fallback", () => {
    expect(credentialFor(OR_MODEL, { accountId: ACCOUNT, bindingId: BINDING })).toBeNull();
    expect(credentialFor(OR_MODEL)).toBeNull();
    // A host with no entry does not inherit another host's key.
    expect(credentialFor(FREE, ctx)).toBeNull();
  });
});

describe("the happy path — the tenant's key, and this worker never holds it", () => {
  it("calls OpenRouter with the TENANT's key, not the platform's", async () => {
    const seen = upstream();
    const w = await world();

    const { output, usage } = await callModel(w.env, OR_MODEL, messages, 64, w.ctx);

    expect(output).toBe("extracted []");
    expect(usage).toEqual({ tokensIn: 40, tokensOut: 3 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(seen[0]!.auth).toBe(`Bearer ${TENANT_KEY}`);
    expect(seen[0]!.auth).not.toBe(`Bearer ${PLATFORM_KEY}`);
  });

  it("honours a per-candidate credRef the same way", async () => {
    const seen = upstream();
    const w = await world({
      config: { modelAliases: { extract: [{ ...OR_MODEL, credRef: "openrouter" }] } },
    });
    // No binding-wide default here: the candidate is the only thing naming it.
    const { output } = await callModel(w.env, { ...OR_MODEL, credRef: "openrouter" }, messages, 64, w.ctx);
    expect(output).toBe("extracted []");
    expect(seen[0]!.auth).toBe(`Bearer ${TENANT_KEY}`);
  });

  it("records cost exactly as a platform-keyed run does (s07 T5 is untouched)", async () => {
    upstream();
    const w = await world();
    await w.env.ROUTES.put(
      "cache:modelsdev:slim",
      JSON.stringify({
        fetchedAt: Date.now(),
        prices: { [OR_MODEL.model]: 3 },
        legs: { [OR_MODEL.model]: { input: 1, output: 2 } },
      }),
    );

    const { usage } = await callModel(w.env, OR_MODEL, messages, 64, w.ctx);
    const cost = await invocationCost(w.env, OR_MODEL, usage);

    // 40×1 + 3×2 = 46 µUSD. Money, not "unknown": BYOK moves who is billed at
    // the provider, never whether the invocation booked a number.
    expect(cost).toEqual({
      provider: "openrouter",
      model: OR_MODEL.model,
      tokensIn: 40,
      tokensOut: 3,
      costMicros: 46,
    });
  });

  it("still records NULL — not 0 — when the provider reports no usage", async () => {
    upstream(() => Response.json({ choices: [{ message: { content: "x" } }] }));
    const w = await world();
    const { usage } = await callModel(w.env, OR_MODEL, messages, 64, w.ctx);
    expect(usage).toBeUndefined();
    expect((await invocationCost(w.env, OR_MODEL, usage)).costMicros).toBeNull();
  });
});

describe("NO SILENT FALLBACK — the guarantee that keeps one tenant's work off another's bill", () => {
  it("refuses when the grant is missing, and the platform key never reaches the wire", async () => {
    const seen = upstream();
    const w = await world({ grant: false });

    await expect(callModel(w.env, OR_MODEL, messages, 64, w.ctx)).rejects.toThrow(/bureau refused credential/);
    expect(seen, "nothing was sent — least of all with the platform key").toHaveLength(0);
  });

  it("refuses when the binding is disabled (the kill switch reaches spend)", async () => {
    const seen = upstream();
    const w = await world({ enabled: 0 });
    await expect(callModel(w.env, OR_MODEL, messages, 64, w.ctx)).rejects.toThrow(/disabled/);
    expect(seen).toHaveLength(0);
  });

  it("refuses when the binding's config no longer names the credential", async () => {
    const seen = upstream();
    // The binding stopped naming it, but the caller's context still carries the
    // stale map. The Bureau re-reads the row and refuses; nothing falls back.
    const w = await world({ config: { modelAliases: { extract: [OR_MODEL] } } });
    const ctx: ModelCallContext = { ...w.ctx, credentials: { openrouter: "openrouter" } };
    await expect(callModel(w.env, OR_MODEL, messages, 64, ctx)).rejects.toThrow(/does not name credential/);
    expect(seen).toHaveLength(0);
  });

  it("refuses when the credential exists but its allowlist forbids the provider", async () => {
    const seen = upstream();
    const w = await world({ allow: "https://api.stripe.com" });
    await expect(callModel(w.env, OR_MODEL, messages, 64, w.ctx)).rejects.toThrow(/not in the allowlist/);
    expect(seen).toHaveLength(0);
  });

  it("refuses when no binding context was threaded — a named credential is never optional", async () => {
    const seen = upstream();
    const w = await world();
    // The candidate names a credential; the call carries no ctx. The platform
    // key is right there in env, and is still not used.
    await expect(callModel(w.env, { ...OR_MODEL, credRef: "openrouter" }, messages, 64)).rejects.toThrow(
      /no binding context/,
    );
    expect(seen).toHaveLength(0);
  });

  it("refuses when the BUREAU binding is not wired at all", async () => {
    const seen = upstream();
    const w = await world();
    // `@bullmoose/test-fakes`' unwired Bureau throws on use — the shape a
    // deployment missing the binding has.
    const unwired = fakeEnv();
    const env: Env = { ...w.env, BUREAU: unwired.env.BUREAU };
    await expect(callModel(env, OR_MODEL, messages, 64, w.ctx)).rejects.toThrow(/bureau unreachable/);
    expect(seen).toHaveLength(0);
  });

  it("names the credential and the reason in the error, and NEVER the value", async () => {
    upstream();
    const w = await world({ grant: false });
    const err = await callModel(w.env, OR_MODEL, messages, 64, w.ctx).catch((e: unknown) => String(e));
    expect(err).toContain("openrouter");
    expect(err).toMatch(/no live grant/);
    // The text a pipeline stamps into result_json. It cannot carry a secret,
    // because this worker never had one.
    expect(err).not.toContain(TENANT_KEY);
    expect(err).not.toContain(PLATFORM_KEY);
    expect(err).not.toContain("canary");
  });
});

describe("the fallback chain — honest degradation, never a wedge", () => {
  it("falls through a failed BYOK route to the FREE route, and says why in the error trail", async () => {
    upstream();
    const w = await world({ grant: false });
    w.env.AI = {
      run: async () => ({ response: "free answer", usage: { prompt_tokens: 5, completion_tokens: 2 } }),
    } as unknown as Ai;

    const { output, used } = await callWithFallback(w.env, [OR_MODEL, FREE], messages, 64, w.ctx);

    // The menu's next line is a decision an operator wrote down — that is what
    // makes this degradation legitimate where an env fallback would not be.
    expect(output).toBe("free answer");
    expect(used).toEqual(FREE);
  });

  it("throws the collected reasons when every route fails — the invocation records why", async () => {
    upstream();
    const w = await world({ grant: false });
    await expect(callWithFallback(w.env, [OR_MODEL], messages, 64, w.ctx)).rejects.toThrow(
      /openrouter\/minimax\/minimax-m3: .*bureau refused/,
    );
  });
});

describe("candidates that cannot carry a key", () => {
  it("refuses a credRef on a workers-ai candidate rather than ignoring it", async () => {
    const w = await world();
    await expect(callModel(w.env, { ...FREE, credRef: "openrouter" }, messages, 64, w.ctx)).rejects.toThrow(
      /takes no key/,
    );
  });

  it("refuses a credRef on the mock provider", async () => {
    const w = await world();
    await expect(
      callModel(w.env, { provider: "mock", model: "m", credRef: "openrouter" }, messages, 64, w.ctx),
    ).rejects.toThrow(/takes no key/);
  });
});

describe("the platform key still works — BYOK is opt-in, not a migration", () => {
  it("uses env when nothing named a credential", async () => {
    const seen = upstream();
    const w = await world({ config: { modelAliases: { extract: [OR_MODEL] } } });
    const ctx = modelCallContext({ account_id: ACCOUNT, binding_id: BINDING }, {});

    const { output } = await callModel(w.env, OR_MODEL, messages, 64, ctx);

    expect(output).toBe("extracted []");
    expect(seen[0]!.auth).toBe(`Bearer ${PLATFORM_KEY}`);
  });

  it("still throws the old 'not configured' error when there is no key of either sort", async () => {
    const w = await world({ config: {}, platformKey: undefined });
    const ctx = modelCallContext({ account_id: ACCOUNT, binding_id: BINDING }, {});
    await expect(callModel(w.env, OR_MODEL, messages, 64, ctx)).rejects.toThrow(/OpenRouter not configured/);
  });
});

describe("the gateway host takes a tenant key by the same route", () => {
  it("proxies the gateway call through the Bureau when the binding names a credential", async () => {
    const seen = upstream();
    const w = await world({
      config: {
        modelAliases: { reply: [{ provider: "gateway", model: "anthropic/claude" }] },
        providerCredentials: { gateway: "openrouter" },
      },
    });
    w.env.GATEWAY_COMPAT_URL = "https://openrouter.ai/api/v1"; // allowlisted origin, so the seal fits
    w.env.GATEWAY_TOKEN = "platform-gateway-token";

    const { output } = await callModel(w.env, { provider: "gateway", model: "anthropic/claude" }, messages, 64, w.ctx);

    expect(output).toBe("extracted []");
    expect(seen[0]!.auth).toBe(`Bearer ${TENANT_KEY}`);
  });

  it("keeps the platform gateway token when nothing named a credential", async () => {
    const seen = upstream();
    const w = await world({ config: {} });
    w.env.GATEWAY_COMPAT_URL = "https://gateway.example/compat";
    w.env.GATEWAY_TOKEN = "platform-gateway-token";
    const ctx = modelCallContext({ account_id: ACCOUNT, binding_id: BINDING }, {});

    await callModel(w.env, { provider: "gateway", model: "anthropic/claude" }, messages, 64, ctx);

    expect(seen[0]!.auth).toBe("Bearer platform-gateway-token");
  });
});
