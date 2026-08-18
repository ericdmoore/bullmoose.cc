/** @jsxImportSource preact */
import type { ComponentChildren } from "preact";
import { cx } from "../../lib/ui/classes";

/** The columns row a quad-panel surface lays its Columns in (s24 T0). Pairs
 *  with AppTw's frame="surface" (exactly one viewport tall): the frame fills
 *  it, the Columns inside scroll themselves. Below lg it stacks and scrolls
 *  as one (s25 T1): three fixed-width columns in a row at 390px leave the
 *  content column ~0 wide — on a phone the quad is a stack until the realm
 *  adopts the T3 list⇄detail navigation. */
export default function SurfaceFrame({ class: cls, children }: { class?: string; children: ComponentChildren }) {
  return <div class={cx("flex h-full min-h-0 w-full max-lg:flex-col max-lg:overflow-y-auto", cls)}>{children}</div>;
}
