/**
 * Online-guess throttle for `POST /auth/login`.
 *
 * WHY IT EXISTS. Verification on that path is deliberately cheap: the
 * 600k-iteration PBKDF2 runs on the CLIENT (auth-core's derivation
 * contract) because Workers Free caps CPU at 10ms, so the server pays
 * exactly one SHA-256 per attempt. Right for the CPU budget, hostile
 * without a throttle — "cheap to verify" is also "cheap to attack", and
 * a single hit mints a long-lived bearer token immediately. A guesser
 * still pays the KDF on their own hardware, but that is GPU-parallel;
 * the server-side window is what actually bounds the guess rate.
 *
 * WHY KV AND NOT D1. A D1 row per FAILED login is a self-inflicted DoS
 * surface: an unauthenticated attacker would drive one control-plane
 * write per attempt against the same database that serves mail. KV
 * writes are cheap, the keys self-collect on expiry, and there is no
 * schema to migrate (this repo has no migration framework — schema is
 * re-applied `CREATE TABLE IF NOT EXISTS`). No audit table is written
 * here for the same reason; if an audit trail is wanted later it should
 * be sampled/asynchronous, not one synchronous write per guess.
 *
 * WHY THE `ROUTES` NAMESPACE. Reusing the binding the jmap worker
 * already holds means no new binding, no `infra/bootstrap.mjs` resource
 * or wire change, and it works on every already-deployed environment.
 * That is not just convenience: `bootstrap.mjs:149` rewrites only the
 * FIRST `"id"` after `"kv_namespaces"`, so a second namespace in
 * `services/jmap/wrangler.jsonc` would be silently clobbered with the
 * ROUTES id (the same hazard filed as infra issue 013). ROUTES is
 * already the shared small-hot-state namespace — submit writes
 * `suppress:<email>`, agent caches models.dev pricing there — and the
 * `login:` prefix below cannot collide with `route:` / `suppress:` /
 * `pricing:`.
 *
 * WHAT IT IS NOT. KV reads are edge-cached (~60s) and writes to one key
 * are rate-limited to roughly one per second, so these counters are a
 * BOUND, not an exact ledger: a burst from one colo can land more than
 * the nominal cap before the count is visible everywhere. Accepted —
 * it turns unbounded online guessing into a small multiple of the cap
 * per window at zero provisioning cost. If that stops being enough, the
 * upgrade is a Durable Object (strongly consistent, one per email) or
 * Cloudflare's native rate-limiting binding for burst control; both slot
 * in behind the `beginLoginAttempt` interface without touching callers.
 */

/** Failures allowed per login email per window before it stops verifying. */
export const EMAIL_MAX_FAILURES = 5;
/** Failures allowed per client IP per window before it is refused outright. */
export const IP_MAX_FAILURES = 20;
/** Window length. A window starts at the FIRST failure and is never extended. */
export const LOGIN_WINDOW_MS = 15 * 60_000;

/** KV rejects an absolute expiration less than 60s out. */
const KV_MIN_EXPIRY_S = 60;
/** RFC 5321 caps a path at 256 octets; anything longer can't be a real login. */
const MAX_KEY_EMAIL_LEN = 256;

interface Window {
  /** Failures recorded so far in this window. */
  n: number;
  /** Epoch ms at which the window (and the KV entry) expires. */
  resetAt: number;
}

export interface LoginAttempt {
  /**
   * `null`  → proceed to verification.
   * `"ip"`  → refuse with 429; carries no per-account information.
   * `"email"` → refuse WITHOUT verifying, but with the ordinary 401 body.
   *
   * The asymmetry is the point. Locking the email window with a distinct
   * status would turn "429 here, 401 there" into an account-existence
   * oracle, undoing the deliberate uniform-401 property of this endpoint.
   * The email window is therefore silent: same status, same body, no
   * D1 read, no hash. Only the IP window — which is keyed on the caller,
   * not on any account — is allowed to change the status code.
   */
  readonly block: null | "ip" | "email";
  /** Seconds until the IP window resets. Only meaningful when block === "ip". */
  readonly retryAfterSeconds: number;
  /**
   * Count this attempt as a failure against BOTH windows. Must be called
   * for every non-success, including unknown-principal — if unknown
   * emails did not count, the IP window would trip only on real accounts
   * and become the enumeration oracle the email window avoids.
   */
  fail(): Promise<void>;
  /** Verified: forget both windows so a recovered user is not held back. */
  succeed(): Promise<void>;
}

/**
 * Read both windows once and hand back the verdict plus the two mutators.
 * Callers get one KV round trip for the decision and at most one more for
 * the outcome; nothing re-reads.
 */
export async function beginLoginAttempt(
  kv: KVNamespace,
  email: string,
  ip: string,
  now: number = Date.now(),
): Promise<LoginAttempt> {
  const emailKey = `login:e:${email.toLowerCase().slice(0, MAX_KEY_EMAIL_LEN)}`;
  const ipKey = `login:i:${ip}`;

  const [emailWin, ipWin] = await Promise.all([read(kv, emailKey, now), read(kv, ipKey, now)]);

  // IP is the outer gate: it is checked first so a throttled caller sees
  // the same 429 for every email, locked or not.
  const ipBlocked = (ipWin?.n ?? 0) >= IP_MAX_FAILURES;
  const emailBlocked = (emailWin?.n ?? 0) >= EMAIL_MAX_FAILURES;

  return {
    block: ipBlocked ? "ip" : emailBlocked ? "email" : null,
    retryAfterSeconds: ipWin ? Math.max(1, Math.ceil((ipWin.resetAt - now) / 1000)) : 1,
    async fail() {
      await Promise.all([write(kv, emailKey, bump(emailWin, now), now), write(kv, ipKey, bump(ipWin, now), now)]);
    },
    async succeed() {
      await Promise.all([kv.delete(emailKey), kv.delete(ipKey)]);
    },
  };
}

/** An expired or unparseable entry reads as "no window" — fail open, then re-arm. */
async function read(kv: KVNamespace, key: string, now: number): Promise<Window | null> {
  const raw = await kv.get(key);
  if (!raw) return null;
  let win: unknown;
  try {
    win = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof win !== "object" || win === null) return null;
  const { n, resetAt } = win as Partial<Window>;
  if (typeof n !== "number" || typeof resetAt !== "number") return null;
  // KV expiry is lazy and floored at 60s, so the window is enforced here too.
  return resetAt > now ? { n, resetAt } : null;
}

/**
 * The window starts at the first failure and is NEVER extended — otherwise
 * an attacker could hold a victim's login shut indefinitely by keeping the
 * counter warm.
 */
function bump(win: Window | null, now: number): Window {
  return win ? { n: win.n + 1, resetAt: win.resetAt } : { n: 1, resetAt: now + LOGIN_WINDOW_MS };
}

/**
 * Pin collection to the window's own end, not "now + TTL". A rolling
 * `expirationTtl` would push the entry forward on every increment, so a
 * hammered key would outlive its logical window (the same trap the
 * demo-keys worker documents on its record writes).
 */
function write(kv: KVNamespace, key: string, win: Window, now: number): Promise<void> {
  const expiration = Math.max(Math.ceil(win.resetAt / 1000), Math.floor(now / 1000) + KV_MIN_EXPIRY_S);
  return kv.put(key, JSON.stringify(win), { expiration });
}
