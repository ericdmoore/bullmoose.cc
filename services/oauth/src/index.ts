import { hashLoginKey, isLoginKey, OAUTH_SCOPES, timingSafeEqualHex, unknownScopes } from "@bullmoose/auth-core";
import { beginLoginAttempt } from "@bullmoose/auth-core/loginThrottle";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { consentPage, deriveScript, errorPage } from "./consent.js";
import { AUTH_DOCS, docsResponse } from "./docs.js";
import { recordConsent } from "./consentMirror.js";
import { revoke } from "./revoke.js";
import { webmailSession, type UnwrappedToken } from "./webmailSession.js";
import { anyRedirectMatches, CLAUDE_REDIRECT_URIS, redirectHost } from "./redirects.js";

/**
 * bullmoose's OAuth 2.1 authorization server (s02 T3) — the front door proper.
 *
 * ## The shape
 *
 * `@cloudflare/workers-oauth-provider` owns the protocol: authorization
 * codes, PKCE (S256; plain is rejected by default and we leave it that way),
 * refresh rotation, RFC 9207 `iss`, RFC 8707 resource indicators, RFC 7009
 * revocation, CIMD, and hashed storage of every code and token. We own
 * exactly two things it cannot know:
 *
 *   1. WHO the human at the consent screen is — resolved to a bullmoose
 *      principal, and put into the encrypted `props` the resource server
 *      later reads (the T4 bridge);
 *   2. WHAT the scopes mean, in words, so consent is informed.
 *
 * ## Two token systems, deliberately
 *
 * `bm_` tokens stay for CLI, webmail and JMAP; OAuth tokens are minted and
 * stored by the provider in KV. They meet at ONE point: `props.principalId`.
 * That is what lets us adopt an AS without touching the token model, and it
 * sidesteps every "no refresh concept / no code store / tokens never expire"
 * blocker in a single move.
 *
 * ## What this worker cannot do
 *
 * It has no R2, no Durable Object, no service binding and no SUBMIT. It
 * issues credentials; it must not also be able to spend them. Its D1 binding
 * exists only to resolve a bearer to a principal at consent time.
 */

export interface Env {
  OAUTH_KV: KVNamespace;
  DB: D1Database;
  MCP_RESOURCE_URI: string;
  ISSUER: string;
  DEV_ACCOUNT_ID: string;
  DEV_TENANT_ID: string;
  DEV_USERNAME: string;
  /** The webmail's CIMD client id — the one client `/webmail/session` serves. */
  WEBMAIL_CLIENT_ID: string;
  OAUTH_PROVIDER: {
    parseAuthRequest(request: Request): Promise<AuthRequestLike>;
    lookupClient(clientId: string): Promise<ClientLike | null>;
    completeAuthorization(options: Record<string, unknown>): Promise<{ redirectTo: string }>;
    listUserGrants(
      userId: string,
      options?: { limit?: number; cursor?: string },
    ): Promise<{ items: Array<{ id: string; clientId: string }>; cursor?: string }>;
    revokeGrant(grantId: string, userId: string): Promise<void>;
    unwrapToken(token: string): Promise<UnwrappedToken | null>;
  };
}

interface AuthRequestLike {
  clientId: string;
  redirectUri: string;
  scope: string[];
  state: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  resource?: string;
}

interface ClientLike {
  clientId: string;
  clientName?: string;
  redirectUris: string[];
  logoUri?: string;
  clientUri?: string;
}

/**
 * Everything that is not the token/register/metadata endpoints — which means
 * the authorization endpoint and its consent screen. The provider handles the
 * rest itself.
 */
