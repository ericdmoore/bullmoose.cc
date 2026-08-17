import { describe, expect, it } from "vitest";
import { computeWindow, scrollToIndex, shouldLoadMore } from "./virtual";

const BASE = { rowHeight: 40, viewportHeight: 400, count: 1000, overscan: 6 };

describe("computeWindow", () => {
  it("renders a window, not the whole list", () => {
    const w = computeWindow({ ...BASE, scrollTop: 0 });
    expect(w.start).toBe(0);
    expect(w.end).toBeLessThan(BASE.count);
    // 10 visible rows + 1 sliver + 6 overscan.
    expect(w.end).toBe(17);
  });

  it("keeps total height constant through the spacers", () => {
    const w = computeWindow({ ...BASE, scrollTop: 4000 });
    const rendered = (w.end - w.start) * BASE.rowHeight;
    expect(w.topPad + rendered + w.bottomPad).toBe(BASE.count * BASE.rowHeight);
  });

  it("overscans above and below once scrolled into the middle", () => {
    const w = computeWindow({ ...BASE, scrollTop: 4000 });
    expect(w.start).toBe(100 - 6);
    expect(w.topPad).toBe((100 - 6) * 40);
    expect(w.bottomPad).toBeGreaterThan(0);
  });

  it("clamps at the end of the list rather than overrunning it", () => {
    const w = computeWindow({ ...BASE, scrollTop: 999_999 });
    expect(w.end).toBe(BASE.count);
    expect(w.bottomPad).toBe(0);
  });

  it("clamps a negative scrollTop (rubber-band scrolling) to the top", () => {
    const w = computeWindow({ ...BASE, scrollTop: -200 });
    expect(w.start).toBe(0);
    expect(w.topPad).toBe(0);
  });

  it("renders nothing for an empty list", () => {
    expect(computeWindow({ ...BASE, count: 0, scrollTop: 0 })).toEqual({
      start: 0,
      end: 0,
      topPad: 0,
      bottomPad: 0,
    });
  });

  it("does not divide by a zero row height", () => {
    expect(computeWindow({ ...BASE, rowHeight: 0, scrollTop: 0 }).end).toBe(0);
  });

  it("covers a viewport taller than the whole list", () => {
    const w = computeWindow({ rowHeight: 40, viewportHeight: 1000, count: 5, scrollTop: 0 });
    expect(w.start).toBe(0);
    expect(w.end).toBe(5);
  });
});

describe("scrollToIndex", () => {
  it("leaves the scroll alone when the row is already visible", () => {
    expect(scrollToIndex(5, { scrollTop: 0, viewportHeight: 400, rowHeight: 40, count: 100 })).toBe(
      0,
    );
  });

  it("scrolls up by the minimum to reveal a row above the viewport", () => {
    expect(
      scrollToIndex(2, { scrollTop: 400, viewportHeight: 400, rowHeight: 40, count: 100 }),
    ).toBe(80);
  });

  it("scrolls down by the minimum to reveal a row below the viewport", () => {
    // Row 12 ends at 520; the viewport shows 0–400, so scroll to 120.
    expect(
      scrollToIndex(12, { scrollTop: 0, viewportHeight: 400, rowHeight: 40, count: 100 }),
    ).toBe(120);
  });

  it("never scrolls past the end", () => {
    expect(
      scrollToIndex(99, { scrollTop: 0, viewportHeight: 400, rowHeight: 40, count: 100 }),
    ).toBe(3600);
  });

  it("clamps an out-of-range index", () => {
    expect(
      scrollToIndex(-5, { scrollTop: 200, viewportHeight: 400, rowHeight: 40, count: 100 }),
    ).toBe(0);
    expect(
      scrollToIndex(500, { scrollTop: 0, viewportHeight: 400, rowHeight: 40, count: 100 }),
    ).toBe(3600);
  });

  it("returns 0 for an empty list", () => {
    expect(scrollToIndex(0, { scrollTop: 0, viewportHeight: 400, rowHeight: 40, count: 0 })).toBe(
      0,
    );
  });
});

describe("shouldLoadMore", () => {
  it("asks for the next page as the window nears the loaded end", () => {
    expect(shouldLoadMore({ end: 45 }, 50, 1000)).toBe(true);
  });

  it("does not ask while the window is far from the end", () => {
    expect(shouldLoadMore({ end: 17 }, 50, 1000)).toBe(false);
  });

  it("stops once everything is loaded", () => {
    expect(shouldLoadMore({ end: 50 }, 50, 50)).toBe(false);
  });

  it("asks when the total is not known yet", () => {
    expect(shouldLoadMore({ end: 45 }, 50, undefined)).toBe(true);
  });
});
