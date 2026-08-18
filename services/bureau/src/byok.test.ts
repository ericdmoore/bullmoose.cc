import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeD1, type FakeD1 } from "@bullmoose/test-fakes";
import { bindingNamesCredential } from "./byok";
import worker from "./index";
import type { Env } from "./models";

/**
 * s26 T4 — **BYOK through the binding-scoped door**, driven through the real
 * worker with a really-sealed credential and the live schema.
 *
 * This door trades `/bureau/use`'s bearer for three row-derived checks (see
 * `byok.ts`), so these tests are mostly about the trade: each check is driven
 * to its refusal, and the ones that matter most — *can binding A spend tenant
 * B's key?*, *does the platform's key get spent when a tenant's fails?* — are
 * driven adversarially rather than asserted in prose.
 *
 * The upstream is a stubbed global `fetch` that RECORDS what went on the wire,
 * because "the tenant's key authenticated the call, and the caller never saw
 * it" is a claim about the wire that a response-only test cannot check.
 */

const MASTER = "test-vault-master-key-0123456789abcdef";
const INTERNAL = "internal-test-token";
/** Distinctive on purpose: every leak assertion greps for this exact string. */
const TENANT_KEY = "sk-or-TENANT-canary-7f21ab";
const OTHER_KEY = "sk-or-OTHER-canary-5e90cd";

const OPENROUTER = "https://openrouter.ai/api/v1/chat/completions";
const CRED_META = { allow: "https://openrouter.ai", header: "Authorization: Bearer {}", scope: "actor" };

const A = { accountId: "a_ann", principalId: "p_ann", email: "ann@bullmoose.cc", bindingId: "b_ann" };
const B = { accountId: "a_bob", principalId: "p_bob", email: "bob@bullmoose.cc", bindingId: "b_bob" };

afterEach(() => vi.unstubAllGlobals());

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

/** The fake provider. Returns the live recording array. */
function upstream(handler: (seen: Seen) => Response = () => completion()): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    const record: Seen = {
      url: String(input),
      headers,
      body: typeof init?.body === "string" ? init.body : null,
    };
    seen.push(record);
    return handler(record);
  });
  return seen;
}

const completion = (content = "extracted []") =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 40, completion_tokens: 3 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const MENU = { extract: [{ provider: "openrouter", model: "minimax/minimax-m3" }] };

interface Harness {
  env: Env;
  db: FakeD1;
  /** POST /internal/bureau/binding-use, as `services/agent`'s model router. */
  use: (body: Record<string, unknown>, token?: string) => Promise<Response>;
  /** The chat-completions request `callModel` composes. */
  chat: Record<string, unknown>;
}

async function harness(
  opts: {
    /** Config for Ann's binding; defaults to naming the credential. */
    config?: Record<string, unknown>;
    enabled?: number;
    /** Skip Ann's grant, to drive the mint≠authorize refusal. */
    noGrant?: boolean;
    revoked?: boolean;
    meta?: Record<string, unknown>;
  } = {},
): Promise<Harness> {
  const db = fakeD1();
  for (const who of [A, B]) {
    db.seedAccount({ accountId: who.accountId, principalId: who.principalId, loginEmail: who.email });
  }
  db.seed("agent_bindings", [
    {
      id: A.bindingId,
      account_id: A.accountId,
      name: "extractor",
      trigger_on: "mailbox-delivery",
      sla_seconds: null,
      enabled: opts.enabled ?? 1,
      config_json: JSON.stringify(
        opts.config ?? { pipeline: "extract", modelAliases: MENU, providerCredentials: { openrouter: "openrouter" } },
      ),
      recipients_book_id: null,
    },
    {
      id: B.bindingId,
      account_id: B.accountId,
      name: "extractor",
      trigger_on: "mailbox-delivery",
      sla_seconds: null,
      enabled: 1,
      config_json: JSON.stringify({
        pipeline: "extract",
        modelAliases: MENU,
        providerCredentials: { openrouter: "openrouter" },
      }),
      recipients_book_id: null,
    },
  ]);
  db.seed("bureau_grants", [
    ...(opts.noGrant
      ? []
      : [
          {
            id: "bg_ann",
            principal_id: A.principalId,
            cred_name: "openrouter",
            verb: "fetch",
            created_by: "admin",
            created_at: 1,
            expires_at: null,
            revoked_at: opts.revoked ? 2 : null,
          },
        ]),
    {
      id: "bg_bob",
      principal_id: B.principalId,
      cred_name: "openrouter",
      verb: "fetch",
      created_by: "admin",
      created_at: 1,
      expires_at: null,
      revoked_at: null,
    },
  ]);

  const env: Env = { DB: db, VAULT_MASTER_KEY: MASTER, INTERNAL_TOKEN: INTERNAL };

  // Both tenants seal a credential under the SAME handle — the interesting
  // case, since a handle is only unique per principal.
  for (const [who, key] of [
    [A, TENANT_KEY],
    [B, OTHER_KEY],
  ] as const) {
    const sealed = await worker.fetch(
      new Request("https://bureau.internal/internal/bureau/seal", {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-token": INTERNAL },
        body: JSON.stringify({
          mode: "mint",
          principalId: who.principalId,
          name: "openrouter",
          kind: "api-key",
          metaJson: JSON.stringify(opts.meta ?? CRED_META),
          secret: key,
        }),
      }),
      env,
    );
    expect(sealed.status, "seeding the credential").toBe(200);
  }

  const chat = {
    url: OPENROUTER,
    method: "POST",
    headers: { "content-type": "application/json", "x-title": "bullmoose" },
    body: JSON.stringify({ model: "minimax/minimax-m3", messages: [], max_tokens: 64 }),
  };

  return {
    env,
    db,
    chat,
    use: (body, token = INTERNAL) =>
      worker.fetch(
        new Request("https://bureau.internal/internal/bureau/binding-use", {
          method: "POST",
          headers: { "content-type": "application/json", "x-internal-token": token },
          body: JSON.stringify(body),
        }),
        env,
      ),
  };
}

