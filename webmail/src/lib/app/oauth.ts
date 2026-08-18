// Real login (s07 T7): the webmail as a public OAuth 2.1 client.
//
// The AS at `auth.bullmoose.cc` is the system's real login — email + password
// in, a system token out — and it already exists because claude.ai needed it
// (s02 T3). Building a second bespoke webmail login would be building the
// front door twice, so this module makes the webmail an ORDINARY client of
// that AS: authorization code + PKCE S256, exchanged in the browser, then
// swapped at the AS's first-party `/webmail/session` route for the `bm_`
// session token everything else already understands (`bullmoose.token`,
// `isTokenShape`, `FetchJmapClient`).
//
// ## Identity: a client-id metadata document, not a registration
//
// The webmail is a static site; a DCR-minted random client id would have to
// be baked into every build and re-minted per deployment. A CIMD client id is
// a STABLE URL the app itself serves (`public/oauth/client.json`), which the
// AS fetches and validates — no registration step, nothing to drift. The AS
// already supports CIMD because claude.ai uses it. `oauth.test.ts` holds this
// module and that document together.
//
// The registered redirect is exactly `https://app.bullmoose.cc/login` — no
// loopback entry, deliberately: the AS's `/webmail/session` route trusts this
// client id with a JMAP-capable session, and a `localhost` redirect in the
// document would let any local process impersonate the webmail (the CIMD
// impersonation caveat `redirects.ts` documents). Dev and homelab origins use
// the paste-a-token fallback instead, which is why it survives on the door.
//
// ## What never happens here
//
//  - The verifier never enters a URL, localStorage, or any request to any
//    origin except the AS's token endpoint. It lives in sessionStorage —
//    scoped to this tab, dead with it — only long enough for the round trip.
//  - The refresh token in the AS's token response is IGNORED. A refresh
//    credential in browser storage would outlive the page's need for it; the
//    `bm_` session (30 days, then sign in again) is the persistence.
//  - Navigation is the island's job. This module builds `start.authorizeUrl`
//    — the ONE sanctioned external navigation, carrying only public OAuth
//    parameters (tokenInUrl.test.ts names it) — and returns strings.
//
// Everything here is pure-ish (storage + injected fetch); the island
// (`components/LoginForm.tsx`) does the two impure things — `storeSession`
// then `location.assign` — and neither can put a credential in a URL.

import { createPkce } from "../console/credentials";
import { isTokenShape } from "./login";

/** The AS. One deployment, one issuer — a runtime override would let a
 *  phishing page name its own AS, so there deliberately is none. */
export const AUTH_ISSUER = "https://auth.bullmoose.cc";

/** The one origin whose CIMD document names /login as a redirect. */
export const APP_ORIGIN = "https://app.bullmoose.cc";

/** The CIMD client id — the URL of the document the app itself serves.
 *  MIRRORS `webmail/public/oauth/client.json` and the AS's
 *  `WEBMAIL_CLIENT_ID` var; `oauth.test.ts` pins all three together. */
export const CLIENT_ID = `${APP_ORIGIN}/oauth/client.json`;

/** Where the AS sends the code back to. Must match the document exactly. */
export const REDIRECT_URI = `${APP_ORIGIN}/login`;

/** RFC 8707 audience. The AS pins this value anyway when omitted; sending it
 *  makes the binding legible at the call site (explorer precedent). */
export const RESOURCE = "https://mcp.bullmoose.cc/mcp";

/**
 * What the session asks for: the `mail` bundle (which `hasScope` expands to
 * all six mail verbs) plus the three realm scopes the app's sections drive.
 * `vault` is not requestable through consent (and the console's credential
 * operations bounce to the CLI anyway); `agent` is an identity marker, not a
 * capability. The test asserts this list stays within auth-core's
 * OAUTH_SCOPES — the one list the consent screen validates against.
 */
export const SESSION_SCOPES: readonly string[] = ["mail", "contacts", "calendar", "files"];

