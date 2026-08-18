/** @jsxImportSource preact */
import { describe, expect, it } from "vitest";
import { render } from "preact-render-to-string";
import type { Annotation } from "../lib/annotations/types";
import AnnotationMargin from "./AnnotationMargin";
import PersonPanel from "./PersonPanel";

// s18 A3 — render tests, no jsdom (the ui.test.tsx pattern): SSR the margin
// and assert on the markup. The properties are the surface's design rules:
// collapsed by default behind an "N notes" chip; verbs ONLY on an open claim;
// a closed claim muted with its epitaph; confidence spoken, never printed;
// NULL rationale → "Why: not stated".

function anno(id: string, over: Partial<Annotation> = {}): Annotation {
  return {
    id,
    accountId: "acct",
    authorKind: "agent",
    author: "scribe",
    anchor: { realm: "Email", objectId: "e1" },
    class: "commitment",
    body: "You told Grace Monday works",
    confidence: 0.72,
    status: "open",
    rationale: null,
    sourceRef: null,
    createdAt: 1000,
    updatedAt: 1000,
    ...over,
  };
}

const noop = () => {};
const none: ReadonlySet<string> = new Set();

describe("AnnotationMargin", () => {
  it("renders nothing at all for a message with no annotations — a calm surface, no dead region", () => {
    expect(render(<AnnotationMargin annotations={[]} busy={none} onClose={noop} />)).toBe("");
  });

  it("collapses to a gutter chip by default — the notes stay behind '2 notes'", () => {
    const html = render(<AnnotationMargin annotations={[anno("a"), anno("b")]} busy={none} onClose={noop} />);
    expect(html).toContain("2 notes");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("anno-list");
    expect(html).not.toContain("Resolve");
  });

  it("singular chip for one note", () => {
    const html = render(<AnnotationMargin annotations={[anno("a")]} busy={none} onClose={noop} />);
    expect(html).toContain("1 note");
    expect(html).not.toContain("1 notes");
  });

  it("expanded: an OPEN claim carries the two verbs — Resolve, and the labeled negative", () => {
    const html = render(<AnnotationMargin annotations={[anno("a")]} busy={none} onClose={noop} initiallyOpen />);
    expect(html).toContain("Resolve");
    expect(html).toContain("Not a real one");
    expect(html).toContain("anno-commitment");
    expect(html).toContain("Commitment");
    expect(html).toContain("scribe");
  });

  it("speaks confidence as voice, never as a number", () => {
    const html = render(<AnnotationMargin annotations={[anno("a")]} busy={none} onClose={noop} initiallyOpen />);
    expect(html).toContain("Sounds like you told Grace Monday works");
    expect(html).not.toContain("0.72");
    expect(html).not.toContain("72%");
  });

  it("a NULL rationale renders 'Why: not stated' — never invented", () => {
    const html = render(<AnnotationMargin annotations={[anno("a")]} busy={none} onClose={noop} initiallyOpen />);
    expect(html).toContain("Why: not stated");
  });

  it("a stated rationale renders verbatim", () => {
    const html = render(
      <AnnotationMargin
        annotations={[anno("a", { rationale: "“I'll get it to you Friday.”" })]}
        busy={none}
        onClose={noop}
        initiallyOpen
      />,
    );
    expect(html).toContain("Why: “I'll get it to you Friday.”");
  });

  it("a closed claim renders muted with its epitaph and NO verbs", () => {
    const html = render(
      <AnnotationMargin annotations={[anno("a", { status: "dismissed" })]} busy={none} onClose={noop} initiallyOpen />,
    );
    expect(html).toContain("anno-closed");
    expect(html).toContain("Dismissed — not a real one");
    expect(html).not.toContain('<button type="button" disabled');
    // The chip is the only button — no verb buttons inside the note.
    expect(html).not.toContain("Resolve");
  });

  it("greys the verbs after a forbidden (verbsDisabled) and while a write is in flight (busy)", () => {
    const disabled = render(
      <AnnotationMargin annotations={[anno("a")]} busy={none} verbsDisabled onClose={noop} initiallyOpen />,
    );
    expect(disabled.match(/disabled/g)?.length).toBe(2);
    const busyHtml = render(
      <AnnotationMargin annotations={[anno("a")]} busy={new Set(["a"])} onClose={noop} initiallyOpen />,
    );
    expect(busyHtml.match(/disabled/g)?.length).toBe(2);
  });

  it("surfaces a verb refusal in place", () => {
    const html = render(
      <AnnotationMargin
        annotations={[anno("a")]}
        busy={none}
        error="This session is not allowed to do that."
        onClose={noop}
        initiallyOpen
      />,
    );
    expect(html).toContain("anno-error");
    expect(html).toContain("not allowed");
  });
});

describe("PersonPanel", () => {
  it("renders nothing when nothing is open — no dead region beside the mail", () => {
    expect(render(<PersonPanel person="Grace Hopper" items={[]} />)).toBe("");
  });

  it("names the person and speaks each open item in its voice", () => {
    const html = render(
      <PersonPanel
        person="Grace Hopper"
        items={[anno("a"), anno("b", { class: "task", body: "Waiting on Grace's reply", confidence: null })]}
      />,
    );
    expect(html).toContain("Open with Grace Hopper");
    expect(html).toContain("in this thread");
    expect(html).toContain("Sounds like you told Grace Monday works");
    expect(html).toContain("Waiting on Grace's reply"); // NULL confidence asserts plainly
    expect(html).toContain("Commitment");
    expect(html).toContain("Task");
  });
});
