// s25 T6 — swipe triage, the pure half. MAIL ONLY, deliberately: the sprint
// plan REFUSES this for Approvals, because a decision queue's ethos is
// deliberateness and a flick that fires a tier-2 send is the wrong affordance.
// Nothing here knows what mail is, but nothing else imports it either.
//
// ## The interaction contract (the whole reason this file exists)
//
// Since #194 a thread row's body is a real `<a href="/mail?thread=…">`, so a
// gesture layered on top has to share the element with a link. The rules:
//
//   TAP      → the anchor navigates, natively. We never call preventDefault on
//              a click that did not move, and we never synthesize navigation.
//   SWIPE    → reveals triage actions and NOTHING ELSE. The click that would
//              have followed is suppressed (`suppressClick`), because a finger
//              that travelled 90px was not pointing at a link.
//   SCROLL   → belongs to the browser. The row declares `touch-action: pan-y`,
//              so vertical panning never reaches this model at all; the axis
//              decision below is the second guard, for pointers that ignore it.
//
// The axis is decided ONCE, at `AXIS_SLOP`, and never revisited. A gesture
// that starts vertical stays vertical for its whole life even if the finger
// later wanders sideways — re-deciding mid-drag is how a list becomes
// impossible to scroll near its rows.
//
// Nothing in this file commits an action. The gesture REVEALS; a deliberate
// tap on a labelled button commits. That two-step is the "confirmed" half of
// the plan's undoable-or-confirmed rule — a flick alone can never file mail.
//
// ## Why discrete steps
//
// The row cannot follow the finger continuously: that needs
// `style="transform:…"` per frame, and this app's generated CSP carries a
// `style-src` with no 'unsafe-inline' on purpose (ShellNav.tsx). So the offset
// SNAPS to one of five translate classes — the same trade the rail's
// drag-resize already makes (ShellNav's `WIDTHS`). At 40px granularity a
// thumb reads it as continuous.

import { cx } from "./classes";

/** Movement (px) before a gesture claims an axis. Below this everything is
 *  still a tap, and the anchor keeps its click. */
export const AXIS_SLOP = 10;

/** Width of one revealed action button (`w-20`). The resting open offset is
 *  this times the number of actions, so a realm with no Trash mailbox opens
 *  half as far instead of showing a gap. */
export const ACTION_PX = 80;

export type SwipeAxis = "undecided" | "horizontal" | "vertical";

export interface SwipeDrag {
  /** Which row is being dragged — one at a time, by construction. */
  readonly id: string;
  readonly startX: number;
  readonly startY: number;
  /** The resting offset this drag began from: 0 (closed) or `min` (open). */
  readonly from: number;
  /** How far left the row may travel, as a negative px offset. */
  readonly min: number;
  /** Where the row sits now, clamped to [min, 0]. */
  readonly offset: number;
  readonly axis: SwipeAxis;
  /** True once the finger has travelled far enough horizontally that the
   *  release is NOT a tap. The click suppressor reads exactly this. */
  readonly moved: boolean;
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** Open width for `n` revealed actions — zero actions never opens. */
export function openWidth(actionCount: number): number {
  return actionCount * ACTION_PX;
}

export function beginDrag(id: string, x: number, y: number, from = 0, min = -openWidth(2)): SwipeDrag {
  return {
    id,
    startX: x,
    startY: y,
    from,
    min: Math.min(0, min),
    offset: clamp(from, Math.min(0, min), 0),
    axis: "undecided",
    moved: false,
  };
}

/**
 * Advance a drag. Returns a NEW drag — the caller holds it in state, so this
 * stays a reducer and tests read as a sequence of moves.
 *
 * A vertical gesture is inert: the offset never leaves where it started, so
 * the row does not twitch while the list scrolls under the finger.
 */
export function extendDrag(drag: SwipeDrag, x: number, y: number): SwipeDrag {
  const dx = x - drag.startX;
  const dy = y - drag.startY;

  let axis = drag.axis;
  if (axis === "undecided" && Math.max(Math.abs(dx), Math.abs(dy)) >= AXIS_SLOP) {
    axis = Math.abs(dx) > Math.abs(dy) ? "horizontal" : "vertical";
  }
  if (axis !== "horizontal") return { ...drag, axis };

  return {
    ...drag,
    axis,
    offset: clamp(drag.from + dx, drag.min, 0),
    // `moved` latches: once a drag has been a swipe it never turns back into a
    // tap, even if the finger returns to where it started.
    moved: drag.moved || Math.abs(dx) >= AXIS_SLOP,
  };
}

/**
 * Release. Past halfway the row settles OPEN, otherwise it snaps shut — the
 * only two resting positions, so a row is never left in a state the keyboard
 * cannot describe.
 */
export function settleDrag(drag: SwipeDrag): { open: boolean; suppressClick: boolean } {
  return {
    open: drag.min < 0 && drag.offset <= drag.min / 2,
    suppressClick: drag.moved,
  };
}

/**
 * The offset as a translate CLASS — five steps, 40px apart, covering both the
 * one-action (-80) and two-action (-160) open widths exactly.
 */
const STEPS: ReadonlyArray<{ px: number; cls: string }> = [
  { px: 0, cls: "translate-x-0" },
  { px: -40, cls: "-translate-x-10" },
  { px: -80, cls: "-translate-x-20" },
  { px: -120, cls: "-translate-x-30" },
  { px: -160, cls: "-translate-x-40" },
];

export function offsetClass(px: number): string {
  let best = STEPS[0]!;
  for (const step of STEPS) {
    if (Math.abs(step.px - px) < Math.abs(best.px - px)) best = step;
  }
  return best.cls;
}

/**
 * The sliding container: the row and its actions travel together, so the
 * actions live OFF-SCREEN to the right (clipped by the shell) rather than
 * underneath the row. That means the row needs no opaque background of its
 * own — which is what kept `.thread-row`'s hover/cursor/selected treatments
 * (webmail.css) working unchanged through the swipe.
 *
 * `animating` is false while a finger is down (the row tracks the thumb) and
 * true on release (it glides to its resting step).
 */
export function swipeRowClasses(offsetPx: number, animating: boolean): string {
  return cx("flex h-full w-full", animating && "transition-transform duration-150 ease-out", offsetClass(offsetPx));
}

/** The shell that clips the actions until they are swiped into view.
 *  `touch-pan-y` is the contract's first guard: the browser keeps vertical
 *  scrolling and hands us the horizontal axis. */
export function swipeShellClasses(): string {
  return "relative w-full touch-pan-y overflow-hidden";
}

export type SwipeTone = "neutral" | "danger";

/** A revealed action. `w-20` is `ACTION_PX` — the two must agree or the row
 *  rests with a sliver of the second button showing. */
export function swipeActionClasses(tone: SwipeTone): string {
  return cx(
    "flex w-20 shrink-0 flex-col items-center justify-center gap-y-1 text-xs font-semibold text-white",
    tone === "danger" ? "bg-red-600 hover:bg-red-500" : "bg-gray-600 hover:bg-gray-500",
  );
}
