import { principalFromGrant, type Principal } from "@bullmoose/auth-core/principal";
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
