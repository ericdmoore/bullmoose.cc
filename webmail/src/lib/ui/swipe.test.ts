import { describe, expect, it } from "vitest";
import {
  ACTION_PX,
  AXIS_SLOP,
  beginDrag,
  extendDrag,
  offsetClass,
  openWidth,
  settleDrag,
  swipeActionClasses,
  swipeRowClasses,
  swipeShellClasses,
} from "./swipe";

// s25 T6 — the gesture, driven. Every rule of the tap-vs-swipe contract that
// can be tested WITHOUT a DOM is tested here, because the component half is a
// render test and cannot dispatch pointer events (no jsdom, by house rule).
// What that leaves for review is the wiring; what is pinned here is the
// behaviour that decides whether a link still works.

const drag = (from = 0, min = -160) => beginDrag("T1", 100, 200, from, min);

describe("axis: the browser keeps vertical", () => {
  it("is undecided until the finger has travelled AXIS_SLOP", () => {
    const d = extendDrag(drag(), 100 + AXIS_SLOP - 1, 200);
    expect(d.axis).toBe("undecided");
    expect(d.offset).toBe(0);
    expect(d.moved).toBe(false);
  });

  it("claims horizontal when the movement is mostly sideways", () => {
    const d = extendDrag(drag(), 60, 205);
    expect(d.axis).toBe("horizontal");
    expect(d.offset).toBe(-40);
    expect(d.moved).toBe(true);
  });

  it("yields to a vertical gesture and never moves the row", () => {
    const d = extendDrag(drag(), 105, 260);
    expect(d.axis).toBe("vertical");
    expect(d.offset).toBe(0);
    expect(d.moved).toBe(false);
  });

  it("decides ONCE — a vertical gesture that later wanders sideways stays vertical", () => {
    let d = extendDrag(drag(), 105, 260);
    d = extendDrag(d, 20, 265);
    expect(d.axis).toBe("vertical");
    expect(d.offset).toBe(0);
  });
});

describe("offset", () => {
  it("clamps to the open width — a row never slides past its actions", () => {
    expect(extendDrag(drag(), -500, 200).offset).toBe(-160);
  });

  it("never slides RIGHT past closed", () => {
    expect(extendDrag(drag(), 400, 200).offset).toBe(0);
  });

  it("a drag that starts open is measured from open", () => {
    const d = extendDrag(drag(-160), 140, 200);
    expect(d.offset).toBe(-120);
  });

  it("`moved` latches: returning to the start does not turn a swipe back into a tap", () => {
    let d = extendDrag(drag(), 40, 200);
    d = extendDrag(d, 100, 200);
    expect(d.offset).toBe(0);
    expect(d.moved).toBe(true);
  });
});

describe("settle: two resting positions, and the click verdict", () => {
  it("past halfway settles open", () => {
    expect(settleDrag(extendDrag(drag(), 100 - 90, 200)).open).toBe(true);
  });

  it("short of halfway snaps shut", () => {
    expect(settleDrag(extendDrag(drag(), 100 - 60, 200)).open).toBe(false);
  });

  it("halfway is measured against the ACTUAL open width, not a constant", () => {
    // One action (no Trash mailbox): open is 80px, so 50px is past halfway.
    expect(settleDrag(extendDrag(drag(0, -80), 50, 200)).open).toBe(true);
  });

  it("with no actions there is nothing to open", () => {
    expect(settleDrag(extendDrag(drag(0, 0), -500, 200)).open).toBe(false);
  });

  it("suppresses the trailing click exactly when the finger swiped", () => {
    expect(settleDrag(extendDrag(drag(), 40, 200)).suppressClick).toBe(true);
    // A tap: under the slop, nothing suppressed — the anchor navigates.
    expect(settleDrag(extendDrag(drag(), 103, 202)).suppressClick).toBe(false);
    expect(settleDrag(extendDrag(drag(), 100, 260)).suppressClick).toBe(false);
  });
});

describe("classes: the CSP-safe half", () => {
  it("snaps the offset to a discrete translate class", () => {
    expect(offsetClass(0)).toBe("translate-x-0");
    expect(offsetClass(-80)).toBe("-translate-x-20");
    expect(offsetClass(-160)).toBe("-translate-x-40");
    // Between steps, the nearest one.
    expect(offsetClass(-75)).toBe("-translate-x-20");
    // Beyond the range, clamped by the nearest-step search.
    expect(offsetClass(-9999)).toBe("-translate-x-40");
  });

  it("covers both open widths exactly, so a resting row has no sliver showing", () => {
    expect(offsetClass(-openWidth(1))).toBe("-translate-x-20");
    expect(offsetClass(-openWidth(2))).toBe("-translate-x-40");
  });

  it("animates on release and not while a finger is down", () => {
    expect(swipeRowClasses(-80, true)).toContain("transition-transform");
    expect(swipeRowClasses(-80, false)).not.toContain("transition-transform");
  });

  it("the shell clips the actions and leaves vertical panning to the browser", () => {
    expect(swipeShellClasses()).toContain("overflow-hidden");
    expect(swipeShellClasses()).toContain("touch-pan-y");
  });

  it("an action is ACTION_PX wide, and danger reads as danger", () => {
    expect(ACTION_PX).toBe(80);
    expect(swipeActionClasses("neutral")).toContain("w-20");
    expect(swipeActionClasses("danger")).toContain("bg-red-600");
    expect(swipeActionClasses("neutral")).not.toContain("bg-red-600");
  });

  it("no class string ever carries an inline style (CSP)", () => {
    for (const s of [
      swipeRowClasses(-40, true),
      swipeShellClasses(),
      swipeActionClasses("danger"),
      offsetClass(-120),
    ]) {
      expect(s).not.toMatch(/style|:\s*-?\d+px/);
    }
  });
});

describe("openWidth", () => {
  it("scales with the number of revealed verbs", () => {
    expect(openWidth(0)).toBe(0);
    expect(openWidth(1)).toBe(ACTION_PX);
    expect(openWidth(2)).toBe(ACTION_PX * 2);
  });
});
