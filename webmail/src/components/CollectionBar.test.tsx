/** @jsxImportSource preact */
import { describe, expect, it } from "vitest";
import { render } from "preact-render-to-string";
import CollectionBar from "./CollectionBar";
import { InboxIcon } from "./icons";
import type { CollectionGroup } from "../lib/shell/collections";

const GROUPS: CollectionGroup[] = [
  {
    id: "mailboxes",
    items: [
      { id: "inbox", label: "Inbox", icon: InboxIcon },
      { id: "archive", label: "Archive", icon: InboxIcon },
    ],
  },
];

describe("CollectionBar", () => {
  it("is a breadcrumb above the list: realm / current folder, plus restore-column", () => {
    const html = render(
      <CollectionBar
        title="Mail"
        groups={GROUPS}
        selectedId="archive"
        onSelect={() => {}}
        onExpand={() => {}}
        newLabel="New message"
        onNew={() => {}}
      />,
    );
    expect(html).toContain("Show mail collections as a column");
    expect(html).toContain("Mail");
    expect(html).toContain("Archive");
    expect(html).toContain("New message");
    expect(html).toContain("bg-brand-600");
    expect(html).not.toContain("Inbox"); // picker closed
  });

  it("the open picker is a dialog of the same collection tree", () => {
    const html = render(
      <CollectionBar
        title="Mail"
        groups={GROUPS}
        selectedId="archive"
        onSelect={() => {}}
        onExpand={() => {}}
        defaultOpen
      />,
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain("Inbox");
    expect(html).toContain('aria-current="true"');
  });
});
