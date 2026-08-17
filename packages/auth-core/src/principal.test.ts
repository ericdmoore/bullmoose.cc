import { describe, expect, it } from "vitest";
import { fakeD1 } from "@bullmoose/test-fakes";
import { mintToken } from "./index";
import {
  authorizeAccount,
  verifyBearer,
  type AccountAccess,
  type GrantRef,
  type Principal,
} from "./principal";

// authorizeAccount is a pure decision (no I/O), so these run with plain
// object fixtures — no DB, no network, no mocks. Per .plans/devPrinciples.md:
// keep the core pure and the effect (the grant_audit write) in the shell.

const owned = (accountId: string, extra: Partial<AccountAccess> = {}): AccountAccess => ({
  accountId,
  tenantId: "t_bm",
  name: accountId,
  ...extra,
});

const grantRef = (over: Partial<GrantRef> = {}): GrantRef => ({
  grantId: "g_1",
  scopes: ["read"],
  collection: null,
  collectionId: null,
  ...over,
});

const principal = (over: Partial<Principal> = {}): Principal => ({
  username: "eric@bullmoose.cc",
  scopes: ["read", "draft"],
  accounts: [owned("a_eric")],
  ...over,
});

describe("authorizeAccount — owned accounts", () => {
  it("allows a scope the token holds, with no grant to audit", () => {
    const d = authorizeAccount(principal(), "a_eric", "read", "mail");
    expect(d).toEqual({ ok: true, access: owned("a_eric"), auditGrant: null });
  });

  it('treats "mail" as a superset of every mail verb', () => {
    const d = authorizeAccount(principal({ scopes: ["mail"] }), "a_eric", "send", "mail");
    expect(d.ok).toBe(true);
  });

  it("forbids a scope the token lacks", () => {
    const d = authorizeAccount(principal({ scopes: ["read"] }), "a_eric", "send", "mail");
    expect(d).toEqual({
      ok: false,
      reason: "forbidden",
      detail: 'token lacks the "send" scope',
    });
  });

  it("reports accountNotFound for an account the principal cannot see", () => {
    const d = authorizeAccount(principal(), "a_stranger", "read", "mail");
    expect(d).toEqual({ ok: false, reason: "accountNotFound" });
  });
});

describe("authorizeAccount — grant-reached accounts", () => {
  const granted = (grants: GrantRef[], tokenScopes = ["read", "draft"]): Principal =>
    principal({
      username: "allen@bullmoose.cc",
      scopes: tokenScopes,
      accounts: [owned("a_allen"), owned("a_eric", { granted: grants })],
    });

  it("allows when token AND a covering grant both hold the scope, returning the grant to audit", () => {
    const d = authorizeAccount(granted([grantRef({ scopes: ["read"] })]), "a_eric", "read", "mail");
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.auditGrant?.grantId).toBe("g_1");
  });

  it("forbids when the token has the scope but no grant covers it", () => {
    // token has draft; grant only read → token ∩ grant excludes draft.
    const d = authorizeAccount(
      granted([grantRef({ scopes: ["read"] })]),
      "a_eric",
      "draft",
      "mail",
    );
    expect(d).toEqual({
      ok: false,
      reason: "forbidden",
      detail: 'no grant covers "draft" on this account',
    });
  });

  it("checks the token scope BEFORE the grant (token lacks scope wins)", () => {
    const d = authorizeAccount(
      granted([grantRef({ scopes: ["read", "draft"] })], ["read"]),
      "a_eric",
      "draft",
      "mail",
    );
    expect(d).toEqual({
      ok: false,
      reason: "forbidden",
      detail: 'token lacks the "draft" scope',
    });
  });

  it("does not let an AddressBook-scoped grant satisfy a mail-domain call", () => {
    const d = authorizeAccount(
      granted([grantRef({ scopes: ["read"], collection: "AddressBook", collectionId: "ab_1" })]),
      "a_eric",
      "read",
      "mail",
    );
    expect(d).toEqual({
      ok: false,
      reason: "forbidden",
      detail: 'no grant covers "read" on this account',
    });
  });

  it("lets a whole-account grant (collection null) cover any domain", () => {
    const d = authorizeAccount(
      granted([grantRef({ scopes: ["read"], collection: null })]),
      "a_eric",
      "read",
      "contacts",
    );
    expect(d.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// s03.A T2 — grant tombstones. verifyBearer is the resolution layer where a
// grant becomes reach; this is where `revoked_at IS NULL` must bite. Real
// node:sqlite on the live schema, so the tombstone column is the deployed one.
// ---------------------------------------------------------------------------
describe("verifyBearer — a revoked grant stops resolving but its history survives", () => {
  const GRANTEE = "a_allen";
  const TARGET = "a_eric";

  /** Two accounts, a token for the grantee, and one grant onto the target. */
  async function seed(revokedAt: number | null) {
    const db = fakeD1();
    db.seedAccount({
      accountId: GRANTEE,
      principalId: "p_allen",
      loginEmail: "allen@bullmoose.cc",
    });
    db.seedAccount({ accountId: TARGET, principalId: "p_eric", loginEmail: "eric@bullmoose.cc" });
    const minted = await mintToken();
    db.seed("tokens", [
      {
        id: minted.id,
        principal_id: "p_allen",
        secret_hash: minted.secretHash,
        name: "laptop",
        scopes: JSON.stringify(["mail"]),
        created_at: 1,
      },
    ]);
    db.seed("grants", [
      {
        id: "g_1",
        tenant_id: "t_bm",
        grantee_account_id: GRANTEE,
        target_account_id: TARGET,
        scopes: JSON.stringify(["read"]),
        created_by: "admin",
        created_at: 1,
        revoked_at: revokedAt,
      },
    ]);
    return { db, token: minted.token };
  }

  it("resolves a LIVE grant — the target appears as a granted account", async () => {
    const { db, token } = await seed(null);
    const p = await verifyBearer(db, token);
    const target = p?.accounts.find((a) => a.accountId === TARGET);
    expect(target?.granted?.[0]?.grantId).toBe("g_1");
  });

  it("does NOT resolve a REVOKED grant — reach is gone immediately", async () => {
    const { db, token } = await seed(Date.now());
    const p = await verifyBearer(db, token);
    // The grantee still owns its own account; it just no longer reaches the target.
    expect(p?.accounts.map((a) => a.accountId)).toEqual([GRANTEE]);
    expect(p?.accounts.some((a) => a.accountId === TARGET)).toBe(false);
  });

  it("keeps the tombstoned row — a point-in-time query can still find it", async () => {
    const { db } = await seed(Date.now());
    // The row is not deleted: "who could have reached this account?" stays
    // answerable. This is the whole bargain — resolution hides it, history keeps it.
    expect(db.count("grants")).toBe(1);
    expect(db.count("grants", "revoked_at IS NOT NULL")).toBe(1);
  });
});
