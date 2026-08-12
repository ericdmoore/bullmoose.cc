import { describe, expect, it } from "vitest";
import { AGENT_CAP, MAIL_CAP } from "../jmap/capabilities";
import { defaultSession } from "../jmap/FakeJmapClient";
import type { ActionProposal } from "./types";
import { parseProposal } from "./types";
import {
  HOLD_UNWIRED_NOTE,
  REJECT_REASONS,
  TIER3_CAPABILITY_NOTE,
  approvalsAccountId,
  approvalsGate,
  approveVerb,
  summarizeProposal,
  tierLabel,
} from "./rows";

describe("approvalsGate — the plain-client floor (arch.md §8.6)", () => {
  it("opens when the session advertises the agent capability", () => {
    expect(approvalsGate(defaultSession()).state).toBe("open");
  });

  it("closes with an explanation — not an error — when the capability is absent", () => {
    const session = defaultSession();
    const { [AGENT_CAP]: _dropped, ...rest } = session.capabilities;
    const gate = approvalsGate({ capabilities: rest });
    expect(gate.state).toBe("no-capability");
    expect(gate.reason).toContain("does not advertise");
    expect(gate.reason).toContain("unaffected");
  });

  it("closes on no session at all", () => {
    expect(approvalsGate(undefined).state).toBe("no-capability");
  });
});

describe("approvalsAccountId", () => {
  it("anchors on the mail primary — the live session has no agent entry (session.ts:77-83)", () => {
    expect(approvalsAccountId(defaultSession())).toBe("acct-fake");
  });

  it("falls back to the first account for a session with no mail primary", () => {
    const session = defaultSession();
    const { [MAIL_CAP]: _dropped, ...primaries } = session.primaryAccounts;
    expect(approvalsAccountId({ ...session, primaryAccounts: primaries })).toBe("acct-fake");
  });
});

describe("tier rendering matches what approve DOES (arch.md §2)", () => {
  it("labels the three tiers by reversibility", () => {
    expect(tierLabel(1)).toContain("reversible");
    expect(tierLabel(2)).toContain("retractable");
    expect(tierLabel(3)).toContain("irreversible");
  });

  it("tier-2 approve says HOLD and does not claim a send", () => {
    expect(approveVerb(2)).toContain("nothing sent");
    expect(approveVerb(2)).not.toMatch(/^Send|& send/);
  });

  it("tier-3 approve says send and says irreversible — no softening", () => {
    expect(approveVerb(3)).toContain("send");
    expect(approveVerb(3)).toContain("irreversible");
  });

  it("the tier-3 note names the capability wall, the hold note names T2", () => {
    expect(TIER3_CAPABILITY_NOTE).toContain("send capability");
    expect(TIER3_CAPABILITY_NOTE).toContain("agent token is refused");
    expect(HOLD_UNWIRED_NOTE).toContain("not wired");
    expect(HOLD_UNWIRED_NOTE).toContain("s03.D T2");
  });
});

describe("the no-thanks reasons (arch.md §3)", () => {
  it("offers exactly the server's enum, snooze last", () => {
    expect(REJECT_REASONS.map((r) => r.reason)).toEqual(["wrongContent", "wrongAction", "notNow"]);
  });

  it("marks notNow as counting against nothing", () => {
    expect(REJECT_REASONS[2]?.hint).toContain("counts against nothing");
  });
});

describe("summarizeProposal — one line per row, grant-request included", () => {
  const base = (over: Partial<ActionProposal>): ActionProposal =>
    parseProposal({
      id: "p",
      agent: "Emily",
      kind: "reply-draft",
      tier: 2,
      subject: { realm: "Email", objectId: "e-1" },
      payload: {},
      rationale: "why",
      evidence: [],
      status: "pending",
      createdAt: "2026-08-11T00:00:00Z",
      ...over,
    } as unknown as Record<string, unknown>)!;

  it("headlines a reply with its recipient and subject", () => {
    const p = base({ payload: { to: "grace@example.test", subject: "Re: Kickoff" } });
    expect(summarizeProposal(p)).toBe("Reply to grace@example.test — “Re: Kickoff”");
  });

  it("headlines a grant-request as an ask — same summarizer, same queue (arch.md §1)", () => {
    const p = base({
      kind: "grant-request",
      payload: { scope: "read", target: "Events/Fair", durationDays: 30 },
    });
    expect(summarizeProposal(p)).toBe("Requests read on Events/Fair for 30 days");
  });

  it("headlines a create-contact by the card's name", () => {
    const p = base({ kind: "create-contact", payload: { card: { name: { full: "Dana Calloway" } } } });
    expect(summarizeProposal(p)).toBe("Add contact Dana Calloway");
  });

  it("falls back to kind-on-subject for a kind it has not met", () => {
    const p = base({ kind: "mystery-verb", subject: { realm: "Email", objectId: "e-9" } });
    expect(summarizeProposal(p)).toBe("mystery-verb on Email e-9");
  });
});

describe("parseProposal (types.ts)", () => {
  it("drops a row with no id and coerces malformed fields to empty values", () => {
    expect(parseProposal({})).toBeNull();
    const p = parseProposal({ id: "x", payload: "not-an-object", evidence: "nope", tier: 2 });
    expect(p).toMatchObject({ id: "x", payload: {}, evidence: [], tier: 2, status: "pending" });
  });

  it("fails an unknown tier CLOSED — unknown reversibility reads as irreversible", () => {
    expect(parseProposal({ id: "x", tier: 9 })?.tier).toBe(3);
    expect(parseProposal({ id: "x" })?.tier).toBe(3);
  });
});
