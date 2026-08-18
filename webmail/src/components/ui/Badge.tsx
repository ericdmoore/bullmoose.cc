/** @jsxImportSource preact */
import type { ComponentChildren } from "preact";
import { badgeClasses, cx, type BadgeTone } from "../../lib/ui/classes";

/** A small labelled chip — tier pills, counts, statuses (s24 T0). */
export default function Badge({
  tone = "neutral",
  class: cls,
  children,
}: {
  tone?: BadgeTone;
  class?: string;
  children: ComponentChildren;
}) {
  return <span class={cx(badgeClasses(tone), cls)}>{children}</span>;
}
