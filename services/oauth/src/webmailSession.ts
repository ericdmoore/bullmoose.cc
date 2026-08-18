import { mintToken, OAUTH_SCOPES, unknownScopes } from "@bullmoose/auth-core";

/**
 * POST /webmail/session — the first-party exchange that retires the interim
 * door (s07 T7).
 *
 * The webmail is a static site with no server of its own, so it cannot do
 * what the explorer does (`services/jmap/src/explore/oauth.ts`: redeem the
 * code server-side, set a cookie). And the JMAP API authenticates `bm_`
 * tokens only (`verifyBearer` parses that shape and nothing else), so an
 * OAuth access token in the browser cannot drive a mailbox. This route is
 * the bridge between those two facts: the browser completes an ordinary
 * authorization-code + PKCE flow against this AS, presents the access token
 * HERE, and walks away with a `bm_` session token — the credential every
 * other part of the system already understands, stores, lists and revokes.
 *
 * ## Why only the webmail's client id may exchange
 *
 * This is the one rule in the route that is security rather than plumbing.
 * The MCP tool surface deliberately has NO send tool — *agent drafts, human
 * sends* is an invariant (`emailTools.ts:68-90`, pinned by
 * `mcpTools.test.ts:124-128`). But a `bm_` token with the `mail` bundle can
 * reach JMAP directly, where submission exists. If ANY consented client
 * could exchange its access token here, a third party granted `mail` for
 * MCP purposes could laterally mint itself a JMAP credential and send —
 * the exact capability the tool surface withholds. So the exchange is
 * gated to the grant's `clientId`, and the only accepted value is the
 * webmail's own CIMD URL (`WEBMAIL_CLIENT_ID`). A stranger's grant gets a
 * 403 and keeps exactly what it consented to.
 *
 * ## What the human sees afterwards
 *
 * Two artifacts, each visible and revocable in its own listing:
 *   - the OAuth grant ("bullmoose webmail" under connected apps, mirrored
 *     to `oauth_consents`) — revoked via POST /revoke;
 *   - the minted `bm_` row (named "webmail session" in `bullmoose token
 *     list`) — revoked like any device token.
 * Revoking one does not revoke the other; they are separate credentials
 * with separate lifetimes, which is why both are on display.
 *
 * ## Why this worker may mint
 *
 * "This worker issues credentials and must not also be able to spend them"
 * (wrangler.jsonc). A `bm_` session token is a credential ISSUED here and
 * spent elsewhere — the same relationship it already has to every OAuth
 * token in OAUTH_KV, now expressed in the row shape the rest of the system
 * reads. Note the mint is strictly narrowing: the scopes come from the
 * grant's own consented list (validated against OAUTH_SCOPES at the consent
 * screen AND re-checked here), never from the request.
 *
 * A leaf module (no import from index.ts) so it is testable in plain Node:
 * index.ts pulls the provider, and the provider pulls `cloudflare:workers`.
 */

/**
 * The session's lifetime. Unlike the paste-a-token door's `bm_` tokens —
 * which never expire, because neither self-service mint site writes
 * `expires_at` — a signed-in webmail session ends. Thirty days is a browser
 * session bound to a device, not a permanent credential; sign in again and
 * the old row is just an expired row.
 */
export const WEBMAIL_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** The `name` column of the minted row — what `bullmoose token list` shows. */
export const WEBMAIL_SESSION_TOKEN_NAME = "webmail session";

/** The slice of the worker Env this route needs. Structurally satisfied by
 *  index.ts's Env; declared here so tests need no provider import. */
export interface WebmailSessionEnv {
  DB: D1Database;
  /** The webmail's CIMD client id — the ONLY client allowed to exchange. */
  WEBMAIL_CLIENT_ID: string;
  /** The canonical resource URI every token this AS mints is bound to. */
  MCP_RESOURCE_URI: string;
  OAUTH_PROVIDER: {
    unwrapToken(token: string): Promise<UnwrappedToken | null>;
  };
}

/** What `OAUTH_PROVIDER.unwrapToken` hands back for a live access token —
 *  the provider's TokenSummary, narrowed to the fields this route reads. */
export interface UnwrappedToken {
  userId: string;
  grantId: string;
  /** Seconds since epoch (the provider's unit, not ours). */
  expiresAt: number;
  audience?: string | string[];
  scope: string[];
  grant: {
    clientId: string;
    scope: string[];
    /** The T4 bridge props `decide()` sealed at consent. */
    props: Record<string, unknown> | null;
  };
}

