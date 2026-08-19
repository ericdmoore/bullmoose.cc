/** @jsxImportSource preact */
import { describe, expect, it } from "vitest";
import { render } from "preact-render-to-string";
import FinderApp, { FinderChips, HitDetail, RefineBar, SuggestBar, ThreadGroups } from "./FinderApp";
import CollectionColumn from "./CollectionColumn";
import { buildFinderCollections } from "../lib/finder/collections";
import type { FinderHit } from "../lib/finder/run";
import { newSession, refine } from "../lib/finder/session";
import { suggestRefinements } from "../lib/finder/suggest";
import { groupByThread } from "../lib/finder/threads";
import type { Mailbox } from "../lib/mail/types";

// s20 T5 — render tests (plain Node, preact-render-to-string, the s24 T0
// idiom). The behaviour lives pure in lib/finder/* with its own tests; here
// we prove the MARKUP: chips carry their remove buttons, results group by
// thread with aria-current on the selection, and the detail pane's one exit
// is a plain literal-path anchor into /mail — no navigation API anywhere
// (tokenInUrl.test.ts scans the source; this asserts the rendered shape).

const NOW = () => Date.parse("2026-08-15T12:00:00Z");

const hit = (partial: Partial<FinderHit> & Pick<FinderHit, "id" | "threadId" | "receivedAt">): FinderHit => ({
  subject: "(no subject)",
  sender: "Someone",
  senderEmail: "someone@example.test",
  preview: "",
  hasAttachment: false,
  ...partial,
});

describe("FinderChips", () => {
  const session = refine(refine(newSession("elk", NOW), { kind: "from", value: "grace" }), { kind: "attachment" });
  const html = render(<FinderChips session={session} onRemove={() => {}} />);

  it("leads with the query and renders each refinement as a chip", () => {
    expect(html).toContain("“elk”");
    expect(html).toContain("from: grace");
    expect(html).toContain("has attachment");
  });

  it("every chip carries its own labelled remove button — backed out one at a time", () => {
    expect(html).toContain('aria-label="Remove from: grace"');
    expect(html).toContain('aria-label="Remove has attachment"');
  });

  it("shows an honest placeholder when the find is chips-only", () => {
    const bare = refine(newSession("", NOW), { kind: "attachment" });
    expect(render(<FinderChips session={bare} onRemove={() => {}} />)).toContain("(no text)");
  });
});

describe("RefineBar", () => {
  const mailboxes = [{ id: "mb-inbox", name: "Inbox" }] as unknown as Mailbox[];
  const html = render(<RefineBar mailboxes={mailboxes} onAdd={() => {}} canSave={true} onSave={() => {}} />);

  it("offers the facet controls: from/to, mailbox, has-attachment, save", () => {
    expect(html).toContain(">From<");
    expect(html).toContain(">To<");
    expect(html).toContain("Inbox");
    expect(html).toContain("Has attachment");
    expect(html).toContain("Save this find");
  });

  it("is buttons and inputs, never a form — a form with no action still navigates", () => {
    expect(html).not.toContain("<form");
  });

  it("disables save for a blank find", () => {
    const blank = render(<RefineBar mailboxes={[]} onAdd={() => {}} canSave={false} onSave={() => {}} />);
    expect(blank).toContain('finder-save" disabled');
    expect(html).not.toContain('finder-save" disabled');
  });
});

describe("SuggestBar — the agent's offers (s20 T5b)", () => {
  const offers = suggestRefinements(newSession("elk permit from sergio", NOW), [
    ...Array.from({ length: 5 }, (_, i) =>
      hit({
        id: `s${i}`,
        threadId: `t${i}`,
        receivedAt: "2026-08-01T00:00:00Z",
        sender: "Sergio Ruiz",
        senderEmail: "sergio@example.test",
      }),
    ),
    ...Array.from({ length: 4 }, (_, i) =>
      hit({
        id: `a${i}`,
        threadId: `u${i}`,
        receivedAt: "2026-08-02T00:00:00Z",
        sender: "Sergio's assistant",
        senderEmail: "assistant@example.test",
      }),
    ),
  ]);
  const html = render(<SuggestBar suggestions={offers} onAccept={() => {}} />);

  it("shows each offer as a chip WITH its reason — grounds you cannot see are grounds you cannot decline", () => {
    expect(offers.length).toBeGreaterThan(1);
    expect(html).toContain("from: sergio");
    expect(html).toContain("assistant@example.test");
    expect(html).toContain("rather than both");
  });

  it("says out loud that ignoring it is free", () => {
    expect(html).toContain("nothing is applied until you click");
  });

  it("is buttons only — nothing checked, nothing selected, nothing to dismiss", () => {
    // The anti-star, in markup: no checkbox, no toggle, no aria-pressed state,
    // and no "don't show me this again" — the offers recompute and vanish on
    // their own.
    expect(html).not.toContain("checkbox");
    expect(html).not.toContain("aria-pressed");
    expect(html).not.toContain("aria-checked");
    expect(html).not.toContain("Dismiss");
    expect(html).not.toContain("<form");
    expect(html).not.toContain(" style=");
  });

  it("renders NOTHING when there is nothing to offer — an empty strip is the agent taking up room", () => {
    expect(render(<SuggestBar suggestions={[]} onAccept={() => {}} />)).toBe("");
  });
});

