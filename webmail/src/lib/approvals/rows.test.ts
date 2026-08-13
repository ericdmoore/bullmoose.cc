import { describe, expect, it } from "vitest";
import { AGENT_CAP, MAIL_CAP } from "../jmap/capabilities";
import { defaultSession } from "../jmap/FakeJmapClient";
import type { ActionProposal } from "./types";
import { parseProposal } from "./types";
import {
  HOLD_UNWIRED_NOTE,
  REJECT_REASONS,
  RETIRED_REJECT_REASONS,
  TIER3_CAPABILITY_NOTE,
  approvalsAccountId,
  approvalsGate,
  approveVerb,
  describeReason,
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

describe("the no-thanks reasons (arch.md §3, decline-taxonomy.md)", () => {
  it("offers exactly the server's enum — three, hard negative last", () => {
    expect(REJECT_REASONS.map((r) => r.reason)).toEqual(["wrongContent", "wrongAction", "unsafe"]);
  });

  it("words `unsafe` as the categorically-separate hard stop, not another decline flavour", () => {
    const unsafe = REJECT_REASONS.find((r) => r.reason === "unsafe")!;
    // What it MEANS, in the human's own terms — the two things it covers.
    expect(unsafe.label).toContain("leaked private information");
    expect(unsafe.label).toContain("committed me");
    // And that it is a different KIND of judgment, not a louder "no".
    expect(unsafe.hint).toContain("hard stop");
    expect(unsafe.hint).toContain("not a stronger no");
    expect(unsafe.severe).toBe(true);
    // The two quality reasons are NOT marked severe — the separation is the point.
    expect(REJECT_REASONS.filter((r) => r.severe).map((r) => r.reason)).toEqual(["unsafe"]);
  });

  it("keeps the two quality reasons pointed at what each STEERS", () => {
    expect(REJECT_REASONS[0]?.hint).toContain("trains the drafter");
    expect(REJECT_REASONS[1]?.hint).toContain("trains the classifier");
  });

  it("NEVER offers a retired reason — notNow cannot be chosen again", () => {
    expect(REJECT_REASONS.map((r) => r.reason)).not.toContain("notNow");
    expect(RETIRED_REJECT_REASONS.has("notNow")).toBe(true);
  });

  it("NEVER offers needsInfo as a decline reason — it is an action, not a reject (decline-taxonomy.md)", () => {
    // The RL invariant on the UI side: a fatigued click through the decline
    // panel must not be able to record a needsInfo "rejection", because the
    // panel cannot offer one. The verb lives on its own button.
    expect(REJECT_REASONS.map((r) => r.reason)).not.toContain("needsInfo");
  });
});

describe("describeReason — reading history the enum no longer writes", () => {
  it("renders a live reason by its panel label", () => {
    expect(describeReason("wrongContent")).toBe("Wrong content");
    expect(describeReason("unsafe")).toContain("Unsafe");
  });

  it("renders a RETIRED reason as itself, marked — never remapped, never dropped", () => {
    // The legacy-tolerance rule: a decision recorded as `notNow` is a fact. It
    // must not silently become "Wrong action" (a judgment the human never
    // made) and must not vanish (erasing why the proposal was declined).
    expect(describeReason("notNow")).toBe("notNow (retired)");
  });

  it("renders an unrecognized reason verbatim rather than throwing", () => {
    expect(describeReason("someFutureReason")).toBe("someFutureReason");
    expect(() => describeReason("")).not.toThrow();
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

  it("headlines a RECIPIENT grant-request by who it wants to email (s10 T3)", () => {
    const p = base({
      kind: "grant-request",
      payload: { grantType: "recipient", bookId: "ab_gov", address: "bob@example.com" },
    });
    expect(summarizeProposal(p)).toBe("Asks to email bob@example.com — widens its allowlist");
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
