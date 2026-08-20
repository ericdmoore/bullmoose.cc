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
    expect(html).toContain("M19.5 8.25"); // restore-column points down, matching collapse-up
    expect(html).toContain("Mail");
    expect(html).toContain("Archive");
    expect(html).toContain("New message");
    expect(html).toContain("bg-brand-600");
    expect(html).not.toContain("Inbox"); // picker closed
  });

  it("accepts a class so a surface can hide the bar where another picker owns the phone", () => {
    const html = render(
      <CollectionBar
        title="Approvals"
        groups={[{ id: "lifecycle", items: [{ id: "pending", label: "Waiting on you" }] }]}
        selectedId="pending"
        onSelect={() => {}}
        onExpand={() => {}}
        class="max-lg:hidden"
      />,
    );
    expect(html).toContain("max-lg:hidden");
    expect(html).toContain("Approvals");
    expect(html).toContain("Waiting on you");
    expect(html).toContain("Show approvals collections as a column");
  });

  it("contacts and agents crumbs name the current collection", () => {
    const contacts = render(
      <CollectionBar
        title="Contacts"
        groups={[{ id: "books", items: [{ id: "", label: "All address books" }] }]}
        selectedId=""
        onSelect={() => {}}
        onExpand={() => {}}
        newLabel="New contact"
        onNew={() => {}}
      />,
    );
    expect(contacts).toContain("All address books");
    expect(contacts).toContain("New contact");

    const agents = render(
      <CollectionBar
        title="Agents"
        groups={[
          { id: "agents", items: [{ id: "all", label: "All agents" }] },
          { id: "governance", items: [{ id: "console", label: "Access console" }] },
        ]}
        selectedId="console"
        onSelect={() => {}}
        onExpand={() => {}}
      />,
    );
    expect(agents).toContain("Agents");
    expect(agents).toContain("Access console");
    expect(agents).not.toContain("New contact");
    expect(agents).not.toContain("bg-brand-600");
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
