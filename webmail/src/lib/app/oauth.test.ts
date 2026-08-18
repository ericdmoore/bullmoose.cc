import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { OAUTH_SCOPES } from "@bullmoose/auth-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { urlWithoutLoginCallback } from "./client";
import {
  AUTH_ISSUER,
  beginLogin,
  CLIENT_ID,
  completeLogin,
  readLoginCallback,
  REDIRECT_URI,
  RESOURCE,
  SESSION_SCOPES,
  signInAvailable,
  type LoginCallback,
} from "./oauth";

// s07 T7 — the real login's flow logic, driven with fakes. The properties
// under test are the ones that make PKCE PKCE: the verifier never travels
// anywhere but the token exchange, the state round-trip is enforced, and the
// stored material is single-use.

const APP = "https://app.bullmoose.cc";
const TOKEN = "bm_0123456789ab_" + "a".repeat(48);

let session: Map<string, string>;
let local: Map<string, string>;

beforeEach(() => {
  session = new Map();
  local = new Map();
  const storage = (map: Map<string, string>) => ({
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  });
  vi.stubGlobal("sessionStorage", storage(session));
  vi.stubGlobal("localStorage", storage(local));
  vi.stubGlobal("location", { origin: APP, href: `${APP}/login`, search: "" });
});
afterEach(() => vi.unstubAllGlobals());

/** The stored in-flight pair, parsed. */
function storedPkce(): { verifier: string; state: string } | null {
  const raw = session.get("bullmoose.login.pkce");
  return raw ? (JSON.parse(raw) as { verifier: string; state: string }) : null;
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ── the client identity, held together across three artifacts ──────────────

describe("the CIMD document, this module, and the AS agree on who the webmail is", () => {
  const doc = JSON.parse(
    readFileSync(fileURLToPath(new URL("../../../public/oauth/client.json", import.meta.url)), "utf8"),
  ) as Record<string, unknown>;

  it("the client id IS the document's own URL", () => {
    expect(doc.client_id).toBe(CLIENT_ID);
    expect(CLIENT_ID.startsWith(`${APP}/`)).toBe(true);
  });

  it("the redirect registry is exactly /login on the app origin — no loopback", () => {
    // A localhost redirect here would let any local process impersonate the
    // one client `/webmail/session` trusts with a JMAP-capable session.
    expect(doc.redirect_uris).toEqual([REDIRECT_URI]);
    expect(REDIRECT_URI).toBe(`${APP}/login`);
  });

  it("declares a public client — PKCE is the binding, there is no secret", () => {
    expect(doc.token_endpoint_auth_method).toBe("none");
    expect(JSON.stringify(doc)).not.toContain("client_secret");
  });

  it("the AS's WEBMAIL_CLIENT_ID names the same document", () => {
    const wrangler = readFileSync(
      fileURLToPath(new URL("../../../../services/oauth/wrangler.jsonc", import.meta.url)),
      "utf8",
    );
    expect(wrangler).toContain(`"WEBMAIL_CLIENT_ID": "${CLIENT_ID}"`);
  });

  it("requests only scopes the consent screen can grant (auth-core OAUTH_SCOPES)", () => {
    // The real list, imported — the same drift test login.test.ts runs
    // against parseToken. A scope outside this list dies at the consent
    // screen with "asked for something bullmoose does not grant to apps".
    for (const s of SESSION_SCOPES) expect(OAUTH_SCOPES).toContain(s);
  });
});

// ── beginLogin ─────────────────────────────────────────────────────────────

describe("beginLogin", () => {
  it("builds an authorize URL of public parameters only, and parks the verifier in sessionStorage", async () => {
    const begun = await beginLogin();
    if (!begun.ok) throw new Error(begun.error);
    const url = new URL(begun.start.authorizeUrl);
    const stored = storedPkce();
    if (!stored) throw new Error("nothing stored");

    expect(url.origin).toBe(AUTH_ISSUER);
    expect(url.pathname).toBe("/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(url.searchParams.get("scope")).toBe(SESSION_SCOPES.join(" "));
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("resource")).toBe(RESOURCE);
    expect(url.searchParams.get("state")).toBe(stored.state);

    // The challenge is the verifier's digest — and the verifier itself is in
    // sessionStorage, NOT localStorage, and NOT anywhere in the URL.
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stored.verifier)));
    expect(url.searchParams.get("code_challenge")).toBe(b64url(digest));
    expect(begun.start.authorizeUrl).not.toContain(stored.verifier);
    expect(local.size).toBe(0);
  });

  it("mints fresh state and verifier per attempt", async () => {
    const a = await beginLogin();
    const first = storedPkce();
    const b = await beginLogin();
    const second = storedPkce();
    if (!a.ok || !b.ok || !first || !second) throw new Error("setup");
    expect(second.state).not.toBe(first.state);
    expect(second.verifier).not.toBe(first.verifier);
  });

  it("refuses on any origin the AS cannot redirect back to, and says why", async () => {
    for (const origin of ["http://localhost:4321", "https://mail.selfhost.example"]) {
      const begun = await beginLogin(origin);
      expect(begun.ok).toBe(false);
      expect(signInAvailable(origin)).toBe(false);
      if (!begun.ok) expect(begun.error).toContain("device token");
    }
    expect(signInAvailable(APP)).toBe(true);
  });

  it("refuses when sessionStorage cannot hold the verifier — no storage, no dance", async () => {
    vi.stubGlobal("sessionStorage", undefined);
    const begun = await beginLogin();
    expect(begun.ok).toBe(false);
  });
});

