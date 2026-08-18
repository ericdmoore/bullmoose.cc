/** @jsxImportSource preact */
import { describe, expect, it } from "vitest";
import { render } from "preact-render-to-string";
import CreateFab from "./CreateFab";
import CollectionColumn from "./CollectionColumn";
import type { CollectionGroup } from "../lib/shell/collections";

// s25 T5 — the contextual [New] as a FAB. SSR render, plain Node (the s24 T0
// bar: no jsdom). The class logic is tested pure in lib/ui/classes.test.ts;
// what matters here is the WIRING — that the FAB is the column's own props in
// a different position, and that a realm without a create verb gets nothing.

const GROUPS: readonly CollectionGroup[] = [{ id: "g", items: [{ id: "inbox", label: "Inbox" }] }];

const column = (props: Record<string, unknown> = {}) =>
  render(<CollectionColumn title="Mail" groups={GROUPS} onSelect={() => {}} {...props} />);

describe("CreateFab", () => {
  it("shows the realm's verb as words, and as the accessible name", () => {
    const html = render(<CreateFab label="New message" onClick={() => {}} />);
    expect(html).toContain("New message");
    expect(html).toContain('aria-label="New message"');
  });

  it("is a button, never a link — creating is not navigating", () => {
    const html = render(<CreateFab label="New contact" onClick={() => {}} />);
    expect(html).toContain('type="button"');
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("href");
  });

  it("disabled, not hidden: the realm still has the verb, this session cannot use it", () => {
    const html = render(<CreateFab label="New contact" onClick={() => {}} disabled />);
    expect(html).toContain("disabled");
    expect(html).toContain("New contact");
  });

  it("writes no inline style — position and inset are classes (CSP)", () => {
    expect(render(<CreateFab label="New find" onClick={() => {}} />)).not.toContain("style=");
  });
});

describe("CollectionColumn renders the FAB from its OWN [New] props", () => {
  it("one verb, two positions — the column button and the FAB share a label", () => {
    const html = column({ newLabel: "New message", onNew: () => {} });
    // The column's button carries the words; the FAB carries them AND names
    // itself with them. One label prop behind all three.
    expect(html).toContain("New message</button>");
    expect(html).toContain('aria-label="New message"');
    expect(html).toContain("New message</span>");
    expect(html).toContain("lg:hidden");
  });

  it("a realm with no [New] gets no FAB — absence stays absence", () => {
    const html = column();
    expect(html).not.toContain("lg:hidden");
    expect(html).toContain("Mail");
  });

  it("newDisabled disables BOTH — the two can never disagree about permission", () => {
    const html = column({ newLabel: "New contact", onNew: () => {}, newDisabled: true });
    // The bare boolean attribute, twice: once per button. (`disabled:` in a
    // class string is a Tailwind variant, not an attribute — hence the space.)
    expect(html.match(/ disabled[ >]/g)).toHaveLength(2);
    expect(column({ newLabel: "New contact", onNew: () => {} }).match(/ disabled[ >]/g)).toBeNull();
  });

  it("survives the collapsed column: the FAB is a sibling, not a child", () => {
    // `narrow="hidden"` + collapsed is precisely the phone case where the
    // column is not on screen at all — and precisely where the FAB matters.
    const html = column({
      newLabel: "New message",
      onNew: () => {},
      defaultCollapsed: true,
      narrow: "hidden",
      storageKey: "bm.cc.test",
    });
    expect(html).toContain("New message");
  });
});
