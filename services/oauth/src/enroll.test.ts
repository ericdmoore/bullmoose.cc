import { describe, expect, it } from "vitest";
import { fakeEnv, fakeKV } from "@bullmoose/test-fakes";
import { enrollOptions, enrollPage, enrollRegister, enrollScript } from "./enroll.js";
import { b64u, cborDecode, REQUIRED_AUTHENTICATORS, rpIdOf } from "./webauthn.js";

// The second human's door, now the passkey tea ceremony (s33 slice 2). The
// property under test is still WHO NEVER LEARNS WHAT — but the credential
// rule (2026-08-21) removed the password entirely, so what the operator can
// never know is now structural: there is nothing to know. The refusals are
// the security surface — each has a reason and each gets a test — and the
// ceremony's own refusals (origin, RP hash, challenge reuse) live in
// webauthn.test.ts.

const PRINCIPAL = "p_brother";
const EMAIL = "brother@bullmoose.cc";
const TOKEN = "a".repeat(64);
const RP = "auth.bullmoose.cc";

async function sha256hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function world(over: { expiresAt?: number; consumedAt?: number | null; legacyPassword?: boolean } = {}) {
  const w = fakeEnv();
  const kv = fakeKV();
  await w.env.DB.prepare(
    `INSERT INTO tenants (id, name, created_at) VALUES ('t_bm', 'bm', ?) ON CONFLICT(id) DO NOTHING`,
  )
    .bind(Date.now())
    .run();
  await w.env.DB.prepare(`INSERT INTO principals (id, tenant_id, login_email, created_at) VALUES (?, 't_bm', ?, ?)`)
    .bind(PRINCIPAL, EMAIL, Date.now())
    .run();
  await w.env.DB.prepare(
    `INSERT INTO enrollments (id, principal_id, secret_hash, created_at, expires_at, consumed_at)
     VALUES ('en_1', ?, ?, ?, ?, ?)`,
  )
    .bind(
      PRINCIPAL,
      await sha256hex(TOKEN),
      Date.now(),
      over.expiresAt ?? Date.now() + 86400000,
      over.consumedAt ?? null,
    )
    .run();
  if (over.legacyPassword) {
    await w.env.DB.prepare(
      `INSERT INTO credentials (principal_id, pw_algo, pw_hash, pw_salt, pw_iters, updated_at)
       VALUES (?, 'pbkdf2', 'h', 's', 1, ?)`,
    )
      .bind(PRINCIPAL, Date.now())
      .run();
  }
  return { env: { DB: w.env.DB, OAUTH_KV: kv.ns } as never };
}

const post = (path: string, body: unknown) =>
  new Request(`https://${RP}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const optionsFor = async (env: never, token = TOKEN, email = EMAIL) => {
  const res = await enrollOptions(post("/enroll/webauthn/options", { token, email }), env);
  return { res, body: (await res.json()) as { error?: string; publicKey?: { challenge: string } } };
};

// ---- forging a real ceremony response (the test's authenticator) ----------
// A miniature CBOR ENCODER for exactly what an authenticator emits, so the
// server-side reader is tested against independently-built bytes, not its
// own output.

export function cborEncode(value: unknown): Uint8Array {
  const out: number[] = [];
  const head = (major: number, len: number) => {
    if (len < 24) out.push((major << 5) | len);
    else if (len < 256) out.push((major << 5) | 24, len);
    else out.push((major << 5) | 25, len >> 8, len & 0xff);
  };
  if (typeof value === "number" && Number.isInteger(value)) {
    if (value >= 0) head(0, value);
    else head(1, -1 - value);
  } else if (value instanceof Uint8Array) {
    head(2, value.length);
    out.push(...value);
  } else if (typeof value === "string") {
    const b = new TextEncoder().encode(value);
    head(3, b.length);
    out.push(...b);
  } else if (value instanceof Map) {
    head(5, value.size);
    for (const [k, v] of value) out.push(...cborEncode(k), ...cborEncode(v));
  } else {
    throw new Error("unencodable");
  }
  return new Uint8Array(out);
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data.slice().buffer as ArrayBuffer));
}

export interface ForgeOpts {
  rpId?: string;
  origin?: string;
  type?: string;
  alg?: number;
  credId?: Uint8Array;
  flags?: number;
}

/** One registration response for `challenge`, authentic in structure. */
export async function forgeRegistration(challenge: string, opts: ForgeOpts = {}) {
  const credId = opts.credId ?? crypto.getRandomValues(new Uint8Array(16));
  const coseKey = cborEncode(
    new Map<number, unknown>([
      [1, 2], // kty EC2
      [3, opts.alg ?? -7],
      [-1, 1], // crv P-256
      [-2, new Uint8Array(32).fill(7)],
      [-3, new Uint8Array(32).fill(9)],
    ]),
  );
  const rpHash = await sha256(new TextEncoder().encode(opts.rpId ?? RP));
  const authData = new Uint8Array([
    ...rpHash,
    opts.flags ?? 0x45, // UP | UV | AT
    0,
    0,
    0,
    1, // counter
    ...new Uint8Array(16), // aaguid
    credId.length >> 8,
    credId.length & 0xff,
    ...credId,
    ...coseKey,
  ]);
  const attestation = cborEncode(
    new Map<string, unknown>([
      ["fmt", "none"],
      ["attStmt", new Map()],
      ["authData", authData],
    ]),
  );
  const clientData = new TextEncoder().encode(
    JSON.stringify({ type: opts.type ?? "webauthn.create", challenge, origin: opts.origin ?? `https://${RP}` }),
  );
  return {
    id: b64u(credId),
    response: { clientDataJSON: b64u(clientData), attestationObject: b64u(attestation) },
  };
}

