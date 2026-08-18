import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AGENT_CAP, MAIL_CAP } from "../jmap/capabilities";
import { defaultSession } from "../jmap/FakeJmapClient";
import type { ActionProposal } from "./types";
import { parseProposal, PROPOSAL_STATUSES } from "./types";
import {
  costLabel,
  HOLD_UNWIRED_NOTE,
  REJECT_REASONS,
  RETIRED_REJECT_REASONS,
  TIER3_CAPABILITY_NOTE,
  approvalsAccountId,
  approvalsGate,
  approveVerb,
  declineNeedsReason,
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
    // s03.D T2 landed: commit is automatic, yank is API-only for now. The
    // note must say what the tray actually does — an enabled-looking promise
    // it cannot keep, or a stale "not wired", would both be lies about egress.
    expect(HOLD_UNWIRED_NOTE).toContain("sends automatically");
    expect(HOLD_UNWIRED_NOTE).toContain("yank");
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
    const p = base({
      kind: "create-contact",
      payload: { card: { name: { full: "Dana Calloway" } } },
    });
    expect(summarizeProposal(p)).toBe("Add contact Dana Calloway");
  });

  it("falls back to kind-on-subject for a kind it has not met", () => {
    const p = base({ kind: "mystery-verb", subject: { realm: "Email", objectId: "e-9" } });
    expect(summarizeProposal(p)).toBe("mystery-verb on Email e-9");
  });

  // ---- s11 T9 — the numbers ARE the decision ----
  it("leads a budget-overrun with the numbers, not the agent's name", () => {
    const p = base({
      kind: "budget-overrun",
      tier: 1,
      subject: { realm: "AgentBinding", objectId: "bind_photos" },
      payload: {
        bindingId: "bind_photos",
        bindingName: "photos",
        waitingCount: 12,
        monthSpentMicros: 5_000_000,
        capMicros: 5_000_000,
        estimateMicros: 1_800_000,
        overageMicros: 2_250_000,
        periodKey: "2026-08",
      },
    });
    expect(summarizeProposal(p)).toBe(
      "12 waiting · $5.00 of $5.00 spent · ~$1.80 to clear — approve a $2.25 overage for photos",
    );
  });

  it("says the cost is UNKNOWN rather than printing a guessed $0.00", () => {
    // No paid history for the binding → the sweep reports null, and the row must
    // carry that through. A plausible-looking $0.00 is the one lie that matters
    // on a spend decision.
    const p = base({
      kind: "budget-overrun",
      tier: 1,
      subject: { realm: "AgentBinding", objectId: "bind_photos" },
      payload: {
        bindingId: "bind_photos",
        bindingName: "photos",
        waitingCount: 3,
        monthSpentMicros: 1_000_000,
        capMicros: 1_000_000,
        estimateMicros: null,
        overageMicros: 1_000_000,
        periodKey: "2026-08",
      },
    });
    expect(summarizeProposal(p)).toBe(
      "3 waiting · $1.00 of $1.00 spent · cost unknown — approve a $1.00 overage for photos",
    );
  });

  // ---- s12 — the held-mail batch ----
  it("leads a held-mail-review with the count and names BOTH verbs", () => {
    const p = base({
      kind: "held-mail-review",
      tier: 1,
      subject: { realm: "Mailbox", objectId: "mb_q" },
      payload: {
        periodKey: "2026-08-13",
        heldCount: 3,
        emailIds: ["e1", "e2", "e3"],
        messages: [
          { emailId: "e1", sender: "a@x.test", subject: "one", stage: "bayes-mid@0.5" },
          { emailId: "e2", sender: "b@x.test", subject: "two", stage: "bayes-mid@0.5" },
          { emailId: "e3", sender: "a@x.test", subject: "three", stage: "bayes-mid@0.5" },
        ],
      },
    });
    // Both verbs, because neither is a no-op here: declining is the answer
    // "yes, that is spam", not "never mind".
    expect(summarizeProposal(p)).toBe(
      "3 held messages from a@x.test, b@x.test — approve releases, decline confirms spam",
    );
  });

  it("degrades to the subject when the payload is empty, and never throws", () => {
    const p = base({
      kind: "budget-overrun",
      tier: 1,
      subject: { realm: "AgentBinding", objectId: "bind_photos" },
      payload: {},
    });
    expect(summarizeProposal(p)).toBe("? waiting · budget spent · cost unknown — approve an overage for bind_photos");
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

  it("carries `yanked` — a retraction must never re-present as pending", () => {
    // The s03.D T2 retraction: a held proposal the human took back. Before
    // the enum learned it, `parseProposal` coerced the unknown status to
    // "pending" and the queue re-offered Approve on an action the human had
    // just retracted — the exact lie the yank verb exists to prevent.
    const p = parseProposal({ id: "x", status: "yanked" });
    expect(p?.status).toBe("yanked");
  });

  it("mirrors the server's status enum EXACTLY — a new server state must fail here, loudly", () => {
    // The authority is what the server actually WRITES: every
    // `status = '<value>'` in the ActionProposal methods (decide / yank /
    // hold / commit) and the agent worker's sweeps (expire, needsInfo
    // reopen). Extracted from the source so a state added there without a
    // client mapping fails this test by name instead of silently parsing as
    // "pending" (how `yanked` slipped through).
    const serverFiles = [
      "../../../../services/jmap/src/methods/actionProposal.ts",
      "../../../../services/agent/src/proposals.ts",
    ].map((rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));
    const serverStates = new Set<string>();
    for (const src of serverFiles) {
      for (const m of src.matchAll(/status\s*=\s*'([a-z-]+)'/g)) serverStates.add(m[1]!);
    }
    // Guard the extraction itself: an empty or tiny set means the regex went
    // stale, not that the server simplified its lifecycle.
    expect(serverStates.size).toBeGreaterThanOrEqual(7);
    // Every server state is known to the client…
    for (const s of serverStates) expect(PROPOSAL_STATUSES, `server writes "${s}"`).toContain(s);
    // …and the client invents none the server never writes.
    for (const s of PROPOSAL_STATUSES) expect([...serverStates], `client carries "${s}"`).toContain(s);
  });
});

