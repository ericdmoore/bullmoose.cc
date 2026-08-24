import { beforeEach, describe, expect, it, vi } from "vitest";
import { publishGroups } from "./publishGroups";
import { readPublished } from "./publish";

// #226: five realms publish nothing, so their tray rows have no leaf-nodes.
// The adapter is what makes "ten lines apiece" one line apiece — and these
// pin the two things flattening could get wrong.

// The publish.test.ts stubs, verbatim — a Map-backed localStorage and an
// event sink, because publishing is a browser act.
let store: Map<string, string>;
beforeEach(() => {
  store = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  vi.stubGlobal("dispatchEvent", () => true);
  vi.stubGlobal("location", { search: "" });
});

const groups = [
  { id: "g1", label: "Saved", items: [{ id: "unread", label: "Unread", count: 3 }] },
  { id: "g2", items: [{ id: "all", label: "All", count: null }] },
];

describe("publishGroups", () => {
  it("flattens groups into leaf-nodes the tray can link to", () => {
    publishGroups("notes", "/notes", groups, 1234);
    const out = readPublished("notes");
    expect(out?.items.map((i) => i.id)).toEqual(["unread", "all"]);
    expect(out?.items[0]!.href).toContain("/notes?");
    expect(out?.items[0]!.href).toContain("c=unread");
  });

  it("a labelled group prefixes its items — two groups' same-named rows stay distinct", () => {
    publishGroups("notes", "/notes", groups, 1234);
    const out = readPublished("notes");
    expect(out?.items[0]!.label).toBe("Saved ▸ Unread");
    expect(out?.items[1]!.label).toBe("All"); // ungrouped keeps its own name
  });

  it("count: null is NOT a zero — a column's 'not counted' must not render as 0", () => {
    publishGroups("notes", "/notes", groups, 1234);
    const out = readPublished("notes");
    expect(out?.items[0]!.count).toBe(3);
    expect(out?.items[1]!.count).toBeUndefined();
  });
});
