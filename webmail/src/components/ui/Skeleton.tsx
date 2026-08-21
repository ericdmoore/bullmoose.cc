/** @jsxImportSource preact */
import type { ComponentChildren } from "preact";
import { cx } from "../../lib/ui/classes";

/**
 * Loading placeholders (the s35 shimmer principle).
 *
 * Every realm shipped a bare string — "Loading…", "Loading agents…",
 * "Loading the queue…" — which fails twice. It tells the reader nothing about
 * what is arriving, and it collapses the content region to one line, so the
 * page visibly jumps when data lands. A skeleton holds the SHAPE instead.
 *
 * The wave itself lives in `webmail.css` (both layouts import it) rather than
 * in Tailwind utilities, because the generated CSP allows no inline styles —
 * every size here is a class.
 */
export type SkeletonVariant =
  | "title"
  | "line"
  | "line-short"
  | "meta"
  /** A card-sized region. */
  | "block"
  /** A whole message body — tall enough to hold the pane open. */
  | "body"
  | "avatar"
  | "row";

/** One placeholder shape. Decorative by definition — the announcement belongs
 *  to the surrounding `SkeletonRegion`, so a screen reader hears "Loading
 *  messages" once instead of "blank" eight times. */
export function Skeleton({ variant = "line", class: cls }: { variant?: SkeletonVariant; class?: string }) {
  return <span aria-hidden="true" class={cx("skeleton", `skeleton-${variant}`, cls)} />;
}

/** N stacked line placeholders — a paragraph that has not arrived. */
export function SkeletonLines({ count = 3, class: cls }: { count?: number; class?: string }) {
  return (
    <span class={cx("skeleton-lines", cls)}>
      {Array.from({ length: count }, (_, i) => (
        // The last line runs short, the way real prose does; a block of equal
        // bars reads as a table and mis-sets the expectation.
        <Skeleton key={i} variant={i === count - 1 ? "line-short" : "line"} />
      ))}
    </span>
  );
}

/**
 * The announced wrapper.
 *
 * `aria-busy` plus a named `role="status"` is what makes this honest to a
 * screen reader: the shapes are silent, and the region says what is coming.
 * `label` should name the CONTENT ("the message", "your contacts"), not the
 * act — "Loading…" is exactly the non-answer this component replaces.
 */
export function SkeletonRegion({
  label,
  class: cls,
  children,
}: {
  label: string;
  class?: string;
  children: ComponentChildren;
}) {
  return (
    <div role="status" aria-busy="true" aria-label={`Loading ${label}`} class={cls}>
      {children}
    </div>
  );
}
