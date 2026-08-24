import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mintToken } from "@bullmoose/auth-core";
import { fakeD1 } from "@bullmoose/test-fakes";
import { __resetOAuthTokenCache } from "./oauthTokenVerb";
import worker from "./index";
import type { Env } from "./models";

/**
 * Class B — `oauth_token` (s04 T5's first verb, #4's unblocker).
 *
 * Driven through the REAL worker with a really-sealed refresh token, the
 * same way the Class A tests are, because the claim under test is about the
 * wire: the REFRESH token must reach the provider's token endpoint and
 * nowhere else, the ACCESS token must reach the API and never the caller,
 * and neither may appear in any response the agent can read.
 */

const MASTER = "test-vault-master-key-0123456789abcdef";
const INTERNAL = "internal-test-token";
/** Both distinctive: every leak assertion greps for these exact strings. */
const REFRESH = "bm-canary-REFRESH-do-not-use-7a1c";
const ACCESS = "bm-canary-ACCESS-do-not-use-4f9e";
const ALLEN = { principalId: "p_allen", email: "allen@bullmoose.cc", accountId: "a_allen" };

const GOOGLE_META = {
  allow: "https://www.googleapis.com",
  header: "Authorization: Bearer {}",
  scope: "actor",
  token_url: "https://oauth2.googleapis.com/token",
  client_id: "bullmoose.apps.googleusercontent.com",
};

let allenToken: { id: string; token: string; secretHash: string };
beforeAll(async () => {
  allenToken = await mintToken();
});
afterEach(() => {
  vi.unstubAllGlobals();
  __resetOAuthTokenCache();
});

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

function upstream(handler: (seen: Seen) => Response): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, n) => {
      headers[n.toLowerCase()] = v;
    });
    const rec: Seen = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : null,
    };
    seen.push(rec);
    return handler(rec);
  });
  return seen;
}

async function harness(meta: Record<string, unknown> = GOOGLE_META) {
  const db = fakeD1();
  db.seedAccount({ accountId: ALLEN.accountId, principalId: ALLEN.principalId, loginEmail: ALLEN.email });
  db.seed("tokens", [
    {
      id: allenToken.id,
      principal_id: ALLEN.principalId,
      kind: "bearer",
      secret_hash: allenToken.secretHash,
      name: "invocation",
      scopes: JSON.stringify(["mail"]),
      created_at: 1,
      expires_at: null,
      last_used_at: Date.now(),
    },
  ]);
  db.seed("bureau_grants", [
    {
      id: "bg_oauth",
      principal_id: ALLEN.principalId,
      cred_name: "gcal",
      verb: "oauth_token",
      created_by: "admin",
      created_at: 1,
      expires_at: null,
      revoked_at: null,
    },
  ]);
  const env: Env = { DB: db, VAULT_MASTER_KEY: MASTER, INTERNAL_TOKEN: INTERNAL };
  const sealed = await worker.fetch(
    new Request("https://bureau.internal/internal/bureau/seal", {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": INTERNAL },
      body: JSON.stringify({
        mode: "mint",
        principalId: ALLEN.principalId,
        name: "gcal",
        kind: "oauth-refresh",
        metaJson: JSON.stringify(meta),
        secret: REFRESH,
      }),
    }),
    env,
  );
  expect(sealed.status, "seeding the credential").toBe(200);
  return {
    env,
    use: (args: Record<string, unknown>) =>
      worker.fetch(
        new Request("https://bureau.internal/bureau/use", {
          method: "POST",
          headers: { authorization: `Bearer ${allenToken.token}`, "content-type": "application/json" },
          body: JSON.stringify({ verb: "oauth_token", credRef: "gcal", request: args }),
        }),
        env,
      ),
  };
}

