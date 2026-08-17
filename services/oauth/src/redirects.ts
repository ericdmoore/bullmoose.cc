/**
 * Redirect-URI policy (s02 T3).
 *
 * Redirect matching is the single most security-critical string comparison in
 * OAuth: it is what stops an attacker who can start a flow from having the
 * authorization code delivered to themselves. The default is therefore EXACT
 * comparison, and every relaxation below is a named, justified exception —
 * not a convenience.
 */

/** claude.ai web, Desktop, mobile and Cowork all land here. */
export const CLAUDE_WEB_REDIRECT = "https://claude.ai/api/mcp/auth_callback";

/**
 * Claude Code runs a loopback listener on an EPHEMERAL port and its CIMD
 * declares no port, so an exact match is impossible by construction.
 *
 * RFC 8252 §7.3 mandates port-agnostic matching for the IP-literal loopback
 * form — the port is chosen at runtime and cannot be pre-registered. We apply
 * the same rule to the `localhost` hostname, which RFC 8252 §8.3 discourages
 * (it depends on the resolver rather than the kernel) but Claude Code
 * requires.
 *
 * The relaxation is bounded to exactly this: the PORT. Scheme, host and path
 * still match exactly, and the whole exception applies only to loopback —
 * where "the attacker can bind a port on the user's own machine" already
 * implies a compromise that no redirect check would survive.
 */
export const LOOPBACK_REDIRECTS = [
  "http://localhost/callback",
  "http://127.0.0.1/callback",
] as const;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Is this a loopback URL whose port we are permitted to ignore? */
export function isLoopback(url: URL): boolean {
  return LOOPBACK_HOSTS.has(url.hostname);
}

/**
 * Does `candidate` match `registered`?
 *
 * Exact string equality, except that two loopback URIs agreeing on scheme,
 * host and path match regardless of port. `https` is required for everything
 * that is not loopback — a cleartext redirect off-device would put the
 * authorization code on the wire.
 */
export function redirectUriMatches(candidate: string, registered: string): boolean {
  if (candidate === registered) return true;
  let c: URL;
  let r: URL;
  try {
    c = new URL(candidate);
    r = new URL(registered);
  } catch {
    return false;
  }
  if (!isLoopback(c) || !isLoopback(r)) return false;
  // Loopback is the ONLY place http is acceptable, and even there the two
  // sides must agree on it.
  if (c.protocol !== r.protocol) return false;
  // `localhost` and `127.0.0.1` are registered separately and do NOT match
  // each other: they resolve differently, and treating them as one would let
  // a resolver-level attacker substitute one for the other.
  if (c.hostname !== r.hostname) return false;
  if (c.pathname !== r.pathname) return false;
  // Query and fragment are not part of a registered redirect URI.
  if (c.search !== "" || r.search !== "") return false;
  return true;
}

/** The redirect URIs a first-party Claude client may use. */
export const CLAUDE_REDIRECT_URIS: readonly string[] = [CLAUDE_WEB_REDIRECT, ...LOOPBACK_REDIRECTS];

/** Does any registered URI accept this candidate? */
export function anyRedirectMatches(candidate: string, registered: readonly string[]): boolean {
  return registered.some((r) => redirectUriMatches(candidate, r));
}

/**
 * The hostname a human must be shown on the consent screen.
 *
 * The MCP spec requires displaying it, and CIMD cannot by itself prevent
 * `localhost` impersonation — any process on the user's machine can serve a
 * metadata document claiming to be anything. "You are about to give X access
 * to your mail, and the code will be delivered to <host>" is the only part of
 * the screen an impersonator cannot forge away.
 */
export function redirectHost(redirectUri: string): string {
  try {
    return new URL(redirectUri).host;
  } catch {
    return redirectUri;
  }
}
