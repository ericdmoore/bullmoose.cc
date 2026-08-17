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

// Regression suite for .feedback/fromClaude/common/027 — the scope docs drew
// an ordered lattice the code did not implement. The DECIDED model: any write
// capability implies `read` (you cannot change what you cannot see), and
// nothing else implies anything. `send` stays its own capability (mailing a
// stranger is irreversible) but, like every write, does imply `read`.

describe("any write capability implies read (common/027)", () => {
  it.each([...MAIL_SCOPES.filter((s) => s !== "read")])("the %s mail verb satisfies read", (verb) => {
    expect(hasScope([verb], "read")).toBe(true);
  });

  it.each([...REALM_SCOPES])("the %s realm scope satisfies read", (realm) => {
    expect(hasScope([realm], "read")).toBe(true);
  });

  it("the specific gaps 027 named all close", () => {
    // These four were false before the fix — a token scoped to its own domain
    // could write data it could not list.
    expect(hasScope(["calendar"], "read")).toBe(true);
    expect(hasScope(["contacts"], "read")).toBe(true);
    expect(hasScope(["files"], "read")).toBe(true);
    expect(hasScope(["move"], "read")).toBe(true);
    expect(hasScope(["delete"], "read")).toBe(true);
  });

  it("send implies read — you must see what you send", () => {
    expect(hasScope(["send"], "read")).toBe(true);
  });

  it("the read edge does not run the other way — read implies no write", () => {
    for (const w of [...MAIL_SCOPES.filter((s) => s !== "read"), ...REALM_SCOPES]) {
      expect(hasScope(["read"], w)).toBe(false);
    }
  });
});

describe("the implication is a single read edge, NOT an order (common/027)", () => {
  it("send does NOT imply the other edit verbs — it stays its own capability", () => {
    // The one exception kept distinct: mailing a third party is irreversible.
    expect(hasScope(["send"], "move")).toBe(false);
    expect(hasScope(["send"], "delete")).toBe(false);
    expect(hasScope(["send"], "annotate")).toBe(false);
    expect(hasScope(["send"], "draft")).toBe(false);
  });

  it("delete does NOT imply send — 'may clean up' is not 'may mail strangers'", () => {
    expect(hasScope(["delete"], "send")).toBe(false);
  });

  it("one realm never implies another", () => {
    expect(hasScope(["contacts"], "calendar")).toBe(false);
    expect(hasScope(["calendar"], "contacts")).toBe(false);
    expect(hasScope(["files"], "vault")).toBe(false);
    expect(hasScope(["vault"], "files")).toBe(false);
  });

  it("no write verb implies another write verb", () => {
    expect(hasScope(["move"], "annotate")).toBe(false);
    expect(hasScope(["move"], "delete")).toBe(false);
    expect(hasScope(["draft"], "send")).toBe(false);
    expect(hasScope(["annotate"], "move")).toBe(false);
  });

  it("a realm scope does not imply a mail write verb", () => {
    expect(hasScope(["contacts"], "move")).toBe(false);
    expect(hasScope(["calendar"], "delete")).toBe(false);
  });

  it("admin implies nothing, and nothing implies admin", () => {
    expect(hasScope(["admin"], "read")).toBe(false);
    expect(hasScope(["admin"], "calendar")).toBe(false);
    expect(hasScope(["admin"], "mail")).toBe(false);
    for (const g of [...MAIL_SCOPES, ...REALM_SCOPES, "mail"]) {
      expect(hasScope([g], "admin")).toBe(false);
    }
  });

  it("the read edge does not reopen the vault wildcard (common/001 stays closed)", () => {
    // The sharp hole 001 closed: a `mail`/realm token must not open the vault.
    // Only `read` is implied — `vault` is never `read`, so nothing here leaks.
    expect(hasScope(["mail"], "vault")).toBe(false);
    expect(hasScope(["contacts"], "vault")).toBe(false);
    expect(hasScope(["send"], "vault")).toBe(false);
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

  it("a write token may mint a read-only token — read is a strict narrowing (027)", () => {
    // Since any write implies read, a move-, calendar- or send-only token can
    // mint `read`. DECISION (027): that is correct — the minted token is a
    // strict narrowing of a capability the minter already holds, so the gate
    // should and does permit it. This is the one new mint the read edge opens.
    expect(scopesWithin(["read"], ["move"])).toBe(true);
    expect(scopesWithin(["read"], ["calendar"])).toBe(true);
    expect(scopesWithin(["read"], ["send"])).toBe(true);
  });

  it("but the read edge never lets a token mint a capability it lacks", () => {
    // The write/realm scope confers `read`, nothing more. So the edge does not
    // widen minting: a delete token still cannot mint `send`; a contacts token
    // still cannot mint `vault` or `calendar`; a read token cannot mint a write.
    expect(scopesWithin(["send"], ["delete"])).toBe(false);
    expect(scopesWithin(["vault"], ["contacts"])).toBe(false);
    expect(scopesWithin(["calendar"], ["contacts"])).toBe(false);
    expect(scopesWithin(["move"], ["read"])).toBe(false);
  });

  it("an empty request is trivially within anything", () => {
    // `.every` on [] is true. Documented rather than asserted-as-desirable:
    // callers must not treat "no scopes requested" as "no check needed".
    expect(scopesWithin([], ["read"])).toBe(true);
  });
});
