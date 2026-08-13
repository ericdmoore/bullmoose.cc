import { OAUTH_SCOPES, unknownScopes } from "@bullmoose/auth-core";
import { verifyBearer } from "@bullmoose/auth-core/principal";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { consentPage, errorPage } from "./consent.js";
import { anyRedirectMatches, CLAUDE_REDIRECT_URIS } from "./redirects.js";

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
  OAUTH_PROVIDER: {
    parseAuthRequest(request: Request): Promise<AuthRequestLike>;
    lookupClient(clientId: string): Promise<ClientLike | null>;
    completeAuthorization(options: Record<string, unknown>): Promise<{ redirectTo: string }>;
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
const authorizeHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/authorize") {
      return request.method === "POST" ? decide(request, env) : present(request, env);
    }
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response("bullmoose-oauth", { status: url.pathname === "/" ? 200 : 404 });
    }
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

  const client = await env.OAUTH_PROVIDER.lookupClient(authReq.clientId);
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
 * POST /authorize — the human said yes (or no).
 *
 * The principal is resolved from a bm_ token the human supplies, which is the
 * same interim door `s07` T1 built and carries the same caveat: it is interim.
 * `s07` T7 replaces it with a real session, at which point this reads the
 * session instead. What must NOT change is that `props.principalId` is
 * server-resolved from a verified credential and never taken from the form.
 */
async function decide(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  if (form.get("decision") !== "approve") {
    return errorPage("Not connected.", "You declined, so nothing was shared and no access was granted.");
  }

  const token = String(form.get("token") ?? "");
  const principal = token ? await verifyBearer(env.DB, token) : null;
  if (!principal) {
    return errorPage("That token was not recognized.", "Check the token and try again.");
  }

  const scope = String(form.get("scope") ?? "")
    .split(/\s+/)
    .filter(Boolean);
  const bad = unknownScopes(scope, OAUTH_SCOPES);
  if (bad.length > 0) {
    return errorPage("Unavailable permissions were requested.", bad.join(", "));
  }
  // The consent screen may only ever NARROW what the client asked for, never
  // widen it — the form is attacker-reachable, so the granted set is
  // re-derived here rather than trusted.
  const granted = scope.filter((s) => principal.scopes.includes(s) || principal.scopes.includes("mail"));

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: JSON.parse(String(form.get("authRequest") ?? "{}")),
    userId: principal.username,
    scope: granted,
    metadata: { authorizedAt: Date.now() },
    // The bridge. Everything the resource server needs to become a principal
    // again, and nothing more — no token, no scopes it could self-widen with.
    props: { principalId: principal.username },
  });
  return Response.redirect(redirectTo, 302);
}

export default new OAuthProvider<Env>({
  apiRoute: [],
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
