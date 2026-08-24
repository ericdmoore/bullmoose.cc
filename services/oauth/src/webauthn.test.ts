import { describe, expect, it } from "vitest";
import { fakeEnv, fakeKV } from "@bullmoose/test-fakes";
import { cborDecode, creationOptions, parseAuthData, verifyRegistration } from "./webauthn.js";
// The forge (a miniature independent CBOR encoder + authenticator) lives in
// enroll.test.ts beside the flow that uses it end-to-end; imported here so
// the reader is always tested against bytes it did not produce.
import { forgeRegistration } from "./enroll.test.js";

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
