import { describe, expect, it } from "vitest";
import { CONTACTS_CAP } from "../jmap/capabilities";
import { defaultSession } from "../jmap/FakeJmapClient";
import type { Session } from "../jmap/types";
import { ATTACHMENT_GAP, orderRealms, planSearch, REALMS } from "./plan";

const ACCOUNT = "acct-fake";

/** The grant-only shape `../contacts/demo.ts` drives: one account, not ours. */
function grantOnlySession(): Session {
  const base = defaultSession();
  const contactsOnly = { [CONTACTS_CAP]: {} };
  return {
    ...base,
    accounts: {
      [ACCOUNT]: {
        name: "shared@bullmoose.test",
        isPersonal: false,
        isReadOnly: false,
        accountCapabilities: contactsOnly,
      },
    },
    primaryAccounts: { ...base.primaryAccounts, [CONTACTS_CAP]: "" },
  };
}

describe("planSearch — which realms, whose accounts", () => {
  it("fans a query out to mail, contacts and calendar on the own account", () => {
    const plan = planSearch(defaultSession(), "  elk  ");
    expect(plan.query).toBe("elk");
    expect(plan.queries).toEqual([
      { realm: "mail", accountId: ACCOUNT },
      { realm: "contacts", accountId: ACCOUNT },
      { realm: "calendar", accountId: ACCOUNT },
    ]);
  });

  it("plans nothing for an empty query but still declares coverage", () => {
    const plan = planSearch(defaultSession(), "   ");
    expect(plan.queries).toEqual([]);
    // The scope note renders before the first keystroke; coverage cannot wait
    // for a query to exist.
    expect(plan.coverage.map((c) => c.realm)).toEqual(["mail", "contacts", "calendar", "files"]);
    expect(plan.gaps).toEqual([ATTACHMENT_GAP]);
  });

  it("declares every realm's tier, and files as having no search path at all", () => {
    const byRealm = new Map(planSearch(defaultSession(), "x").coverage.map((c) => [c.realm, c]));
    expect(byRealm.get("mail")).toMatchObject({ tier: "indexed", searched: true });
    expect(byRealm.get("contacts")).toMatchObject({ tier: "scanned", searched: true });
    expect(byRealm.get("calendar")).toMatchObject({ tier: "scanned", searched: true });
    // Not "skipped", not an empty result — there is nothing to call.
    expect(byRealm.get("files")).toMatchObject({
      tier: "none",
      searched: false,
      reason: "no search path yet",
    });
  });

  it("names the premium tier as absent: the attachment gap is always declared", () => {
    // Refinement 4: when the extraction index ships, this DATA changes and the
    // scope note follows — the API shape does not.
    expect(planSearch(defaultSession(), "x").gaps).toContainEqual({
      label: "attachment contents",
      reason: "requires the extraction index",
    });
  });

  it("declares a capability the session lacks as no-access, not as empty", () => {
    const session = defaultSession();
    const account = session.accounts[ACCOUNT];
    if (!account) throw new Error("fixture account missing");
    const caps = { ...account.accountCapabilities } as Record<string, unknown>;
    delete caps["urn:ietf:params:jmap:calendars"];
    account.accountCapabilities = caps;

    const plan = planSearch(session, "x");
    expect(plan.queries.some((q) => q.realm === "calendar")).toBe(false);
    expect(plan.coverage.find((c) => c.realm === "calendar")).toMatchObject({
      searched: false,
      reason: "this session has no access",
    });
  });
});

describe("decision 4 — other people's shared realms are NOT searched", () => {
  it("never emits a query against a grant-reached account", () => {
    const session = defaultSession();
    session.accounts["acct-shared"] = {
      name: "shared@bullmoose.test",
      isPersonal: false,
      isReadOnly: false,
      accountCapabilities: { [CONTACTS_CAP]: {} },
    };
    const plan = planSearch(session, "x");
    expect(plan.queries.every((q) => q.accountId === ACCOUNT)).toBe(true);
    // …and the exclusion is DECLARED, not silent.
    expect(plan.sharedAccountsExcluded).toBe(1);
  });

  it("declares a grant-only realm as shared-not-searched, distinct from no-access", () => {
    const plan = planSearch(grantOnlySession(), "x");
    expect(plan.queries).toEqual([]);
    expect(plan.coverage.find((c) => c.realm === "contacts")).toMatchObject({
      searched: false,
      reason: "reachable only through a grant — shared accounts are not searched",
    });
    // Mail really is unreachable — different fact, different sentence.
    expect(plan.coverage.find((c) => c.realm === "mail")?.reason).toBe(
      "this session has no access",
    );
  });
});

describe("orderRealms — the tiering is the ranking", () => {
  it("orders indexed, then scanned, then unsearched — files trails with its reason", () => {
    const ordered = orderRealms(planSearch(defaultSession(), "x").coverage);
    expect(ordered.map((c) => c.realm)).toEqual(["mail", "contacts", "calendar", "files"]);
  });

  it("moves a refused realm behind the searchable ones", () => {
    const ordered = orderRealms(orderInput());
    expect(ordered.map((c) => c.realm)).toEqual(["mail", "calendar", "contacts", "files"]);
  });

  function orderInput() {
    const coverage = planSearch(defaultSession(), "x").coverage;
    const contacts = coverage.find((c) => c.realm === "contacts");
    if (!contacts) throw new Error("contacts coverage missing");
    contacts.searched = false;
    contacts.reason = "this session has no access";
    return coverage;
  }
});

describe("the searchability table", () => {
  it("covers exactly the four realms, once each", () => {
    expect(REALMS.map((r) => r.realm)).toEqual(["mail", "contacts", "calendar", "files"]);
  });
});