export const authorizeHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/authorize") {
      return request.method === "POST" ? decide(request, env) : present(request, env);
    }
    // The client-side key derivation. A file rather than an inline script so
    // the password page's CSP can stay `script-src 'self'`.
    if (url.pathname === "/derive.js") return deriveScript();
    // Owner revocation: disconnect a connected app (s02 T4's second half).
    if (url.pathname === "/revoke" && request.method === "POST") return revoke(request, env);
    // The webmail's access-token → bm_ session exchange (s07 T7). The module
    // handles its own OPTIONS/405 because the provider CORS-handles only its
    // own endpoints.
    if (url.pathname === "/webmail/session") return webmailSession(request, env);
    // Documentation at the root and at /docs, for the same reason as the MCP
    // surface: the first thing a developer does with a hostname is open it.
    // /health keeps the bare identifier for anything watching it.
    if (url.pathname === "/" || url.pathname === "/docs") return docsResponse(AUTH_DOCS);
    if (url.pathname === "/health") return new Response("bullmoose-oauth");
    return new Response("not found", { status: 404 });
  },
};

/** GET /authorize — show the human what they are about to authorize. */
async function present(request: Request, env: Env): Promise<Response> {
  let authReq: AuthRequestLike;
  try {
    authReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (err) {
    return errorPage("This authorization request is not valid.", String(err));
  }

  // `lookupClient` THROWS for a CIMD client whose metadata document cannot be
  // fetched or does not validate (CimdFetchError) — an unreachable static
  // asset must render as an error page, not a worker 500.
  let client: ClientLike | null;
  try {
    client = await env.OAUTH_PROVIDER.lookupClient(authReq.clientId);
  } catch (err) {
    return errorPage("This client could not be identified.", String(err));
  }
  if (!client) return errorPage("Unknown client.", `No client is registered as ${authReq.clientId}.`);

  // The redirect URI is checked by the provider too; checking it HERE as well
  // means the consent screen never renders for a destination we would refuse
  // to deliver to — a human should not be asked to approve something that
  // cannot complete.
  if (!anyRedirectMatches(authReq.redirectUri, client.redirectUris)) {
    return errorPage(
      "That redirect address is not registered for this client.",
      `${authReq.redirectUri} is not one of the addresses ${client.clientName ?? authReq.clientId} registered.`,
    );
  }

  // PKCE is mandatory: OAuth 2.1 requires it for public clients, and every
  // client we expect here is public. Refusing early gives a clearer failure
  // than letting the token exchange reject it later.
  if (!authReq.codeChallenge) {
    return errorPage("This client did not use PKCE.", "bullmoose requires PKCE (S256) on every authorization.");
  }

  const bad = unknownScopes(authReq.scope, OAUTH_SCOPES);
  if (bad.length > 0) {
    return errorPage(
      "This client asked for something bullmoose does not grant to apps.",
      `Not available through a connected app: ${bad.join(", ")}.`,
    );
  }

  return consentPage({ client, authReq });
}

/**
 * POST /authorize — the human authenticated and said yes (or no).
 *
 * This is the system's real login: email + password in, a system token out.
 * The password itself never arrives — the browser derives a `loginKey` from
 * it (auth-core's client-side PBKDF2 contract) and the server compares one
 * SHA-256 of that against `credentials.pw_hash`, exactly as `/auth/login`
 * does. Verification is therefore CHEAP, which is right for the CPU budget
 * and hostile without a throttle, so the same `beginLoginAttempt` windows
 * apply here.
 *
 * The invariant that must survive any future rework of this function:
 * `props.principalId` is SERVER-RESOLVED from a verified credential and never
 * read from the form.
 */
async function decide(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const authRequest = safeParse(String(form.get("authRequest") ?? "{}"));
  if (form.get("decision") !== "approve") {
    return errorPage("Not connected.", "You declined, so nothing was shared and no access was granted.");
  }

  const email = String(form.get("email") ?? "")
    .trim()
    .toLowerCase();
  const loginKey = String(form.get("loginKey") ?? "");
  // A form post that skipped the client-side derivation (JS off, or a script
  // posting directly) must not be treated as a password attempt — we have no
  // server-side KDF to fall back on, by design.
  if (!email || !isLoginKey(loginKey)) {
    return retry(form, "Enter your bullmoose address and password.");
  }

  // Same windows as /auth/login: the IP gate is the outer one, so a throttled
  // caller sees the same refusal for every email, existing or not.
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const attempt = await beginLoginAttempt(env.OAUTH_KV, email, ip);
  if (attempt.block === "ip") {
    return errorPage("Too many attempts.", `Try again in ${attempt.retryAfterSeconds} seconds.`, 429);
  }
  if (attempt.block === "email") {
    await attempt.fail();
    return retry(form, INVALID);
  }

  const row = await env.DB.prepare(
    `SELECT p.id, p.login_email, c.pw_hash
     FROM principals p JOIN credentials c ON c.principal_id = p.id
     WHERE p.login_email = ?`,
  )
    .bind(email)
    .first<{ id: string; login_email: string; pw_hash: string }>();
  // Identical response for an unknown address and a wrong password, and
  // identically counted, so the windows trip at the same count either way and
  // neither answer reveals which accounts exist.
  if (!row) {
    await attempt.fail();
    return retry(form, INVALID);
  }
  if (!timingSafeEqualHex(await hashLoginKey(loginKey), row.pw_hash)) {
    await attempt.fail();
    return retry(form, INVALID);
  }
  await attempt.succeed();

  // The scopes are re-validated here rather than trusted: this form is
  // attacker-reachable, so a hidden field claiming `vault` must die against
  // the same list the authorize endpoint checked.
  const scope = String(form.get("scope") ?? "")
    .split(/\s+/)
    .filter(Boolean);
  const bad = unknownScopes(scope, OAUTH_SCOPES);
  if (bad.length > 0) {
    return errorPage("Unavailable permissions were requested.", bad.join(", "));
  }

  // Mirror the consent into D1 BEFORE handing back the redirect (s02 T4).
  // Best-effort and never fatal — see consentMirror.ts — but on the consent
  // path itself, because this is the one moment we are certain a consent
  // happened. A reconciling sweep could fall behind silently, and silence is
  // exactly the failure the mirror exists to prevent.
  await recordConsent(
    env.DB,
    {
      principalId: row.id,
      clientId: authRequest.clientId as string,
      clientName: typeof authRequest.clientName === "string" ? authRequest.clientName : undefined,
      redirectHost: redirectHost(String(authRequest.redirectUri ?? "")),
      scopes: scope,
      resource: env.MCP_RESOURCE_URI,
    },
    Date.now(),
  );

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: authRequest,
    userId: row.id,
    scope,
    metadata: { authorizedAt: Date.now(), loginEmail: row.login_email },
    // The bridge (T4 reads this). Everything the resource server needs to
    // become a principal again, and nothing more — no token it could replay,
    // no authority beyond this grant.
    //
    // `scope` is duplicated here rather than read back off the grant because
    // props is what introspection returns, and the resource server must build
    // its principal from THIS grant's scopes. Taking the human's own scopes
    // instead would silently upgrade every connected app to full account
    // authority.
    props: { principalId: row.id, loginEmail: row.login_email, scope },
  });
  return Response.redirect(redirectTo, 302);
}

