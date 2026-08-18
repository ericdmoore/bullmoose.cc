/** @jsxImportSource preact */
import { describe, expect, it } from "vitest";
import { render } from "preact-render-to-string";
import CollectionColumn from "./CollectionColumn";
import type { CollectionGroup } from "../lib/shell/collections";

// s24 T1 — render tests (plain Node, preact-render-to-string). The behaviour
// (selection model) is tested pure in lib/shell/collections.test.ts; here we
// prove the MARKUP: groups render, selection carries aria-current, counts are
// badges (zero renders nothing), [New] is the standardized primary Button, and
// the collapsed strip is just the expand affordance.

const GROUPS: CollectionGroup[] = [
  {
    id: "live",
    label: "Address books",
    items: [
      { id: "all", label: "All contacts", count: 42 },
      { id: "family", label: "Family", count: 0 },
    ],
  },
  { id: "views", label: "Groups", items: [{ id: "church", label: "Church", muted: true }] },
];

describe("CollectionColumn — expanded", () => {
  const html = render(
    <CollectionColumn
      title="Contacts"
      groups={GROUPS}
      selectedId="all"
      onSelect={() => {}}
      newLabel="New contact"
      onNew={() => {}}
      storageKey="bm.cc.contacts"
    />,
  );

  it("is a labelled column of grouped, selectable rows", () => {
    expect(html).toContain('aria-label="Contacts collections"');
    expect(html).toContain("Address books");
    expect(html).toContain("Groups");
    expect(html).toContain("All contacts");
    expect(html).toContain('aria-current="true"');
  });

  it("a count renders as a Badge; a zero renders nothing", () => {
    expect(html).toContain(">42<");
    expect(html).not.toContain(">0<");
  });

  it("[New] is the standardized primary Button with the Plus glyph", () => {
    expect(html).toContain("New contact");
    expect(html).toContain("bg-brand-600");
    expect(html).toContain("<svg");
  });

  it("offers the collapse affordance when a storageKey is given", () => {
    expect(html).toContain("Collapse contacts collections");
  });
});

describe("CollectionColumn — the T2 extensions (Contacts, the second caller)", () => {
  it("a note renders as a neutral badge; count wins when both are present", () => {
    const html = render(
      <CollectionColumn
        title="Contacts"
        groups={[
          {
            id: "g",
            items: [
              { id: "ro", label: "Shared", note: "read-only" },
              { id: "both", label: "Inbox", count: 7, note: "default" },
            ],
          },
        ]}
        onSelect={() => {}}
      />,
    );
    expect(html).toContain("read-only");
    expect(html).toContain(">7<");
    expect(html).not.toContain("default"); // count won
  });

  it("newDisabled disables (not hides) the standardized [New]", () => {
    const html = render(
      <CollectionColumn
        title="C"
        groups={[]}
        onSelect={() => {}}
        newLabel="New contact"
        onNew={() => {}}
        newDisabled
      />,
    );
    expect(html).toContain("New contact");
    expect(html).toContain("disabled");
  });

  it("actions and footer slots render in place", () => {
    const html = render(
      <CollectionColumn
        title="C"
        groups={[{ id: "g", items: [{ id: "a", label: "A" }] }]}
        onSelect={() => {}}
        actions={<i>second-create</i>}
        footer={<em>manage-books</em>}
      />,
    );
    expect(html).toContain("<i>second-create</i>");
    expect(html).toContain("<em>manage-books</em>");
  });
});

describe("CollectionColumn — variants", () => {
  it("without onNew it shows the title instead of a create button", () => {
    const html = render(<CollectionColumn title="Approvals" groups={GROUPS} onSelect={() => {}} />);
    expect(html).toContain("Approvals");
    expect(html).not.toContain("bg-brand-600");
    // and without a storageKey there is no collapse affordance
    expect(html).not.toContain("Collapse approvals");
  });

  it("collapsed renders the thin strip with only the expand affordance", () => {
    const html = render(
      <CollectionColumn title="Mail" groups={GROUPS} onSelect={() => {}} storageKey="k" defaultCollapsed />,
    );
    expect(html).toContain("Expand mail collections");
    expect(html).toContain("w-10");
    expect(html).not.toContain("Address books"); // the list is gone, not hidden
  });
});
