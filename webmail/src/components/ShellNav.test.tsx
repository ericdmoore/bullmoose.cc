/** @jsxImportSource preact */
import { describe, expect, it } from "vitest";
import { render } from "preact-render-to-string";
import { RealmTray } from "./ShellNav";
import { STALE_AFTER_MS, type PublishedCollections } from "../lib/shell/publish";
import type { Section, SectionId } from "../lib/app/sections";

// s25 T4 — render tests for the realm tray (plain Node,
// preact-render-to-string, the s24 T0 bar). The publish contract itself is
// tested in lib/shell/publish.test.ts; here we prove the RENDERING: realm
// rows are literal links, published leaf-nodes appear with counts and hrefs,
// unpublished realms stay plain, staleness mutes and dates the counts, and
// nothing needs an inline style. The full ShellNav's effects (localStorage,
// bm:collections) run only in a browser — the tray takes everything as props
// precisely so the interesting part tests here.

const NOW = Date.UTC(2026, 7, 18, 12, 0);

const PUBLISHED: Partial<Record<SectionId, PublishedCollections>> = {
  mail: {
    realm: "mail",
    at: NOW - 1000,
    items: [
      { id: "inbox", label: "Inbox", count: 12, href: "/mail?c=inbox" },
      { id: "sent", label: "Sent", href: "/mail?c=sent" },
    ],
  },
  approvals: {
    realm: "approvals",
    at: NOW - STALE_AFTER_MS - 60_000, // eleven minutes ago — stale
    items: [{ id: "pending", label: "Waiting on you", count: 3, href: "/approvals?c=pending" }],
  },
};

function tray(overrides: Partial<Parameters<typeof RealmTray>[0]> = {}) {
  return render(
    <RealmTray
      section="mail"
      published={PUBLISHED}
      expandedIds={new Set()}
      onToggle={() => {}}
      now={NOW}
      {...overrides}
    />,
  );
}

describe("RealmTray — realm rows", () => {
  const html = tray();

  it("renders every realm as a literal link, the active one marked", () => {
    expect(html).toContain('href="/mail"');
    expect(html).toContain('href="/approvals"');
    expect(html).toContain('href="/settings"');
    expect(html).toContain('aria-current="page"');
  });

  it("grows a chevron only where something is published — unpublished realms stay plain", () => {
    expect(html).toContain('aria-label="Expand Mail collections"');
    expect(html).toContain('aria-label="Expand Approvals collections"');
    // Contacts published nothing in this fixture: no toggle, just the row.
    expect(html).not.toContain("Expand Contacts collections");
  });

  it("keeps leaf-nodes hidden while collapsed, chevron unrotated (class-swap, not unmount of the row)", () => {
    expect(html).not.toContain("/mail?c=inbox");
    expect(html).not.toContain("rotate-90");
    expect(html).toContain('aria-expanded="false"');
  });

  it("navigates by <a href> alone — no inline styles, no forms", () => {
    expect(html).not.toContain("style=");
    expect(html).not.toContain("<form");
  });
});

describe("RealmTray — expanded leaf-nodes", () => {
  const html = tray({ expandedIds: new Set(["mail"]) });

  it("renders the published collections as links with their counts", () => {
    expect(html).toContain('href="/mail?c=inbox"');
    expect(html).toContain('href="/mail?c=sent"');
    expect(html).toContain("Inbox");
    expect(html).toContain(">12<");
    expect(html).toContain("rotate-90");
    expect(html).toContain('aria-expanded="true"');
  });

  it("a fresh publish is not muted and carries no as-of line", () => {
    expect(html).not.toContain("as of");
    expect(html).not.toContain("text-gray-600");
  });

  it("a countless leaf renders no badge — 0 and absent are both silence", () => {
    // "Sent" published without a count: its row exists, no stray number.
    const sent = html.slice(html.indexOf("/mail?c=sent"));
    expect(sent.slice(0, 200)).not.toContain("tabular-nums");
  });
});

describe("RealmTray — staleness is honest", () => {
  const html = tray({ expandedIds: new Set(["approvals"]) });

  it("mutes a stale count instead of presenting it as live", () => {
    expect(html).toContain(">3<");
    expect(html).toContain("text-gray-600");
  });

  it("dates the staleness out loud — 'as of' with a wall-clock stamp", () => {
    expect(html).toContain("as of ");
  });
});

describe("RealmTray — the planned-section idiom survives", () => {
  it("renders a planned realm disabled WITH its reason, never as a link", () => {
    const roster: Section[] = [
      { id: "mail", label: "Mail", href: "/mail", status: "live" },
      {
        id: "files",
        label: "Files",
        href: "/files",
        status: "planned",
        reason: "lands with s99",
        detail: "The files surface is not built yet — s99 builds it.",
      },
    ];
    const html = tray({ sections: roster, published: {} });
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("lands with s99");
    expect(html).not.toContain('href="/files"');
  });
});

describe("RealmTray — the user's order is a preference, not a replacement", () => {
  it("honours a stored order and appends the sections it does not know", () => {
    const html = tray({ order: ["settings", "mail"] });
    const settingsAt = html.indexOf('href="/settings"');
    const mailAt = html.indexOf('href="/mail"');
    const approvalsAt = html.indexOf('href="/approvals"');
    expect(settingsAt).toBeGreaterThan(-1);
    expect(settingsAt).toBeLessThan(mailAt);
    expect(mailAt).toBeLessThan(approvalsAt);
  });
});