const ask = (h: Harness, over: Record<string, unknown> = {}) =>
  h.use({ accountId: A.accountId, bindingId: A.bindingId, credRef: "openrouter", request: h.chat, ...over });

interface Envelope {
  ok?: boolean;
  status?: number;
  body?: string;
  bodyEncoding?: string;
  error?: string;
}

const read = async (res: Response): Promise<Envelope> => (await res.json()) as Envelope;

describe("the happy path: the tenant's own key authenticates the model call", () => {
  it("proxies to the provider with THEIR key injected, and returns only the result", async () => {
    const seen = upstream();
    const h = await harness();

    const res = await ask(h);
    expect(res.status).toBe(200);
    const env = await read(res);
    expect(env.ok).toBe(true);
    expect(env.status).toBe(200);
    expect(env.bodyEncoding).toBe("text");
    // The model's answer came back — which is all the router needs.
    expect(JSON.parse(env.body as string)).toMatchObject({
      choices: [{ message: { content: "extracted []" } }],
      usage: { prompt_tokens: 40, completion_tokens: 3 },
    });

    // The wire: ONE call, to the allowlisted origin, carrying Ann's key.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(OPENROUTER);
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${TENANT_KEY}`);
    expect(seen[0]!.headers["x-title"]).toBe("bullmoose");
  });

  it("never returns the key — invariant 1, checked over the whole response", async () => {
    upstream();
    const h = await harness();

    const res = await ask(h);
    const text = JSON.stringify({ body: await res.text(), headers: [...res.headers] });
    expect(text).not.toContain(TENANT_KEY);
    expect(text).not.toContain("sk-or-TENANT");
  });

  it("guardrails ride the key: whatever the provider returns for THAT account is what comes back", async () => {
    // The point of the feature, mechanically: the tenant's provider-side
    // redaction rewrote the body, and the platform neither knows nor can
    // override that — it authenticated as them, so it gets their policy's
    // output verbatim.
    upstream(() => completion("Meet at [ADDRESS] on Tuesday"));
    const h = await harness();

    const env = await read(await ask(h));
    expect(JSON.parse(env.body as string).choices[0].message.content).toBe("Meet at [ADDRESS] on Tuesday");
  });

  it("audits the attempt on the grant_audit path, against the RIGHT account", async () => {
    upstream();
    const h = await harness();
    await ask(h);

    const rows = h.db.query<{ grant_id: string; principal: string; account_id: string; method: string }>(
      `SELECT grant_id, principal, account_id, method FROM grant_audit`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      grant_id: "bg_ann",
      principal: A.email,
      account_id: A.accountId,
      method: "bureau:fetch:openrouter",
    });
  });
});

describe("the tenant boundary — the check a second tenant makes load-bearing", () => {
  it("refuses to spend Bob's key for Ann's binding, even though both call it 'openrouter'", async () => {
    const seen = upstream();
    const h = await harness();

    // Ann's account, Ann's binding, and the handle they BOTH use. The lookup is
    // keyed on the account's own principal, so this resolves Ann's row.
    const env = await read(await ask(h));
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${TENANT_KEY}`);
    expect(env.ok).toBe(true);

    // And the reverse direction: naming Bob's binding under Ann's account
    // resolves NOTHING — a binding id is not a capability.
    const crossed = await h.use({
      accountId: A.accountId,
      bindingId: B.bindingId,
      credRef: "openrouter",
      request: h.chat,
    });
    expect(crossed.status).toBe(404);
    expect(seen).toHaveLength(1);
  });

  it("refuses a binding on a different account than the one named", async () => {
    const seen = upstream();
    const h = await harness();
    const res = await h.use({
      accountId: B.accountId,
      bindingId: A.bindingId,
      credRef: "openrouter",
      request: h.chat,
    });
    expect(res.status).toBe(404);
    expect(seen).toHaveLength(0);
  });
});

