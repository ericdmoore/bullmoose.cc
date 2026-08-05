import { describe, expect, it } from "vitest";
import {
  authorizeAccount,
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
    const d = authorizeAccount(
      principal({ scopes: ["mail"] }),
      "a_eric",
      "send",
      "mail",
    );
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
    const d = authorizeAccount(granted([grantRef({ scopes: ["read"] })]), "a_eric", "draft", "mail");
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
