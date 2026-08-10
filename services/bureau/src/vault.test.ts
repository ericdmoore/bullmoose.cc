import { describe, expect, it } from "vitest";
import { fakeD1, type FakeD1 } from "@bullmoose/test-fakes";
import worker from "./index";
import type { Env } from "./models";
import { openCredential } from "./vault";

/**
 * T3a — the master key's new home.
 *
 * `sealSecret` / `openSecret` / `vaultAad` and seal-on-mint all moved here from
 * `services/agent/src/vault.ts`. These tests prove the crypto still round-trips
 * across the move, and — the part that matters more — that the move actually
 * moved something: the Bureau is the only place a value can be produced, and
 * even here no ROUTE produces one.
 */

const MASTER = "test-vault-master-key-0123456789abcdef";
const OTHER_MASTER = "a-completely-different-master-key-9876";
const INTERNAL = "internal-test-token";
const PRINCIPAL = "p_vault";
const EMAIL = "vault@bullmoose.cc";

function harness(master = MASTER) {
  const db = fakeD1();
  db.seedAccount({ accountId: "a_vault", principalId: PRINCIPAL, loginEmail: EMAIL });
  const env: Env = { DB: db, VAULT_MASTER_KEY: master, INTERNAL_TOKEN: INTERNAL };
  const call = (path: string, body: unknown, token = INTERNAL) =>
    worker.fetch(
      new Request(`https://bureau.internal${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-token": token },
        body: JSON.stringify(body),
      }),
      env,
    );
  return { db, env, call };
}

const mint = (h: { call: ReturnType<typeof harness>["call"] }, name: string, secret: string, kind = "api-key") =>
  h.call("/internal/bureau/seal", {
    mode: "mint",
    principalId: PRINCIPAL,
    name,
    kind,
    metaJson: JSON.stringify({ allow: "https://api.stripe.com", scope: "actor" }),
    secret,
  });

describe("seal-on-mint lives in the Bureau now", () => {
  it("seals, stores, and opens back in-process", async () => {
    const h = harness();
    expect((await mint(h, "stripe", "sk_live_TOPSECRET")).status).toBe(200);

    const opened = await openCredential(h.env, PRINCIPAL, "stripe");
    expect(opened?.secret).toBe("sk_live_TOPSECRET");
    expect(opened?.kind).toBe("api-key");
    expect(opened?.meta).toMatchObject({ allow: "https://api.stripe.com", scope: "actor" });
  });

  it("never writes the plaintext to the row", async () => {
    const h = harness();
    await mint(h, "stripe", "sk_live_TOPSECRET");
    const row = h.db.query<{ enc_json: string; meta_json: string }>(
      `SELECT enc_json, meta_json FROM vault_credentials WHERE name = 'stripe'`,
    )[0]!;
    expect(row.enc_json).not.toContain("sk_live_TOPSECRET");
    expect(row.meta_json).not.toContain("sk_live_TOPSECRET");
    expect(JSON.parse(row.enc_json)).toMatchObject({ v: 1 });
  });

  it("rotate re-seals without touching the contract", async () => {
    const h = harness();
    await mint(h, "rotate-me", "OLD");
    const before = h.db.query<{ meta_json: string; enc_json: string }>(
      `SELECT meta_json, enc_json FROM vault_credentials WHERE name = 'rotate-me'`,
    )[0]!;

    const res = await h.call("/internal/bureau/seal", {
      mode: "rotate",
      principalId: PRINCIPAL,
      name: "rotate-me",
      secret: "NEW",
    });
    expect(res.status).toBe(200);

    const after = h.db.query<{ meta_json: string; enc_json: string }>(
      `SELECT meta_json, enc_json FROM vault_credentials WHERE name = 'rotate-me'`,
    )[0]!;
    expect(after.meta_json).toBe(before.meta_json);
    expect(after.enc_json).not.toBe(before.enc_json);
    expect((await openCredential(h.env, PRINCIPAL, "rotate-me"))?.secret).toBe("NEW");
  });

  it("404s rotating a credential that does not exist", async () => {
    const h = harness();
    const res = await h.call("/internal/bureau/seal", {
      mode: "rotate",
      principalId: PRINCIPAL,
      name: "ghost",
      secret: "x",
    });
    expect(res.status).toBe(404);
  });
});

describe("the decrypt-and-discard health check", () => {
  it("returns a boolean and nothing else", async () => {
    const h = harness();
    await mint(h, "health", "v1");
    const res = await h.call("/internal/bureau/verify", { principalEmail: EMAIL, name: "health" });
    expect(await res.json()).toEqual({ ok: true });
  });

  it("reports a row it cannot open, without leaking why", async () => {
    const h = harness();
    await mint(h, "health", "v1");
    // Same rows, different master key — what a botched key rotation looks like.
    const wrongKey: Env = { ...h.env, VAULT_MASTER_KEY: OTHER_MASTER };
    const res = await worker.fetch(
      new Request("https://bureau.internal/internal/bureau/verify", {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-token": INTERNAL },
        body: JSON.stringify({ principalEmail: EMAIL, name: "health" }),
      }),
      wrongKey,
    );
    expect(await res.json()).toEqual({ ok: false, reason: "cannot decrypt" });
  });

  it("reports a missing row as not-found rather than as a crypto failure", async () => {
    const h = harness();
    const res = await h.call("/internal/bureau/verify", { principalEmail: EMAIL, name: "ghost" });
    expect(await res.json()).toEqual({ ok: false, reason: "not found" });
  });
});

describe("the AAD still binds the row (auth-core vaultAad)", () => {
  it("refuses to open a sealed value copied onto another principal's row", async () => {
    const h = harness();
    h.db.seedAccount({ accountId: "a_thief", principalId: "p_thief", loginEmail: "thief@bullmoose.cc" });
    await mint(h, "stripe", "sk_live_TOPSECRET");
    const stolen = h.db.query<{ enc_json: string }>(
      `SELECT enc_json FROM vault_credentials WHERE name = 'stripe'`,
    )[0]!;
    // The row-swap attack the AAD exists to stop: the ciphertext is copied
    // verbatim onto a row the attacker controls. Crypto, not a check, refuses.
    h.db.seed("vault_credentials", [
      {
        id: "vc_stolen",
        principal_id: "p_thief",
        name: "stripe",
        kind: "api-key",
        enc_json: stolen.enc_json,
        meta_json: "{}",
        created_at: 1,
        updated_at: 1,
      },
    ]);
    await expect(openCredential(h.env, "p_thief", "stripe")).rejects.toThrow();
  });
});

describe("no route on this worker returns a credential", () => {
  it("gates every /internal path on the shared token", async () => {
    const h = harness();
    const res = await h.call("/internal/bureau/verify", { principalEmail: EMAIL, name: "x" }, "wrong");
    expect(res.status).toBe(401);
  });

  it("has no route that echoes a stored value back", async () => {
    const h = harness();
    await mint(h, "stripe", "sk_live_TOPSECRET");
    // Invariant 1, asserted as a sweep rather than as a claim about one handler:
    // whatever these routes answer, none of it is the secret. `/bureau/use` is
    // included because it is the one route DESIGNED to act on a credential.
    for (const path of ["/", "/internal/bureau/seal", "/internal/bureau/verify", "/bureau/use"]) {
      const res = await h.call(path, { principalId: PRINCIPAL, name: "stripe", credRef: "stripe", verb: "fetch" });
      expect(await res.text(), path).not.toContain("sk_live_TOPSECRET");
    }
  });
});
