import { beforeAll, describe, expect, it } from "vitest";
import { mintToken } from "@bullmoose/auth-core";
import { fakeEnv } from "@bullmoose/test-fakes";
import { revoke, type RevokeEnv } from "./revoke";
import { recordConsent } from "./consentMirror";

// s02 T4's second half: connect had no disconnect. These pin the /revoke
// route — the owner killing a connected app's grants and tokens.
//
// The security property under test is WHO decides identity: the route
// authenticates the PRESENTED bearer itself (verifyBearer against D1) and
// never reads a caller-asserted principal id. That is what makes it safe on
// the public hostname, and it is why every test here carries a real minted
// token through real crypto rather than a stubbed identity.

let minted: { id: string; token: string; secretHash: string };
beforeAll(async () => {
  minted = await mintToken();
});

interface GrantRow {
  id: string;
  clientId: string;
}

function world(opts: { grants?: GrantRow[]; pages?: GrantRow[][] } = {}) {
  const w = fakeEnv();
  w.db.seedAccount({
    accountId: "a_eric",
    tenantId: "t_bm",
    principalId: "p_eric",
    loginEmail: "eric@bullmoose.cc",
    displayName: "Eric",
  });
  w.db.seed("tokens", [
    {
      id: minted.id,
      principal_id: "p_eric",
      kind: "bearer",
      secret_hash: minted.secretHash,
      name: "test",
      scopes: JSON.stringify(["read"]),
      created_at: 1,
      expires_at: null,
      last_used_at: Date.now(),
    },
  ]);

  const revoked: Array<{ grantId: string; userId: string }> = [];
  const pages = opts.pages ?? [opts.grants ?? []];
  const listCalls: Array<string | undefined> = [];
  const provider = {
    parseAuthRequest: async () => {
      throw new Error("not under test");
    },
    lookupClient: async () => null,
    completeAuthorization: async () => ({ redirectTo: "" }),
    listUserGrants: async (userId: string, o?: { cursor?: string }) => {
      listCalls.push(o?.cursor);
      const i = o?.cursor ? Number(o.cursor) : 0;
      return {
        items: pages[i]!.map((g) => ({ id: g.id, clientId: g.clientId })),
        cursor: i + 1 < pages.length ? String(i + 1) : undefined,
        userId, // not part of the real shape; handy for asserting below
      } as never;
    },
    revokeGrant: async (grantId: string, userId: string) => {
      revoked.push({ grantId, userId });
    },
  };

  const env = { ...w.env, OAUTH_PROVIDER: provider } as unknown as RevokeEnv;
  return { w, env, revoked, listCalls };
}

const post = (env: RevokeEnv, body: unknown, bearer?: string) =>
  revoke(
    new Request("https://auth.bullmoose.cc/revoke", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(body),
    }),
    env,
  );

describe("POST /revoke", () => {
  it("1. refuses without a credential", async () => {
    const { env } = world();
    expect((await post(env, { clientId: "c" })).status).toBe(401);
  });

  it("2. refuses a bogus bearer — identity is verified here, never relayed", async () => {
    const { env, revoked } = world({ grants: [{ id: "g1", clientId: "c" }] });
    expect((await post(env, { clientId: "c" }, "bm_not_real")).status).toBe(401);
    expect(revoked).toEqual([]);
  });

  it("3. refuses a missing clientId", async () => {
    const { env } = world();
    expect((await post(env, {}, minted.token)).status).toBe(400);
  });

  it("4. revokes every grant for THAT client, and only that client", async () => {
    const { env, revoked } = world({
      grants: [
        { id: "g1", clientId: "https://claude.ai/mcp" },
        { id: "g2", clientId: "other-app" },
        { id: "g3", clientId: "https://claude.ai/mcp" },
      ],
    });
    const res = await post(env, { clientId: "https://claude.ai/mcp" }, minted.token);
    const body = (await res.json()) as { ok: boolean; revokedGrants: number };
    expect(body.ok).toBe(true);
    expect(body.revokedGrants).toBe(2);
    expect(revoked.map((r) => r.grantId).sort()).toEqual(["g1", "g3"]);
    // The principal id is resolved server-side from the verified credential.
    expect(revoked.every((r) => r.userId === "p_eric")).toBe(true);
  });

  it("5. walks pagination — a grant on page two still dies", async () => {
    const { env, revoked, listCalls } = world({
      pages: [[{ id: "g1", clientId: "x" }], [{ id: "g2", clientId: "c" }]],
    });
    const res = await post(env, { clientId: "c" }, minted.token);
    expect(((await res.json()) as { revokedGrants: number }).revokedGrants).toBe(1);
    expect(revoked.map((r) => r.grantId)).toEqual(["g2"]);
    expect(listCalls.length).toBe(2);
  });

  it("6. tombstones the D1 mirror in the same request", async () => {
    // A mirror that lags a revocation shows an app as connected that can no
    // longer act — and the person who just revoked it is exactly the person
    // looking.
    const { w, env } = world({ grants: [{ id: "g1", clientId: "c" }] });
    await recordConsent(w.env.DB, {
      principalId: "p_eric",
      clientId: "c",
      clientName: "Test App",
      scopes: ["read"],
    }, 1000);
    await post(env, { clientId: "c" }, minted.token);
    const rows = w.db.query<{ revoked_at: number | null }>(
      `SELECT revoked_at FROM oauth_consents WHERE client_id = 'c'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.revoked_at).not.toBeNull();
  });

  it("7. zero matches is ok:true with a zero count — idempotent, not an error", async () => {
    const { env } = world({ grants: [] });
    const res = await post(env, { clientId: "never-connected" }, minted.token);
    const body = (await res.json()) as { ok: boolean; revokedGrants: number };
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.revokedGrants).toBe(0);
  });
});