describe("the three row-derived checks that replace the bearer", () => {
  it("refuses when the binding is DISABLED — the 008 kill switch reaches BYOK spend", async () => {
    const seen = upstream();
    const h = await harness({ enabled: 0 });

    const res = await ask(h);
    expect(res.status).toBe(403);
    expect((await read(res)).error).toMatch(/disabled/);
    expect(seen, "no request may reach the provider").toHaveLength(0);
  });

  it("refuses a credential the binding's config does not name", async () => {
    const seen = upstream();
    const h = await harness({ config: { pipeline: "extract", modelAliases: MENU } });

    const res = await ask(h);
    expect(res.status).toBe(403);
    expect((await read(res)).error).toMatch(/does not name credential "openrouter"/);
    expect(seen).toHaveLength(0);
  });

  it("refuses without a live grant — minting a credential authorizes nobody", async () => {
    const seen = upstream();
    const h = await harness({ noGrant: true });

    const res = await ask(h);
    expect(res.status).toBe(403);
    expect((await read(res)).error).toMatch(/no live grant/);
    expect(seen).toHaveLength(0);
  });

  it("stops on the NEXT call after the grant is revoked, and records the refusal", async () => {
    const seen = upstream();
    const h = await harness({ revoked: true });

    const res = await ask(h);
    expect(res.status).toBe(403);
    expect(seen).toHaveLength(0);
    // Invariant 6: a refusal is an attempt, and `grant_id = 'none'` says no
    // grant authorized it rather than inventing one.
    const rows = h.db.query<{ grant_id: string; method: string }>(`SELECT grant_id, method FROM grant_audit`);
    expect(rows).toEqual([{ grant_id: "none", method: "bureau:fetch:openrouter" }]);
  });
});

