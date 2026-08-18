/** @jsxImportSource preact */
import { describe, expect, it } from "vitest";
import { render } from "preact-render-to-string";
import * as icons from "./index";

// s24 T0 — the icon library renders real, accessible, class-driven SVG. One
// sweep over every exported glyph beats one test per file: a new icon is
// covered the moment it is exported.

const GLYPHS = Object.entries(icons).filter(([name]) => name.endsWith("Icon")) as Array<
  [string, (p: { class?: string }) => unknown]
>;

describe("every exported icon", () => {
  it("exports at least the ShellNav set", () => {
    expect(GLYPHS.length).toBeGreaterThanOrEqual(14);
  });

  it.each(GLYPHS.map(([n]) => n))("%s renders an aria-hidden svg taking size via class", (name) => {
    const Icon = icons[name as keyof typeof icons] as (p: { class?: string }) => never;
    const html = render(<Icon class="size-5" />);
    expect(html).toContain("<svg");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('class="size-5"');
    expect(html).toContain("<path");
    expect(html).not.toContain("style="); // class-driven, never inline style (CSP)
  });

  it("outline icons stroke; the Mini chevron fills", () => {
    expect(render(<icons.EnvelopeIcon class="x" />)).toContain('stroke="currentColor"');
    expect(render(<icons.ChevronDownMiniIcon class="x" />)).toContain('fill="currentColor"');
  });

  it("strokeWidth is overridable where a call site needs it (the collapse chevron)", () => {
    expect(render(<icons.ChevronDoubleLeftIcon class="x" strokeWidth={2} />)).toContain('stroke-width="2"');
  });
});
