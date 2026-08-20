/** @jsxImportSource preact */
import { describe, expect, it } from "vitest";
import { render } from "preact-render-to-string";
import {
  Alert,
  Avatar,
  Badge,
  Breadcrumb,
  Button,
  Column,
  DescList,
  DescRow,
  EmptyState,
  IconButton,
  ListContainer,
  ListRow,
  PageNotice,
  StackedList,
  StackedRow,
  SurfaceFrame,
} from "./index";
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
  it("active is aria-current and the selection wash", () => {
    const html = render(
      <IconButton label="Inbox" active>
        <PlusIcon class="size-4" />
      </IconButton>,
    );
    expect(html).toContain('aria-current="true"');
    expect(html).toContain("bg-brand-50");
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
    // s25 T1: below lg the row stacks and scrolls as one — three fixed-width
    // columns beside each other at 390px is the audit's crushing bug.
    expect(html).toContain("max-lg:flex-col");
    expect(html).toContain("max-lg:overflow-y-auto");
  });
});

describe("Alert / EmptyState / StackedList / DescList / Breadcrumb", () => {
  it("an alert is a role=alert with its title", () => {
    const html = render(
      <Alert tone="warn" title="Attention needed">
        Fix the due date.
      </Alert>,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Attention needed");
    expect(html).toContain("Fix the due date.");
    expect(html).toContain("bg-yellow-50");
  });
  it("empty state carries the title and optional action", () => {
    const html = render(
      <EmptyState title="No projects" action={<Button variant="primary">New</Button>}>
        Get started.
      </EmptyState>,
    );
    expect(html).toContain("No projects");
    expect(html).toContain("Get started.");
    expect(html).toContain("New");
  });
  it("stacked rows are links or buttons, with aria-current when active", () => {
    const html = render(
      <StackedList>
        <StackedRow href="/approvals?p=1" active>
          Waiting
        </StackedRow>
        <StackedRow onSelect={() => {}}>Held</StackedRow>
      </StackedList>,
    );
    expect(html).toContain('role="list"');
    expect(html).toContain("divide-y");
    expect(html).toContain('href="/approvals?p=1"');
    expect(html).toContain('aria-current="true"');
    expect(html).toContain("<button");
  });
  it("a description list is a dl of term/value pairs", () => {
    const html = render(
      <DescList title="Applicant">
        <DescRow term="Full name">Margot</DescRow>
      </DescList>,
    );
    expect(html).toContain("<dl");
    expect(html).toContain("<dt");
    expect(html).toContain("Full name");
    expect(html).toContain("Margot");
  });
  it("breadcrumb current step is a span; earlier steps are buttons", () => {
    const html = render(
      <Breadcrumb
        items={[
          { label: "Files", onSelect: () => {} },
          { label: "Projects", current: true },
        ]}
      />,
    );
    expect(html).toContain('aria-label="Breadcrumb"');
    expect(html).toContain("<button");
    expect(html).toContain("Projects");
    expect(html).toContain('aria-current="page"');
  });
  it("a current step with onSelect is a button — the Mail folder bar opens a picker", () => {
    const html = render(
      <Breadcrumb
        items={[
          { label: "Mail", onSelect: () => {} },
          { label: "Archive", current: true, onSelect: () => {} },
        ]}
      />,
    );
    expect(html).toContain("Archive</button>");
    expect(html).toContain('aria-current="page"');
  });
  it("PageNotice is a reading column, not a second H1", () => {
    const html = render(<PageNotice title="No files here">This session has no Files realm.</PageNotice>);
    expect(html).toContain("<h2");
    expect(html).not.toContain("<h1");
    expect(html).toContain("No files here");
  });
});
