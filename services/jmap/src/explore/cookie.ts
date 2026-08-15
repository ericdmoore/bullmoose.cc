import { timingSafeEqualHex } from "@bullmoose/auth-core";

/**
 * The explorer's session cookie, and ⚠️ THE RULE THAT KEEPS `/api/` SAFE.
 *
 * ## Why a cookie exists here at all
 *
 * Navigating to a URL sends no `Authorization` header, and a token in the URL
 * is forbidden (`webmail/src/lib/app/tokenInUrl.test.ts` — a credential in a
 * query string lands in history, in `Referer`, and in every access log on the
 * path, and cannot be un-logged). So browser-native navigation needs a third
 * auth mode. That mode is this cookie, and it is deliberately the weakest
 * credential in the system:
 *
 *   - it carries `["read"]` and nothing else, whatever the OAuth grant said;
 *   - it lives for MINUTES (`EXPLORE_COOKIE_TTL_SECONDS`), because a
 *     long-lived cookie on a read-everything surface is the thing that would
 *     make this a bad idea;
 *   - it names a principal, never a token — there is nothing in it to replay
 *     anywhere else, and account reach is re-derived from D1 on every request
 *     so a revoked grant stops working immediately;
 *   - it is `HttpOnly; Secure; SameSite=Strict` and host-only (no `Domain=`),
 *     so it is unreadable from script, never leaves TLS, and is not sent on
 *     any cross-site request.
 *
 * ## ⚠️ And then the rule
 *
 * `cookieAuthAllowed` is the whole reason a cookie-authenticated path can
 * exist in a worker that also serves `app.bullmoose.cc/api/`. Read its comment
 * before changing anything in this file.
 */

/** Minutes, not days. A debugging session, not a login. */
export const EXPLORE_COOKIE_TTL_SECONDS = 900;

export const EXPLORE_COOKIE = "bm_explore";

/**
 * What the cookie says. `p` is a principal id, `s` its scopes, `e` the expiry
 * in epoch ms. No token, no account list, no email address.
 */
export interface ExploreSession {
  v: 1;
  p: string;
  s: string[];
  e: number;
}

/**
 * ⚠️ THE RULE (`.plans/s21-explorer`, open question 1).
 *
 * Cookie auth is honoured **only** when the request arrived on the explore
 * hostname **and** the method is GET. The `Host` header is checked EXPLICITLY
 * — the browser's host-only cookie scoping is not enough, because it is a
 * property of well-behaved clients and this check must hold against anything
 * that can open a socket.
 *
 * Without it, a cookie-authenticated path exists on the API origin and
 * `app.bullmoose.cc/api/jmap` becomes CSRF-able: any page on the internet
 * could make a logged-in browser POST `Email/set destroy` with the user's
 * ambient credential. That trades a debugging convenience for a write
 * primitive, which is the worst trade in this document.
 *
 * **Bearer stays the only credential `app.bullmoose.cc/api/` accepts.**
 * `services/jmap/src/index.ts` calls this once, at the single point where the
 * request's principal is resolved, so there is exactly one place to audit —
 * and `explore/csrf.test.ts` presents a valid explore cookie to the API
 * origin, in both GET and POST shapes, and requires a 401.
 *
 * An unset `exploreHost` returns false: the explorer is OFF BY DEFAULT, and a
 * deployment that never configures it has no cookie path at all.
 */
export function cookieAuthAllowed(
  hostHeader: string | null,
  method: string,
  exploreHost: string | undefined,
): boolean {
  if (!exploreHost) return false;
  if (method !== "GET") return false;
  return hostOnly(hostHeader) === exploreHost.trim().toLowerCase();
}

/** `Host:` minus any port, lowercased. `""` when absent — never a match. */
export function hostOnly(hostHeader: string | null): string {
  if (!hostHeader) return "";
  const h = hostHeader.trim().toLowerCase();
  // IPv6 literals are bracketed; the port (if any) follows the bracket.
  const cut = h.startsWith("[") ? h.indexOf("]") + 1 : 0;
  const colon = h.indexOf(":", cut);
  return colon === -1 ? h : h.slice(0, colon);
}

/** Did this request arrive on the explore hostname? Method-independent. */
export function isExploreHost(hostHeader: string | null, exploreHost: string | undefined): boolean {
  if (!exploreHost) return false;
  return hostOnly(hostHeader) === exploreHost.trim().toLowerCase();
}

// ---- the signed value --------------------------------------------------

/**
 * `<base64url(payload)>.<hex hmac>`. HMAC-SHA256 under `EXPLORE_COOKIE_KEY`,
 * a secret held by this worker alone: the AS cannot set a cookie for another
 * host, so it never tries — it hands back an authorization code and the
 * explorer mints its own credential. That is the ordinary OAuth shape, with
 * the explorer as an ordinary client.
 */
export async function mintExploreCookie(
  key: string,
  principalId: string,
  scopes: string[],
  now: number,
  ttlSeconds = EXPLORE_COOKIE_TTL_SECONDS,
): Promise<string> {
  const session: ExploreSession = {
    v: 1,
    p: principalId,
    s: scopes,
    e: now + ttlSeconds * 1000,
  };
  const payload = b64urlEncode(JSON.stringify(session));
  return `${payload}.${await hmacHex(key, payload)}`;
}

/**
 * Verify and decode, or null. Signature first, then expiry, then shape — a
 * forged cookie and an expired one produce the same `null`, so the refusal is
 * not an oracle for which is which.
 */
export async function readExploreCookie(
  key: string,
  raw: string | undefined,
  now: number,
): Promise<ExploreSession | null> {
  if (!raw) return null;
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  if (!timingSafeEqualHex(sig, await hmacHex(key, payload))) return null;

  let session: ExploreSession;
  try {
    session = JSON.parse(b64urlDecode(payload)) as ExploreSession;
  } catch {
    return null;
  }
  if (session.v !== 1) return null;
  if (typeof session.p !== "string" || session.p.length === 0) return null;
  if (!Array.isArray(session.s) || session.s.some((s) => typeof s !== "string")) return null;
  if (typeof session.e !== "number" || session.e <= now) return null;
  return session;
}

/**
 * `Set-Cookie` for a fresh session.
 *
 * No `Domain=` — the cookie must stay HOST-ONLY. A cookie set on
 * `.bullmoose.cc` to be shared between hosts would also be sent to the
 * marketing apex and to `app.bullmoose.cc`, which is exactly wrong for a
 * read-everything credential (and is the second reason the explorer got its
 * own hostname).
 */
export function setCookieHeader(value: string, ttlSeconds = EXPLORE_COOKIE_TTL_SECONDS): string {
  return (
    `${EXPLORE_COOKIE}=${value}; Path=/; Max-Age=${ttlSeconds}; ` +
    "HttpOnly; Secure; SameSite=Strict"
  );
}

/** `Set-Cookie` that removes it. Same attributes, so the browser matches it. */
export function clearCookieHeader(): string {
  return `${EXPLORE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

/** Parse a `Cookie:` header. Last value wins, as browsers send it. */
export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (name.length === 0) continue;
    out[name] = part.slice(eq + 1).trim();
  }
  return out;
}

// ---- crypto helpers ----------------------------------------------------

async function hmacHex(key: string, message: string): Promise<string> {
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", hmacKey, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function b64urlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): string {
  const padded = s.replaceAll("-", "+").replaceAll("_", "/");
  const bin = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** base64url of raw bytes — the PKCE challenge's encoding. */
export function b64urlBytes(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
