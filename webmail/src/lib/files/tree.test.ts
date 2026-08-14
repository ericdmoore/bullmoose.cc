import { describe, expect, it } from "vitest";
import {
  ancestorIds,
  breadcrumb,
  childrenOf,
  descendantIds,
  moveTargets,
  pathOf,
  ROOT_CRUMB,
  sortChildren,
} from "./tree";
import type { FileNode, FileNodeType } from "./types";

const node = (
  id: string,
  parentId: string | null,
  name: string,
  nodeType: FileNodeType = "file",
): FileNode => ({
  id,
  parentId,
  name,
  nodeType,
  blobId: nodeType === "file" ? `blob-${id}` : null,
  size: nodeType === "file" ? 10 : null,
  type: nodeType === "file" ? "text/plain" : null,
  created: "2026-01-01T00:00:00.000Z",
  modified: "2026-01-01T00:00:00.000Z",
  accessed: "2026-01-01T00:00:00.000Z",
  changed: "2026-01-01T00:00:00.000Z",
  executable: false,
  isSubscribed: true,
  myRights: {
    mayRead: true,
    mayAddChildren: true,
    mayRename: true,
    mayDelete: true,
    mayModifyContent: true,
    mayShare: true,
  },
  shareWith: null,
  role: null,
});

const map = (nodes: FileNode[]) => new Map(nodes.map((n) => [n.id, n]));

describe("breadcrumb", () => {
  it("is just the root when nothing is selected", () => {
    const trail = breadcrumb(map([]), null);
    expect(trail.crumbs).toEqual([ROOT_CRUMB]);
    expect(trail.truncated).toBe(false);
  });

  it("puts a top-level folder directly under the root", () => {
    const projects = node("a", null, "Projects", "directory");
    const trail = breadcrumb(map([projects]), "a");
    expect(trail.crumbs.map((c) => c.name)).toEqual(["Files", "Projects"]);
    expect(trail.crumbs.map((c) => c.id)).toEqual([null, "a"]);
    expect(trail.truncated).toBe(false);
  });

  it("walks a deep chain root-first, not leaf-first", () => {
    // The order is the whole point: a breadcrumb rendered backwards is a
    // breadcrumb that navigates people the wrong way.
    const nodes = [
      node("a", null, "Projects", "directory"),
      node("b", "a", "2026", "directory"),
      node("c", "b", "Q3", "directory"),
      node("d", "c", "deck.pdf"),
    ];
    const trail = breadcrumb(map(nodes), "d");
    expect(trail.crumbs.map((c) => c.name)).toEqual(["Files", "Projects", "2026", "Q3", "deck.pdf"]);
    expect(ancestorIds(trail)).toEqual(["a", "b", "c", "d"]);
    expect(trail.truncated).toBe(false);
  });

  it("truncates — and SAYS so — when an ancestor was not fetched", () => {
    // `fetchParents` omitted, or a genuinely orphaned row. Either way the
    // trail must not imply the node sits at the top level.
    const orphan = node("c", "missing", "Q3", "directory");
    const trail = breadcrumb(map([orphan]), "c");
    expect(trail.crumbs.map((c) => c.name)).toEqual(["Files", "Q3"]);
    expect(trail.truncated).toBe(true);
  });

  it("truncates on an unknown id rather than throwing", () => {
    const trail = breadcrumb(map([]), "nope");
    expect(trail.crumbs).toEqual([ROOT_CRUMB]);
    expect(trail.truncated).toBe(true);
  });

  it("does not spin on a cycle", () => {
    // `FileNode/set` refuses to create one, but a direct DB write can; the
    // screen that would FIX it must be usable.
    const a = { ...node("a", "b", "A", "directory") };
    const b = { ...node("b", "a", "B", "directory") };
    const trail = breadcrumb(map([a, b]), "a");
    expect(trail.truncated).toBe(true);
    expect(trail.crumbs.length).toBeLessThanOrEqual(3);
  });

  it("renders a path from the same walk", () => {
    const nodes = [node("a", null, "Projects", "directory"), node("b", "a", "roadmap.md")];
    expect(pathOf(map(nodes), "b")).toBe("Projects/roadmap.md");
  });
});

describe("sortChildren", () => {
  it("puts every directory before every file, then sorts by name", () => {
    const rows = [
      node("f1", null, "alpha.txt"),
      node("d2", null, "Zulu", "directory"),
      node("f2", null, "Beta.txt"),
      node("d1", null, "apple", "directory"),
    ];
    expect(sortChildren(rows).map((n) => n.name)).toEqual(["apple", "Zulu", "alpha.txt", "Beta.txt"]);
  });

  it("breaks ties on id, matching the server's own last resort", () => {
    const rows = [node("b", null, "same.txt"), node("a", null, "same.txt")];
    expect(sortChildren(rows).map((n) => n.id)).toEqual(["a", "b"]);
  });

  it("does not mutate its input", () => {
    const rows = [node("f", null, "b.txt"), node("d", null, "a", "directory")];
    const before = rows.map((n) => n.id);
    sortChildren(rows);
    expect(rows.map((n) => n.id)).toEqual(before);
  });
});

describe("childrenOf / descendantIds", () => {
  const tree = [
    node("a", null, "Projects", "directory"),
    node("b", "a", "2026", "directory"),
    node("c", "b", "deck.pdf"),
    node("d", null, "README.txt"),
  ];

  it("finds direct children, with null meaning the top level", () => {
    expect(childrenOf(tree, null).map((n) => n.id)).toEqual(["a", "d"]);
    expect(childrenOf(tree, "a").map((n) => n.id)).toEqual(["b"]);
    expect(childrenOf(tree, "c")).toEqual([]);
  });

  it("collects transitive descendants — what a destroy would take with it", () => {
    expect(descendantIds(tree, "a").sort()).toEqual(["b", "c"]);
    expect(descendantIds(tree, "d")).toEqual([]);
  });
});

describe("moveTargets", () => {
  const tree = [
    node("a", null, "Projects", "directory"),
    node("b", "a", "2026", "directory"),
    node("c", "b", "deck.pdf"),
    node("z", null, "Scratch", "directory"),
  ];

  it("never offers a destination the server would refuse as a cycle", () => {
    const targets = moveTargets(tree, tree[0]!).map((t) => t.id);
    expect(targets).not.toContain("a"); // itself
    expect(targets).not.toContain("b"); // its own descendant
    expect(targets).toContain("z");
  });

  it("omits the current parent — moving somewhere it already is is not a move", () => {
    const deck = tree[2]!;
    expect(moveTargets(tree, deck).map((t) => t.id)).not.toContain("b");
  });

  it("offers the root only when the node is not already at the top level", () => {
    const deck = tree[2]!;
    expect(moveTargets(tree, deck)[0]).toEqual(ROOT_CRUMB);
    expect(moveTargets(tree, tree[0]!).some((t) => t.id === null)).toBe(false);
  });

  it("never offers a file as a destination", () => {
    const targets = moveTargets(tree, tree[3]!);
    expect(targets.some((t) => t.id === "c")).toBe(false);
  });
});
