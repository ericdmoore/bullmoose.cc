/** @jsxImportSource preact */
import { describe, expect, it } from "vitest";
import { render } from "preact-render-to-string";
import CollectionSheet, { CollectionSheetButton } from "./CollectionSheet";
import type { CollectionGroup } from "../lib/shell/collections";

// s25 T2 — render tests (plain Node, preact-render-to-string). The tree's
// behaviour is tested pure in lib/shell/collections.test.ts and its markup in
// CollectionColumn.test.tsx (the sheet renders the SAME <CollectionTree>);
// here we prove the SHEET around it: a small-screen modal that stays mounted
// and animates by class swap (open/closed via props), its backdrop a real
// button, its bottom padded for the safe area. Escape/focus are effects and
// SSR runs no effects — they are hand-rolled per the ShellNav pattern and
// exercised in a browser, not here.

const GROUPS: CollectionGroup[] = [
  {
    id: "queue",
    label: "Queue",
    items: [
      { id: "pending", label: "Waiting on you", count: 3 },
      {
        id: "by-agent",
        label: "By agent",
        children: [{ id: "agent-allen", label: "Allen", count: 2 }],
      },
    ],
  },
  {
    id: "views",
    label: "Views",
    items: [{ id: "high-cost", label: "High cost", disabled: true, reason: "coming with cost data" }],
  },
];

describe("CollectionSheet — open", () => {
  const html = render(
    <CollectionSheet
      title="Approvals"
      groups={GROUPS}
      selectedId="pending"
      onSelect={() => {}}
      open
      onClose={() => {}}
    />,
  );

  it("is a small-screen modal dialog named for the realm", () => {
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-label="Approvals collections"');
    expect(html).toContain("lg:hidden"); // desktop keeps the column; the sheet is the phone's picker
    expect(html).toContain('aria-hidden="false"');
  });

  it("slides up from the bottom by class swap, never inline style", () => {
    expect(html).toContain("translate-y-0");
    expect(html).not.toContain("translate-y-full");
    expect(html).not.toContain("style=");
  });

  it("the backdrop is a real button — tap-outside-to-dismiss is a control", () => {
    expect(html).toContain('aria-label="Close collections"');
  });

  it("pads its bottom with the safe-area inset (s25 T1)", () => {
    expect(html).toContain("pb-[env(safe-area-inset-bottom)]");
  });

  it("renders the SAME tree: groups, selection, counts, the planned row with its reason", () => {
    expect(html).toContain("Queue");
    expect(html).toContain("Waiting on you");
    expect(html).toContain('aria-current="true"');
    expect(html).toContain(">3<");
    expect(html).toContain('aria-label="Expand By agent"'); // collapsed parent, chevron present
    expect(html).not.toContain("Allen");
    expect(html).toContain("High cost");
    expect(html).toContain("coming with cost data");
  });

  it("defaultExpanded reaches the tree (the SSR/test seam)", () => {
    const expanded = render(
      <CollectionSheet
        title="Approvals"
        groups={GROUPS}
        onSelect={() => {}}
        open
        onClose={() => {}}
        defaultExpanded={["by-agent"]}
      />,
    );
    expect(expanded).toContain("Allen");
    expect(expanded).toContain('aria-expanded="true"');
  });
});

describe("CollectionSheet — closed (mounted so the slide can animate)", () => {
  const html = render(
    <CollectionSheet title="Approvals" groups={GROUPS} onSelect={() => {}} open={false} onClose={() => {}} />,
  );

  it("is off-screen, inert and hidden from the tree", () => {
    expect(html).toContain("translate-y-full");
    expect(html).toContain("pointer-events-none");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('tabindex="-1"'); // the backdrop leaves the tab order
  });
});

describe("CollectionSheetButton — the tappable list title (≤lg)", () => {
  it("shows the active collection's name and summons a dialog", () => {
    const html = render(<CollectionSheetButton label="Waiting on you" open={false} onOpen={() => {}} />);
    expect(html).toContain("Waiting on you");
    expect(html).toContain("lg:hidden"); // desktop keeps its plain heading
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("<svg"); // the chevron says "this opens"
  });
});
