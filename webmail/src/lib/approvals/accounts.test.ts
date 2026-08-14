import { describe, expect, it } from "vitest";
import { defaultSession } from "../jmap/FakeJmapClient";
import { AGENT_CAP, CONTACTS_CAP, MAIL_CAP } from "../jmap/capabilities";
import type { Session } from "../jmap/types";
import { accountLabel, approvalsAccountId, approvalsAccounts, rowAuthority } from "./accounts";

/**
 * s10 T7 — the queue's reach, and the honesty rule at its buttons.
 *
 * The bug these pin: `/approvals` read ONE account (the session's mail
 * primary), while an agent's proposals live on the agent's own account under
 * its own principal. The human was told "Nothing is waiting on you" while a
 * real pending proposal sat one grant away.
 */

const OWN = "acct-fake";
const EMILY = "acct-emily";
const ALLEN = "acct-allen";

/** A session with the human's own account plus two grant-reached agent
 *  accounts, carrying the per-account agent capability the server now sends. */
function multiAccountSession(overrides: Record<string, unknown> = {}): Session {
  const base = defaultSession();
  const agentCaps = (mayDecide: boolean, mayApproveIrreversible: boolean) => ({
    [MAIL_CAP]: {},
    [CONTACTS_CAP]: {},
    [AGENT_CAP]: { mayDecide, mayApproveIrreversible },
  });
  return {
    ...base,
    accounts: {
      [EMILY]: {
        name: "editor@bullmoose.cc",
        isPersonal: false,
        isReadOnly: false,
        accountCapabilities: agentCaps(true, true),
      },
      [OWN]: {
        name: "eric@bullmoose.cc",
        isPersonal: true,
        isReadOnly: false,
        accountCapabilities: agentCaps(true, true),
      },
      [ALLEN]: {
        name: "analyst@bullmoose.cc",
        isPersonal: false,
        isReadOnly: true,
        accountCapabilities: agentCaps(false, false),
      },
    },
    ...overrides,
  } as Session;
}

describe("approvalsAccounts — which accounts the queue spans", () => {
  it("returns every agent-capable account, OWNED first", async () => {
    const accounts = approvalsAccounts(multiAccountSession());
    expect(accounts.map((a) => a.accountId)).toEqual([OWN, ALLEN, EMILY]);
    // The agent accounts are exactly the ones a single-account queue missed.
    expect(accounts.filter((a) => !a.isPersonal).map((a) => a.name)).toEqual([
      "analyst@bullmoose.cc",
      "editor@bullmoose.cc",
    ]);
  });

  it("skips an account that does not advertise the agent capability", () => {
    const session = multiAccountSession();
    session.accounts[ALLEN]!.accountCapabilities = { [CONTACTS_CAP]: {} };
    expect(approvalsAccounts(session).map((a) => a.accountId)).toEqual([OWN, EMILY]);
  });

  it("is empty when the SERVER does not advertise the agent capability at all", () => {
    const session = multiAccountSession();
    const { [AGENT_CAP]: _dropped, ...rest } = session.capabilities;
    expect(approvalsAccounts({ ...session, capabilities: rest })).toEqual([]);
  });

  it("reads an UNREPORTED authority as permitted — the server is the gate", () => {
    // A pre-T7 server sends `{}` for the per-account agent capability. Hiding
    // buttons a server would honour is its own dishonesty, so absent ⇒ true.
    const session = defaultSession();
    const [only] = approvalsAccounts(session);
    expect(only).toMatchObject({ mayDecide: true, mayApproveIrreversible: true });
  });

  it("labels a row by its account, falling back to the id", () => {
    const accounts = approvalsAccounts(multiAccountSession());
    expect(accountLabel(accounts, EMILY)).toBe("editor@bullmoose.cc");
    expect(accountLabel(accounts, "acct-gone")).toBe("acct-gone");
  });
});

describe("approvalsAccountId — the single-account anchor", () => {
  it("is the mail primary", () => {
    expect(approvalsAccountId(defaultSession())).toBe(OWN);
  });
});

describe("rowAuthority — no button that cannot be used", () => {
  const accounts = approvalsAccounts(multiAccountSession());
  const own = accounts.find((a) => a.accountId === OWN)!;
  const allen = accounts.find((a) => a.accountId === ALLEN)!;

  it("offers every verb on an account you may decide", () => {
    expect(rowAuthority({ tier: 3 }, own)).toEqual({
      canApprove: true,
      canDecline: true,
      note: "",
    });
  });

  it("offers NOTHING on a watch-only account, and says why", () => {
    const authority = rowAuthority({ tier: 1 }, allen);
    expect(authority.canApprove).toBe(false);
    expect(authority.canDecline).toBe(false);
    expect(authority.note).toMatch(/Watch-only/);
    // The account is NAMED: a bare "not allowed" on a merged queue leaves the
    // human guessing which of their agents is the read-only one.
    expect(authority.note).toContain("analyst@bullmoose.cc");
  });

  it("hides ONLY approve when the account's access lacks send (tier 3)", () => {
    const narrowed = { ...own, mayApproveIrreversible: false };
    // Tier 1 and 2 are unaffected — the wall is about irreversible egress.
    expect(rowAuthority({ tier: 1 }, narrowed)).toEqual({
      canApprove: true,
      canDecline: true,
      note: "",
    });
    const tier3 = rowAuthority({ tier: 3 }, narrowed);
    expect(tier3.canApprove).toBe(false);
    // Declining and asking for information still work — the question is
    // genuinely waiting on this human, and hiding the whole row would hide it.
    expect(tier3.canDecline).toBe(true);
    expect(tier3.note).toMatch(/send capability/);
  });

  it("refuses everything on an account the session does not list", () => {
    const authority = rowAuthority({ tier: 1 }, undefined);
    expect(authority).toMatchObject({ canApprove: false, canDecline: false });
    expect(authority.note).toMatch(/cannot reach/);
  });
});
