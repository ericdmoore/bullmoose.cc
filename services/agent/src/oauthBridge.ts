import { principalFromGrant, type Principal } from "@bullmoose/auth-core/principal";
import { ToolError } from "./jmapBridge.js";
import type { ToolDef } from "./mcp.js";
import type { Env } from "./models.js";

/**
 * The resource-server half of the OAuth bridge (s02 T4).
 *
 * ## What crosses the seam
 *
 * The AS (`services/oauth`) verified a human's password and put
 * `{ principalId, loginEmail }` into the provider's ENCRYPTED props, stored
 * beside the token. This module turns a validated grant back into a
 * `Principal` — and deliberately carries nothing else across:
 *
 *   - **no token**, so a compromised resource server cannot replay the
 *     human's credential anywhere else;
 *   - **no account list**, which is re-derived from D1 on every request, so
 *     revoking a share or deleting an account takes effect immediately
 *     rather than whenever a token happens to expire;
 *   - **no scope escalation**: the scopes come from THIS grant, not from the
 *     human's own authority. An app granted `read` stays `read` even though
 *     its owner could have granted more.
 *
 * ## Why the audience check is here and not left to the library
 *
 * RFC 8707 protects against a token minted for one resource being replayed at
 * another — but only when both ends do their part. Sending `resource` is the
 * client's obligation and pinning `aud` is the AS's; REFUSING a token whose
 * audience is someone else is ours. The provider validates the token; only
 * this server knows which resource URI it is.
 */

/** Props the AS writes at consent time. Anything not listed is ignored. */
export interface GrantProps {
  principalId?: unknown;
  loginEmail?: unknown;
}

/**
 * A `bm_` bearer is resolved locally; anything else is an OAuth token and
 * goes to the AS. Dispatching on the prefix rather than by trying one and
 * falling back means a failed credential produces ONE clear refusal instead
 * of two confusable ones, and costs no subrequest for the common local case.
 */
export function isLocalToken(raw: string): boolean {
  return raw.startsWith("bm_");
}

/**
 * Ask the AS who this token is (s02 T4).
 *
 * The token store lives only on the AS, so validation is a hop across the
 * OAUTH service binding — the same shape as agent→bureau for the vault key,
 * and for the same reason: this worker reads untrusted email, so the fewer
 * credential-bearing bindings it holds, the less an attacker who reaches it
 * inherits. The cost is one subrequest per OAuth-authenticated MCP call.
 *
 * Returns null for anything that is not a clean, active answer. A validation
 * hop that fails — AS down, network error, malformed body — must REFUSE, never
 * fall through to a weaker check: an availability problem turning into an
 * authorization bypass is the classic fail-open bug.
 */
