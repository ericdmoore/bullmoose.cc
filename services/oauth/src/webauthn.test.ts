import { describe, expect, it } from "vitest";
import { fakeEnv, fakeKV } from "@bullmoose/test-fakes";
import { cborDecode, creationOptions, parseAuthData, verifyRegistration } from "./webauthn.js";
// The forge (a miniature independent CBOR encoder + authenticator) lives in
// enroll.test.ts beside the flow that uses it end-to-end; imported here so
// the reader is always tested against bytes it did not produce.
import { cborEncode, forgeRegistration } from "./enroll.test.js";

// The ceremony's own refusals — each is a sentence a test pins, because
// every one of these is a security boundary: the origin check is WebAuthn's
// entire defence against the lookalike-domain relay (s33 hole #2), the RP
// hash binds the credential to OUR boundary, and the single-use challenge
// is what makes a captured response worthless (hole #3, replay).

const PRINCIPAL = "p_kevin";

async function world() {
  const w = fakeEnv();
  const kv = fakeKV();
  await w.env.DB.prepare(
    `INSERT INTO tenants (id, name, created_at) VALUES ('t_bm', 'bm', ?) ON CONFLICT(id) DO NOTHING`,
  )
    .bind(Date.now())
    .run();
  await w.env.DB.prepare(
    `INSERT INTO principals (id, tenant_id, login_email, created_at) VALUES (?, 't_bm', 'k@bm.cc', ?)`,
  )
    .bind(PRINCIPAL, Date.now())
    .run();
  const env = { DB: w.env.DB, OAUTH_KV: kv.ns } as never;
  const opts = (await creationOptions(env, { id: PRINCIPAL, email: "k@bm.cc" })) as { challenge: string };
  return { env, challenge: opts.challenge };
}

const refusalOf = (out: unknown): string => (out as { refused?: string }).refused ?? "";

describe("verifyRegistration — the refusals are the boundary", () => {
  it("a ceremony completed on a lookalike origin is worthless here", async () => {
    const { env, challenge } = await world();
    const forged = await forgeRegistration(challenge, { origin: "https://auth.bullmoose.cc.evil.net" });
    expect(refusalOf(await verifyRegistration(env, PRINCIPAL, forged))).toContain("is not https://auth.bullmoose.cc");
  });

  it("authenticator data for a different RP ID refuses", async () => {
    const { env, challenge } = await world();
    const forged = await forgeRegistration(challenge, { rpId: "evil.net" });
    expect(refusalOf(await verifyRegistration(env, PRINCIPAL, forged))).toContain("different RP ID");
  });

  it("a challenge is single-use: the SAME response replayed refuses (hole #3)", async () => {
    const { env, challenge } = await world();
    const forged = await forgeRegistration(challenge);
    const first = await verifyRegistration(env, PRINCIPAL, forged);
    expect("credentialId" in (first as object)).toBe(true);
    expect(refusalOf(await verifyRegistration(env, PRINCIPAL, forged))).toContain("expired challenge");
  });

  it("someone else's challenge refuses even when structurally perfect", async () => {
    const { env, challenge } = await world();
    const forged = await forgeRegistration(challenge);
    expect(refusalOf(await verifyRegistration(env, "p_not_kevin", forged))).toContain("different enrollment");
  });

  it("webauthn.get (an ASSERTION) cannot register — type is checked", async () => {
    const { env, challenge } = await world();
    const forged = await forgeRegistration(challenge, { type: "webauthn.get" });
    expect(refusalOf(await verifyRegistration(env, PRINCIPAL, forged))).toContain("webauthn.create");
  });

  it("an algorithm slice 3 could not verify refuses NOW, not at assertion time", async () => {
    const { env, challenge } = await world();
    const forged = await forgeRegistration(challenge, { alg: -8 }); // EdDSA — real, but not ours
    expect(refusalOf(await verifyRegistration(env, PRINCIPAL, forged))).toContain("unsupported key algorithm");
  });

  it("no user presence refuses — the ceremony must be observed", async () => {
    const { env, challenge } = await world();
    const forged = await forgeRegistration(challenge, { flags: 0x44 }); // AT|UV, no UP
    expect(refusalOf(await verifyRegistration(env, PRINCIPAL, forged))).toContain("presence");
  });

  it("a credential id that disagrees between envelope and authData refuses", async () => {
    const { env, challenge } = await world();
    const forged = await forgeRegistration(challenge);
    forged.id = "someone-elses-id";
    expect(refusalOf(await verifyRegistration(env, PRINCIPAL, forged))).toContain("disagrees");
  });
});

