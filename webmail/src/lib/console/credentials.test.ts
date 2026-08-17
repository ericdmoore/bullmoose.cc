import { describe, expect, it } from "vitest";
import {
  CredentialVault,
  VaultError,
  cliCommandFor,
  createPkce,
  entryPlan,
  isRawKeyKind,
  rotateCommandFor,
} from "./credentials";
import { OriginRefusal } from "./origins";

const SITE = "https://mail.bullmoose.cc";
const VAULT = "https://agent.bullmoose.cc";
const SECRET = "sk_live_THIS_IS_THE_SECRET_VALUE";

interface Recorded {
  url: string;
  method: string;
  body: string;
}

/** An instrumented `fetch` that records every request the console makes. */
function recorder(respond: (url: string) => Response = () => json({ ok: true })) {
  const seen: Recorded[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : "",
    });
    return respond(String(input));
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const vault = (fetchImpl: typeof fetch, origins = { vault: VAULT, site: SITE }): CredentialVault =>
  new CredentialVault({ origins, token: "tok_operator", fetch: fetchImpl });

// ── THE assertion devPlan.md T2 asks for ────────────────────────────────────
//
//   "a raw key never appears in a request to the site origin. Assert the second
//    with a test, not a convention."

describe("no secret transits the site backend", () => {
  it("sweeps every operation the console can perform and finds the secret only at the vault", async () => {
    const { seen, fetchImpl } = recorder();
    const v = vault(fetchImpl);

    // Drive EVERY mutation this module offers, including the two that carry
    // entropy. If a new route is added without going through `resolveTarget`,
    // it lands in `seen` and the origin assertion below catches it.
    await v.list();
    await v.mintDirect({ name: "stripe-key", kind: "api-key", allow: "https://api.stripe.com" }, SECRET);
    await v.rotate("stripe-key", SECRET);
    await v.revoke("stripe-key");
    await v.beginOAuth({
      name: "google-oauth",
      kind: "oauth-refresh",
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      clientId: "demo.apps.googleusercontent.com",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    });

    expect(seen.length).toBe(5);

    for (const req of seen) {
      const origin = new URL(req.url).origin;
      // 1. Nothing at all is addressed to the site origin.
      expect(origin, `request to ${req.url}`).not.toBe(SITE);
      // 2. Everything is addressed to the vault.
      expect(origin).toBe(VAULT);
    }

    // 3. The secret material really was sent (otherwise this test proves
    //    nothing), and only to the vault.
    const carrying = seen.filter((r) => r.body.includes(SECRET));
    expect(carrying).toHaveLength(2); // mint + rotate
    for (const r of carrying) expect(new URL(r.url).origin).toBe(VAULT);

    // 4. …and the PKCE verifier, which is credential material of the same class.
    const oauth = seen.find((r) => r.url.endsWith("/vault/oauth/start"));
    expect(oauth).toBeDefined();
    const started = JSON.parse((oauth as Recorded).body) as Record<string, unknown>;
    expect(typeof started.code_verifier).toBe("string");
    expect(new URL((oauth as Recorded).url).origin).toBe(VAULT);
  });

  it("refuses — throws, does not warn — when the vault is misconfigured to the site", async () => {
    const { seen, fetchImpl } = recorder();
    const v = vault(fetchImpl, { vault: SITE, site: SITE });

    await expect(v.mintDirect({ name: "k", kind: "api-key" }, SECRET)).rejects.toThrow(OriginRefusal);
    await expect(v.rotate("k", SECRET)).rejects.toThrow(OriginRefusal);
    // The request was never made — a refusal, not a redirect.
    expect(seen).toHaveLength(0);
  });

  it("refuses when no vault origin is configured at all", async () => {
    const { seen, fetchImpl } = recorder();
    const v = vault(fetchImpl, { vault: "", site: SITE });
    await expect(v.mintDirect({ name: "k", kind: "api-key" }, SECRET)).rejects.toThrow(OriginRefusal);
    expect(seen).toHaveLength(0);
  });

  it("still allows the metadata operations when the vault is unset — reads are not secrets", async () => {
    const { seen, fetchImpl } = recorder();
    const v = vault(fetchImpl, { vault: "", site: SITE });
    await v.revoke("k");
    expect(seen).toHaveLength(1);
    // A DELETE carries no credential material; bureau.md invariant 1 means no
    // response can return one either.
    expect(seen[0]?.body).toBe("");
  });

  it("puts no secret in a URL — header-only injection has a client-side twin", async () => {
    const { seen, fetchImpl } = recorder();
    await vault(fetchImpl).mintDirect({ name: "k", kind: "api-key" }, SECRET);
    expect(seen[0]?.url).not.toContain(SECRET);
    expect(seen[0]?.url).not.toContain("secret=");
  });
});

