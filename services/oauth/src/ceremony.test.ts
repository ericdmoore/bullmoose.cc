import { describe, expect, it } from "vitest";
import { fakeEnv, fakeKV } from "@bullmoose/test-fakes";
import { ceremonyBegin, ceremonyPage, ceremonyScript, ceremonyVerify } from "./ceremony.js";
import { b64u } from "./webauthn.js";
import { realAuthenticator, signAssertion } from "./webauthn.test.js";

// The tea ceremony's own contract: the page states the ACT (from the row —
// the URL carries only an opaque token), the assertion is bound to THIS
// ceremony's purpose, a pass flips exactly once, and every failure DECIDES
// the row — one link, one answer, whoever holds it.

const PRINCIPAL = "p_kevin";
const TOKEN = "c".repeat(64);
const DESCRIPTION =
  "Approve: hr@company.com disclosing your 401(k) balance in reply to a message sent from alice@company.com at 3:04 AM.";

async function sha256hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function world(over: { expiresAt?: number; status?: string } = {}) {
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
     VALUES (?, ?, ?, -7, 0, ?)`,
  )
    .bind(b64u(authn.credId), PRINCIPAL, b64u(authn.cose), Date.now())
    .run();
  await w.env.DB.prepare(
    `INSERT INTO ceremonies (id, principal_id, account_id, binding_id, category, description, secret_hash, status, created_at, expires_at)
     VALUES ('cer_1', ?, 't_bm__a_k', 'bind_hr', 'benefits.balance', ?, ?, ?, ?, ?)`,
  )
    .bind(
      PRINCIPAL,
      DESCRIPTION,
      await sha256hex(TOKEN),
      over.status ?? "pending",
      Date.now(),
      over.expiresAt ?? Date.now() + 5 * 60_000,
    )
    .run();
  return { env: { DB: w.env.DB, OAUTH_KV: kv.ns } as never, authn, db: w.env.DB };
}

const post = (path: string, body: unknown) =>
  new Request(`https://auth.bullmoose.cc${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const begin = async (env: never, token = TOKEN) => {
  const res = await ceremonyBegin(post("/ceremony/begin", { token }), env);
  return {
    res,
    body: (await res.json()) as { error?: string; description?: string; publicKey?: { challenge: string } },
  };
};

const rowStatus = async (db: D1Database) =>
  (await db
    .prepare(`SELECT status, consumed_at FROM ceremonies WHERE id = 'cer_1'`)
    .first<{ status: string; consumed_at: number | null }>())!;

describe("the described act is the product", () => {
  it("begin returns the ROW's description — the URL carried only a token", async () => {
    const { env } = await world();
    const { res, body } = await begin(env);
    expect(res.status).toBe(200);
    expect(body.description).toBe(DESCRIPTION);
  });

  it("the page and script never embed an act — it always arrives from begin", async () => {
    expect(await ceremonyPage().text()).toContain("read what it is");
    const js = await ceremonyScript().text();
    expect(js).toContain("/ceremony/begin");
    expect(js).toContain("location.hash");
  });

  it("decided, expired and unknown links each refuse in their own words", async () => {
    const decided = await world({ status: "passed" });
    expect((await begin(decided.env)).body.error).toContain("already decided");
    const expired = await world({ expiresAt: Date.now() - 1 });
    expect((await begin(expired.env)).body.error).toContain("expired");
    const fresh = await world();
    expect((await begin(fresh.env, "wrong")).body.error).toContain("not recognized");
  });
});

describe("the verdict", () => {
  it("the owner's real passkey passes — once, atomically", async () => {
    const { env, authn, db } = await world();
    const opts = await begin(env);
    const assertion = await signAssertion(authn, opts.body.publicKey!.challenge);
    const res = await ceremonyVerify(post("/ceremony/verify", { token: TOKEN, assertion }), env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { passed: boolean }).passed).toBe(true);
    expect((await rowStatus(db)).status).toBe("passed");
    // The second answer refuses: one link, one answer.
    const again = await begin(env);
    expect(again.body.error).toContain("already decided");
  });

  it("a login challenge cannot satisfy a ceremony — purpose binds the assertion", async () => {
    const { env, authn, db } = await world();
    // Sign against a challenge minted for LOGIN, not this ceremony.
    const { assertionOptions } = await import("./webauthn.js");
    const loginOpts = (await assertionOptions(env, "login")) as { challenge: string };
    const assertion = await signAssertion(authn, loginOpts.challenge);
    const res = await ceremonyVerify(post("/ceremony/verify", { token: TOKEN, assertion }), env);
    expect(res.status).toBe(422);
    // And the mismatch DECIDED the ceremony — an attacker with the link
    // does not get unlimited tries at the wrong human.
    expect((await rowStatus(db)).status).toBe("failed");
  });

  it("someone ELSE'S valid passkey fails the ceremony — authentic and still not the identity", async () => {
    const { env, db } = await world();
    // Kevin Durant's burner: a REAL credential, registered to another
    // principal. Cryptographically perfect; exactly the wrong person.
    const { realAuthenticator: mint } = await import("./webauthn.test.js");
    const other = await mint();
    await (db as D1Database)
      .prepare(
        `INSERT INTO principals (id, tenant_id, login_email, created_at) VALUES ('p_other', 't_bm', 'o@bm.cc', ?)`,
      )
      .bind(Date.now())
      .run();
    await (db as D1Database)
      .prepare(
        `INSERT INTO webauthn_credentials (id, principal_id, public_key_cose, alg, counter, created_at)
         VALUES (?, 'p_other', ?, -7, 0, ?)`,
      )
      .bind(b64u(other.credId), b64u(other.cose), Date.now())
      .run();
    const opts = await begin(env);
    const assertion = await signAssertion(other, opts.body.publicKey!.challenge);
    const res = await ceremonyVerify(post("/ceremony/verify", { token: TOKEN, assertion }), env);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toContain("does not belong to this account's owner");
    expect((await rowStatus(db)).status).toBe("failed");
  });

  it("a failed signature decides the row and says the owner will be told", async () => {
    const { env, authn, db } = await world();
    const opts = await begin(env);
    const assertion = await signAssertion(authn, opts.body.publicKey!.challenge, { wrongKey: true });
    const res = await ceremonyVerify(post("/ceremony/verify", { token: TOKEN, assertion }), env);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toContain("the account owner will be told");
    expect((await rowStatus(db)).status).toBe("failed");
  });
});
