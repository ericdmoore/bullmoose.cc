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

// ---- passwords (PBKDF2-SHA256 via WebCrypto) -----------------------------
//
// Why not argon2? argon2id IS the modern standard (memory-hard, PHC
// winner) — but Workers' WebCrypto has no argon2; it would need a WASM
// build. PBKDF2 at OWASP-recommended iterations is the strongest
// platform-native primitive, and the password's blast radius here is
// deliberately small: it only mints tokens (rare, never on the hot
// path). The credentials table carries pw_algo so rows can migrate to
// 'argon2id' (WASM) later — verify-by-row, rehash-on-next-login.

/** OWASP 2023+ guidance for PBKDF2-HMAC-SHA256. */
const PBKDF2_ITERATIONS = 600_000;

export interface PasswordHash {
  saltHex: string;
  iterations: number;
  hashHex: string;
}

export async function hashPassword(
  password: string,
  saltHex = randomHex(16),
  iterations = PBKDF2_ITERATIONS,
): Promise<PasswordHash> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: hexToBytes(saltHex), iterations },
    key,
    256,
  );
  return { saltHex, iterations, hashHex: bytesToHex(new Uint8Array(bits)) };
}

export async function verifyPassword(
  password: string,
  stored: PasswordHash,
): Promise<boolean> {
  const candidate = await hashPassword(password, stored.saltHex, stored.iterations);
  return timingSafeEqualHex(candidate.hashHex, stored.hashHex);
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