// ── readLoginCallback ──────────────────────────────────────────────────────

describe("readLoginCallback", () => {
  it("is null for a plain door render, including the dev affordances", () => {
    expect(readLoginCallback("")).toBeNull();
    expect(readLoginCallback("?demo=1")).toBeNull();
    expect(readLoginCallback("?state=alone")).toBeNull();
    expect(readLoginCallback("?code=alone")).toBeNull();
  });

  it("reads a code callback with its issuer", () => {
    expect(readLoginCallback("?code=c1&state=s1&iss=https%3A%2F%2Fauth.bullmoose.cc")).toEqual({
      kind: "code",
      code: "c1",
      state: "s1",
      iss: "https://auth.bullmoose.cc",
    });
  });

  it("reads a denial", () => {
    expect(readLoginCallback("?error=access_denied")).toEqual({
      kind: "denied",
      error: "access_denied",
      description: null,
    });
  });
});

// ── completeLogin ──────────────────────────────────────────────────────────

/** A fake AS: records every request, answers /token then /webmail/session. */
function fakeAs(overrides: { token?: Response; session?: Response } = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    if (url === `${AUTH_ISSUER}/token`) {
      return (
        overrides.token ??
        Response.json({ access_token: "u:g:secret", token_type: "bearer", refresh_token: "r-1", expires_in: 3600 })
      );
    }
    if (url === `${AUTH_ISSUER}/webmail/session`) {
      return overrides.session ?? Response.json({ token: TOKEN, tokenId: "tk_x", expiresAt: 1234567890 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

/** Arrange an in-flight dance, return the callback the AS would send back. */
async function inFlight(): Promise<{ cb: LoginCallback; verifier: string }> {
  const begun = await beginLogin();
  if (!begun.ok) throw new Error(begun.error);
  const stored = storedPkce();
  if (!stored) throw new Error("no pkce stored");
  return {
    cb: { kind: "code", code: "code-1", state: stored.state, iss: AUTH_ISSUER },
    verifier: stored.verifier,
  };
}

describe("completeLogin", () => {
  it("redeems the code with the stored verifier, swaps for a bm_ session, and clears the pkce", async () => {
    const { cb, verifier } = await inFlight();
    const as = fakeAs();
    const done = await completeLogin(cb, as.fetchImpl);

    expect(done).toEqual({ ok: true, token: TOKEN, expiresAt: 1234567890 });
    expect(storedPkce()).toBeNull();

    // The token exchange carried exactly the public identity + the verifier…
    const exchange = new URLSearchParams(String(as.calls[0]?.init.body));
    expect(as.calls[0]?.url).toBe(`${AUTH_ISSUER}/token`);
    expect(exchange.get("grant_type")).toBe("authorization_code");
    expect(exchange.get("code")).toBe("code-1");
    expect(exchange.get("client_id")).toBe(CLIENT_ID);
    expect(exchange.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(exchange.get("code_verifier")).toBe(verifier);
    expect(exchange.get("resource")).toBe(RESOURCE);

    // …and the session exchange presented the access token as a bearer.
    const headers = as.calls[1]?.init.headers as Record<string, string>;
    expect(as.calls[1]?.url).toBe(`${AUTH_ISSUER}/webmail/session`);
    expect(headers.authorization).toBe("Bearer u:g:secret");
  });

  it("never stores the access or refresh token anywhere", async () => {
    const { cb } = await inFlight();
    const done = await completeLogin(cb, fakeAs().fetchImpl);
    expect(done.ok).toBe(true);
    const everything = JSON.stringify([...session.entries(), ...local.entries()]);
    expect(everything).not.toContain("u:g:secret");
    expect(everything).not.toContain("r-1");
    // Storing the RESULT is the island's job (client.ts owns the key) — this
    // module writes no token at all.
    expect(everything).not.toContain(TOKEN);
  });

  it("refuses a state that is not the one this tab minted — and does not redeem the code", async () => {
    const { cb } = await inFlight();
    if (cb.kind !== "code") throw new Error("setup");
    const as = fakeAs();
    const done = await completeLogin({ ...cb, state: "attacker-state" }, as.fetchImpl);
    expect(done.ok).toBe(false);
    expect(as.calls).toHaveLength(0);
  });

  it("the stored pkce is single-use: a replayed callback finds nothing", async () => {
    const { cb } = await inFlight();
    const as = fakeAs();
    expect((await completeLogin(cb, as.fetchImpl)).ok).toBe(true);
    const replay = await completeLogin(cb, as.fetchImpl);
    expect(replay.ok).toBe(false);
    expect(as.calls).toHaveLength(2); // the first run's two calls, none for the replay
  });

  it("is single-use even when the exchange FAILS — the verifier is spent, not retried", async () => {
    const { cb } = await inFlight();
    const as = fakeAs({ token: Response.json({ error: "invalid_grant" }, { status: 400 }) });
    const done = await completeLogin(cb, as.fetchImpl);
    expect(done.ok).toBe(false);
    expect(storedPkce()).toBeNull();
  });

  it("refuses a callback naming a different issuer (RFC 9207) without redeeming the code", async () => {
    const { cb } = await inFlight();
    if (cb.kind !== "code") throw new Error("setup");
    const as = fakeAs();
    const done = await completeLogin({ ...cb, iss: "https://evil.example" }, as.fetchImpl);
    expect(done.ok).toBe(false);
    expect(as.calls).toHaveLength(0);
  });

  it("reports a denial in words, without any network traffic", async () => {
    await inFlight();
    const as = fakeAs();
    const done = await completeLogin({ kind: "denied", error: "access_denied", description: null }, as.fetchImpl);
    expect(done.ok).toBe(false);
    if (!done.ok) expect(done.error).toContain("cancelled");
    expect(as.calls).toHaveLength(0);
    // A denial also ends the in-flight attempt.
    expect(storedPkce()).toBeNull();
  });

  it("refuses a session response whose token is not bm_-shaped", async () => {
    const { cb } = await inFlight();
    const as = fakeAs({ session: Response.json({ token: "u:g:not-a-bm-token" }) });
    const done = await completeLogin(cb, as.fetchImpl);
    expect(done.ok).toBe(false);
  });

  it("names invalid_grant for what it is: an expired sign-in", async () => {
    const { cb } = await inFlight();
    const as = fakeAs({ token: Response.json({ error: "invalid_grant" }, { status: 400 }) });
    const done = await completeLogin(cb, as.fetchImpl);
    if (done.ok) throw new Error("should refuse");
    expect(done.error).toContain("expired");
  });
});

// ── the address bar after the callback ─────────────────────────────────────

describe("urlWithoutLoginCallback strips the whole callback, and only the callback", () => {
  it("removes code, state and iss in one pass", () => {
    expect(urlWithoutLoginCallback(`${APP}/login?code=c1&state=s1&iss=x`)).toBe(`${APP}/login`);
  });

  it("removes an error callback too — a reload must not replay a dead denial", () => {
    expect(urlWithoutLoginCallback(`${APP}/login?error=access_denied&error_description=x`)).toBe(`${APP}/login`);
  });

  it("preserves unrelated params and reports nothing to do", () => {
    expect(urlWithoutLoginCallback(`${APP}/login?code=c1&demo=1`)).toBe(`${APP}/login?demo=1`);
    expect(urlWithoutLoginCallback(`${APP}/login`)).toBeNull();
    expect(urlWithoutLoginCallback("not a url")).toBeNull();
  });
});
