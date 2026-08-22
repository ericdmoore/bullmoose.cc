/** @jsxImportSource preact */
import { describe, expect, it } from "vitest";
import { render } from "preact-render-to-string";
import { parseDecided, parseFiredWatch, type DecidedItem, type WatchItem } from "../lib/activity/types";
import { DecidedDetail, FeedRow, WatchDetail } from "./ActivityRows";

// s23 v1 — render tests, no jsdom: the feed's stateless pieces SSR to an HTML
// string in plain Node (the s24 T0 pattern, ui.test.tsx) and we assert on the
// markup. The wording itself is tested as functions in lib/activity/feed.test;
// here we prove the markup carries it — and carries NO verbs.

const NOW = Date.parse("2026-08-11T12:00:00Z");
const iso = (ms: number): string => new Date(ms).toISOString();
const HOUR = 3600_000;

function decided(overrides: Record<string, unknown> = {}): DecidedItem {
  const item = parseDecided({
    id: "p1",
    accountId: "acct-a",
    agent: "Emily",
    kind: "reply-draft",
    tier: 2,
    subject: { realm: "Email", objectId: "e1" },
    payload: { to: "grace@example.test", subject: "Re: hello", text: "the agent's words" },
    editedPayload: null,
    rationale: "Grace asked twice.",
    evidence: [{ realm: "Email", objectId: "e1", note: "the thread" }],
    status: "approved",
    decision: { by: "cj@bullmoose.test" },
    createdAt: iso(NOW - 3 * HOUR),
    decidedAt: iso(NOW - 1 * HOUR),
    holdUntil: null,
    expiresAt: null,
    dueAt: null,
    question: null,
    amendments: [],
    invocationStatus: "done",
    claimedAt: null,
    costMicros: 2140,
    tokensIn: 1832,
    tokensOut: 412,
    costModel: "openrouter/minimax/minimax-m3",
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
    sourceRef: "email:e-boards",
    createdAt: NOW - 72 * HOUR,
    firedAt: NOW - 5 * HOUR,
    proposalId: "ap-followup",
    ...overrides,
  });
  if (!item) throw new Error("fixture did not parse");
  return item;
}

describe("FeedRow", () => {
  const HREF = "/activity?a=p1";

  it("is a LINK carrying summary, status, actor and when", () => {
    // A link, not a button: the row was `onSelect`-only, which left every
    // decided record with no URL to cmd-click, copy or cite. The in-page
    // selection is unchanged — `StackedRow` takes both, and the plain click
    // still stays here (lib/ui/navigation.ts).
    const html = render(<FeedRow item={decided()} now={NOW} active={false} label="" href={HREF} onSelect={() => {}} />);
    expect(html).toContain("<a");
    expect(html).toContain(`href="${HREF}"`);
    expect(html).not.toContain("<button");
    expect(html).toContain("Reply to grace@example.test");
    expect(html).toContain("approved");
    expect(html).toContain("Emily");
    expect(html).toContain("1h 0m ago");
    expect(html).toContain("µ$"); // the µUSD cost rides the list row too
  });

  it("marks the active row for assistive tech, not just by color", () => {
    const html = render(<FeedRow item={decided()} now={NOW} active={true} label="" href={HREF} onSelect={() => {}} />);
    expect(html).toContain('aria-current="true"');
  });

  it("labels the account only on a merged feed", () => {
    const merged = render(
      <FeedRow item={decided()} now={NOW} active={false} label="emily@…" href={HREF} onSelect={() => {}} />,
    );
    expect(merged).toContain("emily@…");
  });
});

describe("DecidedDetail — the read-only record", () => {
  it("shows WHAT, WHO decided, WHEN, and the µUSD cost", () => {
    const html = render(<DecidedDetail item={decided()} now={NOW} label="" />);
    expect(html).toContain("Reply to grace@example.test"); // what
    expect(html).toContain("approved by cj@bullmoose.test"); // who — the delegate, not you
    expect(html).toContain("1h 0m ago"); // when
    expect(html).toContain("sat with you 2h 0m"); // how long it waited
    expect(html).toContain("2,140 µ$"); // the frozen cost
    expect(html).toContain("openrouter/minimax/minimax-m3");
    expect(html).toContain("Grace asked twice."); // the agent's why
    expect(html).toContain("looked at:"); // evidence
  });

  it("renders NO buttons and NO forms — a record, not a decision surface", () => {
    const html = render(<DecidedDetail item={decided()} now={NOW} label="" />);
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<input");
  });

  it("an edited approval shows the HUMAN's version and says so", () => {
    const item = decided({
      editedPayload: { to: "grace@example.test", subject: "Re: hello", text: "the human's words" },
    });
    const html = render(<DecidedDetail item={item} now={NOW} label="" />);
    expect(html).toContain("approved after edit by cj@bullmoose.test");
    expect(html).toContain("the human's words");
    expect(html).not.toContain("the agent's words");
    expect(html).toContain("edited before approval");
  });

  it("a retired reject reason renders as itself, marked — history is not migrated", () => {
    const item = decided({ status: "rejected", decision: { by: "eric@bullmoose.test", reason: "notNow" } });
    const html = render(<DecidedDetail item={item} now={NOW} label="" />);
    expect(html).toContain("notNow (retired)");
  });

  it("a yanked row reads as a retraction, past tense", () => {
    const item = decided({ status: "yanked", decision: { by: "eric@bullmoose.test", note: "recount first" } });
    const html = render(<DecidedDetail item={item} now={NOW} label="" />);
    expect(html).toContain("yanked from the hold tray by eric@bullmoose.test");
    expect(html).toContain("recount first");
    expect(html).not.toContain("waiting on you");
  });

  it("uses no inline style — the CSP carries no unsafe-inline", () => {
    expect(render(<DecidedDetail item={decided()} now={NOW} label="" />)).not.toContain("style=");
  });
});

describe("WatchDetail", () => {
  it("says what was watched, what firing did, and where the outcome went", () => {
    const html = render(<WatchDetail item={fired()} now={NOW} />);
    expect(html).toContain("No reply from sergio@example.test");
    expect(html).toContain("drafted a follow-up");
    expect(html).toContain("ap-followup");
    expect(html).toContain('href="/approvals"'); // the cross-link, a literal path
    expect(html).toContain("5h 0m ago");
    expect(html).toContain("email:e-boards");
  });

  it("a notify-only fire points at no proposal and offers no verbs", () => {
    const html = render(<WatchDetail item={fired({ actionType: "notify", proposalId: null })} now={NOW} />);
    expect(html).not.toContain("href=");
    expect(html).not.toContain("<button");
    expect(html).toContain("a record, not a task");
  });
});
