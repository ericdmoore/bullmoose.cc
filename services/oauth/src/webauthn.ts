// s33 slice 2 — passkey REGISTRATION on the AS. The plan's placement
// argument, condensed: this worker is already the identity plane, WebAuthn
// is origin-bound (the RP ID *is* the security boundary, and
// auth.bullmoose.cc is already a stable dedicated origin), and a passkey
// record is a PUBLIC key — nothing to seal, so it is not a Bureau asset.
//
// Registration-only, deliberately: the ceremony that AUTHORIZES something
// (assertion + described-act page + mint) is slice 3. With attestation
// "none" — the passkey norm — registration verifies STRUCTURE and BINDING,
// not a signature: the clientData must be a webauthn.create for OUR
// challenge at OUR origin, the authenticator data must be for OUR RP ID
// hash, and the COSE key must be an algorithm slice 3 can actually verify
// (ES256/RS256 — refusing the rest now beats storing a key we would choke
// on at assertion time).
//
// Dependency-free by decision: the CBOR here is a READER for the small
// subset the spec emits (ints, byte/text strings, arrays, maps), and
// none-attestation needs no signature math — the vetted-library argument
// applies to assertion verification, which is WebCrypto's job in slice 3,
// not to structural parsing. Every refusal below is a named string a test
// pins.
//
// The credential rule (Eric, 2026-08-21): TWO authenticators complete an
// account; any ONE satisfies a ceremony. Enforcement of "complete" lives
// at the enrollment door (enroll.ts); this file records and counts.

export interface WebAuthnEnv {
  DB: D1Database;
  OAUTH_KV: KVNamespace;
  /** The RP ID — defaults to the production AS host. A BYO-domain install
   *  has its OWN (s33 OQ3: passkeys do not port between installs). */
  RP_ID?: string;
}

export const rpIdOf = (env: WebAuthnEnv): string => env.RP_ID ?? "auth.bullmoose.cc";
export const originOf = (env: WebAuthnEnv): string => `https://${rpIdOf(env)}`;

/** Two authenticators complete an account (any one satisfies a ceremony). */
export const REQUIRED_AUTHENTICATORS = 2;

const CHALLENGE_TTL_S = 300;

// ---- base64url, the ONLY wire encoding WebAuthn uses ----------------------

