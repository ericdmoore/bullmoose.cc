import { OAUTH_SCOPES } from "@bullmoose/auth-core";
import type { Env } from "./models.js";

/**
 * The front door's discovery half (s02 T1): RFC 9728 Protected Resource
 * Metadata, the `WWW-Authenticate` challenge that points at it, and the
 * Origin check that must not shut out the clients we are building this for.
 *
 * The shape of the handshake this serves, in order:
 *
 *   1. client POSTs /mcp with no credential
 *   2. we answer 401 + WWW-Authenticate: Bearer resource_metadata="…"
 *   3. client GETs that PRM document, reads `authorization_servers[0]`
 *   4. client discovers the AS, does PKCE, comes back with a token
 *
 * Step 2 is load-bearing and easy to get subtly wrong: Anthropic's docs are
 * explicit that Claude does NOT honour `WWW-Authenticate` on a 200, and that
 * a `200 {isError:true}` is read as an application error and handed to the
 * model. A server that answers "unauthorized" with a friendly 200 never
 * triggers an auth prompt — the user just sees the model apologize.
 */

/** RFC 8707 §2: the canonical resource URI. Scheme required, fragment
 *  forbidden, no trailing slash — and it MUST equal the URL the user typed
 *  into Claude, path and all, or discovery silently fails to match. */
export function resourceUri(url: URL, env: Env): string {
  if (env.MCP_RESOURCE_URI) return env.MCP_RESOURCE_URI;
  return `${url.origin}/mcp`;
}

/**
 * The AS that issues tokens for this resource. Claude uses the FIRST entry of
 * `authorization_servers` and does not fall back, so the list stays at one
 * element on purpose (s02 decision 2: a separate `auth.` host).
 *
 * The derivation is a DEV convenience and assumes a two-label registrable
 * domain — it is wrong for `example.co.uk` and meaningless for a
 * `*.workers.dev` URL. Production states `OAUTH_ISSUER` in wrangler.jsonc
 * rather than relying on it; the guess exists so a local run has a sane
 * default, not so a deploy can skip the var.
 */
export function issuer(url: URL, env: Env): string {
  if (env.OAUTH_ISSUER) return env.OAUTH_ISSUER;
  return `${url.protocol}//auth.${url.hostname.split(".").slice(-2).join(".")}`;
}

/**
 * Scopes a third party may ask for — the `scopes_supported` of the RFC 9728
 * protected-resource document, which is how an agent LEARNS what it may
 * request. Under-advertising is not a security bug (the AS validates every
 * request against `OAUTH_SCOPES` regardless) but it is a discoverability one,
 * and on a surface whose primary reader is a machine that is the same kind of
 * defect as shipping prose where a schema belongs.
 *
 * Derived from `OAUTH_SCOPES` minus an explicit deny list, rather than
 * hand-kept beside it. It was hand-kept, and it drifted: `files` shipped in
 * #128 and never reached this list, so the metadata told every agent that the
 * files realm did not exist.
 *
 * `vault` and `admin` are not here because they are not in `OAUTH_SCOPES` at
 * all — the AS will not grant them through a consent screen (s02 decision 4).
 * The deny list below is for scopes the AS *would* grant but that we decline
 * to advertise to strangers; `wellKnown.test.ts` fails if an entry stops being
 * real, so removing one is a decision rather than a deletion.
 */
const NOT_ADVERTISED: Record<string, string> = {
  // The bundle, not a capability: it expands to the six mail verbs, so a
  // stranger asking for it is asking for all of them without naming them.
  // `/auth/login`'s default, deliberately not a connected-app request.
  mail: "a bundle — a third party should name the verbs it wants",
  // Irreversible and unattended. `delete` through a consent screen is the one
  // grant whose mistake cannot be walked back by revoking the grant.
  delete: "irreversible — revoking the grant does not restore the mail",
};

