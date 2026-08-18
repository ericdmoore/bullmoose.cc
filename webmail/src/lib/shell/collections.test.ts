import { describe, expect, it } from "vitest";
import { ensureSelection, flattenItems, stepSelection, type CollectionGroup } from "./collections";

// s24 T1 — the selection model. The properties that matter: selection is
// always valid (the approvals self-repair, generalized), and keyboard order is
// visual order across group boundaries.

const GROUPS: CollectionGroup[] = [
  {
    id: "g1",
    label: "Live",
    items: [
      { id: "a", label: "A" },
      { id: "b", label: "B", count: 3 },
    ],
  },
  { id: "g2", label: "Views", items: [{ id: "c", label: "C", muted: true }] },
];

describe("flattenItems", () => {
  it("is visual order across groups", () => {
    expect(flattenItems(GROUPS).map((i) => i.id)).toEqual(["a", "b", "c"]);
  });
});

describe("ensureSelection — always valid", () => {
  it("keeps a valid id, repairs an unknown one to the first, and empties to undefined", () => {
    expect(ensureSelection(GROUPS, "b")).toBe("b");
    expect(ensureSelection(GROUPS, "ghost")).toBe("a");
    expect(ensureSelection(GROUPS, undefined)).toBe("a");
    expect(ensureSelection([], "a")).toBeUndefined();
    expect(ensureSelection([{ id: "g", items: [] }], "a")).toBeUndefined();
  });
});

describe("stepSelection — ArrowUp/Down, clamped, crossing groups", () => {
  it("steps in visual order and crosses the group boundary", () => {
    expect(stepSelection(GROUPS, "a", 1)).toBe("b");
    expect(stepSelection(GROUPS, "b", 1)).toBe("c"); // g1 → g2
    expect(stepSelection(GROUPS, "c", -1)).toBe("b");
  });
  it("clamps at the ends rather than wrapping", () => {
    expect(stepSelection(GROUPS, "a", -1)).toBe("a");
    expect(stepSelection(GROUPS, "c", 1)).toBe("c");
  });
  it("recovers from an invalid selection", () => {
    expect(stepSelection(GROUPS, "ghost", 1)).toBe("a");
    expect(stepSelection([], "a", 1)).toBeUndefined();
  });
});
