/** @jsxImportSource preact */
import { describe, expect, it } from "vitest";
import { render } from "preact-render-to-string";
import ShellNav, { RealmTray } from "./ShellNav";
import type { RealmChromeControl } from "../lib/shell/realmChrome";
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

// s25 T5 — the contextual search bar, collapsed. SSR renders the whole
// ShellNav at its FIRST state (effects do not run in preact-render-to-string,
// which is exactly the collapsed one), so what is testable here is the
// starting shape — and that is the shape the invariants live in.

describe("ShellNav — the collapsing search", () => {
  const html = render(<ShellNav section="mail" email="eric@bullmoose.cc" />);

  it("starts collapsed at EVERY width: a magnifier trigger", () => {
    expect(html).toContain('aria-controls="bm-global-search"');
    expect(html).toContain('aria-expanded="false"');
  });

  it("the trigger is no longer desktop-hidden", () => {
    // s25 T5 gated the collapse to below `lg`, so the desktop header kept a
    // permanently expanded field whose placeholder taught query syntax —
    // spending the whole bar, at rest, on something nobody reads twice.
    const trigger = /<button[^>]*aria-controls="bm-global-search"[^>]*>/.exec(html)?.[0] ?? "";
    expect(trigger).not.toBe("");
    expect(trigger).not.toContain("lg:hidden");
  });

  it("keeps the FIELD mounted but collapsed, so nothing typed is lost", () => {
    // Collapsed is `max-w-0`, not `display:none`. Two things follow: the width
    // can animate, and the uncontrolled input keeps whatever was typed when
    // the reader clicks away and comes back.
    expect(html).toContain('id="bm-global-search"');
    expect(html).toContain("max-w-0");
    expect(html).not.toContain("max-lg:hidden");
    expect(html).not.toContain('<form class="hidden">');
  });

  it("still renders exactly ONE search input — the collapse is a class, not a second field", () => {
    expect(html.match(/id="bm-global-search"/g)).toHaveLength(1);
  });

  it("the form still cannot navigate (the s07 T1 invariant, unchanged)", () => {
    expect(html).toContain("<form");
    expect(html).not.toMatch(/<form[^>]*\b(action|method)=/);
  });

  it("a realm with no wired search renders neither trigger nor field", () => {
    const bare = render(<ShellNav section="calendar" email="eric@bullmoose.cc" />);
    expect(bare).not.toContain("bm-global-search");
    expect(bare).not.toContain("<form");
  });

  it("writes no inline style anywhere in the chrome (CSP)", () => {
    expect(html).not.toContain("style=");
  });
});

// s34 — the realm chrome control: the one thing a SURFACE may hang in the
// shared header, beside the identity chip. The publish/pick contract itself
// is tested in lib/shell/realmChrome.test.ts; here we prove the RENDERING,
// and that the identity chip still fits beside it.

const ACCOUNT_PICKER: RealmChromeControl = {
  realm: "contacts",
  label: "Account",
  options: [
    { id: "acct-mine", label: "eric@bullmoose.cc" },
    { id: "acct-shared", label: "family@bullmoose.cc (shared)" },
  ],
  selectedId: "acct-shared",
};

describe("ShellNav — the realm chrome control (s34)", () => {
  const html = render(<ShellNav section="contacts" email="eric@bullmoose.cc" realmControl={ACCOUNT_PICKER} />);

  it("renders the surface's picker in the header, with every option", () => {
    expect(html).toContain('aria-label="Account"');
    expect(html).toContain("eric@bullmoose.cc");
    expect(html).toContain("family@bullmoose.cc (shared)");
    expect(html).toContain('value="acct-shared"');
  });

  it("puts it BESIDE the identity chip, not below it — the picker precedes the avatar menu", () => {
    // Eric's annotation was about position: the account picker sat a full row
    // under the chrome. Both now live in the same header row, picker first.
    const picker = html.indexOf('aria-label="Account"');
    const chip = html.indexOf("Open user menu");
    expect(picker).toBeGreaterThan(-1);
    expect(chip).toBeGreaterThan(picker);
  });

  it("does not disturb the identity chip's own layout", () => {
    // The chip's nowrap+truncate clamp (the second Kitesurf screenshot fix)
    // survives, and so does its menu.
    expect(html).toContain("max-w-56");
    expect(html).toContain("Open user menu");
  });

  it("renders nothing for a realm you are not standing in", () => {
    const elsewhere = render(<ShellNav section="mail" email="eric@bullmoose.cc" realmControl={ACCOUNT_PICKER} />);
    expect(elsewhere).not.toContain('aria-label="Account"');
  });

  it("renders nothing when there is only one option — a picker needs a choice", () => {
    const single = render(
      <ShellNav
        section="contacts"
        email="eric@bullmoose.cc"
        realmControl={{ ...ACCOUNT_PICKER, options: [ACCOUNT_PICKER.options[0]!] }}
      />,
    );
    expect(single).not.toContain('aria-label="Account"');
  });

  it("renders nothing at all for a surface that published nothing", () => {
    expect(render(<ShellNav section="contacts" email="eric@bullmoose.cc" />)).not.toContain('aria-label="Account"');
  });

  it("is a plain select — no form, no navigation, no inline style (CSP + tokenInUrl)", () => {
    expect(html).toContain("<select");
    expect(html).not.toMatch(/<select[^>]*\bform=/);
    expect(html).not.toContain("style=");
  });
});