/**
 * sessionStorage, never localStorage, for the in-flight verifier + state:
 * the pair is a one-shot secret scoped to THIS tab's authorization, and
 * sessionStorage is exactly that scope — unshared across tabs, gone when the
 * tab is. localStorage would leave a live verifier lying around for any
 * later same-origin script to replay.
 */
const PKCE_KEY = "bullmoose.login.pkce";

interface StoredPkce {
  verifier: string;
  state: string;
  startedAt: number;
}

/**
 * Can the hosted sign-in work from this origin? The redirect registry is the
 * reason: the AS delivers codes only to `https://app.bullmoose.cc/login`, so
 * a dev server or tailnet origin that started the dance would strand the
 * user on the production app. Saying so up front beats a confusing bounce.
 */
export function signInAvailable(origin = globalThis.location?.origin ?? ""): boolean {
  return origin === APP_ORIGIN;
}

export interface OAuthStart {
  /** The AS's authorize endpoint: client id, redirect, scope, state and the
   *  PKCE *challenge* — never the verifier, never any token. */
  authorizeUrl: string;
  state: string;
}

export type BeginLogin = { ok: true; start: OAuthStart } | { ok: false; error: string };

/**
 * Start the dance: mint PKCE material, park it in sessionStorage, hand back
 * the authorize URL for the island to navigate to.
 */