describe("the parsers refuse what they do not vouch for", () => {
  it("authData without the AT flag is not a registration", () => {
    const bytes = new Uint8Array(64).fill(1);
    bytes[32] = 0x01; // UP only
    expect(() => parseAuthData(bytes)).toThrow(/AT flag/);
  });

  it("cbor outside the registration subset throws rather than guessing", () => {
    expect(() => cborDecode(new Uint8Array([0xf9, 0x3c, 0x00]))).toThrow(/subset/); // a float16
    expect(() => cborDecode(new Uint8Array([0x5b]))).toThrow(/subset/); // 8-byte length form
    expect(() => cborDecode(new Uint8Array([0x58, 0x05, 0x01]))).toThrow(/truncated/);
  });
});

// ---- the assertion ceremony (slice 3) — REAL crypto, no shortcuts ---------
// The forge generates a genuine P-256 keypair, registers its COSE form, and
// SIGNS authData||sha256(clientData) exactly as an authenticator does —
// including re-encoding WebCrypto's raw r||s as the DER WebAuthn delivers,
// so derToRaw is tested against real DER it did not produce.

import { assertionOptions, b64u, importCoseKey, verifyAssertion } from "./webauthn.js";

function rawToDer(raw: Uint8Array): Uint8Array {
  const int = (bytes: Uint8Array): number[] => {
    let b = [...bytes];
    while (b.length > 1 && b[0] === 0 && (b[1]! & 0x80) === 0) b.shift();
    if (b[0]! & 0x80) b.unshift(0);
    return [0x02, b.length, ...b];
  };
  const r = int(raw.slice(0, 32));
  const s = int(raw.slice(32));
  return new Uint8Array([0x30, r.length + s.length, ...r, ...s]);
}

export async function realAuthenticator() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  const fromB64u = (t: string) =>
    Uint8Array.from(atob(t.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const cose = cborEncode(
    new Map<number, unknown>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, fromB64u(jwk.x!)],
      [-3, fromB64u(jwk.y!)],
    ]),
  );
  return { pair, cose, credId: crypto.getRandomValues(new Uint8Array(16)) };
}

export async function assertWorld(counter = 0) {
  const w = fakeEnv();
  const kv = fakeKV();
  await w.env.DB.prepare(
    `INSERT INTO tenants (id, name, created_at) VALUES ('t_bm', 'bm', ?) ON CONFLICT(id) DO NOTHING`,
  )
    .bind(Date.now())
    .run();
  await w.env.DB.prepare(
    `INSERT INTO principals (id, tenant_id, login_email, created_at) VALUES (?, 't_bm', 'k@bm.cc', ?)`,
  )
    .bind(PRINCIPAL, Date.now())
    .run();
  const authn = await realAuthenticator();
  await w.env.DB.prepare(
    `INSERT INTO webauthn_credentials (id, principal_id, public_key_cose, alg, counter, created_at)
     VALUES (?, ?, ?, -7, ?, ?)`,
  )
    .bind(b64u(authn.credId), PRINCIPAL, b64u(authn.cose), counter, Date.now())
    .run();
  const env = { DB: w.env.DB, OAUTH_KV: kv.ns } as never;
  const opts = (await assertionOptions(env, "login")) as { challenge: string };
  return { env, authn, challenge: opts.challenge, db: w.env.DB };
}

interface SignOpts {
  origin?: string;
  type?: string;
  counter?: number;
  rpId?: string;
  flags?: number;
  wrongKey?: boolean;
}

export async function signAssertion(
  authn: Awaited<ReturnType<typeof realAuthenticator>>,
  challenge: string,
  opts: SignOpts = {},
) {
  const sha = async (d: Uint8Array) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", d.slice().buffer as ArrayBuffer));
  const rpHash = await sha(new TextEncoder().encode(opts.rpId ?? "auth.bullmoose.cc"));
  const c = opts.counter ?? 0;
  const authData = new Uint8Array([
    ...rpHash,
    opts.flags ?? 0x05,
    (c >> 24) & 0xff,
    (c >> 16) & 0xff,
    (c >> 8) & 0xff,
    c & 0xff,
  ]);
  const clientData = new TextEncoder().encode(
    JSON.stringify({
      type: opts.type ?? "webauthn.get",
      challenge,
      origin: opts.origin ?? "https://auth.bullmoose.cc",
    }),
  );
  const signed = new Uint8Array([...authData, ...(await sha(clientData))]);
  const signingKey = opts.wrongKey
    ? ((await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"])) as CryptoKeyPair)
        .privateKey
    : authn.pair.privateKey;
  const rawSig = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signingKey, signed.slice().buffer as ArrayBuffer),
  );
  return {
    id: b64u(authn.credId),
    response: {
      clientDataJSON: b64u(clientData),
      authenticatorData: b64u(authData),
      signature: b64u(rawToDer(rawSig)),
    },
  };
}