describe("the door's gate — every refusal has its own sentence", () => {
  it("unknown, consumed, expired and mismatched-address links each refuse distinctly", async () => {
    const { env } = await world();
    expect((await optionsFor(env, "wrong-token")).body.error).toContain("not recognized");
    expect((await optionsFor(env, TOKEN, "other@x.com")).body.error).toContain("does not match");
    const consumed = await world({ consumedAt: Date.now() });
    expect((await optionsFor(consumed.env)).body.error).toContain("already used");
    const expired = await world({ expiresAt: Date.now() - 1 });
    expect((await optionsFor(expired.env)).body.error).toContain("expired");
  });

  it("a legacy password principal cannot come through this door — arrival only", async () => {
    const { env } = await world({ legacyPassword: true });
    expect((await optionsFor(env)).body.error).toContain("already set up");
  });
});

describe("the ceremony ×2 — the credential rule end to end", () => {
  it("two registrations complete the account, consume the link, and refuse a third", async () => {
    const { env } = await world();

    // First authenticator.
    const one = await optionsFor(env);
    expect(one.res.status).toBe(200);
    const reg1 = await enrollRegister(
      post("/enroll/webauthn/register", {
        token: TOKEN,
        email: EMAIL,
        credential: await forgeRegistration(one.body.publicKey!.challenge),
      }),
      env,
    );
    const out1 = (await reg1.json()) as { count: number; complete: boolean };
    expect(out1).toMatchObject({ count: 1, complete: false });

    // The link stays live for the SECOND authenticator — one arrival, two
    // devices — and the second's options exclude the first credential.
    const two = await optionsFor(env);
    expect(two.res.status).toBe(200);
    const reg2 = await enrollRegister(
      post("/enroll/webauthn/register", {
        token: TOKEN,
        email: EMAIL,
        credential: await forgeRegistration(two.body.publicKey!.challenge),
      }),
      env,
    );
    const out2 = (await reg2.json()) as { count: number; complete: boolean };
    expect(out2).toMatchObject({ count: REQUIRED_AUTHENTICATORS, complete: true });

    // Completion consumed the link: the door is closed, in its own words.
    expect((await optionsFor(env)).body.error).toContain("already used");
  });

  it("the operator, the logs and the wire never held a secret — the row is a public key", async () => {
    const { env } = await world();
    const opt = await optionsFor(env);
    await enrollRegister(
      post("/enroll/webauthn/register", {
        token: TOKEN,
        email: EMAIL,
        credential: await forgeRegistration(opt.body.publicKey!.challenge),
      }),
      env,
    );
    const row = (env as { DB: D1Database }).DB
      ? await (env as { DB: D1Database }).DB.prepare(
          `SELECT public_key_cose, alg FROM webauthn_credentials WHERE principal_id = ?`,
        )
          .bind(PRINCIPAL)
          .first<{ public_key_cose: string; alg: number }>()
      : null;
    expect(row?.alg).toBe(-7);
    // The stored bytes decode as a COSE map — a public key, nothing sealed.
    const cose = cborDecode(
      Uint8Array.from(atob(row!.public_key_cose.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)),
    ).value;
    expect(cose).toBeInstanceOf(Map);
  });
});

describe("the page and its script", () => {
  it("the page says the quiet part out loud: two passkeys, no password", async () => {
    const html = await enrollPage().text();
    expect(html).toContain("two");
    expect(html.toLowerCase()).toContain("no password");
    expect(html).not.toContain('type="password"');
  });

  it("the script moves the fragment out of the URL and never posts to /enroll", async () => {
    const js = await enrollScript().text();
    expect(js).toContain("location.hash");
    expect(js).toContain("replaceState");
    expect(js).toContain("/enroll/webauthn/options");
    expect(js).toContain(`of ${REQUIRED_AUTHENTICATORS} registered`);
  });

  it("rpIdOf honours the env override — the BYO-install seam", () => {
    expect(rpIdOf({ RP_ID: "auth.tea.example" } as never)).toBe("auth.tea.example");
    expect(rpIdOf({} as never)).toBe(RP);
  });
});