/** One message for every credential failure — see the comment at its uses. */
const INVALID = "That address and password did not match.";

/** Re-render the consent screen with an error, preserving the request. */
function retry(form: FormData, message: string): Response {
  const authReq = safeParse(String(form.get("authRequest") ?? "{}")) as unknown as ConsentAuthReq;
  if (typeof authReq?.clientId !== "string") {
    return errorPage("This authorization request expired.", "Start again from your client.");
  }
  return consentPage({
    client: { clientId: authReq.clientId, redirectUris: [] },
    authReq,
    error: message,
  });
}

interface ConsentAuthReq {
  clientId: string;
  redirectUri: string;
  scope: string[];
  state: string;
}

function safeParse(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Token introspection, for the resource server (s02 T4).
 *
 * `OAUTH_KV` is bound HERE and nowhere else — the same discipline as the
 * Bureau's master key. `services/agent` runs every MCP tool and reads
 * untrusted email; giving it the namespace holding every issued credential
 * would hand exactly that worker the token store, which is the arrangement
 * the Bureau split exists to prevent.
 *
 * The library exposes no standalone "is this token valid" call — validation
 * happens only inside the provider's own request path. So this route IS an
 * `apiRoute`: the provider validates the presented bearer before our handler
 * runs, and the handler's whole job is to hand back the identity the provider
 * already proved. A request that gets here at all is authenticated.
 *
 * It needs no shared secret, and is safe even though it answers on the public
 * hostname: the credential required to read a token's identity IS that token,
 * so the only thing a caller can learn is who they already are. Presenting
 * someone else's token would mean already holding it.
 */
const introspectHandler = {
  async fetch(_request: Request, _env: Env, ctx: ExecutionContext & { props?: Record<string, unknown> }) {
    const props = ctx.props ?? {};
    return new Response(JSON.stringify({ active: true, props }), {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  },
};

export default new OAuthProvider<Env>({
  // Keyed to the MCP resource URI, not to a path on this host — which looks
  // odd until you know what the provider does with it.
  //
  // On an apiRoute request the provider computes "which resource server am I"
  // from the REQUEST URL (`oauth-provider.js:2694`) and refuses any token
  // whose audience does not match it. Our tokens are audience-bound to
  // `https://mcp.bullmoose.cc/mcp` — correctly, that is the whole point of
  // RFC 8707 — so an introspection route at `auth.bullmoose.cc/introspect`
  // could never accept one. Audience binding and introspection were in direct
  // conflict, and the T7 harness is what surfaced it.
  //
  // A service binding routes to the bound worker regardless of the URL, and
  // never touches DNS, so the agent worker calls us AT the canonical resource
  // URI. The provider then computes the right resource server and the check
  // passes on its merits rather than being disabled.
  //
  // `matchApiRoute` compares hostname + path prefix for a full-URL route, so
  // a public request to auth.bullmoose.cc/mcp does NOT match this and falls
  // through to the 404 below. The route is reachable over the binding only.
  apiRoute: ["https://mcp.bullmoose.cc/mcp"],
  apiHandler: introspectHandler as never,
  defaultHandler: authorizeHandler as never,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  // DCR stays enabled as a deprecated-but-permitted backstop. Anthropic
  // advise against it because it registers a fresh client per connection —
  // CIMD is the preferred path and is advertised below — but a client that
  // cannot do CIMD should degrade to DCR rather than fail to connect.
  clientRegistrationEndpoint: "/register",
  // Short access tokens with refresh rotation. This is the FIRST place in
  // bullmoose where a token genuinely expires: both self-service bm_ mint
  // sites omit expires_at entirely, so a bm_ token is a permanent credential.
  accessTokenTTL: 3600,
  scopesSupported: [...OAUTH_SCOPES],
  // CIMD requires BOTH signals in the metadata — this flag, and "none" in
  // token_endpoint_auth_methods_supported (which the provider emits for
  // public clients). Miss either and Claude silently falls back to DCR.
  clientIdMetadataDocumentEnabled: true,
  // Audience binding. Sending `resource` is the client's obligation;
  // HONOURING it is ours, and RFC 8707 protects against replay only when the
  // AS supports the capability. Pinning it here makes an omitted resource
  // inherit this value rather than staying unbound.
  resourceMetadata: {
    resource: "https://mcp.bullmoose.cc/mcp",
    authorization_servers: ["https://auth.bullmoose.cc"],
    scopes_supported: [...OAUTH_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "bullmoose mail",
  },
});

export { CLAUDE_REDIRECT_URIS };
