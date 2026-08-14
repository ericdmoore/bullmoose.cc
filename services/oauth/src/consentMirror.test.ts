import { describe, expect, it } from "vitest";
import { fakeEnv } from "@bullmoose/test-fakes";
import { recordConsent, revokeConsent } from "./consentMirror";

// s02 T4 — the mirror exists so the console cannot answer "who can reach my
// mail?" with silence. KV stays canonical for AUTHORIZATION; nothing here is
// ever consulted to decide a request.

function db() {
  const w = fakeEnv();
  w.db.seedAccount({
    accountId: "a_eric",
    tenantId: "t_bm",
    principalId: "p_eric",
    loginEmail: "eric@bullmoose.cc",
    displayName: "Eric",
  });
  return w;
}

const REC = {
  principalId: "p_eric",
  clientId: "https://claude.ai/mcp",
  clientName: "Claude",
  redirectHost: "claude.ai",
  scopes: ["read", "calendar"],
  resource: "https://mcp.bullmoose.cc/mcp",
};

describe("recordConsent", () => {
  it("1. writes a row a human-facing query can find", async () => {
    const w = db();
    const id = await recordConsent(w.env.DB, REC, 1000);
    expect(id).toMatch(/^oc_/);
    const rows = w.db.query<{ client_id: string; scopes: string; revoked_at: number | null }>(
      `SELECT client_id, scopes, revoked_at FROM oauth_consents`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.client_id).toBe("https://claude.ai/mcp");
    expect(JSON.parse(rows[0]!.scopes)).toEqual(["read", "calendar"]);
    expect(rows[0]!.revoked_at).toBeNull();
  });

  it("2. keeps the redirect host — the anti-impersonation fact worth remembering", async () => {
    // CIMD cannot stop a local process claiming to be Claude Code, so where
    // the codes actually went is the part a human can check afterwards.
    const w = db();
    await recordConsent(w.env.DB, REC, 1000);
    const rows = w.db.query<{ redirect_host: string }>(`SELECT redirect_host FROM oauth_consents`);
    expect(rows[0]!.redirect_host).toBe("claude.ai");
  });

  it("3. records THIS grant's scopes, not the human's full authority", async () => {
    const w = db();
    await recordConsent(w.env.DB, { ...REC, scopes: ["read"] }, 1000);
    const rows = w.db.query<{ scopes: string }>(`SELECT scopes FROM oauth_consents`);
    expect(JSON.parse(rows[0]!.scopes)).toEqual(["read"]);
  });

  it("4. DEGRADES rather than throwing when the table predates the migration", async () => {
    // The trade this makes deliberately: an unmirrored grant is bad, but
    // failing a human's login because a reporting write failed is worse.
    const w = fakeEnv();
    w.db.query(`DROP TABLE IF EXISTS oauth_consents`);
    await expect(recordConsent(w.env.DB, REC, 1000)).resolves.toBeNull();
  });
});

describe("revokeConsent", () => {
  it("10. tombstones rather than deleting, so history survives", async () => {
    const w = db();
    await recordConsent(w.env.DB, REC, 1000);
    const n = await revokeConsent(w.env.DB, "p_eric", "https://claude.ai/mcp", 2000);
    expect(n).toBe(1);
    const rows = w.db.query<{ revoked_at: number }>(`SELECT revoked_at FROM oauth_consents`);
    expect(rows).toHaveLength(1); // still there
    expect(rows[0]!.revoked_at).toBe(2000);
  });

  it("11. is scoped to ONE client — revoking Code must not disconnect claude.ai", async () => {
    const w = db();
    await recordConsent(w.env.DB, REC, 1000);
    await recordConsent(w.env.DB, { ...REC, clientId: "http://localhost/callback", clientName: "Claude Code" }, 1001);
    await revokeConsent(w.env.DB, "p_eric", "http://localhost/callback", 2000);
    const live = w.db.query<{ client_id: string }>(`SELECT client_id FROM oauth_consents WHERE revoked_at IS NULL`);
    expect(live.map((r) => r.client_id)).toEqual(["https://claude.ai/mcp"]);
  });

  it("12. is scoped to one PRINCIPAL — revoking mine must not touch yours", async () => {
    const w = db();
    w.db.seedAccount({
      accountId: "a_mom",
      tenantId: "t_bm",
      principalId: "p_mom",
      loginEmail: "mom@bullmoose.cc",
      displayName: "Mom",
    });
    await recordConsent(w.env.DB, REC, 1000);
    await recordConsent(w.env.DB, { ...REC, principalId: "p_mom" }, 1001);
    await revokeConsent(w.env.DB, "p_eric", "https://claude.ai/mcp", 2000);
    const live = w.db.query<{ principal_id: string }>(
      `SELECT principal_id FROM oauth_consents WHERE revoked_at IS NULL`,
    );
    expect(live.map((r) => r.principal_id)).toEqual(["p_mom"]);
  });

  it("13. revoking twice is a no-op, not a second tombstone", async () => {
    const w = db();
    await recordConsent(w.env.DB, REC, 1000);
    await revokeConsent(w.env.DB, "p_eric", "https://claude.ai/mcp", 2000);
    expect(await revokeConsent(w.env.DB, "p_eric", "https://claude.ai/mcp", 3000)).toBe(0);
    const rows = w.db.query<{ revoked_at: number }>(`SELECT revoked_at FROM oauth_consents`);
    expect(rows[0]!.revoked_at).toBe(2000); // the FIRST revocation time survives
  });

  it("14. degrades rather than throwing on a shard without the table", async () => {
    const w = fakeEnv();
    w.db.query(`DROP TABLE IF EXISTS oauth_consents`);
    await expect(revokeConsent(w.env.DB, "p_eric", "c", 1)).resolves.toBe(0);
  });
});
