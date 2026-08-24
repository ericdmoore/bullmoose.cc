import { describe, expect, it } from "vitest";
import { fakeEnv } from "@bullmoose/test-fakes";
import { mintToken } from "@bullmoose/auth-core";
import { listCredentials, revokeCredential } from "./webauthnManage.js";

// The closer's three rules: own-only with no oracle in the refusals, agents
// never, and the last passkey of a passwordless principal stays put.

const OWNER = "p_owner";
const OTHER = "p_other";

async function world() {
  const w = fakeEnv();
  await w.env.DB.prepare(
    `INSERT INTO tenants (id, name, created_at) VALUES ('t_bm', 'bm', ?) ON CONFLICT(id) DO NOTHING`,
  )
    .bind(Date.now())
    .run();
  for (const [id, email] of [
    [OWNER, "owner@bm.cc"],
    [OTHER, "other@bm.cc"],
  ] as const) {
    await w.env.DB.prepare(`INSERT INTO principals (id, tenant_id, login_email, created_at) VALUES (?, 't_bm', ?, ?)`)
      .bind(id, email, Date.now())
      .run();
  }
  const seedCred = (id: string, principal: string) =>
    w.env.DB.prepare(
      `INSERT INTO webauthn_credentials (id, principal_id, public_key_cose, alg, counter, label, created_at)
       VALUES (?, ?, 'k', -7, 0, 'phone', ?)`,
    )
      .bind(id, principal, Date.now())
      .run();
  await seedCred("cred_a", OWNER);
  await seedCred("cred_b", OWNER);
  await seedCred("cred_z", OTHER);
  const seedToken = async (principal: string, scopes: string[]) => {
    const t = await mintToken();
    await w.env.DB.prepare(
      `INSERT INTO tokens (id, principal_id, secret_hash, name, scopes, created_at) VALUES (?, ?, ?, 't', ?, ?)`,
    )
      .bind(t.id, principal, t.secretHash, JSON.stringify(scopes), Date.now())
      .run();
    return t.token;
  };
  return { w, env: w.env as never, bearer: await seedToken(OWNER, ["read"]), seedToken };
}

const req = (method: string, path: string, bearer?: string) =>
  new Request(`https://auth.bullmoose.cc${path}`, {
    method,
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  });

describe("list/revoke — own only, no oracle, agents never", () => {
  it("lists the caller's own authenticators with last-used honesty, and only theirs", async () => {
    const { env, bearer } = await world();
    const res = await listCredentials(req("GET", "/webauthn/credentials", bearer), env);
    expect(res.status).toBe(200);
    const { credentials } = (await res.json()) as { credentials: Array<{ id: string; lastUsedAt: number | null }> };
    expect(credentials.map((c) => c.id).sort()).toEqual(["cred_a", "cred_b"]);
    expect(credentials[0]!.lastUsedAt).toBeNull(); // "last used", never "active"
  });

  it("no bearer → 401; an agent-scoped token → 403 in as many words", async () => {
    const { env, seedToken } = await world();
    expect((await listCredentials(req("GET", "/webauthn/credentials"), env)).status).toBe(401);
    const agent = await seedToken(OWNER, ["agent"]);
    const res = await listCredentials(req("GET", "/webauthn/credentials", agent), env);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain("owner-only");
  });

  it("revokes an own credential; someone else's answers exactly like a nonexistent one", async () => {
    const { w, env, bearer } = await world();
    const ok = await revokeCredential(req("DELETE", "/webauthn/credentials/cred_a", bearer), env, "cred_a");
    expect(ok.status).toBe(200);
    expect(w.db.query("SELECT id FROM webauthn_credentials WHERE id = 'cred_a'")).toHaveLength(0);
    const theirs = await revokeCredential(req("DELETE", "/webauthn/credentials/cred_z", bearer), env, "cred_z");
    const missing = await revokeCredential(req("DELETE", "/webauthn/credentials/nope", bearer), env, "nope");
    expect(theirs.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await theirs.text()).toBe(await missing.text()); // no oracle in the difference
    expect(w.db.query("SELECT id FROM webauthn_credentials WHERE id = 'cred_z'")).toHaveLength(1);
  });

  it("the last passkey of a PASSWORDLESS principal stays; a legacy-password principal may go to zero", async () => {
    const { w, env, bearer } = await world();
    await revokeCredential(req("DELETE", "/webauthn/credentials/cred_a", bearer), env, "cred_a");
    const last = await revokeCredential(req("DELETE", "/webauthn/credentials/cred_b", bearer), env, "cred_b");
    expect(last.status).toBe(409);
    expect(((await last.json()) as { error: string }).error).toContain("lock the account forever");
    expect(w.db.query("SELECT id FROM webauthn_credentials WHERE id = 'cred_b'")).toHaveLength(1);

    // With a password rung present, the same delete is a plain revocation.
    await w.env.DB.prepare(
      `INSERT INTO credentials (principal_id, pw_algo, pw_hash, pw_salt, pw_iters, updated_at)
       VALUES (?, 'pbkdf2', 'h', 's', 1, ?)`,
    )
      .bind(OWNER, Date.now())
      .run();
    const now = await revokeCredential(req("DELETE", "/webauthn/credentials/cred_b", bearer), env, "cred_b");
    expect(now.status).toBe(200);
  });
});
