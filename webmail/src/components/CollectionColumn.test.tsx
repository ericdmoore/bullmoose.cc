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

// ── s25 T2 — the tree renderings: inline-expandable children (one level) and
// the planned-row idiom (disabled + reason, never a dead row). ────────────

const NESTED: CollectionGroup[] = [
  {
    id: "queue",
    label: "Queue",
    items: [
      { id: "pending", label: "Waiting on you", count: 3 },
      {
        id: "by-agent",
        label: "By agent",
        children: [
          { id: "agent-allen", label: "Allen", count: 2 },
          { id: "agent-piper", label: "Piper" },
        ],
      },
    ],
  },
  {
    id: "views",
    label: "Views",
    items: [{ id: "high-cost", label: "High cost", disabled: true, reason: "coming with cost data" }],
  },
];

describe("CollectionColumn — expandable nodes (s25 T2)", () => {
  it("a collapsed parent shows its chevron but not its children", () => {
    const html = render(<CollectionColumn title="Approvals" groups={NESTED} onSelect={() => {}} />);
    expect(html).toContain('aria-label="Expand By agent"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Allen");
  });

  it("defaultExpanded renders the children inline, indented one step", () => {
    const html = render(
      <CollectionColumn
        title="Approvals"
        groups={NESTED}
        selectedId="agent-allen"
        onSelect={() => {}}
        defaultExpanded={["by-agent"]}
      />,
    );
    expect(html).toContain('aria-label="Collapse By agent"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("rotate-90"); // the chevron turns by class swap, never inline style
    expect(html).toContain("Allen");
    expect(html).toContain("pl-4"); // one discrete indent step (CSP: a class, not paddingLeft)
    expect(html).toContain('aria-current="true"'); // a child can be the selection
  });

  it("a disabled row is greyed WITH its reason — never a dead row", () => {
    const html = render(<CollectionColumn title="Approvals" groups={NESTED} onSelect={() => {}} />);
    expect(html).toContain("High cost");
    expect(html).toContain("coming with cost data"); // visible beside the label
    expect(html).toContain('title="coming with cost data"');
    expect(html).toContain("disabled"); // a native disabled button: unselectable for free
    expect(html).toContain("opacity-60");
  });
});

describe("CollectionColumn — narrow behaviour (s25 T1)", () => {
  it("stacks full-width and height-capped below lg by default", () => {
    const html = render(<CollectionColumn title="Mail" groups={GROUPS} onSelect={() => {}} />);
    expect(html).toContain("w-full");
    expect(html).toContain("max-lg:max-h-[45dvh]");
    expect(html).toContain("lg:w-56");
  });

  it("narrow='hidden' removes it below lg (the surface summons the sheet instead)", () => {
    const html = render(<CollectionColumn title="Approvals" groups={GROUPS} onSelect={() => {}} narrow="hidden" />);
    expect(html).toContain("max-lg:hidden");
    expect(html).not.toContain("max-lg:max-h");
  });

  it("the collapsed strip turns horizontal below lg — and disappears when narrow='hidden'", () => {
    const stacked = render(
      <CollectionColumn title="Mail" groups={GROUPS} onSelect={() => {}} storageKey="k" defaultCollapsed />,
    );
    expect(stacked).toContain("max-lg:flex-row");
    expect(stacked).not.toContain("max-lg:hidden");
    const hidden = render(
      <CollectionColumn
        title="Approvals"
        groups={GROUPS}
        onSelect={() => {}}
        storageKey="k"
        defaultCollapsed
        narrow="hidden"
      />,
    );
    expect(hidden).toContain("max-lg:hidden");
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
