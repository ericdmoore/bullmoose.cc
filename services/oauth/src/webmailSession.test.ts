import { describe, expect, it } from "vitest";
import { OAUTH_SCOPES, parseToken } from "@bullmoose/auth-core";
import { verifyBearer } from "@bullmoose/auth-core/principal";
import { fakeEnv } from "@bullmoose/test-fakes";
import {
  webmailSession,
  WEBMAIL_SESSION_TOKEN_NAME,
  WEBMAIL_SESSION_TTL_MS,
  type UnwrappedToken,
  type WebmailSessionEnv,
} from "./webmailSession";

// s07 T7: the first-party exchange. The security property under test is WHO
// may exchange: only a grant issued to the webmail's own client id becomes a
// bm_ session. Any other consented client — claude.ai, Claude Code, a DCR
// stranger — keeps its OAuth token and nothing else, because a bm_ token
// reaches JMAP where submission exists, and the MCP surface deliberately has
// no send tool. The exchange must not be the hole in that fence.

const WEBMAIL = "https://app.bullmoose.cc/oauth/client.json";
const RESOURCE = "https://mcp.bullmoose.cc/mcp";

function unwrapped(over: Partial<UnwrappedToken> = {}, props?: Record<string, unknown> | null): UnwrappedToken {
  return {
    userId: "p_eric",
    grantId: "g_1",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    audience: RESOURCE,
    scope: ["mail"],
    grant: {
      clientId: WEBMAIL,
      scope: ["mail"],
      props: props === undefined ? { principalId: "p_eric", loginEmail: "eric@bullmoose.cc", scope: ["mail"] } : props,
      ...(over.grant ?? {}),
    },
    ...over,
  };
}

function world(token: UnwrappedToken | null) {
  const w = fakeEnv();
  w.db.seedAccount({
    accountId: "a_eric",
    tenantId: "t_bm",
    principalId: "p_eric",
    loginEmail: "eric@bullmoose.cc",
    displayName: "Eric",
  });
  const unwrapCalls: string[] = [];
  const env: WebmailSessionEnv = {
    DB: w.db as unknown as D1Database,
    WEBMAIL_CLIENT_ID: WEBMAIL,
    MCP_RESOURCE_URI: RESOURCE,
    OAUTH_PROVIDER: {
      unwrapToken: async (raw: string) => {
        unwrapCalls.push(raw);
        return token;
      },
    },
  };
  return { w, env, unwrapCalls };
}

function post(bearer?: string, origin = "https://app.bullmoose.cc"): Request {
  return new Request("https://auth.bullmoose.cc/webmail/session", {
    method: "POST",
    headers: {
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      origin,
    },
  });
}

const ACCESS = "p_eric:g_1:not-a-real-provider-token";

describe("POST /webmail/session — refusals", () => {
  it("401 without a bearer, and never consults the provider", async () => {
    const { env, unwrapCalls } = world(unwrapped());
    const res = await webmailSession(post(), env);
    expect(res.status).toBe(401);
    expect(unwrapCalls).toEqual([]);
  });

  it("401 for a token the provider does not recognise", async () => {
    const { env, w } = world(null);
    const res = await webmailSession(post(ACCESS), env);
    expect(res.status).toBe(401);
    expect(w.db.writes.filter((x) => x.sql.includes("INSERT INTO tokens"))).toHaveLength(0);
  });

  it("403 for a grant issued to any client that is not the webmail — the send-invariant fence", async () => {
    // claude.ai's own client id, holding a perfectly valid mail-scoped grant.
    // The MCP surface it consented to has no send tool; a bm_ token would.
    const { env, w } = world(
      unwrapped({
        grant: {
          clientId: "https://claude.ai/.well-known/claude-client.json",
          scope: ["mail"],
          props: { principalId: "p_eric", loginEmail: "eric@bullmoose.cc", scope: ["mail"] },
        },
      }),
    );
    const res = await webmailSession(post(ACCESS), env);
    expect(res.status).toBe(403);
    expect(w.db.writes.filter((x) => x.sql.includes("INSERT INTO tokens"))).toHaveLength(0);
  });

  it("403 for a token with the wrong audience, and for one with none — fail closed", async () => {
    for (const audience of ["https://other.example/mcp", undefined]) {
      const base = unwrapped();
      const t: UnwrappedToken = { ...base, ...(audience === undefined ? {} : { audience }) };
      if (audience === undefined) delete (t as { audience?: unknown }).audience;
      const { env } = world(t);
      const res = await webmailSession(post(ACCESS), env);
      expect(res.status, `audience=${String(audience)}`).toBe(403);
    }
  });

  it("403 when the grant names no principal", async () => {
    const { env } = world(unwrapped({}, { loginEmail: "eric@bullmoose.cc", scope: ["mail"] }));
    expect((await webmailSession(post(ACCESS), env)).status).toBe(403);
  });

  it("403 when the grant carries no scopes, or a scope no app can hold", async () => {
    for (const scope of [[], ["vault"], ["admin"], ["mail", "made-up"]]) {
      const { env } = world(unwrapped({}, { principalId: "p_eric", scope }));
      const res = await webmailSession(post(ACCESS), env);
      expect(res.status, JSON.stringify(scope)).toBe(403);
    }
  });

  it("403 when the principal row is gone — a consent must not outlive its account", async () => {
    const { env } = world(unwrapped({}, { principalId: "p_deleted", scope: ["mail"] }));
    expect((await webmailSession(post(ACCESS), env)).status).toBe(403);
  });

  it("405 for GET", async () => {
    const { env } = world(unwrapped());
    const res = await webmailSession(new Request("https://auth.bullmoose.cc/webmail/session"), env);
    expect(res.status).toBe(405);
  });
});

