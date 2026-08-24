import { describe, expect, it } from "vitest";
import { fakeEnv } from "@bullmoose/test-fakes";
import { mintToken } from "@bullmoose/auth-core";
import { verifyTokenRow } from "@bullmoose/auth-core/principal";

// #227 / `023`'s pre-ship ask, paid — and the drift it was protecting
// against, pinned. The vault hand-rolled the same `tokens ⋈ principals`
// join and had already diverged: it never stamped `last_used_at`, so a
// token used ONLY for vault calls read as dormant on every "last seen"
// surface s37 built. One implementation means one liveness rule.

const PRINCIPAL = "p_v";

async function world() {
  const w = fakeEnv();
  await w.env.DB.prepare(
    `INSERT INTO tenants (id, name, created_at) VALUES ('t_bm','bm',1) ON CONFLICT(id) DO NOTHING`,
  ).run();
  await w.env.DB.prepare(
    `INSERT INTO principals (id, tenant_id, login_email, created_at) VALUES (?, 't_bm', 'v@bm.cc', 1)`,
  )
    .bind(PRINCIPAL)
    .run();
  const t = await mintToken();
  await w.env.DB.prepare(
    `INSERT INTO tokens (id, principal_id, secret_hash, name, scopes, created_at) VALUES (?, ?, ?, 'vault-box', ?, 1)`,
  )
    .bind(t.id, PRINCIPAL, t.secretHash, JSON.stringify(["vault"]))
    .run();
  return { w, token: t.token, tokenId: t.id };
}

describe("the shared token core", () => {
  it("resolves a bearer to its principal, scopes and token id", async () => {
    const { w, token, tokenId } = await world();
    const row = await verifyTokenRow(w.env.DB, token);
    expect(row).toMatchObject({ principalId: PRINCIPAL, loginEmail: "v@bm.cc", tokenId, scopes: ["vault"] });
  });

  it("STAMPS last_used_at — the drift the hand-rolled vault copy carried", async () => {
    const { w, token, tokenId } = await world();
    await verifyTokenRow(w.env.DB, token);
    const [row] = w.db.query<{ last_used_at: number | null }>("SELECT last_used_at FROM tokens WHERE id = ?", tokenId);
    expect(row!.last_used_at).not.toBeNull();
  });

  it("refuses a wrong secret, an unknown id and an expired token alike", async () => {
    const { w, token, tokenId } = await world();
    // Flip the last hex digit to a DIFFERENT one. `slice(0, -1) + "0"` is a
    // no-op one time in sixteen — the token already ends in 0 — and that is
    // a test that passes locally and fails in CI on the sixteenth run.
    const last = token.at(-1)!;
    expect(await verifyTokenRow(w.env.DB, token.slice(0, -1) + (last === "0" ? "1" : "0"))).toBeNull();
    expect(await verifyTokenRow(w.env.DB, "bm_000000000000_" + "0".repeat(48))).toBeNull();
    await w.env.DB.prepare(`UPDATE tokens SET expires_at = 1 WHERE id = ?`).bind(tokenId).run();
    expect(await verifyTokenRow(w.env.DB, token)).toBeNull();
  });
});
