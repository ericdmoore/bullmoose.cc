import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOGIN_SCOPES,
  MAIL_SCOPES,
  REALM_SCOPES,
  SELF_SERVICE_SCOPES,
  TOKEN_SCOPES,
  hasScope,
  resolveMintScopes,
  unknownScopes,
} from "./index.js";

// The gate every mint site runs. Before it, `body.scopes` went into the
// tokens row verbatim and an omitted field meant ["mail"] — so the shortest
// possible request produced the widest credential the API can express.
//
// Two properties are load-bearing and are asserted here rather than at the
// call sites, because all four call sites now share this one function:
//   1. undefined WITHOUT a fallback is an error (the defaults are gone)
//   2. undefined WITH a fallback is the ONLY surviving default, and only
//      /auth/login passes one — otherwise nobody could get a first token.

describe("resolveMintScopes — the missing default", () => {
  it("refuses an omitted `scopes` when no fallback is offered", () => {
    const r = resolveMintScopes(undefined, SELF_SERVICE_SCOPES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/required/);
  });

  it("names the vocabulary in the error, so the caller can fix it in one go", () => {
    const r = resolveMintScopes(undefined, SELF_SERVICE_SCOPES);
    if (r.ok) throw new Error("expected failure");
    for (const s of ["read", "send", "contacts", "mail"]) expect(r.error).toContain(s);
  });

  it("uses the fallback when one is offered (the /auth/login bootstrap)", () => {
    const r = resolveMintScopes(undefined, SELF_SERVICE_SCOPES, DEFAULT_LOGIN_SCOPES);
    expect(r).toEqual({ ok: true, scopes: ["mail"] });
  });

  it("returns a fresh array — a caller cannot mutate the shared default", () => {
    const r = resolveMintScopes(undefined, SELF_SERVICE_SCOPES, DEFAULT_LOGIN_SCOPES);
    if (!r.ok) throw new Error("expected success");
    r.scopes.push("vault");
    expect(DEFAULT_LOGIN_SCOPES).toEqual(["mail"]);
  });
});

describe("resolveMintScopes — validation", () => {
  it("accepts an explicit narrow request", () => {
    expect(resolveMintScopes(["read", "move"], SELF_SERVICE_SCOPES)).toEqual({
      ok: true,
      scopes: ["read", "move"],
    });
  });

  it("rejects an empty array rather than treating it as `use the default`", () => {
    const r = resolveMintScopes([], SELF_SERVICE_SCOPES, DEFAULT_LOGIN_SCOPES);
    expect(r.ok).toBe(false);
  });

  it("rejects invented scopes — they would store fine and then deny everything", () => {
    const r = resolveMintScopes(["read", "maiil"], SELF_SERVICE_SCOPES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("maiil");
    // The premise: an unknown scope is dead weight in the row.
    expect(hasScope(["maiil"], "read")).toBe(false);
  });

  it("lists every offender once, not just the first", () => {
    const r = resolveMintScopes(["nope", "read", "nope", "alsonope"], SELF_SERVICE_SCOPES);
    if (r.ok) throw new Error("expected failure");
    expect(r.error).toContain("nope, alsonope");
  });

  it("rejects blank and non-string members", () => {
    expect(resolveMintScopes(["read", ""], SELF_SERVICE_SCOPES).ok).toBe(false);
    expect(resolveMintScopes(["read", "  "], SELF_SERVICE_SCOPES).ok).toBe(false);
    expect(resolveMintScopes([1 as unknown as string], SELF_SERVICE_SCOPES).ok).toBe(false);
  });

  it("rejects a non-array (a JSON body can carry anything)", () => {
    expect(resolveMintScopes("mail" as unknown as string[], SELF_SERVICE_SCOPES).ok).toBe(false);
  });
});

describe("scope vocabularies", () => {
  it("self-service excludes `admin`; the operator plane includes it", () => {
    expect(SELF_SERVICE_SCOPES).not.toContain("admin");
    expect(TOKEN_SCOPES).toContain("admin");
  });

  it("a password alone cannot mint a control-plane token", () => {
    // /auth/login has no minter token to compare against, so this list is
    // the only thing between "knows a password" and "holds admin".
    expect(resolveMintScopes(["admin"], SELF_SERVICE_SCOPES).ok).toBe(false);
    expect(resolveMintScopes(["admin"], TOKEN_SCOPES).ok).toBe(true);
  });

  it("covers every mail verb and every realm", () => {
    for (const s of [...MAIL_SCOPES, ...REALM_SCOPES]) {
      expect(SELF_SERVICE_SCOPES).toContain(s);
      expect(TOKEN_SCOPES).toContain(s);
    }
  });

  it("the login default grants the mail verbs and NOTHING else", () => {
    // This is why ["mail"] is still an acceptable default: post-hasScope
    // fix it is a mail bundle, not a wildcard.
    for (const verb of MAIL_SCOPES) expect(hasScope([...DEFAULT_LOGIN_SCOPES], verb)).toBe(true);
    for (const realm of REALM_SCOPES)
      expect(hasScope([...DEFAULT_LOGIN_SCOPES], realm)).toBe(false);
    expect(hasScope([...DEFAULT_LOGIN_SCOPES], "admin")).toBe(false);
  });
});

describe("unknownScopes", () => {
  it("returns [] when everything is allowed", () => {
    expect(unknownScopes(["read", "vault"], SELF_SERVICE_SCOPES)).toEqual([]);
  });

  it("preserves order and de-duplicates", () => {
    expect(unknownScopes(["z", "read", "a", "z"], SELF_SERVICE_SCOPES)).toEqual(["z", "a"]);
  });
});