describe("POST /webmail/session — the mint", () => {
  it("mints a bm_ token that verifyBearer accepts, scoped to the grant, expiring", async () => {
    const before = Date.now();
    const { env, w } = world(
      unwrapped({}, { principalId: "p_eric", loginEmail: "eric@bullmoose.cc", scope: ["mail", "contacts"] }),
    );
    const res = await webmailSession(post(ACCESS), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      token: string;
      tokenId: string;
      username: string;
      scopes: string[];
      expiresAt: number;
    };

    // The token is a real bm_ credential …
    expect(parseToken(body.token)).not.toBeNull();
    expect(body.username).toBe("eric@bullmoose.cc");
    expect(body.scopes).toEqual(["mail", "contacts"]);

    // … that the SAME verification path every worker uses accepts, with the
    // grant's scopes and the principal's accounts — the full round trip.
    const principal = await verifyBearer(env.DB, body.token);
    expect(principal).not.toBeNull();
    expect(principal?.username).toBe("eric@bullmoose.cc");
    expect(principal?.scopes).toEqual(["mail", "contacts"]);
    expect(principal?.accounts.map((a) => a.accountId)).toEqual(["a_eric"]);

    // And unlike the paste-a-token door's mints, it EXPIRES.
    expect(body.expiresAt).toBeGreaterThanOrEqual(before + WEBMAIL_SESSION_TTL_MS);
    expect(body.expiresAt).toBeLessThanOrEqual(Date.now() + WEBMAIL_SESSION_TTL_MS);
    const row = w.db.query<{ name: string; expires_at: number | null; scopes: string }>(
      `SELECT name, expires_at, scopes FROM tokens WHERE id = ?`,
      body.tokenId,
    )[0];
    expect(row?.name).toBe(WEBMAIL_SESSION_TOKEN_NAME);
    expect(row?.expires_at).toBe(body.expiresAt);
    expect(JSON.parse(row?.scopes ?? "[]")).toEqual(["mail", "contacts"]);
  });

  it("scopes come from the grant props, never from anything the caller sent", async () => {
    // A caller-controlled body must be inert: the route reads no body at all.
    const { env } = world(unwrapped({}, { principalId: "p_eric", scope: ["read"] }));
    const req = new Request("https://auth.bullmoose.cc/webmail/session", {
      method: "POST",
      headers: { authorization: `Bearer ${ACCESS}`, "content-type": "application/json" },
      body: JSON.stringify({ scopes: ["mail", "admin"] }),
    });
    const res = await webmailSession(req, env);
    const body = (await res.json()) as { scopes: string[] };
    expect(body.scopes).toEqual(["read"]);
  });

  it("every scope the consent screen can grant survives the exchange's re-validation", async () => {
    // OAUTH_SCOPES is the list decide() validated against; the exchange
    // re-checks the same list, so the two can only drift by failing here.
    const { env } = world(unwrapped({}, { principalId: "p_eric", scope: [...OAUTH_SCOPES] }));
    expect((await webmailSession(post(ACCESS), env)).status).toBe(200);
  });

  it("reflects the caller's origin in CORS headers, and preflights", async () => {
    const { env } = world(unwrapped());
    const res = await webmailSession(post(ACCESS, "https://selfhost.example"), env);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://selfhost.example");
    expect(res.headers.get("cache-control")).toBe("no-store");

    const pre = await webmailSession(
      new Request("https://auth.bullmoose.cc/webmail/session", {
        method: "OPTIONS",
        headers: { origin: "https://app.bullmoose.cc" },
      }),
      env,
    );
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("https://app.bullmoose.cc");
    expect(pre.headers.get("access-control-allow-headers") ?? "").toMatch(/authorization/i);
  });
});
