/** @jsxImportSource preact */
import { describe, expect, it } from "vitest";
import { render } from "preact-render-to-string";
import { Avatar, Badge, Button, Column, IconButton, ListContainer, ListRow, SurfaceFrame } from "./index";
import { PlusIcon } from "../icons";

// s24 T0 — render tests, no jsdom: preact-render-to-string SSRs each stateless
// primitive to an HTML string in plain Node and we assert on the markup. This
// is exactly what stateless comps make possible — and the bar the devPlan sets
// (every primitive: a class-logic test + a render test).

describe("Button", () => {
  it("renders a <button type=button> by default", () => {
    const html = render(<Button>Save</Button>);
    expect(html).toContain("<button");
    expect(html).toContain('type="button"');
    expect(html).toContain("Save");
  });
  it("renders an <a> when given href — identical styling path", () => {
    const html = render(
      <Button href="/contacts" variant="primary">
        New contact
      </Button>,
    );
    expect(html).toContain("<a");
    expect(html).toContain('href="/contacts"');
    expect(html).toContain("bg-brand-600"); // the standardized [New] look
  });
  it("disabled renders a disabled <button>, even with href", () => {
    const html = render(
      <Button href="/x" disabled>
        New
      </Button>,
    );
    expect(html).toContain("<button");
    expect(html).toContain("disabled");
  });
});

describe("IconButton", () => {
  it("carries its label as sr-only text AND title", () => {
    const html = render(
      <IconButton label="Open sections">
        <PlusIcon class="size-5" />
      </IconButton>,
    );
    expect(html).toContain('title="Open sections"');
    expect(html).toContain('class="sr-only"');
    expect(html).toContain("Open sections");
    expect(html).toContain("<svg");
  });
});

describe("Badge / Avatar", () => {
  it("badge carries its tone classes", () => {
    expect(render(<Badge tone="accent">tier 1</Badge>)).toContain("bg-brand-100");
    expect(render(<Badge>3</Badge>)).toContain("bg-gray-100");
  });
  it("avatar shows the initial and is aria-hidden (decorative)", () => {
    const html = render(<Avatar name="eric@bullmoose.cc" />);
    expect(html).toContain(">E<");
    expect(html).toContain('aria-hidden="true"');
  });
});

describe("ListContainer / ListRow", () => {
  it("is a role=list of rows; active row carries aria-current + the selection classes", () => {
    const html = render(
      <ListContainer>
        <ListRow active onSelect={() => {}}>
          Inbox
        </ListRow>
        <ListRow onSelect={() => {}}>Archive</ListRow>
        <ListRow href="/mail?tag=x">Tagged</ListRow>
      </ListContainer>,
    );
    expect(html).toContain('role="list"');
    expect(html).toContain('aria-current="true"');
    expect(html).toContain("bg-brand-50");
    expect(html).toContain('href="/mail?tag=x"');
    // a button row and a link row coexist
    expect(html).toContain("<button");
    expect(html).toContain("<a");
  });
});

describe("Column / SurfaceFrame", () => {
  it("a Column is its own scroll context with an optional pinned header", () => {
    const html = render(
      <Column aria-label="Collections" class="w-56" header={<b>Mail</b>}>
        <p>rows</p>
      </Column>,
    );
    expect(html).toContain('aria-label="Collections"');
    expect(html).toContain("overflow-y-auto");
    expect(html).toContain("min-h-0");
    expect(html).toContain("w-56");
    expect(html).toContain("<b>Mail</b>");
  });
  it("a SurfaceFrame is the flex row the Columns sit in", () => {
    const html = render(
      <SurfaceFrame>
        <Column aria-label="a">x</Column>
        <Column aria-label="b">y</Column>
      </SurfaceFrame>,
    );
    expect(html.match(/<section/g)).toHaveLength(2);
    expect(html).toContain("flex h-full min-h-0 w-full");
  });
});