export const PUBLIC_SCOPES: readonly string[] = OAUTH_SCOPES.filter(
  (s) => !(s in NOT_ADVERTISED),
);

/** Exported for the drift test, which asserts every entry is still a real scope. */
export const NOT_ADVERTISED_SCOPES = NOT_ADVERTISED;

export function protectedResourceMetadata(url: URL, env: Env): Record<string, unknown> {
  return {
    resource: resourceUri(url, env),
    authorization_servers: [issuer(url, env)],
    bearer_methods_supported: ["header"],
    scopes_supported: [...PUBLIC_SCOPES],
    // Points at the docs THIS worker serves, not at the marketing site. The
    // first value here was `https://bullmoose.cc/docs/mcp`, which returned 200
    // — and served the homepage, because the Astro site answers unknown paths
    // with a catch-all. That is worse than a 404: a developer or agent
    // following it lands on a plausible page, gets no answer, and nothing
    // signals the mistake. A discovery document is a promise; this one now
    // points somewhere that ships in the same upload as the behaviour.
    resource_documentation: `${url.origin}/docs`,
  };
}

/**
 * RFC 9728 §3.1 defines PATH INSERTION, not suffixing: for a resource at
 * `https://host/mcp` the document lives at
 * `https://host/.well-known/oauth-protected-resource/mcp` — the resource
 * path goes AFTER the well-known segment. Clients probe that form first and
 * fall back to the root form, so both are served.
 */
export function isProtectedResourceMetadataPath(pathname: string): boolean {
  return (
    pathname === "/.well-known/oauth-protected-resource" ||
    pathname.startsWith("/.well-known/oauth-protected-resource/")
  );
}

/** The 401 that teaches. Without `resource_metadata` a client has nowhere to
 *  go and the connection attempt just fails. */
export function unauthorized(url: URL, env: Env, detail = "invalid_token"): Response {
  const prm = `${url.origin}/.well-known/oauth-protected-resource${new URL(resourceUri(url, env)).pathname}`;
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32001, message: "unauthorized" },
    }),
    {
      status: 401,
      headers: {
        "content-type": "application/json",
        "www-authenticate": `Bearer error="${detail}", resource_metadata="${prm}"`,
      },
    },
  );
}

/**
 * Anthropic's documented egress range. It is allowlisted explicitly because
 * the two rules in play genuinely conflict:
 *
 *  - the MCP spec says servers MUST validate `Origin` to prevent DNS
 *    rebinding, which is a BROWSER attack;
 *  - claude.ai connects from Anthropic's cloud, not from the user's browser,
 *    and the documented failure mode is an over-strict `Origin` check
 *    rejecting exactly the client we want.
 *
 * Resolution: DNS rebinding needs a browser to be the confused deputy, so
 * the check only means anything when the request actually came from one.
 * A request with no `Origin` is not a browser request and is not the attack.
 */
export const ANTHROPIC_EGRESS_CIDR = "160.79.104.0/21";

/** Is this `Origin` one a browser would send for a cross-site request we
 *  should refuse? Absent → not a browser → not the rebinding attack. */
export function originAllowed(request: Request, url: URL): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  // Non-browser clients occasionally send a literal "null" origin; it is not
  // a site, so it cannot be a rebinding source.
  if (origin === "null") return true;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  // Same-origin is always fine. Anything else browser-shaped is refused —
  // this endpoint has no browser client and needs no CORS.
  return parsed.origin === url.origin;
}

export function handleWellKnown(request: Request, url: URL, env: Env): Response | null {
  if (!isProtectedResourceMetadataPath(url.pathname)) return null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  }
  return new Response(JSON.stringify(protectedResourceMetadata(url, env), null, 1), {
    headers: {
      "content-type": "application/json",
      // Public, cacheable, and small. Discovery runs on every fresh connect
      // and Claude's discovery timeout is ~10s.
      "cache-control": "public, max-age=3600",
    },
  });
}
