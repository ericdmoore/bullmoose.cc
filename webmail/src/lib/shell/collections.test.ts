import { describe, expect, it } from "vitest";
import {
  ensureSelection,
  findItem,
  flattenItems,
  iconRailItems,
  stepSelection,
  toggleExpansion,
  type CollectionGroup,
  type CollectionItem,
} from "./collections";

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

describe("iconRailItems", () => {
  const Icon = (() => null) as unknown as CollectionItem["icon"];
  const withIcons: CollectionGroup[] = [
    {
      id: "g",
      items: [
        { id: "inbox", label: "Inbox", icon: Icon },
        { id: "plain", label: "No glyph" },
        { id: "junk", label: "Junk", icon: Icon, disabled: true, reason: "planned" },
      ],
    },
  ];
  it("keeps only selectable items that carry a glyph", () => {
    expect(iconRailItems(withIcons).map((i) => i.id)).toEqual(["inbox"]);
  });
});

describe("findItem", () => {
  it("finds a top-level item and a child, and misses the unknown", () => {
    expect(findItem(GROUPS, "b")?.label).toBe("B");
    expect(findItem(GROUPS, "ghost")).toBeUndefined();
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

// ── s25 T2 — the tree: one level of children, expansion as an input, and the
// planned-row idiom (disabled + reason) skipped by selection. ─────────────

const TREE: CollectionGroup[] = [
  {
    id: "g1",
    label: "Queue",
    items: [
      { id: "pending", label: "Waiting on you", count: 3 },
      {
        id: "by-agent",
        label: "By agent",
        children: [
          { id: "agent-allen", label: "Allen", count: 2 },
          { id: "agent-piper", label: "Piper", count: 1 },
        ],
      },
      { id: "held", label: "Hold tray" },
    ],
  },
  {
    id: "g2",
    label: "Views",
    items: [{ id: "planned", label: "High cost", disabled: true, reason: "coming with cost data" }],
  },
];

describe("flattenItems — expansion state is an input", () => {
  it("hides children by default (the s24 callers pass nothing and see no change)", () => {
    expect(flattenItems(TREE).map((i) => i.id)).toEqual(["pending", "by-agent", "held", "planned"]);
  });
  it("findItem still sees a child whose parent is collapsed", () => {
    expect(findItem(TREE, "agent-allen")?.label).toBe("Allen");
  });
  it("an expanded parent's children follow it in visual order", () => {
    expect(flattenItems(TREE, new Set(["by-agent"])).map((i) => i.id)).toEqual([
      "pending",
      "by-agent",
      "agent-allen",
      "agent-piper",
      "held",
      "planned",
    ]);
  });
  it("an id in the set with no children is inert", () => {
    expect(flattenItems(TREE, new Set(["pending", "ghost"])).map((i) => i.id)).toEqual([
      "pending",
      "by-agent",
      "held",
      "planned",
    ]);
  });
});

describe("ensureSelection — disabled rows are never landed on", () => {
  it("repairs a selection resting on a disabled row to the first enabled item", () => {
    expect(ensureSelection(TREE, "planned")).toBe("pending");
  });
  it("a child id is valid only while its parent is expanded", () => {
    expect(ensureSelection(TREE, "agent-allen")).toBe("pending"); // collapsed → not visible
    expect(ensureSelection(TREE, "agent-allen", new Set(["by-agent"]))).toBe("agent-allen");
  });
  it("skips a disabled FIRST row when falling back", () => {
    const groups: CollectionGroup[] = [
      {
        id: "g",
        items: [
          { id: "a", label: "A", disabled: true, reason: "planned" },
          { id: "b", label: "B" },
        ],
      },
    ];
    expect(ensureSelection(groups, undefined)).toBe("b");
  });
  it("a column of nothing but planned rows selects nothing", () => {
    const groups: CollectionGroup[] = [
      { id: "g", items: [{ id: "a", label: "A", disabled: true, reason: "planned" }] },
    ];
    expect(ensureSelection(groups, "a")).toBeUndefined();
  });
});

describe("stepSelection — steps over disabled rows and through expanded children", () => {
  it("skips a disabled row entirely: it is not a stop", () => {
    // held → (planned is disabled) nothing below → clamps on held
    expect(stepSelection(TREE, "held", 1)).toBe("held");
  });
  it("walks into an expanded parent's children", () => {
    const open = new Set(["by-agent"]);
    expect(stepSelection(TREE, "by-agent", 1, open)).toBe("agent-allen");
    expect(stepSelection(TREE, "agent-piper", 1, open)).toBe("held");
    expect(stepSelection(TREE, "held", -1, open)).toBe("agent-piper");
  });
  it("steps straight past a collapsed parent's children", () => {
    expect(stepSelection(TREE, "by-agent", 1)).toBe("held");
  });
});

describe("toggleExpansion — a fresh Set every time", () => {
  it("adds, removes, and never mutates its input", () => {
    const start = new Set(["a"]);
    const opened = toggleExpansion(start, "b");
    expect([...opened].sort()).toEqual(["a", "b"]);
    const closed = toggleExpansion(opened, "a");
    expect([...closed]).toEqual(["b"]);
    expect([...start]).toEqual(["a"]); // the input survived both
  });
});
