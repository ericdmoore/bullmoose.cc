import { describe, expect, it } from "vitest";
import { hasScope, scopesWithin, MAIL_SCOPES, REALM_SCOPES } from "./index";

// Regression suite for .feedback/fromClaude/common/001 — `mail` as a
// universal scope.
//
// The defect: `hasScope` returned true for EVERY non-"admin" scope when the
// token held "mail". Since /auth/login mints ["mail"] by default
// (authRoutes.ts:89), that was every token ever issued — and it meant a mail
// token opened the vault, which holds third-party provider credentials.

describe("mail is a bundle of the mail verbs, not a wildcard", () => {
  it.each([...MAIL_SCOPES])("mail covers the %s verb", (verb) => {
    expect(hasScope(["mail"], verb)).toBe(true);
  });

  it.each([...REALM_SCOPES])("mail does NOT cover the %s realm", (realm) => {
    expect(hasScope(["mail"], realm)).toBe(false);
  });

  it("mail does not cover admin", () => {
    // Was already false, via a `required !== "admin"` special case. That case
    // is now redundant — admin simply is not in MAIL_SCOPES — so this asserts
    // the behaviour survived removing it.
    expect(hasScope(["mail"], "admin")).toBe(false);
  });

  it("denies an unknown scope rather than defaulting open", () => {
    expect(hasScope(["mail"], "vault-admin")).toBe(false);
    expect(hasScope(["mail"], "")).toBe(false);
  });
});

describe("scopes held verbatim still satisfy themselves", () => {
  it.each([...REALM_SCOPES])("a %s token satisfies %s", (realm) => {
    expect(hasScope([realm], realm)).toBe(true);
  });

  it("realm scopes do not cover each other", () => {
    expect(hasScope(["contacts"], "calendar")).toBe(false);
    expect(hasScope(["calendar"], "vault")).toBe(false);
  });

  it("a mail verb does not imply the bundle", () => {
    expect(hasScope(["read"], "mail")).toBe(false);
    expect(hasScope(["read"], "delete")).toBe(false);
  });

  it("an admin token is not a mail token", () => {
    expect(hasScope(["admin"], "read")).toBe(false);
  });
});

describe("scopesWithin — the self-service minting gate", () => {
  // This is the lockout mechanism. /auth/tokens gates a mint on
  // scopesWithin(requested, thisToken.scopes), so a token can only narrow
  // itself. After this fix a `mail` token cannot mint a vault token — which
  // is why `bullmoose login --scopes` exists as the widening path.
  it("a mail token can narrow to any mail verb", () => {
    expect(scopesWithin(["read", "send"], ["mail"])).toBe(true);
  });

  it("a mail token CANNOT widen into a realm scope", () => {
    expect(scopesWithin(["vault"], ["mail"])).toBe(false);
    expect(scopesWithin(["contacts"], ["mail"])).toBe(false);
  });

  it("a mixed request fails if any single scope exceeds", () => {
    expect(scopesWithin(["read", "vault"], ["mail"])).toBe(false);
  });

  it("a token holding the realm scope can pass it on", () => {
    expect(scopesWithin(["vault"], ["mail", "vault"])).toBe(true);
  });

  it("an empty request is trivially within anything", () => {
    // `.every` on [] is true. Documented rather than asserted-as-desirable:
    // callers must not treat "no scopes requested" as "no check needed".
    expect(scopesWithin([], ["read"])).toBe(true);
  });
});