describe("ThreadGroups", () => {
  const groups = groupByThread([
    hit({ id: "m1", threadId: "t-elk", receivedAt: "2026-07-01T10:00:00Z", subject: "Kickoff", sender: "Grace" }),
    hit({ id: "m2", threadId: "t-elk", receivedAt: "2026-07-01T12:00:00Z", subject: "Re: Kickoff", sender: "Eric" }),
    hit({ id: "m3", threadId: "t-inv", receivedAt: "2026-07-02T09:00:00Z", subject: "Invoice", sender: "Accounts" }),
  ]);
  const html = render(<ThreadGroups groups={groups} selectedId="m2" onSelect={() => {}} />);

  it("groups rows under a thread heading with the message count", () => {
    expect(html).toContain("Re: Kickoff");
    expect(html).toContain("2 messages");
    expect(html).toContain("Invoice");
  });

  it("marks the selected row with aria-current", () => {
    expect(html).toContain('aria-current="true"');
    expect((html.match(/aria-current="true"/g) ?? []).length).toBe(1);
  });
});

describe("HitDetail", () => {
  const detailed = hit({
    id: "m1",
    threadId: "t-elk",
    receivedAt: "2026-07-01T10:00:00Z",
    subject: "Kickoff",
    sender: "Grace Hopper",
    senderEmail: "grace@example.test",
    preview: "Kicking this off Monday.",
    hasAttachment: true,
  });
  const html = render(<HitDetail hit={detailed} />);

  it("renders the excerpt with sender, date and the attachment mark", () => {
    expect(html).toContain("Kickoff");
    expect(html).toContain("Grace Hopper");
    expect(html).toContain("Kicking this off Monday.");
    expect(html).toContain("2026-07-01");
    expect(html).toContain("attachment");
  });

  it("exits through a plain anchor to a literal /mail path — never a navigation call", () => {
    expect(html).toContain('href="/mail?thread=t-elk"');
    expect(html).toContain("Open in Mail");
  });

  it("says the excerpt is an excerpt — the full message lives in Mail", () => {
    expect(html).toContain("stored excerpt");
  });

  it("is honest when no preview is stored rather than rendering an empty pane", () => {
    const bare = hit({ id: "m9", threadId: "t-x", receivedAt: "2026-07-01T10:00:00Z", preview: "" });
    expect(render(<HitDetail hit={bare} />)).toContain("No preview is stored");
  });
});

describe("FinderApp shell", () => {
  it("renders the connecting state before any client resolves (effects do not run in SSR)", () => {
    const html = render(<FinderApp />);
    expect(html).toContain("Connecting…");
  });
});

/**
 * The empty Finder is the FIRST thing a new account sees on `/search`, and for
 * a while it greeted them with "No saved que…", "No finds y…", "No dat…" — the
 * label and its hint fighting over one line inside a `w-56` column. An
 * explanation nobody can finish reading is worse than no explanation, and it
 * made the product look broken at the exact moment it was working correctly.
 *
 * These are the REAL rows (`buildFinderCollections` with nothing in it, fed to
 * the REAL column), asserted whole: each label appears as its own complete
 * text node, each hint as its own, neither clipped by the other. The layout
 * that guarantees it is asserted in `CollectionColumn.test.tsx`; this holds
 * the Finder's three specific strings to it, because a future hint two words
 * longer must not be able to eat a label again.
 */
describe("the empty Finder reads completely at the real column width", () => {
  const html = render(
    <CollectionColumn
      title="Finder"
      groups={buildFinderCollections({ saved: [], sessions: [], dateGroups: [] })}
      onSelect={() => {}}
    />,
  );

  it("every empty-state label is a whole text node, not a truncated fragment", () => {
    for (const label of ["No saved queries", "No finds yet", "No dates"]) {
      expect(html, label).toContain(`<span class="truncate">${label}</span>`);
    }
  });

  it("every hint renders whole, on its own line under its label", () => {
    for (const [label, hint] of [
      ["No saved queries", "save a find to keep it"],
      ["No finds yet", "search above to start one"],
      ["No dates", "dates come from the current find"],
    ]) {
      expect(html, hint).toMatch(
        new RegExp(`<span class="truncate">${label}</span><span class="[^"]*">${hint}</span></span>`),
      );
    }
  });

  it("each one is still a disabled row carrying its reason on `title` — the idiom is intact", () => {
    expect(html).toContain('title="save a find to keep it"');
    expect(html).toContain('title="search above to start one"');
    expect(html).toContain('title="dates come from the current find"');
    expect(html).toContain("cursor-not-allowed");
  });
});