// ── the deliberate CLI bounce ───────────────────────────────────────────────

describe("raw keys bounce to the CLI", () => {
  it("classifies the three raw-entropy kinds", () => {
    expect(isRawKeyKind("api-key")).toBe(true);
    expect(isRawKeyKind("aws-sigv4")).toBe(true);
    expect(isRawKeyKind("hmac-key")).toBe(true);
    expect(isRawKeyKind("oauth-refresh")).toBe(false);
  });

  it("routes a raw key to the CLI and an OAuth credential to the browser", () => {
    expect(entryPlan("api-key").route).toBe("cli");
    expect(entryPlan("aws-sigv4").route).toBe("cli");
    expect(entryPlan("oauth-refresh").route).toBe("oauth");
    expect(entryPlan("oauth-refresh").reason).toContain("nothing sensitive is ever typed");
  });

  it("emits a command that does not carry the secret on argv", () => {
    const cmd = cliCommandFor({
      name: "aws-mcp",
      kind: "aws-sigv4",
      allow: "https://*.amazonaws.com",
      enforcement: "broad",
    });
    expect(cmd).toContain("bullmoose creds set aws-mcp");
    expect(cmd).toContain("--kind aws-sigv4");
    expect(cmd).toContain("--enforcement broad");
    // bureau.md §5 "Entropy intake hygiene": --secret on argv lands in shell
    // history and `ps`.
    expect(cmd).not.toContain("--secret ");
    expect(cmd).toContain("never appears in argv");
    expect(rotateCommandFor("aws-mcp")).toContain("SAME name");
  });

  it("defaults enforcement to `broad` — the honest assumption (§5.2)", () => {
    expect(cliCommandFor({ name: "k", kind: "api-key" })).toContain("--enforcement broad");
  });
});

// ── OAuth initiation ────────────────────────────────────────────────────────

describe("OAuth initiation", () => {
  it("produces a real S256 challenge and a provider URL that leaks nothing", async () => {
    const { seen, fetchImpl } = recorder();
    const start = await vault(fetchImpl).beginOAuth({
      name: "google-oauth",
      kind: "oauth-refresh",
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      clientId: "cid",
      scopes: ["a", "b"],
    });
    const url = new URL(start.authorizeUrl);
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe("a b");
    // The verifier is NOT in the URL — only its hash.
    const sent = JSON.parse((seen[0] as Recorded).body) as { code_verifier: string };
    expect(url.toString()).not.toContain(sent.code_verifier);
    // The callback is the vault's origin: the authorization code is a bearer
    // for one exchange and must not pass through the site.
    expect(new URL(start.redirectUri).origin).toBe(VAULT);
    expect(url.searchParams.get("redirect_uri")).toBe(start.redirectUri);
  });

  it("generates a distinct verifier and state each time", async () => {
    const a = await createPkce();
    const b = await createPkce();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.state).not.toBe(b.state);
    expect(a.challenge).not.toBe(a.verifier);
    // base64url — no padding, no + or /
    expect(a.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("refuses to begin when the callback could not be a vault URL", async () => {
    const { fetchImpl } = recorder();
    await expect(
      vault(fetchImpl, { vault: SITE, site: SITE }).beginOAuth({
        name: "x",
        kind: "oauth-refresh",
        authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        clientId: "cid",
        scopes: [],
      }),
    ).rejects.toThrow(OriginRefusal);
  });
});

// ── error surfaces ──────────────────────────────────────────────────────────

describe("vault errors", () => {
  it("surfaces the vault's own message rather than a generic failure", async () => {
    const { fetchImpl } = recorder(() => json({ error: 'token lacks the "vault" scope' }, 403));
    await expect(vault(fetchImpl).list()).rejects.toThrow('token lacks the "vault" scope');
  });

  it("reports a missing OAuth route honestly instead of pretending it worked", async () => {
    const { fetchImpl } = recorder(() => json({ error: "not found" }, 404));
    const err = await vault(fetchImpl)
      .beginOAuth({
        name: "x",
        kind: "oauth-refresh",
        authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        clientId: "cid",
        scopes: [],
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VaultError);
    expect((err as VaultError).status).toBe(404);
  });

  it("refuses an empty secret before it reaches the wire", async () => {
    const { seen, fetchImpl } = recorder();
    await expect(vault(fetchImpl).mintDirect({ name: "k", kind: "api-key" }, "")).rejects.toThrow(VaultError);
    await expect(vault(fetchImpl).rotate("k", "")).rejects.toThrow(VaultError);
    expect(seen).toHaveLength(0);
  });
});
