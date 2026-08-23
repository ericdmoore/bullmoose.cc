import { describe, expect, it } from "vitest";
import { AGENT_CAP } from "../jmap/capabilities";
import {
  activityCollections,
  activityGate,
  actorLabel,
  agoLabel,
  decisionLabel,
  filterFeed,
  orderFeed,
  satWithYouLabel,
  statusWord,
  summarizeItem,
  summarizeWatch,
} from "./feed";
import { parseDecided, parseFiredWatch, type ActivityItem, type DecidedItem, type WatchItem } from "./types";

const NOW = Date.parse("2026-08-11T12:00:00Z");
const iso = (ms: number): string => new Date(ms).toISOString();
const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** Items built through the REAL parsers, so the wording tests exercise the
 *  same shapes the wire produces — including the yanked coercion. */
function decided(overrides: Record<string, unknown> = {}): DecidedItem {
  const item = parseDecided({
    id: "p1",
    accountId: "acct-a",
    agent: "Emily",
    kind: "reply-draft",
    tier: 2,
    subject: { realm: "Email", objectId: "e1" },
    payload: { to: "grace@example.test", subject: "Re: hello" },
    editedPayload: null,
    rationale: "why",
    evidence: [],
    status: "approved",
    decision: { by: "eric@bullmoose.test" },
    createdAt: iso(NOW - 3 * HOUR),
    decidedAt: iso(NOW - 1 * HOUR),
    holdUntil: null,
    expiresAt: null,
    dueAt: null,
    question: null,
    amendments: [],
    invocationStatus: "done",
    claimedAt: null,
    costMicros: null,
    tokensIn: null,
    tokensOut: null,
    costModel: null,
    ...overrides,
  });
  if (!item) throw new Error("fixture did not parse");
  return item;
}

function fired(overrides: Record<string, unknown> = {}): WatchItem {
  const item = parseFiredWatch({
    id: "w1",
    accountId: "acct-a",
    conditionType: "no-reply-from",
    condition: { sender: "sergio@example.test" },
    deadlineAt: NOW - 5 * HOUR,
    actionType: "draft-followup",
    action: {},
    status: "fired",
    sourceRef: null,
    createdAt: NOW - 3 * DAY,
    firedAt: NOW - 5 * HOUR,
    proposalId: null,
    ...overrides,
  });
  if (!item) throw new Error("fixture did not parse");
  return item;
}

describe("activityGate", () => {
  it("opens when the agent capability is advertised", () => {
    expect(activityGate({ capabilities: { [AGENT_CAP]: {} } }).state).toBe("open");
  });
  it("explains the plain-client floor — an explanation, not an error", () => {
    const gate = activityGate({ capabilities: {} });
    expect(gate.state).toBe("no-capability");
    expect(gate.reason).toContain("no activity to record");
    // Not worded as a failure — it names what still works.
    expect(gate.reason).toContain("unaffected");
  });
  it("no session yet is not open either", () => {
    expect(activityGate(undefined).state).toBe("no-capability");
  });
});

describe("orderFeed — newest first, stable", () => {
  it("sorts by occurredAt descending across sources", () => {
    const a = decided({ id: "a", decidedAt: iso(NOW - 2 * HOUR) });
    const w = fired({ id: "w", firedAt: NOW - 1 * HOUR, deadlineAt: NOW - 1 * HOUR });
    const b = decided({ id: "b", decidedAt: iso(NOW - 3 * HOUR) });
    expect(orderFeed([a, b, w]).map((i) => i.id)).toEqual(["watch:w", "decided:a", "decided:b"]);
  });

  it("sinks undated rows to the end instead of faking a place in time", () => {
    const undated = decided({ id: "u", decidedAt: null, expiresAt: null, createdAt: "not a date" });
    const dated = decided({ id: "d" });
    expect(orderFeed([undated, dated]).map((i) => i.id)).toEqual(["decided:d", "decided:u"]);
  });

  it("breaks timestamp ties by id, so reloads render identically", () => {
    const x = decided({ id: "x" });
    const y = decided({ id: "y" });
    expect(orderFeed([y, x]).map((i) => i.id)).toEqual(["decided:x", "decided:y"]);
    expect(orderFeed([x, y]).map((i) => i.id)).toEqual(["decided:x", "decided:y"]);
  });
});

describe("collections", () => {
  const items: ActivityItem[] = [decided({ id: "a" }), decided({ id: "b", status: "rejected" }), fired()];

  it("filters to the two sources, and `all` is genuinely all", () => {
    expect(filterFeed(items, "decided")).toHaveLength(2);
    expect(filterFeed(items, "watches")).toHaveLength(1);
    expect(filterFeed(items, "all")).toHaveLength(3);
    // An unknown collection id degrades to `all`, never to an empty pane.
    expect(filterFeed(items, "nope")).toHaveLength(3);
  });

  it("counts every group, zeros included — an empty history is an answer", () => {
    const groups = activityCollections([decided()]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.items.map((i) => [i.id, i.count])).toEqual([
      ["all", 1],
      ["decided", 1],
      ["watches", 0],
    ]);
  });
});

describe("agoLabel", () => {
  it("relative, past tense", () => {
    expect(agoLabel(NOW - 3 * HOUR, NOW)).toBe("3h 0m ago");
    expect(agoLabel(NOW - 2 * DAY, NOW)).toBe("2d 0h ago");
  });
  it("undated is said plainly, never invented", () => {
    expect(agoLabel(0, NOW)).toBe("undated");
    expect(agoLabel(Number.NaN, NOW)).toBe("undated");
  });
  it("clock skew reads as just now, not a negative duration", () => {
    expect(agoLabel(NOW + 60_000, NOW)).toBe("just now");
  });
});