describe("declineNeedsReason — the no-fault kinds (the enum's mirror)", () => {
  it("asks for a reason on kinds where declining IS feedback", () => {
    for (const kind of ["reply-draft", "create-contact", "grant-request", "organize-files"]) {
      expect(declineNeedsReason(kind)).toBe(true);
    }
  });

  it("does NOT on the kinds the server refuses a reason for", () => {
    // The server's `NO_FAULT_KINDS` rejects any reason on these, so a panel
    // that demanded one made the verb unsendable — declining a budget-overrun
    // was impossible from this client, and a held-mail decline would have
    // inherited it. Mirrored here, once, next to the enum it qualifies.
    expect(declineNeedsReason("budget-overrun")).toBe(false);
    expect(declineNeedsReason("held-mail-review")).toBe(false);
  });
});

describe("costLabel — the µUSD figure holds the NULL-vs-0 honesty rule", () => {
  it("null is 'not recorded' — never a dollar figure", () => {
    expect(costLabel({ costMicros: null, costModel: null })).toBe("cost not recorded");
    expect(costLabel({ costMicros: null, costModel: "openrouter/minimax" })).toBe("cost not recorded");
  });
  it("0 is 'free' — distinct from unknown", () => {
    expect(costLabel({ costMicros: 0, costModel: null })).toBe("free");
  });
  it("small spends render in µ$, larger in dollars, with the model when known", () => {
    expect(costLabel({ costMicros: 2140, costModel: null })).toBe("2,140 µ$");
    expect(costLabel({ costMicros: 2140, costModel: "openrouter/minimax/minimax-m3" })).toBe(
      "2,140 µ$ · openrouter/minimax/minimax-m3",
    );
    expect(costLabel({ costMicros: 12_500_000, costModel: null })).toBe("$12.50");
    expect(costLabel({ costMicros: 10_000, costModel: null })).toBe("$0.01");
  });
});
