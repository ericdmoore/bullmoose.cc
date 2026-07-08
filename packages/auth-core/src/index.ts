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

// ---- credential vault envelope crypto (Phase 3, Q2 "build it right") ------
//
// sealSecret/openSecret protect vault_credentials rows. Construction:
//   key = HKDF-SHA256(masterSecret, salt="bullmoose-vault-v1", info=aad)
//   ciphertext = AES-256-GCM(key, iv=random 96-bit, aad)
// The AAD is the row's identity (principalId + ":" + name), so a sealed
// value copied onto another row fails to open — no row-swap attacks.
// The envelope is versioned for future rotation ({v:1}); rotating the
// master means open-with-old + seal-with-new per row.
// The master secret lives ONLY in the agent worker (VAULT_MASTER_KEY);
// nothing here ever logs or returns plaintext except openSecret's value,
// which callers must keep in-process.

export interface SealedSecret {
  v: 1;
  /** base64 96-bit GCM nonce */
  iv: string;
  /** base64 ciphertext + GCM tag */
  ct: string;
}

const VAULT_HKDF_SALT = "bullmoose-vault-v1";

async function vaultKey(masterSecret: string, aad: string): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(masterSecret),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode(VAULT_HKDF_SALT),
      info: new TextEncoder().encode(aad),
    },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function sealSecret(
  masterSecret: string,
  plaintext: string,
  aad: string,
): Promise<SealedSecret> {
  const key = await vaultKey(masterSecret, aad);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) },
    key,
    new TextEncoder().encode(plaintext),
  );
  return { v: 1, iv: bytesToBase64(iv), ct: bytesToBase64(new Uint8Array(ct)) };
}

/** Throws on tamper/wrong-row/wrong-master. Keep the return value in-process. */
export async function openSecret(
  masterSecret: string,
  sealed: SealedSecret,
  aad: string,
): Promise<string> {
  if (sealed.v !== 1) throw new Error(`unknown vault envelope version: ${String(sealed.v)}`);
  const key = await vaultKey(masterSecret, aad);
  const pt = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64ToBytes(sealed.iv),
      additionalData: new TextEncoder().encode(aad),
    },
    key,
    base64ToBytes(sealed.ct),
  );
  return new TextDecoder().decode(pt);
}

/** The canonical AAD for a vault row. */
export function vaultAad(principalId: string, name: string): string {
  return `${principalId}:${name}`;
}

function bytesToBase64(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
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
