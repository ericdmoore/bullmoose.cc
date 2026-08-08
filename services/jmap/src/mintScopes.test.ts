import { hashLoginKey } from "@bullmoose/auth-core";
import { beforeAll, describe, expect, it } from "vitest";
import { fakeEnv } from "@bullmoose/test-fakes";
import type { Principal } from "./auth";
import { handleLogin, handleTokens } from "./authRoutes";

// What the two self-service mint endpoints actually WRITE to the tokens row.
//
// Both used to read `body.scopes ?? ["mail"]`, so a request that said
// nothing about scope got the widest self-service credential there is —
// /auth/login being the sharp one, since it mints every user's primary
// token. Neither validated the strings it stored, so `["admin"]` and
// `["nonsense"]` both persisted verbatim.
//
// These tests assert on the INSERT arguments, not the response body: the
// row is what a later hasScope() check reads.

const GOOD_KEY = "a".repeat(64); // isLoginKey: 64 lowercase hex
const EMAIL = "eric@bullmoose.cc";

let pwHash: string;
beforeAll(async () => {
  pwHash = await hashLoginKey(GOOD_KEY);
});

/**
 * One principal with a password, seeded into the real tables so both handlers'
 * SELECTs run as written. Fakes are @bullmoose/test-fakes (sVOL 002); this file
 * used to carry its own D1 *and* its own KV, and the KV disagreed with the one
 * in authRoutes.test.ts about whether expiry exists.
 */
function world() {
  const w = fakeEnv();
  w.db.seedAccount({ accountId: "a_eric", principalId: "p_eric", loginEmail: EMAIL });
  w.db.seed("credentials", [
    {
      principal_id: "p_eric",
      pw_algo: "client-pbkdf2-sha256-v1",
      pw_hash: pwHash,
      pw_salt: "salt",
      pw_iters: 1,
      updated_at: 1,
    },
  ]);
  return w;
}

/** The `scopes` column of the single INSERT INTO tokens, parsed. */
function insertedScopes(writes: Array<{ sql: string; args: unknown[] }>): string[] {
  const w = writes.filter((x) => x.sql.includes("INSERT INTO tokens"));
  expect(w).toHaveLength(1);
  // (id, principal_id, secret_hash, name, scopes, created_at[, expires_at])
  return JSON.parse(String(w[0]?.args[4]));
}

function login(body: Record<string, unknown>) {
  const w = world();
  const req = new Request("https://jmap.bullmoose.cc/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7" },
    body: JSON.stringify({ email: EMAIL, loginKey: GOOD_KEY, ...body }),
  });
  return { res: handleLogin(req, w.env), writes: w.db.writes };
}

function mint(body: Record<string, unknown>, held: string[] = ["mail", "contacts", "vault"]) {
  const w = world();
  const principal: Principal = { username: EMAIL, scopes: held, accounts: [] };
  const url = new URL("https://jmap.bullmoose.cc/auth/tokens");
  const req = new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { res: handleTokens(req, url, w.env, principal), writes: w.db.writes };
}

describe("POST /auth/login — the one surviving default", () => {
  it("mints the mail bundle when no scopes are asked for", async () => {
    // Bootstrap: this must keep working, or a user with no token has no way
    // to get one. `mail` is now exactly the six mail verbs.
    const { res, writes } = login({});
    expect((await res).status).toBe(200);
    expect(insertedScopes(writes)).toEqual(["mail"]);
  });

  it("honours an explicit narrow request", async () => {
    const { res, writes } = login({ scopes: ["read"] });
    expect((await res).status).toBe(200);
    expect(insertedScopes(writes)).toEqual(["read"]);
  });

  it("honours an explicit WIDE request — login is the only way to widen", async () => {
    const { res, writes } = login({ scopes: ["mail", "contacts", "calendar", "vault"] });
    expect((await res).status).toBe(200);
    expect(insertedScopes(writes)).toEqual(["mail", "contacts", "calendar", "vault"]);
  });

  it("refuses `admin`: a password must not reach the control plane", async () => {
    const { res, writes } = login({ scopes: ["admin"] });
    const r = await res;
    expect(r.status).toBe(400);
    expect(writes.filter((w) => w.sql.includes("INSERT INTO tokens"))).toHaveLength(0);
  });

  it("refuses an invented scope instead of storing it", async () => {
    const { res, writes } = login({ scopes: ["read", "sudo"] });
    expect((await res).status).toBe(400);
    expect(writes).toHaveLength(0);
  });

  it("refuses an empty array rather than minting a useless token", async () => {
    const { res } = login({ scopes: [] });
    expect((await res).status).toBe(400);
  });

  it("rejects bad scopes before touching credentials (no account oracle)", async () => {
    // The 400 is a property of the request, so it is identical whether or
    // not the email exists — and it costs no credential read.
    const { res, writes } = login({ email: "nobody@bullmoose.cc", scopes: ["sudo"] });
    const r = await res;
    expect(r.status).toBe(400);
    expect(writes).toHaveLength(0);
  });
});

describe("POST /auth/tokens — no default at all", () => {
  it("refuses a mint that omits scopes (was: silently ['mail'])", async () => {
    const { res, writes } = mint({ name: "iphone" });
    const r = await res;
    expect(r.status).toBe(400);
    expect((await r.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining("required"),
    });
    expect(writes).toHaveLength(0);
  });

  it("mints exactly what was asked for", async () => {
    const { res, writes } = mint({ name: "popper", scopes: ["read", "move"] });
    expect((await res).status).toBe(200);
    expect(insertedScopes(writes)).toEqual(["read", "move"]);
  });

  it("still enforces narrowing — requested must be within the minter's scopes", async () => {
    const { res, writes } = mint({ name: "x", scopes: ["calendar"] }, ["mail"]);
    expect((await res).status).toBe(403);
    expect(writes).toHaveLength(0);
  });

  it("a `mail` token can no longer reach the vault through an omitted field", async () => {
    // Before: omit scopes -> ["mail"], and hasScope let "mail" satisfy
    // "vault". Both halves are closed now; this asserts the mint half.
    const { res } = mint({ name: "x" }, ["mail"]);
    expect((await res).status).toBe(400);
  });

  it("refuses `admin` even when asked explicitly", async () => {
    const { res } = mint({ name: "x", scopes: ["admin"] }, ["mail", "admin"]);
    expect((await res).status).toBe(400);
  });

  it("refuses an invented scope", async () => {
    const { res, writes } = mint({ name: "x", scopes: ["maiil"] });
    expect((await res).status).toBe(400);
    expect(writes).toHaveLength(0);
  });
});