describe("verifyAssertion — a real key, a real signature, real refusals", () => {
  it("a genuine assertion passes, resolves the principal, and stamps the row", async () => {
    const { env, authn, challenge, db } = await assertWorld();
    const out = await verifyAssertion(env, "login", await signAssertion(authn, challenge, { counter: 7 }));
    expect(out).toMatchObject({ principalId: PRINCIPAL });
    const row = await db
      .prepare(`SELECT counter, last_used_at FROM webauthn_credentials WHERE id = ?`)
      .bind(b64u(authn.credId))
      .first<{ counter: number; last_used_at: number | null }>();
    expect(row?.counter).toBe(7);
    expect(row?.last_used_at).not.toBeNull();
  });

  it("a DIFFERENT P-256 key's signature refuses — this is the arithmetic", async () => {
    const { env, authn, challenge } = await assertWorld();
    const out = await verifyAssertion(env, "login", await signAssertion(authn, challenge, { wrongKey: true }));
    expect(refusalOf(out)).toContain("not the registered key");
  });

  it("a login challenge cannot satisfy a different ceremony", async () => {
    const { env, authn, challenge } = await assertWorld();
    const out = await verifyAssertion(env, "disclose:401k", await signAssertion(authn, challenge));
    expect(refusalOf(out)).toContain("different ceremony");
  });

  it("replaying a consumed assertion refuses (hole #3 again, get-side)", async () => {
    const { env, authn, challenge } = await assertWorld();
    const signed = await signAssertion(authn, challenge, { counter: 3 });
    await verifyAssertion(env, "login", signed);
    expect(refusalOf(await verifyAssertion(env, "login", signed))).toContain("expired challenge");
  });

  it("a counter that fails to advance past a nonzero high-water refuses", async () => {
    const { env, authn, challenge } = await assertWorld(9);
    const out = await verifyAssertion(env, "login", await signAssertion(authn, challenge, { counter: 9 }));
    expect(refusalOf(out)).toContain("cloned");
  });

  it("a constant-zero counter (the passkey norm) is fine", async () => {
    const { env, authn, challenge } = await assertWorld(0);
    const out = await verifyAssertion(env, "login", await signAssertion(authn, challenge, { counter: 0 }));
    expect(out).toMatchObject({ principalId: PRINCIPAL });
  });

  it("webauthn.create cannot assert; a lookalike origin cannot assert", async () => {
    const w1 = await assertWorld();
    expect(
      refusalOf(
        await verifyAssertion(
          w1.env,
          "login",
          await signAssertion(w1.authn, w1.challenge, { type: "webauthn.create" }),
        ),
      ),
    ).toContain("webauthn.get");
    const w2 = await assertWorld();
    expect(
      refusalOf(
        await verifyAssertion(
          w2.env,
          "login",
          await signAssertion(w2.authn, w2.challenge, { origin: "https://evil.net" }),
        ),
      ),
    ).toContain("is not https://auth.bullmoose.cc");
  });

  it("an unknown credential refuses without an oracle about why", async () => {
    const { env, authn, challenge } = await assertWorld();
    const signed = await signAssertion(authn, challenge);
    signed.id = b64u(crypto.getRandomValues(new Uint8Array(16)));
    expect(refusalOf(await verifyAssertion(env, "login", signed))).toContain("unknown credential");
  });

  it("importCoseKey round-trips the registration forge's key shape", async () => {
    const { authn } = await assertWorld();
    const { alg } = await importCoseKey(authn.cose);
    expect(alg).toBe(-7);
  });
});

describe("registration and assertion must agree about discoverability", () => {
  // These two functions are ~200 lines apart and silently coupled. The bug
  // this pins: creationOptions asked for `residentKey: "preferred"`, which
  // lets an authenticator answer with a SERVER-SIDE credential — while
  // assertionOptions sends `allowCredentials: []`, which can only ever find a
  // DISCOVERABLE one.
  //
  // The failure that produces is the worst shape available: enrollment
  // SUCCEEDS, every other test passes (they hand a constructed assertion
  // straight to the verifier and never ask a browser to find anything), and
  // then that person can neither complete a ceremony NOR LOG IN — silently,
  // permanently, and only them. It was found with a real browser; this is what
  // keeps it found.
  it("assertion asks the browser to find the credential unaided", async () => {
    const { env } = await assertWorld();
    const opts = (await assertionOptions(env, "login")) as { allowCredentials?: unknown[] };
    expect(
      opts.allowCredentials,
      "if this ever gets populated, the residentKey requirement below can relax — until then it cannot",
    ).toEqual([]);
  });

  it("so registration REQUIRES a discoverable credential, not merely prefers one", async () => {
    const { env } = await assertWorld();
    const opts = (await creationOptions(env, { id: "prin_x", email: "x@test.local" })) as {
      authenticatorSelection?: { residentKey?: string; requireResidentKey?: boolean };
    };
    expect(
      opts.authenticatorSelection?.residentKey,
      'residentKey "preferred" lets an authenticator create a credential that assertionOptions can never find',
    ).toBe("required");
    // The legacy sibling of the same flag; older authenticators read this one.
    expect(opts.authenticatorSelection?.requireResidentKey).toBe(true);
  });
});
