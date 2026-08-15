import { hasScope } from "@bullmoose/auth-core";
import type { Env } from "../index";
import { b64urlBytes, mintExploreCookie, setCookieHeader } from "./cookie";

/**
 * The explorer as an ORDINARY OAuth client (s21 step 3).
 *
 * `auth.bullmoose.cc` is not a special-cased dependency here — it is the
 * authorization server and this is a client, doing the boring thing:
 * authorization code + PKCE S256, redeemed server-side, exchanged for a
 * credential of the client's own making. The AS cannot set a cookie for
 * another host, so it never tries; the explorer redeems the code and sets its
 * OWN host-only cookie. That asymmetry is the entire reason the separate
 * hostname costs nothing (`.plans/s21-explorer`, open question 1).
 *
 * ## Pre-registered, not DCR
 *
 * The AS enables DCR (`/register`) as a "deprecated-but-permitted backstop"
 * for clients that cannot pre-register. The explorer can: its redirect URI is
 * a fixed `https://` URL known before the first request. Registering per cold
 * start would mint a fresh client id on every deploy, leaving a growing tail
 * of client registrations nobody can enumerate or revoke, and would need a
 * writable store for the id anyway. So the operator runs `/register` ONCE, out
 * of band, and puts the resulting id in `EXPLORE_CLIENT_ID`. DCR is the
 * mechanism that creates the registration; it is not part of the request path.
 *
 * A public client (`token_endpoint_auth_method: "none"`) is the default and
 * PKCE is what binds the code to this client. If the operator registered a
 * confidential client instead, setting `EXPLORE_CLIENT_SECRET` switches the
 * token call to `client_secret_post`; nothing else changes.
 *
 * ## Why the AS is reached over a service binding
 *
 * The same reason `services/agent` does it (`oauthBridge.ts`): the token store
 * lives only on the AS, and the introspection route is an `apiRoute` keyed to
 * the MCP resource URI, so it must be addressed AT that URI. A service binding
 * routes to the bound worker regardless of the URL and never touches DNS —
 * which also means the whole flow is testable with an injected `Fetcher`
 * instead of a network stub.
 *
 * ## What crosses into the cookie
 *
 * The principal id, `["read"]`, and an expiry. **Not the access token.** The
 * explorer redeems it, reads who it belongs to, and throws it away — there is
 * nothing in the cookie to replay against the MCP resource or anywhere else.
 */

const DEFAULT_ISSUER = "https://auth.bullmoose.cc";
const DEFAULT_RESOURCE = "https://mcp.bullmoose.cc/mcp";

/** The one scope the explorer ever asks a human to grant. */
export const EXPLORE_SCOPE = "read";

/** How long an in-flight authorization may take before its state expires. */
const PKCE_TTL_SECONDS = 600;

const pkceKey = (state: string) => `explore:pkce:${state}`;

export interface ExploreConfig {
  host: string;
  clientId: string;
  clientSecret?: string;
  cookieKey: string;
  issuer: string;
  resource: string;
  redirectUri: string;
  oauth: Fetcher;
}

/**
 * Resolve the sign-in configuration, or say exactly what is missing.
 *
 * Returning the missing NAMES is safe (they are configuration keys, not
 * values) and is the difference between "the explorer is broken" and "run
 * `wrangler secret put EXPLORE_COOKIE_KEY`".
 */
export function exploreConfig(env: Env): { ok: true; config: ExploreConfig } | { ok: false; missing: string[] } {
  const missing: string[] = [];
  if (!env.EXPLORE_HOST) missing.push("EXPLORE_HOST");
  if (!env.EXPLORE_CLIENT_ID) missing.push("EXPLORE_CLIENT_ID");
  if (!env.EXPLORE_COOKIE_KEY) missing.push("EXPLORE_COOKIE_KEY");
  if (!env.OAUTH) missing.push("OAUTH (service binding to bullmoose-oauth)");
  if (missing.length > 0) return { ok: false, missing };
  const host = env.EXPLORE_HOST as string;
  return {
    ok: true,
    config: {
      host,
      clientId: env.EXPLORE_CLIENT_ID as string,
      ...(env.EXPLORE_CLIENT_SECRET ? { clientSecret: env.EXPLORE_CLIENT_SECRET } : {}),
      cookieKey: env.EXPLORE_COOKIE_KEY as string,
      issuer: (env.EXPLORE_ISSUER ?? DEFAULT_ISSUER).replace(/\/+$/, ""),
      resource: env.EXPLORE_RESOURCE ?? DEFAULT_RESOURCE,
      redirectUri: `https://${host}/oauth/callback`,
      oauth: env.OAUTH as Fetcher,
    },
  };
}

/**
 * `GET /oauth/start` — begin an authorization.
 *
 * The PKCE verifier goes to KV under a random `state`, never to a cookie: a
 * cookie set before the redirect would have to be `SameSite=Lax` to survive
 * the cross-site return, and there is no reason to weaken anything when the
 * AS already hands `state` back for exactly this purpose. Single-use and
 * ten-minute TTL, so a replayed callback finds nothing.
 */