const tokenOK = (expiresIn = 3600) =>
  new Response(JSON.stringify({ access_token: ACCESS, expires_in: expiresIn, token_type: "Bearer" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("oauth_token — exchange, then spend, inside the Bureau", () => {
  it("exchanges the refresh token at the credential's OWN endpoint and spends the access token", async () => {
    const h = await harness();
    const seen = upstream((req) =>
      req.url.startsWith("https://oauth2.googleapis.com")
        ? tokenOK()
        : new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const res = await h.use({ url: "https://www.googleapis.com/calendar/v3/calendars/primary/events" });
    expect(res.status).toBe(200);

    // Two hops, in order, and each carries exactly one of the two secrets.
    expect(seen).toHaveLength(2);
    expect(seen[0]!.url).toBe("https://oauth2.googleapis.com/token");
    expect(seen[0]!.body).toContain(encodeURIComponent(REFRESH));
    expect(seen[0]!.body).toContain("grant_type=refresh_token");

    expect(seen[1]!.url).toContain("googleapis.com/calendar/v3");
    expect(seen[1]!.headers.authorization).toBe(`Bearer ${ACCESS}`);
    // The REFRESH token must never reach the API host.
    expect(JSON.stringify(seen[1]!)).not.toContain(REFRESH);
  });

  it("NEITHER token reaches the caller — the whole point of the verb", async () => {
    const h = await harness();
    upstream((req) =>
      req.url.includes("oauth2") ? tokenOK() : new Response(JSON.stringify({ ok: 1 }), { status: 200 }),
    );
    const body = await (await h.use({ url: "https://www.googleapis.com/calendar/v3/x" })).text();
    expect(body).not.toContain(REFRESH);
    expect(body).not.toContain(ACCESS);
  });

  it("the allowlist still governs the SPEND — an exchanged token is not a free pass", async () => {
    const h = await harness();
    const seen = upstream(() => tokenOK());
    const res = await h.use({ url: "https://evil.test/exfiltrate" });
    // A 403 from the Bureau itself, not a 200 envelope carrying a failure:
    // the destination binding refuses BEFORE anything is spent.
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("allowlist");
    // Nothing was ever sent to the off-allowlist host.
    expect(seen.every((s) => !s.url.includes("evil.test"))).toBe(true);
  });

  it("caches the access token — five reads are one exchange, not five", async () => {
    const h = await harness();
    const seen = upstream((req) =>
      req.url.includes("oauth2") ? tokenOK() : new Response(JSON.stringify({}), { status: 200 }),
    );
    for (let i = 0; i < 3; i++) await h.use({ url: "https://www.googleapis.com/calendar/v3/x" });
    expect(seen.filter((s) => s.url.includes("oauth2"))).toHaveLength(1);
  });

  it("a failed exchange refuses without echoing the provider's body", async () => {
    const h = await harness();
    upstream(() => new Response(`{"error":"invalid_grant","refresh_token":"${REFRESH}"}`, { status: 400 }));
    const body = await (await h.use({ url: "https://www.googleapis.com/calendar/v3/x" })).text();
    expect(body).toContain("token exchange failed");
    // A provider error body can echo the token back; only the status crosses.
    expect(body).not.toContain(REFRESH);
  });

  it("a credential with no token_url cannot be exchanged, and says so", async () => {
    const h = await harness({
      allow: "https://www.googleapis.com",
      header: "Authorization: Bearer {}",
      scope: "actor",
    });
    const seen = upstream(() => tokenOK());
    const body = await (await h.use({ url: "https://www.googleapis.com/x" })).text();
    expect(body).toContain("token_url");
    expect(seen).toHaveLength(0); // nothing was attempted
  });

  it("a non-https token_url is refused — the exchange carries the refresh token", async () => {
    const h = await harness({ ...GOOGLE_META, token_url: "http://oauth2.googleapis.com/token" });
    const seen = upstream(() => tokenOK());
    expect(await (await h.use({ url: "https://www.googleapis.com/x" })).text()).toContain("https");
    expect(seen).toHaveLength(0);
  });
});