export async function beginLogin(origin = globalThis.location?.origin ?? ""): Promise<BeginLogin> {
  if (!signInAvailable(origin)) {
    return {
      ok: false,
      error: `Sign-in returns to ${APP_ORIGIN}, so it only works from there. From this origin, use a device token below.`,
    };
  }

  let pkce: { verifier: string; challenge: string; state: string };
  try {
    // REUSED from the console's credential flow (lib/console/credentials.ts)
    // — the same RFC 7636 S256 material, minted the same way.
    pkce = await createPkce();
  } catch {
    return { ok: false, error: "This browser cannot do PKCE (WebCrypto is unavailable)." };
  }

  if (!writePkce({ verifier: pkce.verifier, state: pkce.state, startedAt: Date.now() })) {
    return {
      ok: false,
      error: "sessionStorage is unavailable, so the sign-in return trip could not be verified. Use a device token.",
    };
  }

  const url = new URL(`${AUTH_ISSUER}/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SESSION_SCOPES.join(" "));
  url.searchParams.set("state", pkce.state);
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", RESOURCE);
  return { ok: true, start: { authorizeUrl: url.toString(), state: pkce.state } };
}

/** What came back on the redirect — or null when this is a plain door render. */
export type LoginCallback =
  | { kind: "code"; code: string; state: string; iss: string | null }
  | { kind: "denied"; error: string; description: string | null };

export function readLoginCallback(search: string): LoginCallback | null {
  const params = new URLSearchParams(search);
  const error = params.get("error");
  if (error) return { kind: "denied", error, description: params.get("error_description") };
  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state) return null;
  return { kind: "code", code, state, iss: params.get("iss") };
}

export type CompleteLogin = { ok: true; token: string; expiresAt: number | null } | { ok: false; error: string };

/**
 * Finish the dance: verify state, redeem the code, swap the access token for
 * a `bm_` session. Returns the token for the ISLAND to store — client.ts is
 * the one owner of `bullmoose.token`, and this module never writes it.
 *
 * The caller must strip the callback params from the address bar FIRST
 * (client.ts `forgetLoginCallbackInUrl`, the app's one history call): an
 * authorization code is a one-exchange bearer, and the same reasoning that
 * keeps a token out of the URL applies for the seconds the code is live.
 */
export async function completeLogin(cb: LoginCallback, fetchImpl?: typeof fetch): Promise<CompleteLogin> {
  const doFetch = (fetchImpl ?? globalThis.fetch).bind(globalThis);

  if (cb.kind === "denied") {
    clearPkce();
    return {
      ok: false,
      error:
        cb.error === "access_denied"
          ? "Sign-in was cancelled. Nothing was shared."
          : `The authorization server refused: ${cb.description ?? cb.error}`,
    };
  }

  // Single use. Read AND delete before anything async — a replayed callback,
  // or the same tab restoring after the exchange, must find nothing to ride
  // (the explorer makes the same move server-side, explore/oauth.ts).
  const stored = readPkce();
  clearPkce();
  if (!stored) {
    return { ok: false, error: "This sign-in expired or was already used — start again." };
  }

  // CSRF: the state must be the one THIS tab minted. A mismatch means the
  // callback was not the answer to our question, and the code in it is
  // someone else's — refuse without redeeming it.
  if (cb.state !== stored.state) {
    return { ok: false, error: "This sign-in did not start in this tab — start again." };
  }

  // RFC 9207: the AS names itself on the callback; a different issuer means
  // a mix-up, and the code must not be presented anywhere.
  if (cb.iss !== null && cb.iss !== AUTH_ISSUER) {
    return { ok: false, error: "The sign-in response came from an unexpected server — start again." };
  }

  let tokenRes: Response;
  try {
    tokenRes = await doFetch(`${AUTH_ISSUER}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: cb.code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: stored.verifier,
        resource: RESOURCE,
      }).toString(),
    });
  } catch {
    return { ok: false, error: "Could not reach the authorization server — check your connection and try again." };
  }
  if (!tokenRes.ok) {
    const detail = await oauthError(tokenRes);
    return {
      ok: false,
      error:
        detail === "invalid_grant"
          ? "The sign-in expired before it completed — start again."
          : `The code exchange failed (${detail}).`,
    };
  }
  const grant = (await tokenRes.json().catch(() => null)) as { access_token?: unknown } | null;
  // The response also carries a refresh token. Deliberately unread: nothing
  // stores it, so nothing can leak it — see the header.
  const accessToken = typeof grant?.access_token === "string" ? grant.access_token : null;
  if (!accessToken) {
    return { ok: false, error: "The authorization server returned no access token." };
  }

  let sessionRes: Response;
  try {
    sessionRes = await doFetch(`${AUTH_ISSUER}/webmail/session`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}` },
    });
  } catch {
    return { ok: false, error: "Signed in, but the session exchange was unreachable — try again." };
  }
  if (!sessionRes.ok) {
    return { ok: false, error: `Signed in, but the session exchange failed (${await oauthError(sessionRes)}).` };
  }
  const session = (await sessionRes.json().catch(() => null)) as {
    token?: unknown;
    expiresAt?: unknown;
  } | null;
  const token = typeof session?.token === "string" ? session.token : null;
  // The same shape gate the door applies to a paste: storing something the
  // resolver will refuse would surface three requests later as a mystery.
  if (!token || !isTokenShape(token)) {
    return { ok: false, error: "The session exchange did not return a usable token." };
  }
  return { ok: true, token, expiresAt: typeof session?.expiresAt === "number" ? session.expiresAt : null };
}

/** Best-effort error naming from an OAuth-shaped error body. */
async function oauthError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: unknown; error_description?: unknown } | null;
  if (typeof body?.error === "string") {
    return typeof body.error_description === "string" ? `${body.error}: ${body.error_description}` : body.error;
  }
  return `HTTP ${res.status}`;
}

// ── storage (guarded like client.ts's — a locked-down browser must degrade,
//    not crash) ─────────────────────────────────────────────────────────────

function readPkce(): StoredPkce | null {
  try {
    const raw = globalThis.sessionStorage?.getItem(PKCE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredPkce>;
    if (typeof parsed.verifier !== "string" || typeof parsed.state !== "string") return null;
    return { verifier: parsed.verifier, state: parsed.state, startedAt: Number(parsed.startedAt) || 0 };
  } catch {
    return null;
  }
}

function writePkce(value: StoredPkce): boolean {
  try {
    const storage = globalThis.sessionStorage;
    if (!storage) return false;
    storage.setItem(PKCE_KEY, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function clearPkce(): void {
  try {
    globalThis.sessionStorage?.removeItem(PKCE_KEY);
  } catch {
    /* non-fatal */
  }
}