export async function webmailSession(request: Request, env: WebmailSessionEnv): Promise<Response> {
  // Preflight. The provider CORS-handles only its own endpoints (token,
  // register, metadata, api routes); default-handler routes answer for
  // themselves. The POST carries an Authorization header, so the browser
  // always preflights.
  if (request.method === "OPTIONS") {
    return withCors(request, new Response(null, { status: 204 }));
  }
  if (request.method !== "POST") {
    return withCors(request, json({ error: "method not allowed" }, 405));
  }

  const authz = request.headers.get("authorization") ?? "";
  const raw = authz.startsWith("Bearer ") ? authz.slice(7) : null;
  if (!raw) {
    return withCors(request, json({ error: "an OAuth access token is required" }, 401));
  }

  // The provider owns the token store; only it can say whether this string
  // is a live access token. `unwrapToken` checks existence and expiry and
  // decrypts the grant props — the same identity the introspection route
  // hands the MCP resource server.
  const token = await env.OAUTH_PROVIDER.unwrapToken(raw).catch(() => null);
  if (!token) {
    return withCors(request, json({ error: "that access token is not valid or has expired" }, 401));
  }

  // The first-party gate — see the header for why this is the load-bearing
  // check. `clientId` is the provider's own record of who the code was
  // issued to (PKCE-bound), never a caller assertion.
  if (token.grant.clientId !== env.WEBMAIL_CLIENT_ID) {
    return withCors(
      request,
      json(
        {
          error:
            "only the bullmoose webmail may exchange an access token for a session — " +
            "connected apps keep the OAuth token they were granted",
        },
        403,
      ),
    );
  }

  // Audience, fail closed. Every token this AS mints is bound to the
  // canonical resource (the provider pins `resource`), so anything else —
  // including a token that somehow carries none — is refused rather than
  // reasoned about.
  const audiences = Array.isArray(token.audience) ? token.audience : token.audience ? [token.audience] : [];
  if (!audiences.includes(env.MCP_RESOURCE_URI)) {
    return withCors(request, json({ error: "that token is not bound to this deployment's resource" }, 403));
  }

  // The bridge props, exactly as decide() sealed them. `props.scope` rather
  // than `grant.scope` for the reason decide() records: props is what THIS
  // grant authorized, and it is the copy the resource server builds a
  // principal from — the session must be built from the same one.
  const props = token.grant.props ?? {};
  const principalId = typeof props.principalId === "string" && props.principalId ? props.principalId : null;
  if (!principalId) {
    return withCors(request, json({ error: "the grant names no principal" }, 403));
  }
  const scopes = Array.isArray(props.scope) ? props.scope.filter((s): s is string => typeof s === "string") : [];
  if (scopes.length === 0) {
    return withCors(request, json({ error: "the grant carries no scopes" }, 403));
  }
  // Re-validated here rather than trusted: consent already checked this
  // list, but a mint site that assumes its input was validated somewhere
  // else is how an invented scope ends up in a stored row.
  const bad = unknownScopes(scopes, OAUTH_SCOPES);
  if (bad.length > 0) {
    return withCors(request, json({ error: `the grant carries scopes no app can hold: ${bad.join(", ")}` }, 403));
  }

  // The principal must still exist — a consent that outlived its account
  // must not resurrect it as a fresh credential.
  const row = await env.DB.prepare(`SELECT id, login_email FROM principals WHERE id = ?`)
    .bind(principalId)
    .first<{ id: string; login_email: string }>();
  if (!row) {
    return withCors(request, json({ error: "no principal" }, 403));
  }

  const minted = await mintToken();
  const now = Date.now();
  const expiresAt = now + WEBMAIL_SESSION_TTL_MS;
  await env.DB.prepare(
    `INSERT INTO tokens (id, principal_id, secret_hash, name, scopes, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(minted.id, row.id, minted.secretHash, WEBMAIL_SESSION_TOKEN_NAME, JSON.stringify(scopes), now, expiresAt)
    .run();

  return withCors(
    request,
    json({
      token: minted.token, // the one and only time it is visible
      tokenId: minted.id,
      username: row.login_email,
      scopes,
      expiresAt,
    }),
  );
}

/**
 * Reflect the caller's Origin, exactly as the provider's own
 * `addCorsHeaders` does for /token — which returns strictly more than this
 * route (a refresh token). The gate is the bearer, not the origin: a page
 * that does not hold a live access token learns nothing here, whatever
 * origin it runs on, and an allowlist would only break every self-hosted
 * deployment whose app lives on a hostname we did not predict.
 */
function withCors(request: Request, res: Response): Response {
  const origin = request.headers.get("origin");
  if (!origin) return res;
  const out = new Response(res.body, res);
  out.headers.set("access-control-allow-origin", origin);
  out.headers.set("access-control-allow-methods", "POST, OPTIONS");
  out.headers.set("access-control-allow-headers", "Authorization, Content-Type");
  out.headers.set("access-control-max-age", "86400");
  out.headers.set("vary", "Origin");
  return out;
}

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
