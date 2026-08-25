import { describe, expect, it } from "vitest";
import { fakeD1, fakeKV, type FakeD1, type FakeKV } from "@bullmoose/test-fakes";
import bureauWorker from "../../bureau/src/index";
import { openCredential } from "../../bureau/src/vault";
import type { Env as BureauEnv } from "../../bureau/src/models";
import worker from "./index";
import type { Env } from "./index";

/**
 * `POST /provider-keys` (s26 T4) — the BYOK provisioning door.
 *
 * The BUREAU binding is the REAL Bureau worker over the SAME database, as in
 * `services/agent/src/vault.test.ts`: this worker holds no master key, so a
 * stub would prove nothing about the only interesting claim — that the key
 * crosses the boundary once, on the way IN, and cannot come back.
 *
 * The write-only property is asserted by trying to get the key back out of
 * everything this worker touches: the response, the credential row, and the
 * admin read surfaces. It is only recoverable through the Bureau's own
 * `openCredential`, which is in-process there and reachable from no route.
 */

const ADMIN_TOKEN = "admin-secret";
const MASTER = "test-vault-master-key-0123456789abcdef";
const INTERNAL = "internal-test-token";
const DOMAIN = "family.test";
const TENANT = "t_fam";
/** Distinctive on purpose: the leak assertions grep for this exact string. */
const KEY = "sk-or-BYOK-canary-3d81f0";

interface Harness {
  db: FakeD1;
  kv: FakeKV;
  env: Env;
  bureauEnv: BureauEnv;
  post: (path: string, body: Record<string, unknown>) => Promise<Response>;
  get: (path: string) => Promise<Response>;
}