describe("the runtime it shares with /bureau/use", () => {
  it("binds the destination: a credential sealed for openrouter cannot be spent elsewhere", async () => {
    const seen = upstream();
    const h = await harness();

    const res = await ask(h, {
      request: { ...h.chat, url: "https://evil.example/api/v1/chat/completions" },
    });
    expect(res.status).toBe(403);
    expect((await read(res)).error).toMatch(/not in the allowlist/);
    expect(seen, "the credential was never put on a wire").toHaveLength(0);
  });

  it("fails closed on a credential with no allowlist (invariant 5)", async () => {
    const seen = upstream();
    const h = await harness({ meta: { header: "Authorization: Bearer {}", scope: "actor" } });

    const res = await ask(h);
    expect(res.status).toBe(403);
    expect((await read(res)).error).toMatch(/no destination allowlist/);
    expect(seen).toHaveLength(0);
  });

  it("refuses a caller that tries to set the injected header itself", async () => {
    const seen = upstream();
    const h = await harness();

    const res = await ask(h, {
      request: { ...h.chat, headers: { authorization: "Bearer sk-attacker" } },
    });
    expect(res.status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it("gates the verb by kind: an hmac-key credential cannot answer fetch (§4.1)", async () => {
    const seen = upstream();
    const db = fakeD1();
    db.seedAccount({ accountId: A.accountId, principalId: A.principalId, loginEmail: A.email });
    db.seed("agent_bindings", [
      {
        id: A.bindingId,
        account_id: A.accountId,
        name: "extractor",
        trigger_on: "mailbox-delivery",
        sla_seconds: null,
        enabled: 1,
        config_json: JSON.stringify({ providerCredentials: { openrouter: "openrouter" } }),
        recipients_book_id: null,
      },
    ]);
    db.seed("bureau_grants", [
      {
        id: "bg_ann",
        principal_id: A.principalId,
        cred_name: "openrouter",
        verb: "fetch",
        created_by: "admin",
        created_at: 1,
        expires_at: null,
        revoked_at: null,
      },
    ]);
    const env: Env = { DB: db, VAULT_MASTER_KEY: MASTER, INTERNAL_TOKEN: INTERNAL };
    await worker.fetch(
      new Request("https://bureau.internal/internal/bureau/seal", {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-token": INTERNAL },
        body: JSON.stringify({
          mode: "mint",
          principalId: A.principalId,
          name: "openrouter",
          kind: "hmac-key",
          metaJson: JSON.stringify(CRED_META),
          secret: TENANT_KEY,
        }),
      }),
      env,
    );

    const res = await worker.fetch(
      new Request("https://bureau.internal/internal/bureau/binding-use", {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-token": INTERNAL },
        body: JSON.stringify({
          accountId: A.accountId,
          bindingId: A.bindingId,
          credRef: "openrouter",
          request: { url: OPENROUTER, method: "POST", body: "{}" },
        }),
      }),
      env,
    );
    expect(res.status).toBe(403);
    expect((await read(res)).error).toMatch(/not permitted for a "hmac-key" credential/);
    expect(seen).toHaveLength(0);
  });
});

describe("the door itself", () => {
  it("is closed without the internal token", async () => {
    const seen = upstream();
    const h = await harness();
    const res = await h.use(
      { accountId: A.accountId, bindingId: A.bindingId, credRef: "openrouter", request: h.chat },
      "wrong-token",
    );
    expect(res.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it("400s a body missing any of the three names", async () => {
    const h = await harness();
    for (const over of [{ accountId: "" }, { bindingId: "" }, { credRef: "" }]) {
      expect((await ask(h, over)).status).toBe(400);
    }
  });

  it("404s an unknown binding without writing an audit row (there is no principal to name)", async () => {
    const h = await harness();
    const res = await ask(h, { bindingId: "b_nope" });
    expect(res.status).toBe(404);
    expect(h.db.query(`SELECT * FROM grant_audit`)).toHaveLength(0);
  });

  it("refuses a soft-deleted account", async () => {
    const seen = upstream();
    const h = await harness();
    h.db.exec(`UPDATE accounts SET deleted_at = 99 WHERE id = '${A.accountId}'`);
    const res = await ask(h);
    expect(res.status).toBe(404);
    expect(seen).toHaveLength(0);
  });
});

describe("bindingNamesCredential — the operator plane decides, by exact match", () => {
  it("finds the handle under providerCredentials", () => {
    expect(bindingNamesCredential(JSON.stringify({ providerCredentials: { openrouter: "or" } }), "or")).toBe(true);
  });

  it("finds it on a single candidate in the model menu", () => {
    const cfg = JSON.stringify({
      modelAliases: {
        extract: [
          { provider: "workers-ai", model: "x" },
          { provider: "openrouter", model: "y", credRef: "mine" },
        ],
      },
    });
    expect(bindingNamesCredential(cfg, "mine")).toBe(true);
  });

  it("is an EXACT match — no prefix, no substring, no near miss", () => {
    const cfg = JSON.stringify({ providerCredentials: { openrouter: "openrouter-prod" } });
    expect(bindingNamesCredential(cfg, "openrouter")).toBe(false);
    expect(bindingNamesCredential(cfg, "openrouter-prod-2")).toBe(false);
    expect(bindingNamesCredential(cfg, "openrouter-prod")).toBe(true);
  });

  it("says no to an empty, malformed or hostile config", () => {
    expect(bindingNamesCredential("{}", "or")).toBe(false);
    expect(bindingNamesCredential("not json", "or")).toBe(false);
    expect(bindingNamesCredential("[1,2,3]", "or")).toBe(false);
    expect(bindingNamesCredential(JSON.stringify({ providerCredentials: ["or"] }), "or")).toBe(false);
    expect(bindingNamesCredential(JSON.stringify({ modelAliases: { a: "or" } }), "or")).toBe(false);
  });
});
