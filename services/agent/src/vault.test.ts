import { readdirSync, readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { mintToken } from "@bullmoose/auth-core";
import { fakeEnv } from "@bullmoose/test-fakes";
import bureauWorker from "../../bureau/src/index";
import { openCredential } from "../../bureau/src/vault";
import type { Env as BureauEnv } from "../../bureau/src/models";
import type { Env } from "./models";
import { handleVault, handleVaultVerify } from "./vault";

/**
 * The credential vault's write-only HTTP surface, exercised against the live
 * schema (`@bullmoose/test-fakes`, real SQLite) with a really-minted bearer so
 * `authenticateVault`'s tokens⋈principals join and the seal/open crypto run for
 * real. sVOL 020 built the mint-time contract here; **s04 T3a split the file**,
 * and these tests now run across that split.
 *
 * The BUREAU binding is the REAL Bureau worker over the SAME database — not a
 * stub. That is deliberate: T3a's entire claim is that a boundary now exists
 * between the two workers, and a faked boundary proves nothing about it. The
 * agent env carries no `VAULT_MASTER_KEY`, because in production it will not
 * have one, and every seal in this file therefore has to survive the hop.
 *
 * There is still no proxy — nothing here enforces the allowlist or the verb set;
 * this proves the CONTRACT is recorded, honestly, including the fail-closed
 * "unbound" state a missing --allow leaves behind (invariant 5).
 */

const MASTER = "test-vault-master-key-0123456789abcdef";
const PRINCIPAL = "p_vault";
const EMAIL = "vault@bullmoose.cc";

let minted: { id: string; token: string; secretHash: string };
beforeAll(async () => {
  minted = await mintToken();
});

function world(scopes: string[] = ["vault"]) {
  const w = fakeEnv();
  w.db.seedAccount({ accountId: "a_vault", principalId: PRINCIPAL, loginEmail: EMAIL });
  w.db.seed("tokens", [
    {
      id: minted.id,
      principal_id: PRINCIPAL,
      kind: "bearer",
      secret_hash: minted.secretHash,
      name: "test",
      scopes: JSON.stringify(scopes),
      created_at: 1,
      expires_at: null,
      last_used_at: Date.now(),
    },
  ]);
  // The Bureau: same D1, and the ONLY holder of the master key.
  const bureauEnv: BureauEnv = {
    DB: w.env.DB,
    VAULT_MASTER_KEY: MASTER,
    INTERNAL_TOKEN: w.env.INTERNAL_TOKEN,
  };
  const BUREAU = {
    fetch: (input: RequestInfo | URL, init?: RequestInit) =>
      bureauWorker.fetch(new Request(input as RequestInfo, init), bureauEnv),
  } as unknown as Fetcher;
  const env: Env = { ...w.env, BUREAU };
  return { env, bureauEnv, db: w.db };
}

function req(method: string, path: string, body?: unknown, token = minted.token): Request {
  return new Request(`https://agent.example${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

interface CredView {
  name: string;
  kind: string;
  allow: string | null;
  header: string | null;
  scope: string | null;
  enforcement: string | null;
  bound: boolean;
  meta: Record<string, unknown>;
}

async function list(env: Env): Promise<CredView[]> {
  const res = await handleVault(req("GET", "/vault/credentials"), env);
  const body = (await res.json()) as { credentials: CredView[] };
  return body.credentials;
}

const put = (env: Env, body: unknown) => handleVault(req("PUT", "/vault/credentials", body), env);

describe("the write-only surface authenticates", () => {
  it("501s when the vault is not configured", async () => {
    const { db } = world();
    const res = await handleVault(req("GET", "/vault/credentials"), {
      ...({} as Env),
      DB: db as unknown as D1Database,
    });
    expect(res.status).toBe(501);
  });

  it("401s without a valid bearer, 403s without the vault scope", async () => {
    const anon = await handleVault(req("GET", "/vault/credentials", undefined, "bm_deadbeefdead_x"), world().env);
    expect(anon.status).toBe(401);
    const mailOnly = world(["mail"]);
    const denied = await handleVault(req("GET", "/vault/credentials"), mailOnly.env);
    expect(denied.status).toBe(403);
  });
});

describe("all four kinds mint (bureau.md §4.1)", () => {
  it("keeps the legacy kinds", async () => {
    const { env } = world();
    for (const kind of ["api-key", "oauth-refresh"]) {
      const res = await put(env, {
        name: `legacy-${kind}`,
        kind,
        secret: "s",
        allow: "https://api.example.com",
      });
      expect(res.status, kind).toBe(200);
    }
  });

  it("accepts aws-sigv4 and hmac-key — the two sVOL 020 widens to", async () => {
    const { env } = world();
    for (const kind of ["aws-sigv4", "hmac-key"]) {
      const res = await put(env, {
        name: `new-${kind}`,
        kind,
        secret: "s",
        allow: "*.amazonaws.com",
      });
      const body = (await res.json()) as { ok: boolean; kind: string };
      expect(res.status, kind).toBe(200);
      expect(body.kind).toBe(kind);
    }
    const kinds = (await list(env)).map((c) => c.kind).sort();
    expect(kinds).toEqual(["aws-sigv4", "hmac-key"]);
  });

  it("still rejects an unknown kind", async () => {
    const { env } = world();
    const res = await put(env, {
      name: "bad",
      kind: "totp",
      secret: "s",
      allow: "https://x.example.com",
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/kind must be one of/);
  });
});

describe("the §5 mint-time fields persist and read back", () => {
  it("stores allow/header/scope/enforcement and surfaces them typed — never the secret", async () => {
    const { env } = world();
    await put(env, {
      name: "stripe",
      kind: "api-key",
      secret: "bm-canary-DO-NOT-USE-vault-9f3d1c",
      allow: "https://api.stripe.com",
      header: "Authorization: Bearer {}",
      enforcement: "broad",
      meta: { team: "billing" },
    });
    const [c] = await list(env);
    expect(c).toMatchObject({
      name: "stripe",
      kind: "api-key",
      allow: "https://api.stripe.com",
      header: "Authorization: Bearer {}",
      scope: "actor",
      enforcement: "broad",
      bound: true,
      meta: { team: "billing" }, // reserved keys stripped from user meta
    });
    // Invariant 1: no read path returns the value or the envelope.
    const raw = JSON.stringify(c);
    expect(raw).not.toContain("bm-canary-DO-NOT-USE-vault-9f3d1c");
    expect(raw).not.toContain("enc_json");
    expect(raw).not.toMatch(/"ct"|"iv"/);
  });

  it("normalizes the allowlist to a canonical origin (§6, exact not substring)", async () => {
    const { env } = world();
    await put(env, {
      name: "mixed",
      kind: "api-key",
      secret: "s",
      allow: "https://API.Stripe.com/v1/charges",
    });
    expect((await list(env))[0]!.allow).toBe("https://api.stripe.com");
  });

  it("derives Authorization: Bearer {} for api-key when --header is omitted (§5)", async () => {
    const { env } = world();
    await put(env, {
      name: "derived",
      kind: "api-key",
      secret: "s",
      allow: "https://api.example.com",
    });
    expect((await list(env))[0]!.header).toBe("Authorization: Bearer {}");
  });

  it("derives allow from the OAuth issuer when omitted (§5)", async () => {
    const { env } = world();
    await put(env, {
      name: "gcal",
      kind: "oauth-refresh",
      secret: "refresh",
      meta: { token_url: "https://oauth2.googleapis.com/token" },
    });
    expect((await list(env))[0]!.allow).toBe("https://oauth2.googleapis.com");
  });

  it("records a missing allow as fail-closed / unbound (invariant 5), not an error", async () => {
    const { env } = world();
    const res = await put(env, { name: "unbound", kind: "api-key", secret: "s" });
    const body = (await res.json()) as { bound: boolean; allow: string | null };
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ bound: false, allow: null });
    expect((await list(env))[0]).toMatchObject({ bound: false, allow: null });
  });
});

describe("mint-time validation refuses the deferred and the malformed", () => {
  it('refuses scope other than "actor" with a "not yet" (the §9 AAD change is deferred)', async () => {
    const { env } = world();
    for (const scope of ["inbox", "global"]) {
      const res = await put(env, {
        name: "s",
        kind: "api-key",
        secret: "s",
        allow: "https://x.example.com",
        scope,
      });
      expect(res.status, scope).toBe(400);
      expect(await res.text()).toMatch(/not yet supported/);
    }
  });

  it("rejects an unknown enforcement rung", async () => {
    const { env } = world();
    const res = await put(env, {
      name: "s",
      kind: "api-key",
      secret: "s",
      allow: "https://x.example.com",
      enforcement: "trust-me",
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/enforcement must be one of/);
  });

  it("rejects a non-http allow and a header with no {} slot", async () => {
    const { env } = world();
    expect((await put(env, { name: "a", kind: "api-key", secret: "s", allow: "ftp://host" })).status).toBe(400);
    expect(
      (
        await put(env, {
          name: "b",
          kind: "api-key",
          secret: "s",
          allow: "https://x.example.com",
          header: "X-Api-Key no-slot",
        })
      ).status,
    ).toBe(400);
  });
});

describe("the secret round-trips across the T3a boundary", () => {
  it("seals in the Bureau and carries the whole §5 contract with it", async () => {
    const { env, bureauEnv } = world();
    await put(env, {
      name: "aws-mcp",
      kind: "aws-sigv4",
      secret: "AWS_SECRET_VALUE",
      allow: "*.amazonaws.com",
      enforcement: "narrow",
    });
    // Opened with the BUREAU's env — the only env in the test that has a key.
    const opened = await openCredential(bureauEnv, PRINCIPAL, "aws-mcp");
    expect(opened?.secret).toBe("AWS_SECRET_VALUE");
    expect(opened?.kind).toBe("aws-sigv4");
    expect(opened?.meta).toMatchObject({
      allow: "https://*.amazonaws.com",
      enforcement: "narrow",
      scope: "actor",
    });
  });
});

/**
 * T3a's done-when, as tests rather than as a claim.
 *
 * The point of moving the key was never that the code is tidier — it is that a
 * whole class of bug stops being reachable. The agent worker runs every MCP tool
 * and, from sVOL `014`, reads untrusted email; if the master key were ambient in
 * that address space, security would rest on nobody ever reaching for it. These
 * assert that there is nothing to reach for.
 */
describe("the agent worker genuinely cannot unseal", () => {
  it("names no master key anywhere in its source or its config", () => {
    // `grep VAULT_MASTER_KEY services/agent` from the dev plan's done-when, run
    // as a test so it cannot rot — over the WHOLE source directory rather than a
    // hand-listed set, so a future file cannot quietly reintroduce the key.
    // Test files are excluded because this one has to name the binding in order
    // to build the Bureau's env and to assert this.
    const srcDir = new URL("./", import.meta.url);
    const sources = readdirSync(srcDir)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .map((f) => `src/${f}`)
      .concat("wrangler.jsonc");
    expect(sources.length).toBeGreaterThan(5); // the sweep found files, not nothing
    for (const file of sources) {
      const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
      expect(text, file).not.toContain("VAULT_MASTER_KEY");
    }
  });

  it("cannot open a credential it just minted", async () => {
    const { env, bureauEnv, db } = world();
    await put(env, {
      name: "stripe",
      kind: "api-key",
      secret: "bm-canary-DO-NOT-USE-vault-9f3d1c",
      allow: "https://api.stripe.com",
    });

    // The ciphertext is right there in a table the agent worker CAN read. What
    // it lacks is the key, and that is the whole difference between isolation
    // and a naming convention.
    const row = db.query<{ enc_json: string }>(`SELECT enc_json FROM vault_credentials WHERE name = 'stripe'`)[0]!;
    expect(row.enc_json).not.toContain("bm-canary-DO-NOT-USE-vault-9f3d1c");
    expect(Object.keys(env)).not.toContain("VAULT_MASTER_KEY");
    // ...and with the key, in the Bureau, it opens. The value is recoverable —
    // just not here.
    expect((await openCredential(bureauEnv, PRINCIPAL, "stripe"))?.secret).toBe("bm-canary-DO-NOT-USE-vault-9f3d1c");
  });

  it("fails closed when the Bureau is unreachable rather than sealing locally", async () => {
    const { env, db } = world();
    const broken: Env = {
      ...env,
      BUREAU: {
        fetch: async () => new Response("boom", { status: 500 }),
      } as unknown as Fetcher,
    };
    const res = await put(broken, {
      name: "stripe",
      kind: "api-key",
      secret: "bm-canary-DO-NOT-USE-vault-9f3d1c",
      allow: "https://api.stripe.com",
    });
    expect(res.status).toBe(502);
    // Nothing was written: a credential the Bureau never sealed must not exist
    // as a row, or `creds list` would show a credential that can never be used.
    expect(db.count("vault_credentials")).toBe(0);
  });
});

describe("rotate re-seals under the same name (bureau.md §5)", () => {
  it("swaps the secret while keeping kind/allow/enforcement, and the new secret opens", async () => {
    const { env, bureauEnv, db } = world();
    await put(env, {
      name: "rotate-me",
      kind: "api-key",
      secret: "OLD",
      allow: "https://api.example.com",
      enforcement: "narrow",
    });
    const before = db.query<{ updated_at: number; meta_json: string }>(
      "SELECT updated_at, meta_json FROM vault_credentials WHERE name = 'rotate-me'",
    )[0]!;

    const res = await handleVault(req("POST", "/vault/credentials/rotate-me/rotate", { secret: "NEW" }), env);
    const body = (await res.json()) as { ok: boolean; rotated: boolean; kind: string };
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, rotated: true, kind: "api-key" });

    // The new secret opens — in the Bureau, which is where opening happens now.
    const opened = await openCredential(bureauEnv, PRINCIPAL, "rotate-me");
    expect(opened?.secret).toBe("NEW");
    const view = (await list(env))[0]!;
    expect(view).toMatchObject({
      allow: "https://api.example.com",
      enforcement: "narrow",
      kind: "api-key",
    });

    const after = db.query<{ updated_at: number; meta_json: string }>(
      "SELECT updated_at, meta_json FROM vault_credentials WHERE name = 'rotate-me'",
    )[0]!;
    expect(after.meta_json).toBe(before.meta_json); // metadata unchanged
    expect(after.updated_at).toBeGreaterThanOrEqual(before.updated_at);
  });

  it("404s rotating a credential that does not exist", async () => {
    const { env } = world();
    const res = await handleVault(req("POST", "/vault/credentials/ghost/rotate", { secret: "x" }), env);
    expect(res.status).toBe(404);
  });

  it("still passes the decrypt-and-discard health check after a rotate", async () => {
    const { env } = world();
    await put(env, {
      name: "health",
      kind: "api-key",
      secret: "v1",
      allow: "https://api.example.com",
    });
    await handleVault(req("POST", "/vault/credentials/health/rotate", { secret: "v2" }), env);
    const res = await handleVaultVerify(
      new Request("https://agent.example/internal/vault/verify", {
        method: "POST",
        body: JSON.stringify({ principalEmail: EMAIL, name: "health" }),
      }),
      env,
    );
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("delete still works and is scoped to the principal", () => {
  it("removes only the named row", async () => {
    const { env } = world();
    await put(env, {
      name: "gone",
      kind: "api-key",
      secret: "s",
      allow: "https://api.example.com",
    });
    const res = await handleVault(req("DELETE", "/vault/credentials/gone"), env);
    expect(await res.json()).toEqual({ deleted: true });
    expect(await list(env)).toHaveLength(0);
  });
});
