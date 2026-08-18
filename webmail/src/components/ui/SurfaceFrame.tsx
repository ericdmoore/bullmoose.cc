/** @jsxImportSource preact */
import type { ComponentChildren } from "preact";
import { cx } from "../../lib/ui/classes";

/** The columns row a quad-panel surface lays its Columns in (s24 T0). Pairs
 *  with AppTw's frame="surface" (exactly one viewport tall): the frame fills
 *  it, the Columns inside scroll themselves. */
export default function SurfaceFrame({ class: cls, children }: { class?: string; children: ComponentChildren }) {
  return <div class={cx("flex h-full min-h-0 w-full", cls)}>{children}</div>;
}
