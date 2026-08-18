/** @jsxImportSource preact */
import { describe, expect, it } from "vitest";
import { render } from "preact-render-to-string";
import ThreadListView from "./ThreadListView";
import type { ThreadRow } from "../lib/mail/threadList";

// s25 T3 — the list's rows become deep-linkable. With `hrefFor` the row body
// is a real `<a href="/mail?thread=…">` (the click path: MPA navigation,
// native back); without it the body stays a div and `onOpen` carries the
// in-page path (keyboard j/k + Enter). SSR render, plain Node — the
// virtual-window math is tested pure in lib/mail/virtual.

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
