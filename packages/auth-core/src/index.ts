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

/** Realm scopes. Independent of the mail verbs — NOT covered by "mail". */
export const REALM_SCOPES = ["contacts", "calendar", "vault"] as const;

export type Scope = (typeof MAIL_SCOPES)[number] | (typeof REALM_SCOPES)[number] | "mail" | "admin";

const MAIL_COVERS: ReadonlySet<string> = new Set<string>(MAIL_SCOPES);

/**
 * Does a token's scope list satisfy a required scope?
 *
 * `"mail"` is a BUNDLE OF THE MAIL VERBS, not a wildcard. It covers exactly
 * MAIL_SCOPES and nothing else.
 *
 * It used to return true for every non-"admin" scope, which meant a `mail`
 * token silently satisfied `contacts`, `calendar` and — the sharp one —
 * `vault`, the store holding third-party provider credentials. Since
 * `/auth/login` mints `["mail"]` by default (authRoutes.ts:89), that was
 * every token this system has ever issued.
 *
 * The old `required !== "admin"` carve-out is gone as redundant: `admin` is
 * not in MAIL_SCOPES, so the set membership test excludes it for free.
 *
 * Unknown scope strings are denied unless held verbatim. Fail closed.
 */
export function hasScope(granted: string[], required: string): boolean {
  if (granted.includes(required)) return true;
  return granted.includes("mail") && MAIL_COVERS.has(required);
}

/** For self-service minting: requested must not exceed what the minter holds. */
export function scopesWithin(requested: string[], granted: string[]): boolean {
  return requested.every((s) => hasScope(granted, s));
}

// ---- what a mint may ask for -------------------------------------------
//
// Three lists, because "valid scope" depends on who is asking.
//
// Nothing used to validate a mint request at all: /auth/login, /auth/tokens
// and provision's POST /tokens each wrote `body.scopes` into the tokens row
// verbatim. An invented string ("maiil") stored fine and then failed every
// hasScope check — a token that looks minted and silently does nothing —
// and "admin" was mintable by anyone who knew a password.

/** Everything the operator plane (provision, behind ADMIN_TOKEN) may mint. */
export const TOKEN_SCOPES: readonly string[] = [
  ...MAIL_SCOPES,
  ...REALM_SCOPES,
  "mail",
  "admin",
];

/**
 * What a self-service caller may mint — `/auth/login` (password-authenticated)
 * and `POST /auth/tokens` (bearer-authenticated).
 *
 * `admin` is deliberately absent: it is control-plane only, so knowing a
 * password must not be a path to it. `/auth/tokens` would already refuse via
 * `scopesWithin`, but `/auth/login` has no minter token to compare against —
 * this list is the only thing standing there.
 */
export const SELF_SERVICE_SCOPES: readonly string[] = [...MAIL_SCOPES, ...REALM_SCOPES, "mail"];

/**
 * The default for `/auth/login` ONLY, and the one default that survives.
 *
 * Every other mint site now requires scopes explicitly. Login cannot: it is
 * how a user with no token gets their first one, so refusing an unscoped
 * login would make the system unbootstrappable. `mail` is the honest default
 * for a primary device token — post-`hasScope` fix it is exactly the six mail
 * verbs and grants no contacts, calendar or vault access.
 */
export const DEFAULT_LOGIN_SCOPES: readonly string[] = ["mail"];

/**
 * Which of `requested` are not in `allowed`. Empty result = acceptable.
 * Order-preserving and de-duplicated so the 400 lists each offender once.
 */
export function unknownScopes(requested: readonly string[], allowed: readonly string[]): string[] {
  const ok = new Set(allowed);
  const bad: string[] = [];
  for (const s of requested) if (!ok.has(s) && !bad.includes(s)) bad.push(s);
  return bad;
}

/**
 * The one gate every mint site runs. Returns the scopes to store, or the
 * message to hand back — callers never re-derive either.
 *
 * `requested === undefined` means "the caller said nothing", which is an
 * error unless the site passes a `fallback` (only `/auth/login` does).
 */
export function resolveMintScopes(
  requested: readonly string[] | undefined,
  allowed: readonly string[],
  fallback?: readonly string[],
): { ok: true; scopes: string[] } | { ok: false; error: string } {
  if (requested === undefined) {
    if (fallback) return { ok: true, scopes: [...fallback] };
    return { ok: false, error: `scopes required — one or more of: ${allowed.join(", ")}` };
  }
  if (!Array.isArray(requested)) return { ok: false, error: "scopes must be an array of strings" };
  const trimmed = requested.filter((s) => typeof s === "string" && s.trim() !== "");
  if (trimmed.length !== requested.length) {
    return { ok: false, error: "scopes must be an array of non-empty strings" };
  }
  if (trimmed.length === 0) {
    // An empty array is not "give me the default" — it is a token that can
    // do nothing. Almost always a client bug; say so rather than mint it.
    return { ok: false, error: `scopes must not be empty — one or more of: ${allowed.join(", ")}` };
  }
  const bad = unknownScopes(trimmed, allowed);
  if (bad.length > 0) {
    return {
      ok: false,
      error: `unknown scope(s): ${bad.join(", ")} — valid: ${allowed.join(", ")}`,
    };
  }
  return { ok: true, scopes: trimmed };
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
