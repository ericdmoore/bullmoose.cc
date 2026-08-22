import { describe, expect, it, vi } from "vitest";
import { nearestStep, readStep, writeStep, type WidthStep } from "./resizable";

const STEPS: WidthStep[] = [
  { px: 320, w: "lg:w-80" },
  { px: 384, w: "lg:w-96" },
  { px: 448, w: "lg:w-[28rem]" },
];

describe("nearestStep", () => {
  it("1. snaps to the closest allowed width", () => {
    expect(nearestStep(318, STEPS)).toBe(0);
    expect(nearestStep(400, STEPS)).toBe(1);
    expect(nearestStep(9999, STEPS)).toBe(2);
    expect(nearestStep(-50, STEPS)).toBe(0);
  });

  it("2. takes a WIDTH, not a pointer position", () => {
    // The distinction that matters: the rail is anchored at x=0 so clientX IS
    // its width, but the list column begins after a rail the reader may have
    // resized. Handing this function a raw clientX there snaps a step wide by
    // exactly the rail's width, which reads as the drag lagging the pointer.
    // Documented as a test so the next caller subtracts the pane's left edge.
    const RAIL = 288;
    const pointer = 672; // reader wants a 384px column beside a 288px rail
    expect(nearestStep(pointer, STEPS)).toBe(2); // wrong — the naive call
    expect(nearestStep(pointer - RAIL, STEPS)).toBe(1); // right
  });

  it("3. an empty step list cannot throw", () => {
    expect(nearestStep(100, [])).toBe(0);
  });
});

describe("readStep", () => {
  const withStore = (value: string | null) =>
    vi.stubGlobal("localStorage", { getItem: () => value, setItem: () => {} });

  it("10. reads a stored step", () => {
    withStore("2");
    expect(readStep("k", STEPS, 1)).toBe(2);
  });

  it("11. a value from a build with MORE steps falls back, never indexes past the end", () => {
    // The upgrade case: shipping fewer steps must not leave a reader with a
    // stored index that resolves to undefined and renders no width class.
    withStore("7");
    expect(readStep("k", STEPS, 1)).toBe(1);
  });

  it("12. garbage, negatives and absence all fall back", () => {
    for (const v of ["", "abc", "-1", "1.5", null]) {
      withStore(v);
      expect(readStep("k", STEPS, 1), String(v)).toBe(1);
    }
  });

  it("13. a browser that refuses storage still renders", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("SecurityError");
      },
    });
    expect(readStep("k", STEPS, 1)).toBe(1);
    expect(() => writeStep("k", 2)).not.toThrow();
  });
});
