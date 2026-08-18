/** @jsxImportSource preact */
import { describe, expect, it } from "vitest";
import { render } from "preact-render-to-string";
import FinderApp, { FinderChips, HitDetail, RefineBar, ThreadGroups } from "./FinderApp";
import type { FinderHit } from "../lib/finder/run";
import { newSession, refine } from "../lib/finder/session";
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