export async function exploreOauthStart(env: Env): Promise<Response> {
  const cfg = exploreConfig(env);
  if (!cfg.ok) return unconfigured(cfg.missing);

  const state = randomHex(16);
  const verifier = randomHex(32);
  const challenge = b64urlBytes(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );

  await env.ROUTES.put(pkceKey(state), JSON.stringify({ verifier, createdAt: Date.now() }), {
    expirationTtl: PKCE_TTL_SECONDS,
  });

  const authorize = new URL(`${cfg.config.issuer}/authorize`);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", cfg.config.clientId);
  authorize.searchParams.set("redirect_uri", cfg.config.redirectUri);
  authorize.searchParams.set("scope", EXPLORE_SCOPE);
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  // RFC 8707. The AS pins this value anyway when omitted; sending it makes
  // the audience the token is bound to legible at the call site.
  authorize.searchParams.set("resource", cfg.config.resource);

  // Nothing secret is in this URL: client id, redirect, scope, state and the
  // PKCE *challenge* — never the verifier, never a token.
  return new Response(null, {
    status: 302,
    headers: { location: authorize.toString(), "cache-control": "no-store" },
  });
}

/**
 * `GET /oauth/callback?code&state` — redeem, introspect, set the cookie.
 *
 * Every failure below is terminal and says so. A validation hop that cannot
 * complete must REFUSE rather than fall through to a weaker check: an
 * availability problem turning into an authorization bypass is the classic
 * fail-open bug (`oauthBridge.ts` makes the same argument for the MCP door).
 */
export async function exploreOauthCallback(url: URL, env: Env): Promise<Response> {
  const cfg = exploreConfig(env);
  if (!cfg.ok) return unconfigured(cfg.missing);
  const c = cfg.config;

  const asError = url.searchParams.get("error");
  if (asError) {
    return problem(400, "authorization_failed", `${asError}: ${url.searchParams.get("error_description") ?? ""}`.trim());
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return problem(400, "invalid_callback", "code and state are required");

  const stored = (await env.ROUTES.get(pkceKey(state), "json")) as { verifier?: string } | null;
  // Single use. Delete before the exchange, so a replay of the same callback
  // cannot ride the same verifier even if the exchange is slow.
  await env.ROUTES.delete(pkceKey(state));
  if (!stored?.verifier) {
    return problem(400, "unknown_state", "this authorization expired or was already used");
  }

  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: c.redirectUri,
    client_id: c.clientId,
    code_verifier: stored.verifier,
    resource: c.resource,
  });
  if (c.clientSecret) form.set("client_secret", c.clientSecret);

  let tokenRes: Response;
  try {
    tokenRes = await c.oauth.fetch(`${c.issuer}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
  } catch (err) {
    return problem(502, "token_endpoint_unreachable", String(err).slice(0, 200));
  }
  if (!tokenRes.ok) {
    return problem(502, "token_exchange_failed", `the authorization server returned ${tokenRes.status}`);
  }
  const token = (await tokenRes.json().catch(() => null)) as { access_token?: unknown } | null;
  const accessToken = typeof token?.access_token === "string" ? token.access_token : null;
  if (!accessToken) return problem(502, "token_exchange_failed", "no access_token in the response");

  // Who is this? The AS holds the token store, so only it can say. Addressed
  // AT the resource URI so the provider's audience check passes on its merits.
  let who: Response;
  try {
    who = await c.oauth.fetch(c.resource, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}` },
    });
  } catch (err) {
    return problem(502, "introspection_unreachable", String(err).slice(0, 200));
  }
  if (!who.ok) return problem(502, "introspection_failed", `the authorization server returned ${who.status}`);
  const body = (await who.json().catch(() => null)) as
    | { active?: unknown; props?: { principalId?: unknown; scope?: unknown } }
    | null;
  if (body?.active !== true) return problem(403, "inactive_grant", "that authorization is not active");

  const principalId = body.props?.principalId;
  if (typeof principalId !== "string" || principalId.length === 0) {
    return problem(403, "unusable_grant", "the grant names no principal");
  }
  const granted = Array.isArray(body.props?.scope)
    ? (body.props.scope as unknown[]).filter((s): s is string => typeof s === "string")
    : [];
  if (!hasScope(granted, EXPLORE_SCOPE)) {
    return problem(403, "insufficient_scope", `the grant does not include "${EXPLORE_SCOPE}"`);
  }

  // ⚠️ `["read"]` VERBATIM, not the grant's scopes. Narrowing here can never
  // widen anything, and it means the cookie is literally incapable of
  // authorizing a write even if a write method were ever reachable from this
  // surface. The access token is discarded on this line and never stored.
  const value = await mintExploreCookie(c.cookieKey, principalId, [EXPLORE_SCOPE], Date.now());

  return new Response(null, {
    status: 302,
    headers: {
      location: `https://${c.host}/`,
      "set-cookie": setCookieHeader(value),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

function unconfigured(missing: string[]): Response {
  return problem(
    503,
    "explorer_not_configured",
    `sign-in needs: ${missing.join(", ")}. See services/jmap/wrangler.jsonc.`,
  );
}

function problem(status: number, error: string, detail: string): Response {
  return new Response(JSON.stringify({ error, detail }, null, 2), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}
