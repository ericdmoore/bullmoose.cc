/**
 * auth-core — token + password primitives shared by the jmap and
 * provision workers. WebCrypto only (runs in Workers and Node).
 *
 * Token model (GitHub-PAT shape): `bm_<id>_<secret>`. The server stores
 * only SHA-256(secret); the plaintext is shown once at mint. Bearer
 * tokens are symmetric possession-secrets — a future `kind: "pubkey"`
 * row adds signed-request auth without a redesign.
 *
 * Scope vocabulary (shared with agent grants):
 *   read < annotate < draft < move < send < delete ; "mail" = all of them
 *   "admin" is control-plane only.
 */

export interface MintedToken {
  /** Public row id, embedded in the token string. */
  id: string;
  /** The full `bm_...` string — show once, never store. */
  token: string;
  /** SHA-256 hex of the secret part — the only thing stored. */
  secretHash: string;
}

export async function mintToken(): Promise<MintedToken> {
  const id = randomHex(6);
  const secret = randomHex(24);
  return { id: `tk_${id}`, token: `bm_${id}_${secret}`, secretHash: await sha256Hex(secret) };
}

export interface ParsedToken {
  id: string;
  secret: string;
}

export function parseToken(raw: string): ParsedToken | null {
  const m = /^bm_([0-9a-f]{12})_([0-9a-f]{48})$/.exec(raw.trim());
  return m ? { id: `tk_${m[1]}`, secret: m[2] as string } : null;
}

export async function verifyTokenSecret(secret: string, storedHash: string): Promise<boolean> {
  return timingSafeEqualHex(await sha256Hex(secret), storedHash);
}

// ---- scopes ------------------------------------------------------------

export const MAIL_SCOPES = ["read", "annotate", "draft", "move", "send", "delete"] as const;
export type Scope = (typeof MAIL_SCOPES)[number] | "mail" | "admin";

/** Does a token's scope list satisfy a required scope? "mail" covers all mail verbs. */
export function hasScope(granted: string[], required: string): boolean {
  if (granted.includes(required)) return true;
  return required !== "admin" && granted.includes("mail");
}

/** For self-service minting: requested must not exceed what the minter holds. */
export function scopesWithin(requested: string[], granted: string[]): boolean {
  return requested.every((s) => hasScope(granted, s));
}

// ---- passwords: CLIENT-side stretching ------------------------------------
//
// The KDF runs on the CLIENT (CLI / webmail), not the server, because
// Workers Free caps invocations at 10ms CPU and PBKDF2@600k burns
// ~100ms+. The client derives a loginKey; the wire and the server only
// ever see the derived key — the raw password never leaves the device,
// and server-side verification is one SHA-256 (microseconds).
//
// Derivation contract (any client must match EXACTLY — see the CLI's
// copy in packages/cli/src/tokens.ts):
//   salt      = SHA-256("bullmoose-login-v1:" + lowercase(email))
//   loginKey  = hex(PBKDF2-HMAC-SHA256(password, salt, 600_000 iters, 256 bits))
// Server stores sha256(loginKey); offline crackers still pay the full
// stretching cost per guess. pw_algo = 'client-pbkdf2-sha256-v1'; the
// column exists so rows can migrate (e.g. to argon2id WASM client-side)
// via verify-by-row + rehash-on-login.
//
// Why not argon2? It's the modern standard (memory-hard), but neither
// Workers nor browsers ship it natively — WASM later, same contract slot.

export const LOGIN_KEY_ALGO = "client-pbkdf2-sha256-v1";
export const LOGIN_KEY_ITERATIONS = 600_000;
const LOGIN_SALT_LABEL = "bullmoose-login-v1:";

export function isLoginKey(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/** Runs on the CLIENT. ~200-400ms of local CPU by design. */
export async function deriveLoginKey(email: string, password: string): Promise<string> {
  const salt = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(LOGIN_SALT_LABEL + email.toLowerCase()),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: LOGIN_KEY_ITERATIONS },
    key,
    256,
  );
  return bytesToHex(new Uint8Array(bits));
}

/** Runs on the SERVER: the stored value, and the per-login compare input. */
export async function hashLoginKey(loginKeyHex: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(loginKeyHex));
  return bytesToHex(new Uint8Array(digest));
}

/** The salt hex a given email derives (stored for row self-description). */
export async function loginSaltHex(email: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(LOGIN_SALT_LABEL + email.toLowerCase()),
  );
  return bytesToHex(new Uint8Array(digest));
}

// ---- helpers -------------------------------------------------------------

export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return bytesToHex(buf);
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return bytesToHex(new Uint8Array(digest));
}

function bytesToHex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
