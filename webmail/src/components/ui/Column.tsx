/** @jsxImportSource preact */
import type { ComponentChildren } from "preact";
import { cx } from "../../lib/ui/classes";

// One panel of a multi-column surface (s24 T0): its own scroll context inside
// a SurfaceFrame (min-h-0 + overflow-y-auto is what makes "panes scroll
// themselves" true under frame="surface"). Width comes from the caller via
// `class` — discrete Tailwind width classes, never inline style (CSP).

export default function Column({
  class: cls,
  header,
  "aria-label": ariaLabel,
  children,
}: {
  class?: string;
  header?: ComponentChildren;
  "aria-label"?: string;
  children: ComponentChildren;
}) {
  return (
    <section class={cx("flex h-full min-h-0 min-w-0 flex-col", cls)} aria-label={ariaLabel}>
      {header ? <div class="shrink-0">{header}</div> : null}
      <div class="min-h-0 grow overflow-y-auto">{children}</div>
    </section>
  );
}