export async function introspect(
  oauth: Fetcher,
  token: string,
  resourceUri: string,
): Promise<{ props: GrantProps; scopes: string[] } | null> {
  let res: Response;
  try {
    // Called AT the canonical resource URI, not at some path on the AS's own
    // host. The provider decides "which resource server am I" from the request
    // URL and refuses a token whose audience does not match it — so asking at
    // `auth.bullmoose.cc/introspect` would refuse every token we mint, because
    // ours are correctly bound to the MCP resource. The service binding routes
    // to the AS regardless of the URL and never touches DNS, so we address it
    // as the resource and the audience check passes on its merits.
    res = await oauth.fetch(resourceUri, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let body: { active?: unknown; props?: GrantProps; scopes?: unknown };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    return null;
  }
  if (body.active !== true) return null;
  const props = (body.props ?? {}) as GrantProps & { scope?: unknown };
  // The grant's scopes ride inside props, written by the AS at consent time.
  // An unreadable or absent list is treated as an EMPTY grant — which
  // authorizes nothing rather than everything, and surfaces as a clean -32004
  // from the tool gate rather than as accidental authority.
  const scopes = Array.isArray(props.scope)
    ? props.scope.filter((s): s is string => typeof s === "string")
    : [];
  return { props, scopes };
}

export interface ResolvedGrant {
  principal: Principal;
}

/**
 * Is this token's audience us?
 *
 * An absent audience is REFUSED rather than waved through. RFC 8707 makes
 * `resource` optional on the wire, so "no audience" is a token that may have
 * been minted for anything — and the whole point of binding is that a token
 * for another server must not work here. The AS pins `resource` on every
 * grant it issues, so a token from OUR issuer always carries one; an absent
 * audience means the token came from somewhere else's flow.
 */
export function audienceMatches(aud: unknown, canonical: string): boolean {
  const list = Array.isArray(aud) ? aud : aud === undefined || aud === null ? [] : [aud];
  if (list.length === 0) return false;
  return list.some((a) => typeof a === "string" && a === canonical);
}

/**
 * Rebuild the principal an OAuth grant stands for, or null if it cannot be
 * trusted. Null means "refuse", never "fall through to another credential".
 */
export async function principalFromProps(
  env: Env,
  props: GrantProps | undefined,
  scopes: string[],
): Promise<Principal | null> {
  const principalId = props?.principalId;
  if (typeof principalId !== "string" || principalId.length === 0) return null;
  // Scopes are the GRANT's, and an empty grant authorizes nothing — better a
  // clean -32004 from the tool gate than a principal with implicit powers.
  return principalFromGrant(env.DB, principalId, scopes);
}

/**
 * The conversational console's disconnect (s02 T4's second half). Lives HERE
 * rather than in introspectTools deliberately: introspection answers from D1
 * and the principal and is pinned by test to contain no `fetch(` — while this
 * is an ACTION against the authorization server, which is exactly what this
 * module exists to speak to.
 */
export const REVOKE_APP_TOOL: ToolDef = {
  name: "revoke_app",
  scope: "read",
  domain: "mail",
  // Principal-scoped like whoami: it acts on YOUR roster of connected apps,
  // not on an account. Scope stays "read" deliberately — revocation is
  // deny-only, so the worst failure is disconnecting an app that then has to
  // reconnect. An availability bruise, never a breach; the failure direction
  // earns the latitude (the bouncer precedent).
  accountless: true,
  description:
    "Disconnect a connected app (OAuth client): kills its tokens immediately and removes " +
    "it from your connected-apps list. Use who_can_access to see connected apps and their " +
    "client ids first. Requires that YOU authenticated with your bullmoose device token — " +
    "a connected app cannot manage the app roster, including itself; an app wanting to " +
    "revoke only its own token uses the standard OAuth revocation endpoint instead.",
  inputSchema: {
    type: "object",
    properties: {
      clientId: {
        type: "string",
        description:
          "The client id shown in who_can_access's connectedApps (a URL for CIMD clients).",
      },
    },
    required: ["clientId"],
  },
  async run({ env, rawBearer }, args) {
    const clientId = typeof args.clientId === "string" && args.clientId ? args.clientId : null;
    if (!clientId) throw new ToolError("clientId is required — who_can_access lists them.");
    // The AS route authenticates the PRESENTED credential itself and never
    // trusts a relayed identity — so this tool forwards the human's own
    // bearer, and an OAuth-authenticated caller is refused by construction
    // (ToolContext.rawBearer is only set on the bm_ path).
    if (!rawBearer) {
      throw new ToolError(
        "Refused: managing connected apps requires your own bullmoose device token (bm_…). " +
          "You are calling through a connected app's OAuth credential, and a connected app " +
          "may not disconnect apps — that would be a confused deputy with a kill switch. " +
          "Run this from the CLI or webmail console, or POST to auth.bullmoose.cc/revoke " +
          "with your device token.",
      );
    }
    let res: Response;
    try {
      res = await env.OAUTH.fetch("https://auth.bullmoose.cc/revoke", {
        method: "POST",
        headers: { authorization: `Bearer ${rawBearer}`, "content-type": "application/json" },
        body: JSON.stringify({ clientId }),
      });
    } catch (err) {
      throw new ToolError(
        `The authorization server could not be reached: ${String(err).slice(0, 120)}`,
      );
    }
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean;
      revokedGrants?: number;
      mirroredConsents?: number;
      error?: string;
    } | null;
    if (!res.ok || !body?.ok) {
      throw new ToolError(`Revocation failed (${res.status}): ${body?.error ?? "unknown error"}`);
    }
    return {
      clientId,
      revokedGrants: body.revokedGrants ?? 0,
      mirroredConsents: body.mirroredConsents ?? 0,
      notes: [
        body.revokedGrants
          ? "The app's access and refresh tokens are dead as of now — not at their natural expiry."
          : "No live grants matched that client id. Check who_can_access for the exact id; " +
            "an already-revoked app reports zero.",
        "The app can reconnect only by going through consent again.",
      ],
    };
  },
};
