// Snapping a drag to a set of allowed widths.
//
// PURE, and shared: the nav rail (ShellNav) and the mail list column (AppShell)
// both resize by dragging, and both must land on a Tailwind class rather than
// an inline `style` — the generated CSP carries no 'unsafe-inline' for styles,
// so a computed pixel width is not expressible. Steps are what make that work:
// the drag chooses among a handful of classes instead of producing a number.
//
// "Within reason" is therefore literal. There is no continuous range and no
// pane can be dragged to nothing.

/** One allowed width: the pixel value the drag snaps to, and the classes that
 *  express it. Callers keep their own list because the classes differ. */
export interface WidthStep {
  px: number;
  /** The Tailwind width class for the pane itself. */
  w: string;
}

/**
 * Which step is nearest to a dragged pixel width.
 *
 * ⚠️ Takes a WIDTH, not a pointer position. The rail can pass `clientX`
 * directly because it is anchored at x=0; the list column cannot — it begins
 * after a rail whose own width the reader may have changed. Passing a raw
 * clientX there snaps to the wrong step by exactly the rail's width, which
 * looks like the drag "sticking" a step behind the pointer. The caller
 * subtracts the pane's left edge; this function never guesses at layout.
 */
export function nearestStep(width: number, steps: readonly WidthStep[]): number {
  if (steps.length === 0) return 0;
  let best = 0;
  for (let i = 1; i < steps.length; i++) {
    if (Math.abs(steps[i]!.px - width) < Math.abs(steps[best]!.px - width)) best = i;
  }
  return best;
}

/** Read a stored step index, clamped into range. A stored value from an older
 *  build with more steps must not index past the end. */
export function readStep(key: string, steps: readonly WidthStep[], fallback: number): number {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (raw === null || raw === undefined) return fallback;
    const n = Number.parseInt(raw, 10);
    if (!Number.isInteger(n) || n < 0 || n >= steps.length) return fallback;
    return n;
  } catch {
    return fallback;
  }
}

/** Persist a step. A preference is a nicety: a browser that refuses storage
 *  keeps working, it just forgets. */
export function writeStep(key: string, step: number): void {
  try {
    globalThis.localStorage?.setItem(key, String(step));
  } catch {
    /* nicety, not a requirement */
  }
}