export const b64u = (bytes: ArrayBuffer | Uint8Array): string => {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export const unb64u = (s: string): Uint8Array => {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
};

// ---- the CBOR subset the spec emits ---------------------------------------

/** One decoded item and the offset just past it. Throws on anything outside
 *  the registration subset — an attestation object carrying tags, floats or
 *  indefinite lengths is not one this reader vouches for. */
export function cborDecode(u8: Uint8Array, at = 0): { value: unknown; at: number } {
  if (at >= u8.length) throw new Error("cbor: truncated");
  const initial = u8[at]!;
  const major = initial >> 5;
  const info = initial & 0x1f;

  let length = 0;
  let head = at + 1;
  if (info < 24) length = info;
  else if (info === 24) {
    length = u8[head]!;
    head += 1;
  } else if (info === 25) {
    length = (u8[head]! << 8) | u8[head + 1]!;
    head += 2;
  } else if (info === 26) {
    length = u8[head]! * 0x1000000 + ((u8[head + 1]! << 16) | (u8[head + 2]! << 8) | u8[head + 3]!);
    head += 4;
  } else {
    throw new Error("cbor: length form outside the registration subset");
  }

  switch (major) {
    case 0:
      return { value: length, at: head };
    case 1:
      return { value: -1 - length, at: head };
    case 2:
      if (head + length > u8.length) throw new Error("cbor: truncated");
      return { value: u8.slice(head, head + length), at: head + length };
    case 3:
      if (head + length > u8.length) throw new Error("cbor: truncated");
      return { value: new TextDecoder().decode(u8.slice(head, head + length)), at: head + length };
    case 4: {
      const arr: unknown[] = [];
      let cursor = head;
      for (let i = 0; i < length; i++) {
        const item = cborDecode(u8, cursor);
        arr.push(item.value);
        cursor = item.at;
      }
      return { value: arr, at: cursor };
    }
    case 5: {
      const map = new Map<unknown, unknown>();
      let cursor = head;
      for (let i = 0; i < length; i++) {
        const k = cborDecode(u8, cursor);
        const v = cborDecode(u8, k.at);
        map.set(k.value, v.value);
        cursor = v.at;
      }
      return { value: map, at: cursor };
    }
    default:
      throw new Error("cbor: major type outside the registration subset");
  }
}

// ---- authenticator data (WebAuthn §6.1) -----------------------------------

export interface ParsedAuthData {
  rpIdHash: Uint8Array;
  userPresent: boolean;
  userVerified: boolean;
  counter: number;
  credentialId: Uint8Array;
  /** The COSE key, raw bytes — stored verbatim; slice 3 imports it. */
  publicKeyCose: Uint8Array;
  aaguid: string;
}

export function parseAuthData(u8: Uint8Array): ParsedAuthData {
  if (u8.length < 55) throw new Error("authData: too short to carry a credential");
  const flags = u8[32]!;
  if (!(flags & 0x40)) throw new Error("authData: no attested credential (AT flag unset)");
  const counter = (u8[33]! << 24) | (u8[34]! << 16) | (u8[35]! << 8) | u8[36]!;
  const aaguid = [...u8.slice(37, 53)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const credLen = (u8[53]! << 8) | u8[54]!;
  const credentialId = u8.slice(55, 55 + credLen);
  if (credentialId.length !== credLen) throw new Error("authData: truncated credential id");
  // The COSE key is the remainder-prefix; decode to find where it ends so a
  // trailing-extensions authData still parses.
  const keyStart = 55 + credLen;
  const decoded = cborDecode(u8, keyStart);
  return {
    rpIdHash: u8.slice(0, 32),
    userPresent: (flags & 0x01) !== 0,
    userVerified: (flags & 0x04) !== 0,
    counter: counter >>> 0,
    credentialId,
    publicKeyCose: u8.slice(keyStart, decoded.at),
    aaguid,
  };
}

/** COSE alg of a key — the two slice 3 can verify with WebCrypto. */
export function coseAlg(publicKeyCose: Uint8Array): number {
  const key = cborDecode(publicKeyCose).value;
  if (!(key instanceof Map)) throw new Error("cose: key is not a map");
  const alg = key.get(3);
  if (typeof alg !== "number") throw new Error("cose: no alg");
  return alg;
}

const SUPPORTED_ALGS = [-7, -257]; // ES256, RS256

// ---- the registration ceremony --------------------------------------------

const sha256 = async (data: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", data.slice().buffer as ArrayBuffer));

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

/**
 * Mint creation options for a principal whose enrollment the CALLER has
 * already validated (enroll.ts owns the door; this owns the ceremony). The
 * challenge is single-use, KV-held, 5-minute TTL.
 */
export async function creationOptions(
  env: WebAuthnEnv,
  principal: { id: string; email: string },
): Promise<Record<string, unknown>> {
  const challenge = b64u(crypto.getRandomValues(new Uint8Array(32)));
  await env.OAUTH_KV.put(`webauthn:chal:${challenge}`, JSON.stringify({ principalId: principal.id }), {
    expirationTtl: CHALLENGE_TTL_S,
  });
  const { results: existing } = await env.DB.prepare(`SELECT id FROM webauthn_credentials WHERE principal_id = ?`)
    .bind(principal.id)
    .all<{ id: string }>();
  return {
    challenge,
    rp: { id: rpIdOf(env), name: "bullmoose" },
    user: { id: b64u(new TextEncoder().encode(principal.id)), name: principal.email, displayName: principal.email },
    pubKeyCredParams: SUPPORTED_ALGS.map((alg) => ({ type: "public-key", alg })),
    timeout: CHALLENGE_TTL_S * 1000,
    attestation: "none",
    // Registering the same authenticator twice is a confusing no-op the
    // browser can prevent outright.
    excludeCredentials: existing.map((c) => ({ type: "public-key", id: c.id })),
    // ⚠️ residentKey is REQUIRED, not preferred, and the two are not
    // interchangeable here.
    //
    // `assertionOptions` sends `allowCredentials: []` — usernameless — so at
    // assertion time the browser must FIND the credential with no hint. Only a
    // DISCOVERABLE (resident) credential can be found that way.
    //
    // With "preferred", an authenticator that does not store resident keys is
    // free to create a server-side credential instead. Registration then
    // SUCCEEDS, and every unit test still passes — they hand a constructed
    // assertion straight to the verifier and never ask a browser to find
    // anything. The failure lands later, at the ceremony, permanently, for
    // that person only. tools/e2e-ceremony.mjs reproduced exactly that.
    //
    // "required" moves the refusal to enrollment, which is the honest moment:
    // a human is present, and can reach for a different authenticator.
    authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "preferred" },
  };
}

export interface RegistrationRefusal {
  refused: string;
}

/**
 * Verify one registration response and store the credential. Returns the
 * stored credential id and the principal's new count, or a NAMED refusal —
 * never a silent partial.
 */
export async function verifyRegistration(
  env: WebAuthnEnv,
  principalId: string,
  body: { id?: string; response?: { clientDataJSON?: string; attestationObject?: string }; label?: string },
): Promise<{ credentialId: string; count: number } | RegistrationRefusal> {
  if (!body.id || !body.response?.clientDataJSON || !body.response?.attestationObject) {
    return { refused: "the response is missing its WebAuthn fields" };
  }

  let clientData: { type?: string; challenge?: string; origin?: string };
  try {
    clientData = JSON.parse(new TextDecoder().decode(unb64u(body.response.clientDataJSON)));
  } catch {
    return { refused: "clientDataJSON did not parse" };
  }
  if (clientData.type !== "webauthn.create") return { refused: "clientData.type is not webauthn.create" };
  if (clientData.origin !== originOf(env)) {
    // The origin check is the whole point of WebAuthn — a ceremony completed
    // on a lookalike origin is arithmetically worthless here, and this is
    // where that becomes an explicit refusal rather than luck.
    return { refused: `origin ${clientData.origin ?? "(none)"} is not ${originOf(env)}` };
  }
  if (!clientData.challenge) return { refused: "clientData carries no challenge" };
  const chalKey = `webauthn:chal:${clientData.challenge}`;
  const held = await env.OAUTH_KV.get(chalKey);
  if (!held) return { refused: "unknown or expired challenge — start again" };
  await env.OAUTH_KV.delete(chalKey); // single-use, consumed before any write
  if ((JSON.parse(held) as { principalId: string }).principalId !== principalId) {
    return { refused: "this challenge belongs to a different enrollment" };
  }

  let auth: ParsedAuthData;
  let alg: number;
  try {
    const att = cborDecode(unb64u(body.response.attestationObject)).value;
    if (!(att instanceof Map)) throw new Error("attestationObject is not a map");
    const authData = att.get("authData");
    if (!(authData instanceof Uint8Array)) throw new Error("attestationObject carries no authData");
    auth = parseAuthData(authData);
    alg = coseAlg(auth.publicKeyCose);
  } catch (err) {
    return { refused: `attestation did not parse: ${err instanceof Error ? err.message : err}` };
  }

  const expectedRpHash = await sha256(new TextEncoder().encode(rpIdOf(env)));
  if (b64u(auth.rpIdHash) !== b64u(expectedRpHash)) return { refused: "authenticator data is for a different RP ID" };
  if (!auth.userPresent) return { refused: "no user presence — the ceremony was not observed" };
  if (!SUPPORTED_ALGS.includes(alg)) {
    return { refused: `unsupported key algorithm ${alg} — a key we could not verify at assertion time` };
  }
  const credentialId = b64u(auth.credentialId);
  if (credentialId !== body.id) return { refused: "credential id disagrees between response and authData" };

  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO webauthn_credentials
       (id, principal_id, public_key_cose, alg, counter, aaguid, label, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO NOTHING`,
  )
    .bind(credentialId, principalId, b64u(auth.publicKeyCose), alg, auth.counter, auth.aaguid, body.label ?? null, now)
    .run();

  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM webauthn_credentials WHERE principal_id = ?`)
    .bind(principalId)
    .first<{ n: number }>();
  return { credentialId, count: row?.n ?? 1 };
}

/** How many authenticators a principal holds — the door's completeness read. */
export async function credentialCount(env: WebAuthnEnv, principalId: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM webauthn_credentials WHERE principal_id = ?`)
    .bind(principalId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export { json as webauthnJson };

// ---- the assertion ceremony (slice 3) -------------------------------------
//
// This is the half that needed the real math: an assertion is a SIGNATURE
// over authenticatorData || sha256(clientDataJSON), verified with the COSE
// key stored at registration. WebCrypto does the arithmetic; this file does
// the translations WebCrypto refuses to (COSE map → JWK, and DER ECDSA
// signatures → the raw r||s WebCrypto expects).
//
// Usernameless by design: assertion options carry NO allowCredentials, so
// the authenticator offers whatever discoverable credential it holds and
// the server resolves the principal FROM the credential id. A per-email
// credential list would be an account-existence oracle; an empty list
// cannot be.

/** COSE EC2/RSA labels → a WebCrypto key. Refuses anything else by name. */
export async function importCoseKey(publicKeyCose: Uint8Array): Promise<{ key: CryptoKey; alg: number }> {
  const cose = cborDecode(publicKeyCose).value;
  if (!(cose instanceof Map)) throw new Error("cose: key is not a map");
  const kty = cose.get(1);
  const alg = cose.get(3);
  if (alg === -7 && kty === 2) {
    const x = cose.get(-2);
    const y = cose.get(-3);
    if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array)) throw new Error("cose: EC2 key missing x/y");
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", x: b64u(x), y: b64u(y) },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return { key, alg: -7 };
  }
  if (alg === -257 && kty === 3) {
    const n = cose.get(-1);
    const e = cose.get(-2);
    if (!(n instanceof Uint8Array) || !(e instanceof Uint8Array)) throw new Error("cose: RSA key missing n/e");
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: b64u(n), e: b64u(e) },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return { key, alg: -257 };
  }
  throw new Error(`cose: unsupported kty/alg ${String(kty)}/${String(alg)}`);
}

/**
 * DER ECDSA-Sig-Value → raw r||s (32 bytes each). WebAuthn signatures are
 * DER; WebCrypto's ECDSA verify wants raw. Refuses malformed DER rather
 * than guessing at offsets.
 */
export function derToRaw(der: Uint8Array): Uint8Array {
  if (der[0] !== 0x30) throw new Error("der: not a sequence");
  let at = der[1]! === 0x81 ? 3 : 2; // long-form length for big signatures
  const int = (): Uint8Array => {
    if (der[at] !== 0x02) throw new Error("der: expected integer");
    const len = der[at + 1]!;
    let start = at + 2;
    let n = der.slice(start, start + len);
    at = start + len;
    while (n.length > 32 && n[0] === 0) n = n.slice(1); // strip sign padding
    if (n.length > 32) throw new Error("der: integer wider than P-256");
    const out = new Uint8Array(32);
    out.set(n, 32 - n.length);
    return out;
  };
  const r = int();
  const s = int();
  const raw = new Uint8Array(64);
  raw.set(r, 0);
  raw.set(s, 32);
  return raw;
}

/** Assertion request options — usernameless, single-use KV challenge. */
export async function assertionOptions(env: WebAuthnEnv, purpose: string): Promise<Record<string, unknown>> {
  const challenge = b64u(crypto.getRandomValues(new Uint8Array(32)));
  await env.OAUTH_KV.put(`webauthn:assert:${challenge}`, JSON.stringify({ purpose }), {
    expirationTtl: CHALLENGE_TTL_S,
  });
  return {
    challenge,
    rpId: rpIdOf(env),
    timeout: CHALLENGE_TTL_S * 1000,
    userVerification: "preferred",
    allowCredentials: [], // usernameless — see the header
  };
}

export interface AssertionPass {
  principalId: string;
  credentialId: string;
  userVerified: boolean;
}

/**
 * Verify one assertion end to end. `purpose` must match what the challenge
 * was minted FOR — a login challenge must not satisfy a future disclosure
 * ceremony, however valid its signature.
 */
export async function verifyAssertion(
  env: WebAuthnEnv,
  purpose: string,
  body: {
    id?: string;
    response?: { clientDataJSON?: string; authenticatorData?: string; signature?: string };
  },
): Promise<AssertionPass | RegistrationRefusal> {
  if (!body.id || !body.response?.clientDataJSON || !body.response?.authenticatorData || !body.response?.signature) {
    return { refused: "the assertion is missing its WebAuthn fields" };
  }
  let clientData: { type?: string; challenge?: string; origin?: string };
  try {
    clientData = JSON.parse(new TextDecoder().decode(unb64u(body.response.clientDataJSON)));
  } catch {
    return { refused: "clientDataJSON did not parse" };
  }
  if (clientData.type !== "webauthn.get") return { refused: "clientData.type is not webauthn.get" };
  if (clientData.origin !== originOf(env)) {
    return { refused: `origin ${clientData.origin ?? "(none)"} is not ${originOf(env)}` };
  }
  if (!clientData.challenge) return { refused: "clientData carries no challenge" };
  const chalKey = `webauthn:assert:${clientData.challenge}`;
  const held = await env.OAUTH_KV.get(chalKey);
  if (!held) return { refused: "unknown or expired challenge — start again" };
  await env.OAUTH_KV.delete(chalKey); // single-use, consumed before any verify
  if ((JSON.parse(held) as { purpose: string }).purpose !== purpose) {
    return { refused: "this challenge was minted for a different ceremony" };
  }

  const row = await env.DB.prepare(
    `SELECT principal_id, public_key_cose, counter FROM webauthn_credentials WHERE id = ?`,
  )
    .bind(body.id)
    .first<{ principal_id: string; public_key_cose: string; counter: number }>();
  if (!row) return { refused: "unknown credential" };

  const authData = unb64u(body.response.authenticatorData);
  if (authData.length < 37) return { refused: "authenticator data is truncated" };
  const expectedRpHash = await sha256(new TextEncoder().encode(rpIdOf(env)));
  if (b64u(authData.slice(0, 32)) !== b64u(expectedRpHash)) {
    return { refused: "authenticator data is for a different RP ID" };
  }
  const flags = authData[32]!;
  if (!(flags & 0x01)) return { refused: "no user presence — the ceremony was not observed" };

  let verified = false;
  try {
    const { key, alg } = await importCoseKey(unb64u(row.public_key_cose));
    const clientHash = await sha256(unb64u(body.response.clientDataJSON));
    const signed = new Uint8Array([...authData, ...clientHash]);
    const sig = unb64u(body.response.signature);
    verified =
      alg === -7
        ? await crypto.subtle.verify(
            { name: "ECDSA", hash: "SHA-256" },
            key,
            derToRaw(sig).slice().buffer as ArrayBuffer,
            signed.slice().buffer as ArrayBuffer,
          )
        : await crypto.subtle.verify(
            "RSASSA-PKCS1-v1_5",
            key,
            sig.slice().buffer as ArrayBuffer,
            signed.slice().buffer as ArrayBuffer,
          );
  } catch (err) {
    return { refused: `signature verification failed: ${err instanceof Error ? err.message : err}` };
  }
  if (!verified) return { refused: "the signature does not verify — this is not the registered key" };

  // Clone detection (WebAuthn §6.1.1): a counter that fails to advance past
  // a previously-seen nonzero value means two authenticators share one key.
  // Passkeys commonly report a constant 0, which is fine — 0→0 asserts
  // nothing either way.
  const counter = ((authData[33]! << 24) | (authData[34]! << 16) | (authData[35]! << 8) | authData[36]!) >>> 0;
  if (row.counter > 0 && counter <= row.counter) {
    return { refused: "signature counter did not advance — possible cloned authenticator; use recovery" };
  }
  await env.DB.prepare(`UPDATE webauthn_credentials SET counter = ?, last_used_at = ? WHERE id = ?`)
    .bind(counter, Date.now(), body.id)
    .run();

  return { principalId: row.principal_id, credentialId: body.id, userVerified: (flags & 0x04) !== 0 };
}