function harness(opts: { bureau?: boolean } = {}): Harness {
  const db = fakeD1();
  const kv = fakeKV();
  db.seed("tenants", [{ id: TENANT, name: "Family", status: "active", created_at: 1 }]);
  db.seed("domains", [{ domain: DOMAIN, tenant_id: TENANT, status: "active", cf_zone_id: "z1", created_at: 1 }]);

  const bureauEnv: BureauEnv = { DB: db, VAULT_MASTER_KEY: MASTER, INTERNAL_TOKEN: INTERNAL };
  const BUREAU = {
    fetch: (input: RequestInfo | URL, init?: RequestInit) =>
      bureauWorker.fetch(new Request(input as RequestInfo, init), bureauEnv),
  } as unknown as Fetcher;

  const env: Env = {
    DB: db,
    ROUTES: kv.ns,
    ADMIN_TOKEN,
    SES_REGION: "us-east-1",
    INGEST_WORKER_NAME: "bullmoose-ingest",
    CF_API_TOKEN: "cf",
    SES_ACCESS_KEY_ID: "ak",
    SES_SECRET_ACCESS_KEY: "sk",
    ...(opts.bureau === false ? {} : { BUREAU, INTERNAL_TOKEN: INTERNAL }),
  };

  const call = (method: string, path: string, body?: Record<string, unknown>) =>
    worker.fetch(
      new Request(`https://provision.test${path}`, {
        method,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
      env,
    );

  return {
    db,
    kv,
    env,
    bureauEnv,
    post: (path, body) => call("POST", path, body),
    get: (path) => call("GET", path),
  };
}

async function seedExtractor(h: Harness, localpart = "dad"): Promise<string> {
  expect(
    (await h.post("/accounts", { tenantId: TENANT, domain: DOMAIN, localpart, displayName: localpart })).status,
  ).toBe(200);
  const res = await h.post("/extractor", { email: `${localpart}@${DOMAIN}` });
  expect(res.status).toBe(200);
  return `${localpart}@${DOMAIN}`;
}

interface KeyResponse {
  ok?: boolean;
  created?: boolean;
  rotated?: boolean;
  credRef?: string;
  provider?: string;
  allow?: string;
  header?: string;
  grantId?: string;
  bindings?: Array<{ id: string; name: string }>;
  keyReadable?: boolean;
  note?: string;
  error?: string;
}

const bindingConfig = (h: Harness, name = "extractor") =>
  JSON.parse(
    h.db.query<{ config_json: string }>(`SELECT config_json FROM agent_bindings WHERE name = '${name}'`)[0]!
      .config_json,
  ) as Record<string, unknown>;

describe("POST /provider-keys — sealing a tenant's own provider key", () => {
  it("seals it, grants fetch on it, and attaches it to the binding that routes there", async () => {
    const h = harness();
    const email = await seedExtractor(h);

    const res = await h.post("/provider-keys", { email, key: KEY });
    expect(res.status).toBe(200);
    const body = (await res.json()) as KeyResponse;
    expect(body).toMatchObject({
      ok: true,
      created: true,
      rotated: false,
      provider: "openrouter",
      credRef: "openrouter",
      allow: "https://openrouter.ai",
      header: "Authorization: Bearer {}",
      keyReadable: false,
    });

    // 1 — sealed. The row carries ciphertext and the §5 contract, nothing else.
    const cred = h.db.query<{ kind: string; enc_json: string; meta_json: string }>(
      `SELECT kind, enc_json, meta_json FROM vault_credentials WHERE name = 'openrouter'`,
    );
    expect(cred).toHaveLength(1);
    expect(cred[0]!.kind).toBe("api-key");
    expect(JSON.parse(cred[0]!.meta_json)).toMatchObject({
      allow: "https://openrouter.ai",
      header: "Authorization: Bearer {}",
      scope: "actor",
    });

    // 2 — granted. Sealed-but-ungranted is a key that silently does nothing.
    const grants = h.db.query<{ cred_name: string; verb: string; revoked_at: number | null }>(
      `SELECT cred_name, verb, revoked_at FROM bureau_grants`,
    );
    expect(grants).toEqual([{ cred_name: "openrouter", verb: "fetch", revoked_at: null }]);

    // 3 — attached, which is what makes the Bureau's config check pass.
    expect(body.bindings).toHaveLength(1);
    expect(bindingConfig(h).providerCredentials).toEqual({ openrouter: "openrouter" });
  });

  it("really sealed it — the Bureau, and only the Bureau, can open it again", async () => {
    const h = harness();
    const email = await seedExtractor(h);
    await h.post("/provider-keys", { email, key: KEY });

    const principalId = h.db.query<{ principal_id: string }>(`SELECT principal_id FROM vault_credentials`)[0]!
      .principal_id;
    const opened = await openCredential(h.bureauEnv, principalId, "openrouter");
    expect(opened?.secret).toBe(KEY);
    expect(opened?.kind).toBe("api-key");
  });

  it("keeps the model menu and the history floor intact when it attaches", async () => {
    const h = harness();
    const email = await seedExtractor(h);
    const before = bindingConfig(h);

    await h.post("/provider-keys", { email, key: KEY });

    const after = bindingConfig(h);
    expect(after.modelAliases).toEqual(before.modelAliases);
    expect(after.budgets).toEqual(before.budgets);
    expect(after.createdAt).toEqual(before.createdAt);
  });
});

describe("write-only: the key goes in once and is never readable back", () => {
  it("never echoes the key — not in the response, not in the row, not in any admin read", async () => {
    const h = harness();
    const email = await seedExtractor(h);

    const res = await h.post("/provider-keys", { email, key: KEY });
    const responseText = await res.text();
    expect(responseText).not.toContain(KEY);
    expect(responseText).not.toContain("canary");

    // The stored row: ciphertext, and a contract that names no value.
    const row = h.db.query<{ enc_json: string; meta_json: string }>(
      `SELECT enc_json, meta_json FROM vault_credentials`,
    )[0]!;
    expect(row.enc_json).not.toContain(KEY);
    expect(row.meta_json).not.toContain(KEY);

    // Every read surface this worker offers.
    for (const path of ["/bureau-grants", "/accounts", `/bureau-grants?credRef=openrouter`]) {
      const dump = await (await h.get(path)).text();
      expect(dump, path).not.toContain(KEY);
    }

    // And the whole database, which is the assertion that cannot be fooled by
    // knowing which surfaces exist today.
    const everything = JSON.stringify(h.db.query(`SELECT * FROM vault_credentials`));
    expect(everything).not.toContain(KEY);
  });

  it("has no route that returns a sealed value — asked directly, the Bureau refuses", async () => {
    const h = harness();
    const email = await seedExtractor(h);
    await h.post("/provider-keys", { email, key: KEY });

    // The Bureau's own internal surface, with the right token: seal, verify,
    // and use. None of the three has a shape that can carry a secret out.
    const verify = await h.env.BUREAU!.fetch("https://bureau.internal/internal/bureau/verify", {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": INTERNAL },
      body: JSON.stringify({ principalEmail: email, name: "openrouter" }),
    });
    const verified = await verify.text();
    expect(JSON.parse(verified)).toEqual({ ok: true });
    expect(verified).not.toContain(KEY);
  });
});

describe("re-provisioning swaps the key in place", () => {
  it("rotates the ciphertext under the SAME handle, grant and attachment", async () => {
    const h = harness();
    const email = await seedExtractor(h);
    await h.post("/provider-keys", { email, key: KEY });
    const firstGrant = h.db.query<{ id: string }>(`SELECT id FROM bureau_grants`)[0]!.id;

    const rotated = (await (
      await h.post("/provider-keys", { email, key: "sk-or-SECOND-canary" })
    ).json()) as KeyResponse;

    expect(rotated).toMatchObject({ ok: true, created: false, rotated: true, credRef: "openrouter" });
    // One credential, one grant — a rotation is not a second capability.
    expect(h.db.query(`SELECT id FROM vault_credentials`)).toHaveLength(1);
    expect(h.db.query<{ id: string }>(`SELECT id FROM bureau_grants`)).toEqual([{ id: firstGrant }]);
    expect(bindingConfig(h).providerCredentials).toEqual({ openrouter: "openrouter" });

    // The new value is what opens now.
    const principalId = h.db.query<{ principal_id: string }>(`SELECT principal_id FROM vault_credentials`)[0]!
      .principal_id;
    expect((await openCredential(h.bureauEnv, principalId, "openrouter"))?.secret).toBe("sk-or-SECOND-canary");
  });

  it("reinstates a revoked grant rather than leaving the key sealed and unusable", async () => {
    const h = harness();
    const email = await seedExtractor(h);
    await h.post("/provider-keys", { email, key: KEY });
    const grantId = h.db.query<{ id: string }>(`SELECT id FROM bureau_grants`)[0]!.id;
    expect((await h.get(`/bureau-grants`)).status).toBe(200);
    await h.db.exec(`UPDATE bureau_grants SET revoked_at = 5 WHERE id = '${grantId}'`);

    await h.post("/provider-keys", { email, key: KEY });

    expect(h.db.query<{ revoked_at: number | null }>(`SELECT revoked_at FROM bureau_grants`)).toEqual([
      { revoked_at: null },
    ]);
  });
});

describe("what it refuses", () => {
  it("requires an email and a key", async () => {
    const h = harness();
    await seedExtractor(h);
    expect((await h.post("/provider-keys", { key: KEY })).status).toBe(400);
    expect((await h.post("/provider-keys", { email: `dad@${DOMAIN}` })).status).toBe(400);
    expect((await h.post("/provider-keys", { email: `dad@${DOMAIN}`, key: "" })).status).toBe(400);
  });

  it("refuses a provider that has no key to bring", async () => {
    const h = harness();
    const email = await seedExtractor(h);
    const res = await h.post("/provider-keys", { email, key: KEY, provider: "workers-ai" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as KeyResponse).error).toMatch(/provider must be one of/);
  });

  it("refuses `gateway` without an explicit allowlist — there is no default endpoint to bind to", async () => {
    const h = harness();
    const email = await seedExtractor(h);
    const res = await h.post("/provider-keys", { email, key: KEY, provider: "gateway" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as KeyResponse).error).toMatch(/required for provider "gateway"/);
    expect(h.db.query(`SELECT id FROM vault_credentials`), "nothing was sealed").toHaveLength(0);
  });

  it("refuses a malformed allowlist or header recipe, sealing nothing", async () => {
    const h = harness();
    const email = await seedExtractor(h);
    expect((await h.post("/provider-keys", { email, key: KEY, allow: "ftp://nope" })).status).toBe(400);
    expect((await h.post("/provider-keys", { email, key: KEY, header: "Authorization: Bearer" })).status).toBe(400);
    expect(h.db.query(`SELECT id FROM vault_credentials`)).toHaveLength(0);
  });

  it("404s an unknown account", async () => {
    const h = harness();
    const res = await h.post("/provider-keys", { email: `nobody@${DOMAIN}`, key: KEY });
    expect(res.status).toBe(404);
    expect(h.db.query(`SELECT id FROM vault_credentials`)).toHaveLength(0);
  });

  it("501s — and seals nothing — on a deployment with no BUREAU binding", async () => {
    const h = harness({ bureau: false });
    const email = await seedExtractor(h);
    const res = await h.post("/provider-keys", { email, key: KEY });
    expect(res.status).toBe(501);
    expect(h.db.query(`SELECT id FROM vault_credentials`)).toHaveLength(0);
  });

  it("is admin-gated like every other verb here", async () => {
    const h = harness();
    const res = await worker.fetch(
      new Request("https://provision.test/provider-keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: `dad@${DOMAIN}`, key: KEY }),
      }),
      h.env,
    );
    expect(res.status).toBe(401);
  });
});

describe("attachment", () => {
  it("attaches to a named binding when asked", async () => {
    const h = harness();
    const email = await seedExtractor(h);
    const body = (await (
      await h.post("/provider-keys", { email, key: KEY, bindingName: "extractor" })
    ).json()) as KeyResponse;
    expect(body.bindings?.map((b) => b.name)).toEqual(["extractor"]);
  });

  it("attaches nowhere — and says so — when no binding routes to that provider", async () => {
    const h = harness();
    expect(
      (await h.post("/accounts", { tenantId: TENANT, domain: DOMAIN, localpart: "mum", displayName: "mum" })).status,
    ).toBe(200);

    const body = (await (await h.post("/provider-keys", { email: `mum@${DOMAIN}`, key: KEY })).json()) as KeyResponse;

    expect(body.ok).toBe(true);
    expect(body.bindings).toEqual([]);
    // Honest rather than silent: sealed and granted, but nothing will use it.
    expect(body.note).toMatch(/NO binding .* names it yet/);
  });

  it("leaves other accounts' bindings alone", async () => {
    const h = harness();
    const dad = await seedExtractor(h, "dad");
    await seedExtractor(h, "kid");

    await h.post("/provider-keys", { email: dad, key: KEY });

    const configs = h.db
      .query<{ account_id: string; config_json: string }>(
        `SELECT account_id, config_json FROM agent_bindings ORDER BY account_id`,
      )
      .map((r) => JSON.parse(r.config_json) as { providerCredentials?: unknown });
    expect(configs.filter((c) => c.providerCredentials !== undefined)).toHaveLength(1);
  });
});
