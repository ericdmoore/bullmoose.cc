/** @jsxImportSource preact */
import { describe, expect, it } from "vitest";
import { render } from "preact-render-to-string";
import type { Annotation } from "../lib/annotations/types";
import { AnnotationRow } from "./HomeView";

// The glance row (s18 A4 + the 2026-08-21 gap). Render tests, no jsdom — the
// AnnotationMargin.test.tsx pattern.
//
// The rule being pinned: a commitment noticed on home must be dischargeable
// on home. The verbs existed only on AnnotationMargin, which is rendered by
// MessageView and NotesApp, so the home glance could show you a promise and
// give you no way to close it.

function anno(over: Partial<Annotation> = {}): Annotation {
  return {
    id: "an_1",
    accountId: "acct",
    authorKind: "agent",
    author: "scribe",
    anchor: { realm: "Email", objectId: "e1" },
    class: "commitment",
    body: "You told Grace Monday works",
    confidence: 0.72,
    status: "open",
    rationale: null,
    createdAt: 0,
    updatedAt: 0,
    ...(over as object),
  } as Annotation;
}

describe("AnnotationRow — the glance carries the margin's verbs", () => {
  it("renders both verbs when it can close", () => {
    const html = render(<AnnotationRow a={anno()} onClose={() => {}} />);
    expect(html).toContain("Resolve");
    // "Not a real one" and "Resolve" are DIFFERENT facts about the agent —
    // the thing happened, versus the extraction was wrong. Collapsing them
    // into one "dismiss" would discard the only signal that says the reader
    // misread something.
    expect(html).toContain("Not a real one");
  });

  it("renders NO verbs without a handler, so a read-only context is unchanged", () => {
    const html = render(<AnnotationRow a={anno()} />);
    expect(html).not.toContain("Resolve");
    expect(html).not.toContain("<button");
  });

  it("disables the verbs while a close is in flight", () => {
    const html = render(<AnnotationRow a={anno()} onClose={() => {}} busy />);
    expect(html).toContain("disabled");
  });

  it("says so quietly when the write failed, rather than throwing home away", () => {
    // Home is AMBIENT: a failed close is a line on the row, never an error
    // that takes the page down. The row is back because the optimistic
    // removal was undone.
    const html = render(<AnnotationRow a={anno()} onClose={() => {}} failed />);
    expect(html).toContain("still open");
    expect(html).toContain('role="alert"');
  });

  it("still speaks confidence for an extraction, and nothing for a filed claim", () => {
    expect(render(<AnnotationRow a={anno({ confidence: 0.72 })} />)).toContain("72%");
    expect(render(<AnnotationRow a={anno({ confidence: null })} />)).not.toContain("%");
  });
});
