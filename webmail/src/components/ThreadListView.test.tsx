/** @jsxImportSource preact */
import { describe, expect, it } from "vitest";
import { render } from "preact-render-to-string";
import ThreadListView, { isUnmodifiedPrimaryClick } from "./ThreadListView";
import type { ThreadRow } from "../lib/mail/threadList";

// The row body is a real `<a href="/mail?thread=…">` so cmd-click / copy-link
// still work; a primary click preventDefaults and onOpen fetches in-page
// (mailbox selection must survive). Without hrefFor the body stays a div.
// SSR render, plain Node — the virtual-window math is tested pure in
// lib/mail/virtual.

const row = (threadId: string, subject: string): ThreadRow =>
  ({
    threadId,
    emailIds: [`${threadId}-e1`],
    participants: ["Ada"],
    subject,
    receivedAt: "2026-08-18T09:00:00Z",
    unread: false,
    flagged: false,
    hasAttachment: false,
    loadedCount: 1,
    latest: { preview: "…" },
  }) as unknown as ThreadRow;

const ROWS = [row("T1", "First"), row("T2", "Second")];

const shared = {
  total: 2,
  cursor: 0,
  selected: new Set<string>(),
  loading: false,
  onOpen: () => {},
  onCursor: () => {},
  onToggleSelect: () => {},
  onLoadMore: () => {},
};

describe("ThreadListView — the T3 link path", () => {
  it("renders each row's body as a literal <a> built by hrefFor", () => {
    const html = render(<ThreadListView {...shared} rows={ROWS} hrefFor={(r) => `/mail?thread=${r.threadId}`} />);
    expect(html).toContain('href="/mail?thread=T1"');
    expect(html).toContain('href="/mail?thread=T2"');
    // The body class rides the anchor so the row's layout survives the swap.
    expect(html).toContain('<a class="row-body"');
  });

  it("keeps the select checkbox a SIBLING button — never interactive-inside-a-link", () => {
    const html = render(<ThreadListView {...shared} rows={ROWS} hrefFor={(r) => `/mail?thread=${r.threadId}`} />);
    const anchor = html.slice(html.indexOf("<a "), html.indexOf("</a>"));
    expect(anchor).not.toContain("<button");
  });

  it("without hrefFor the body stays a div — the in-page path is untouched", () => {
    const html = render(<ThreadListView {...shared} rows={ROWS} />);
    expect(html).not.toContain("<a ");
    expect(html).toContain('<div class="row-body"');
  });
});

// s25 T6 — swipe triage. The GESTURE is tested pure in lib/ui/swipe.test.ts
// (no jsdom here, so no pointer events to dispatch); what these pin is the
// markup contract the gesture rides on — above all that switching the feature
// off leaves the pre-T6 DOM alone, and that a swipe never removes the link a
// tap needs.

const ACTIONS = [
  { id: "archive" as const, label: "Archive", tone: "neutral" as const },
  { id: "trash" as const, label: "Trash", tone: "danger" as const },
];

describe("ThreadListView — the T6 swipe layer", () => {
  const swiping = {
    ...shared,
    rows: ROWS,
    hrefFor: (r: ThreadRow) => `/mail?thread=${r.threadId}`,
    swipeActions: ACTIONS,
    onSwipeAction: () => {},
  };

  it("off by default: no shell, no touch-action, no wrappers", () => {
    const html = render(<ThreadListView {...shared} rows={ROWS} hrefFor={(r) => `/mail?thread=${r.threadId}`} />);
    expect(html).not.toContain("touch-pan-y");
    expect(html).not.toContain('role="presentation"');
  });

  it("an empty action list is the same as no swipe — nothing to reveal, nothing to wrap", () => {
    const html = render(<ThreadListView {...swiping} swipeActions={[]} />);
    expect(html).not.toContain("touch-pan-y");
  });

  it("wraps each row in a clipping shell that leaves vertical panning to the browser", () => {
    const html = render(<ThreadListView {...swiping} />);
    expect(html).toContain("touch-pan-y");
    expect(html).toContain("overflow-hidden");
  });

  it("keeps the row a real link — a swipe layer must not cost cmd-click its href", () => {
    const html = render(<ThreadListView {...swiping} />);
    expect(html).toContain('href="/mail?thread=T1"');
    expect(html).toContain('<a class="row-body"');
  });

  it("keeps listbox→option intact: the wrappers are presentational", () => {
    const html = render(<ThreadListView {...swiping} />);
    expect(html).toContain('role="listbox"');
    expect(html).toContain('role="option"');
    expect(html).toContain('role="presentation"');
  });

  it("renders NO action buttons while every row is closed — nothing off-screen in the tab order", () => {
    const html = render(<ThreadListView {...swiping} />);
    expect(html).not.toContain("Archive");
    expect(html).not.toContain("Trash");
  });

  it("rows start at rest: translated to zero, and animating (nothing is mid-drag on first paint)", () => {
    const html = render(<ThreadListView {...swiping} />);
    expect(html).toContain("translate-x-0");
    expect(html).toContain("transition-transform");
  });
});

describe("isUnmodifiedPrimaryClick", () => {
  const left = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
  it("a plain left click opens in-page", () => {
    expect(isUnmodifiedPrimaryClick(left)).toBe(true);
  });
  it("cmd/ctrl/shift/alt and non-left keep the native <a> navigation", () => {
    expect(isUnmodifiedPrimaryClick({ ...left, metaKey: true })).toBe(false);
    expect(isUnmodifiedPrimaryClick({ ...left, ctrlKey: true })).toBe(false);
    expect(isUnmodifiedPrimaryClick({ ...left, shiftKey: true })).toBe(false);
    expect(isUnmodifiedPrimaryClick({ ...left, altKey: true })).toBe(false);
    expect(isUnmodifiedPrimaryClick({ ...left, button: 1 })).toBe(false);
  });
});