describe("decisionLabel — whose authority, the line the section exists for", () => {
  it("approved names the deciding principal (decision_json.by)", () => {
    expect(decisionLabel(decided())).toBe("approved by eric@bullmoose.test");
  });

  it("approved-after-edit is its own outcome, not a plain approve", () => {
    const item = decided({ editedPayload: { to: "grace@example.test", subject: "Re: hello", text: "mine" } });
    expect(decisionLabel(item)).toBe("approved after edit by eric@bullmoose.test");
  });

  it("a delegate's decision reads as the delegate, never as you", () => {
    const item = decided({ decision: { by: "cj@bullmoose.test" } });
    expect(decisionLabel(item)).toBe("approved by cj@bullmoose.test");
  });

  it("declined renders the recorded reason through describeReason — retired taxonomy included", () => {
    const live = decided({ status: "rejected", decision: { by: "eric@bullmoose.test", reason: "wrongAction" } });
    expect(decisionLabel(live)).toBe("declined by eric@bullmoose.test — Wrong action");
    // History is read, not migrated: a retired reason renders as itself,
    // marked — never remapped into a judgment the human did not make.
    const retired = decided({ status: "rejected", decision: { by: "eric@bullmoose.test", reason: "notNow" } });
    expect(decisionLabel(retired)).toBe("declined by eric@bullmoose.test — notNow (retired)");
  });

  it("expired says nobody decided — the clock did", () => {
    const item = decided({ status: "expired", decision: null, decidedAt: null, expiresAt: iso(NOW - DAY) });
    expect(decisionLabel(item)).toBe("expired undecided — the deadline passed with no decision");
  });

  it("yanked names the retraction and who pulled it back", () => {
    const item = decided({ status: "yanked", decision: { by: "eric@bullmoose.test" } });
    expect(decisionLabel(item)).toBe("yanked from the hold tray by eric@bullmoose.test — pulled back before it sent");
  });

  it("closed renders the server's own note — the record answers 'whatever happened to that ask?'", () => {
    // s36 V2: closed is terminal but NOT a decline — nobody decided the row,
    // its ground vanished. The mechanism rides decision.note verbatim.
    const item = decided({
      status: "closed",
      kind: "contingent-commitment",
      decision: { by: "eric@bullmoose.test", note: "closed: the thing this depended on was declined" },
    });
    expect(decisionLabel(item)).toBe("closed: the thing this depended on was declined");
    const bare = decided({ status: "closed", decision: null, decidedAt: null });
    expect(decisionLabel(bare)).toBe("closed — the thing it depended on went away");
  });

  it("a decision missing its principal degrades to unknown, never to silence", () => {
    expect(decisionLabel(decided({ decision: null }))).toBe("approved by unknown");
  });
});

describe("satWithYouLabel — always past tense", () => {
  it("freezes at decidedAt for a decided row", () => {
    expect(satWithYouLabel(decided(), NOW)).toBe("sat with you 2h 0m");
  });

  it("freezes at the lapse for an expired row", () => {
    const item = decided({
      status: "expired",
      decision: null,
      decidedAt: null,
      expiresAt: iso(NOW - 2 * DAY),
      createdAt: iso(NOW - 9 * DAY),
    });
    expect(satWithYouLabel(item, NOW)).toBe("sat with you 7d 0h");
  });

  it("a yanked row reads past tense", () => {
    // `parseProposal` once degraded `yanked` to "pending" (the enum has since
    // learned it — approvals/rows.test.ts); either way a retracted action
    // must read as history here, never as "waiting on you".
    const item = decided({ status: "yanked" });
    expect(item.proposal.status).toBe("yanked");
    expect(satWithYouLabel(item, NOW)).toBe("sat with you 2h 0m");
  });
});

describe("watch wording", () => {
  it("no-reply-from names who went quiet and what firing did", () => {
    expect(summarizeWatch(fired().watch)).toBe(
      "No reply from sergio@example.test by the deadline — drafted a follow-up for your approval",
    );
  });
  it("deadline + notify", () => {
    const w = fired({ conditionType: "deadline", condition: {}, actionType: "notify" }).watch;
    expect(summarizeWatch(w)).toBe("A deadline you set arrived — sent you a notification");
  });
  it("unknown types render as themselves rather than crashing the feed", () => {
    const w = fired({ conditionType: "lunar-phase", actionType: "howl" }).watch;
    expect(summarizeWatch(w)).toBe('Watch "lunar-phase" fired — ran "howl"');
  });
  it("a missing sender is admitted, not invented", () => {
    const w = fired({ condition: {} }).watch;
    expect(summarizeWatch(w)).toContain("(unknown sender)");
  });
});

describe("row meta", () => {
  it("summarizeItem routes by source", () => {
    expect(summarizeItem(decided())).toContain("Reply to grace@example.test");
    expect(summarizeItem(fired())).toContain("No reply from");
  });
  it("statusWord: declined for rejected, fired for a watch, the status otherwise", () => {
    expect(statusWord(decided({ status: "rejected" }))).toBe("declined");
    expect(statusWord(decided())).toBe("approved");
    expect(statusWord(decided({ status: "yanked" }))).toBe("yanked");
    expect(statusWord(fired())).toBe("fired");
  });
  it("actorLabel: the binding for a proposal, the human's own watch otherwise", () => {
    expect(actorLabel(decided())).toBe("Emily");
    expect(actorLabel(fired())).toBe("your watch");
  });
});
