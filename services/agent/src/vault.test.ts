import { beforeAll, describe, expect, it } from "vitest";
import { mintToken } from "@bullmoose/auth-core";
import { fakeEnv } from "@bullmoose/test-fakes";
import type { Env } from "./models";
import { handleVault, handleVaultVerify, openVaultSecret } from "./vault";

/**
 * The credential vault's write-only HTTP surface, exercised against the live
 * schema (`@bullmoose/test-fakes`, real SQLite) with a really-minted bearer so
 * `authenticateVault`'s tokens⋈principals join and the seal/open crypto run for
 * real. This is sVOL 020: the two NEW kinds mint, the bureau.md §5 mint-time
 * fields persist and read back (never the secret), and `rotate` re-seals.
 *
 * There is no proxy yet — nothing here enforces the allowlist or the verb set;
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
  const env: Env = { ...w.env, VAULT_MASTER_KEY: MASTER };
  return { env, db: w.db };
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
      const res = await put(env, { name: `legacy-${kind}`, kind, secret: "s", allow: "https://api.example.com" });
      expect(res.status, kind).toBe(200);
    }
  });

  it("accepts aws-sigv4 and hmac-key — the two sVOL 020 widens to", async () => {
    const { env } = world();
    for (const kind of ["aws-sigv4", "hmac-key"]) {
      const res = await put(env, { name: `new-${kind}`, kind, secret: "s", allow: "*.amazonaws.com" });
      const body = (await res.json()) as { ok: boolean; kind: string };
      expect(res.status, kind).toBe(200);
      expect(body.kind).toBe(kind);
    }
    const kinds = (await list(env)).map((c) => c.kind).sort();
    expect(kinds).toEqual(["aws-sigv4", "hmac-key"]);
  });

  it("still rejects an unknown kind", async () => {
    const { env } = world();
    const res = await put(env, { name: "bad", kind: "totp", secret: "s", allow: "https://x.example.com" });
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
      secret: "sk_live_TOPSECRET",
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
    expect(raw).not.toContain("sk_live_TOPSECRET");
    expect(raw).not.toContain("enc_json");
    expect(raw).not.toMatch(/"ct"|"iv"/);
  });

  it("normalizes the allowlist to a canonical origin (§6, exact not substring)", async () => {
    const { env } = world();
    await put(env, { name: "mixed", kind: "api-key", secret: "s", allow: "https://API.Stripe.com/v1/charges" });
    expect((await list(env))[0]!.allow).toBe("https://api.stripe.com");
  });

  it("derives Authorization: Bearer {} for api-key when --header is omitted (§5)", async () => {
    const { env } = world();
    await put(env, { name: "derived", kind: "api-key", secret: "s", allow: "https://api.example.com" });
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
      const res = await put(env, { name: "s", kind: "api-key", secret: "s", allow: "https://x.example.com", scope });
      expect(res.status, scope).toBe(400);
      expect(await res.text()).toMatch(/not yet supported/);
    }
  });

  it("rejects an unknown enforcement rung", async () => {
    const { env } = world();
    const res = await put(env, { name: "s", kind: "api-key", secret: "s", allow: "https://x.example.com", enforcement: "trust-me" });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/enforcement must be one of/);
  });

  it("rejects a non-http allow and a header with no {} slot", async () => {
    const { env } = world();
    expect((await put(env, { name: "a", kind: "api-key", secret: "s", allow: "ftp://host" })).status).toBe(400);
    expect(
      (await put(env, { name: "b", kind: "api-key", secret: "s", allow: "https://x.example.com", header: "X-Api-Key no-slot" })).status,
    ).toBe(400);
  });
});

describe("the secret round-trips to the in-worker Bureau (openVaultSecret)", () => {
  it("hands back the value and the whole §5 contract in meta", async () => {
    const { env } = world();
    await put(env, {
      name: "aws-mcp",
      kind: "aws-sigv4",
      secret: "AWS_SECRET_VALUE",
      allow: "*.amazonaws.com",
      enforcement: "narrow",
    });
    const opened = await openVaultSecret(env, PRINCIPAL, "aws-mcp");
    expect(opened?.secret).toBe("AWS_SECRET_VALUE");
    expect(opened?.kind).toBe("aws-sigv4");
    expect(opened?.meta).toMatchObject({ allow: "https://*.amazonaws.com", enforcement: "narrow", scope: "actor" });
  });
});

describe("rotate re-seals under the same name (bureau.md §5)", () => {
  it("swaps the secret while keeping kind/allow/enforcement, and the new secret opens", async () => {
    const { env, db } = world();
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

    // The new secret opens; the contract is untouched.
    const opened = await openVaultSecret(env, PRINCIPAL, "rotate-me");
    expect(opened?.secret).toBe("NEW");
    const view = (await list(env))[0]!;
    expect(view).toMatchObject({ allow: "https://api.example.com", enforcement: "narrow", kind: "api-key" });

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
    await put(env, { name: "health", kind: "api-key", secret: "v1", allow: "https://api.example.com" });
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
    await put(env, { name: "gone", kind: "api-key", secret: "s", allow: "https://api.example.com" });
    const res = await handleVault(req("DELETE", "/vault/credentials/gone"), env);
    expect(await res.json()).toEqual({ deleted: true });
    expect(await list(env)).toHaveLength(0);
  });
});
