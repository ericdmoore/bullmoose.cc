// List virtualization — the windowing MATH, kept pure and away from the DOM.
//
// The thread list has to survive a 50k-message mailbox, which means rendering a
// window rather than the whole list. All of the arithmetic that can be wrong
// lives here so it can be unit-tested in plain Node (vitest runs
// `environment: "node"`); the component contributes only a scroll listener and
// two spacer divs.

export interface WindowSpec {
  scrollTop: number;
  viewportHeight: number;
  /** Fixed row height. A uniform list is what makes O(1) windowing possible. */
  rowHeight: number;
  /** Total rows, including ones not yet loaded. */
  count: number;
  /** Rows rendered beyond each edge, to hide scroll latency. Default 6. */
  overscan?: number;
}

export interface WindowResult {
  /** First rendered index, inclusive. */
  start: number;
  /** Last rendered index, EXCLUSIVE — slice-compatible. */
  end: number;
  /** Spacer height above the window, in px. */
  topPad: number;
  /** Spacer height below the window, in px. */
  bottomPad: number;
}

export function computeWindow(spec: WindowSpec): WindowResult {
  const { rowHeight, count } = spec;
  const overscan = spec.overscan ?? 6;

  if (count <= 0 || rowHeight <= 0) return { start: 0, end: 0, topPad: 0, bottomPad: 0 };

  const scrollTop = clamp(spec.scrollTop, 0, Math.max(0, count * rowHeight - spec.viewportHeight));
  const viewport = Math.max(0, spec.viewportHeight);

  const firstVisible = Math.floor(scrollTop / rowHeight);
  // +1 because a viewport that is not row-aligned shows a sliver of one more.
  const visibleRows = Math.ceil(viewport / rowHeight) + 1;

  const start = clamp(firstVisible - overscan, 0, count);
  const end = clamp(firstVisible + visibleRows + overscan, start, count);

  return {
    start,
    end,
    topPad: start * rowHeight,
    bottomPad: (count - end) * rowHeight,
  };
}

/**
 * The scrollTop that brings `index` into view with the least movement — the
 * keyboard-navigation counterpart to `computeWindow`. Returns the CURRENT
 * scrollTop when the row is already fully visible, so `j`/`k` do not jitter the
 * list on every keystroke.
 */
export function scrollToIndex(
  index: number,
  spec: Pick<WindowSpec, "scrollTop" | "viewportHeight" | "rowHeight" | "count">,
): number {
  const { rowHeight, viewportHeight, scrollTop, count } = spec;
  if (count <= 0 || rowHeight <= 0) return 0;

  const i = clamp(index, 0, count - 1);
  const top = i * rowHeight;
  const bottom = top + rowHeight;
  const maxScroll = Math.max(0, count * rowHeight - viewportHeight);

  if (top < scrollTop) return clamp(top, 0, maxScroll);
  if (bottom > scrollTop + viewportHeight) {
    return clamp(bottom - viewportHeight, 0, maxScroll);
  }
  return clamp(scrollTop, 0, maxScroll);
}

/**
 * Should the next page be requested? True once the window is within
 * `threshold` rows of the loaded end AND there is more on the server.
 */
export function shouldLoadMore(
  window: Pick<WindowResult, "end">,
  loaded: number,
  total: number | undefined,
  threshold = 10,
): boolean {
  if (total !== undefined && loaded >= total) return false;
  return window.end + threshold >= loaded;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}
