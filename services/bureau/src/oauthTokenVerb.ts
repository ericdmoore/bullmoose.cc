import { openCredential } from "./vault.js";
import type { CredentialRef } from "./fetchVerb.js";
import type { Env } from "./models.js";

/**
 * **Class B — `bureau.oauth_token`** (bureau.md §3, s04 T5's first verb).
 *
 * The gap this closes: an `oauth-refresh` credential could be MINTED and
 * sealed since s04 T3, and every attempt to use one answered
 * `501 authorized but not implemented`. So the vault could hold a Google
 * refresh token and nothing in the system could turn it into a request —
 * which is why the first two connectors (#4) split exactly here: Notion
 * issues a static bearer that `fetch` has always handled, and Google
 * Calendar cannot work at all without this.
 *
 * ## What it does, and what it refuses to do
 *
 * Refresh token in the vault → access token on the wire, and **the access
 * token is never returned to the caller either**. That is the same rule the
 * `fetch` verb keeps ("a NAME goes in, a RESULT comes back"), applied one
 * layer up: the agent asks for a *request against an OAuth-protected API*,
 * and gets the response. It does not get a bearer it could then spend
 * anywhere the allowlist does not reach.
 *
 * So this verb is not "hand me a token". It is **exchange-and-spend**, in
 * one hop, inside the Bureau:
 *
 *   1. unseal the refresh token,
 *   2. POST it to the credential's own `token_url` (meta, mint-time — the
 *      caller cannot name the endpoint),
 *   3. take the short-lived access token,
 *   4. issue the caller's request with it, under the SAME allowlist and
 *      the SAME manual-redirect discipline `fetch` uses,
 *   5. discard.
 *
 * ## The cache, and why it is per-credential and in-memory
 *
 * Providers rate-limit refresh exchanges, and an agent doing five calendar
 * reads should not do five token exchanges. The access token is cached for
 * the lifetime of the isolate, keyed by credential, expiring a minute early
 * — never written to D1 or KV, because a durable copy of a live bearer is
 * exactly the thing the vault exists to not have. An isolate recycling
 * costs one extra exchange, which is the correct trade.
 */

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

/** Per-isolate only. Deliberately not exported: nothing else may read it. */
const tokenCache = new Map<string, CachedToken>();

/** A minute of headroom — a token that expires mid-flight reads to the
 *  caller as a random 401 from a service that was working a second ago. */
const EXPIRY_SKEW_MS = 60_000;

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const refuse = (status: number, reason: string): Response => json({ error: reason }, status);

export interface OAuthTokenOptions {
  fetchImpl?: typeof fetch;
  /** Test seam — the cache is per-isolate and otherwise unreachable. */
  now?: () => number;
}

/**
 * Exchange the sealed refresh token for an access token. Returns the token
 * to the CALLER OF THIS FUNCTION (inside the Bureau), never to the agent.
 */
async function accessTokenFor(
  env: Env,
  cred: CredentialRef,
  fetchImpl: typeof fetch,
  now: () => number,
): Promise<{ ok: true; token: string } | { ok: false; status: number; reason: string }> {
  const cacheKey = `${cred.principalId}:${cred.credRef}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAtMs > now()) return { ok: true, token: cached.accessToken };

  const tokenUrl = typeof cred.meta.token_url === "string" ? cred.meta.token_url : "";
  const clientId = typeof cred.meta.client_id === "string" ? cred.meta.client_id : "";
  if (!tokenUrl || !clientId) {
    // Mint-time metadata, not caller input: a credential without them cannot
    // be exchanged, and guessing an endpoint would be inventing a
    // destination the operator never allowed.
    return { ok: false, status: 403, reason: `credential "${cred.credRef}" carries no token_url/client_id` };
  }
  let endpoint: URL;
  try {
    endpoint = new URL(tokenUrl);
  } catch {
    return { ok: false, status: 403, reason: `credential "${cred.credRef}" has an unparseable token_url` };
  }
  if (endpoint.protocol !== "https:") {
    return { ok: false, status: 403, reason: "token_url must be https" };
  }

  const opened = await openCredential(env, cred.principalId, cred.credRef);
  if (!opened) return { ok: false, status: 404, reason: `no credential named ${cred.credRef}` };

  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: opened.secret,
    client_id: clientId,
  });
  // A confidential client's secret rides only if the operator sealed one in
  // meta at mint time. PKCE public clients (the CLI's own flow) have none,
  // and inventing one would break them.
  if (typeof cred.meta.client_secret === "string" && cred.meta.client_secret) {
    form.set("client_secret", cred.meta.client_secret);
  }

  let res: Response;
  try {
    res = await fetchImpl(endpoint.toString(), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: form.toString(),
      redirect: "manual", // a token endpoint that redirects is not one we follow
    });
  } catch (err) {
    return { ok: false, status: 502, reason: `token endpoint unreachable: ${String(err)}` };
  }
  if (!res.ok) {
    // The provider's body can echo the refresh token in an error; only the
    // status crosses back.
    return { ok: false, status: 502, reason: `token exchange failed (${res.status})` };
  }
  let body: { access_token?: unknown; expires_in?: unknown };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    return { ok: false, status: 502, reason: "token endpoint did not return JSON" };
  }
  if (typeof body.access_token !== "string" || !body.access_token) {
    return { ok: false, status: 502, reason: "token endpoint returned no access_token" };
  }
  const lifetimeMs = typeof body.expires_in === "number" ? body.expires_in * 1000 : 3_600_000;
  tokenCache.set(cacheKey, {
    accessToken: body.access_token,
    expiresAtMs: now() + Math.max(0, lifetimeMs - EXPIRY_SKEW_MS),
  });
  return { ok: true, token: body.access_token };
}

/**
 * The verb. `args` is the same shape `fetch` takes — url/method/headers/body
 * — because from the agent's side this IS fetch, against a service that
 * happens to need an exchange first.
 */
export async function runOAuthTokenVerb(
  env: Env,
  cred: CredentialRef,
  rawArgs: unknown,
  options: OAuthTokenOptions = {},
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  if (cred.kind !== "oauth-refresh") {
    return refuse(403, `oauth_token needs an "oauth-refresh" credential; "${cred.credRef}" is "${cred.kind}"`);
  }
  const token = await accessTokenFor(env, cred, fetchImpl, now);
  if (!token.ok) return refuse(token.status, token.reason);

  // The request itself runs through the SAME Class A runtime — allowlist,
  // manual redirects, header-only injection, one exit — by handing it a
  // synthetic credential whose "secret" is the access token. There is no
  // second proxy implementation to keep in step with the first, which is
  // the whole reason this verb is thin.
  const { runFetchVerb } = await import("./fetchVerb.js");
  return runFetchVerb(
    env,
    {
      principalId: cred.principalId,
      credRef: cred.credRef,
      kind: "api-key",
      // The recipe is fixed for OAuth: a bearer, in Authorization. The
      // credential's own `allow` still governs where it may go.
      meta: { ...cred.meta, header: "Authorization: Bearer {}" },
    },
    rawArgs,
    {
      ...options,
      // The access token, not the refresh token — openCredential inside
      // runFetchVerb would unseal the wrong thing.
      secretOverride: token.token,
    },
  );
}

/** Test seam: the cache is per-isolate, so a test that exercises expiry
 *  needs a way back to a clean slate. */
export function __resetOAuthTokenCache(): void {
  tokenCache.clear();
}
