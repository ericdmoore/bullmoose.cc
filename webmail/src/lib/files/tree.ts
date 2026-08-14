// Where you are, and what is under you — derived, because the server sends
// neither.
//
// `FileNode` carries `parentId` and nothing else (`types.ts` fact 2): no
// `path`, no depth, no children array. So a breadcrumb is an ancestor WALK, and
// every walk in this file is cycle-guarded. That is not defensive theatre:
// `FileNode/set` rejects a `parentId` change that would close a loop
// (filenode.ts `wouldCycle`, :686-695) but the top-level uniqueness gap in
// `.feedback common/030 §2` is a live reminder that the method layer is the
// only thing holding some of these invariants, and a UI that hangs on a
// corrupt tree is a UI that cannot be used to FIX the corrupt tree.
//
// Everything here is pure and takes a plain array — no client, no fetch, no
// DOM. `api.ts` does the talking.

import type { FileNode } from "./types";

/** One breadcrumb step. `id: null` is the account root, which has no node. */
export interface Crumb {
  id: string | null;
  name: string;
}

/** The root crumb. Rendered as a name, never as an empty string. */
export const ROOT_CRUMB: Crumb = { id: null, name: "Files" };

export interface Breadcrumb {
  crumbs: Crumb[];
  /**
   * True when the walk stopped at a node whose parent was not in the map —
   * either the ancestor chain was not fetched (`fetchParents` omitted) or a row
   * is genuinely orphaned. Either way the trail is INCOMPLETE, and the UI says
   * so rather than implying the node sits at the top level.
   */
  truncated: boolean;
}

/**
 * The trail from the root down to `id`, inclusive.
 *
 * `byId` needs to hold the node and its ancestors — which is exactly what
 * `FileNode/get { ids: [id], fetchParents: true }` returns in one round trip
 * (filenode.ts:83-103). A missing link truncates rather than throwing: half a
 * trail plus a warning beats an exception in the one screen that could repair
 * the tree.
 */
export function breadcrumb(byId: Map<string, FileNode>, id: string | null): Breadcrumb {
  if (id === null) return { crumbs: [ROOT_CRUMB], truncated: false };

  const chain: Crumb[] = [];
  const seen = new Set<string>();
  let cursor: string | null = id;
  let truncated = false;

  while (cursor !== null) {
    if (seen.has(cursor)) {
      // A cycle. Impossible through `FileNode/set`, possible through a direct
      // DB write; stop rather than spin.
      truncated = true;
      break;
    }
    seen.add(cursor);
    const node: FileNode | undefined = byId.get(cursor);
    if (!node) {
      truncated = true;
      break;
    }
    chain.unshift({ id: node.id, name: node.name });
    cursor = node.parentId;
  }

  return { crumbs: [ROOT_CRUMB, ...chain], truncated };
}

/** Ids in a breadcrumb, root excluded — the ancestors to fetch or highlight. */
export function ancestorIds(trail: Breadcrumb): string[] {
  return trail.crumbs.map((c) => c.id).filter((id): id is string => id !== null);
}

/**
 * Directories first, then name.
 *
 * The server cannot do this: `FileNode/query`'s sort vocabulary is
 * name/created/modified/changed/size (filenode.ts:780) with no `nodeType`, so
 * folders-before-files is necessarily a CLIENT ordering. The consequence is
 * real and stated on screen (`scope.ts` `PARTIAL_SORT_NOTE`): when a directory
 * has more children than one page, the grouping only holds over what has
 * loaded — the same window-local honesty the thread list carries.
 *
 * Names compare with `localeCompare` (so "Éclair" files under E) and ties break
 * on id, which mirrors the server's own final tie-break (filenode.ts:804).
 */
export function sortChildren(nodes: readonly FileNode[]): FileNode[] {
  return [...nodes].sort((a, b) => {
    const ad = a.nodeType === "directory" ? 0 : 1;
    const bd = b.nodeType === "directory" ? 0 : 1;
    if (ad !== bd) return ad - bd;
    const byName = a.name.localeCompare(b.name);
    if (byName !== 0) return byName;
    return a.id.localeCompare(b.id);
  });
}

/** Direct children of `parentId` (`null` = top level), unsorted. */
export function childrenOf(nodes: readonly FileNode[], parentId: string | null): FileNode[] {
  return nodes.filter((n) => n.parentId === parentId);
}

/**
 * Every transitive descendant of `id`. Mirrors `collectDescendants`
 * (filenode.ts:698-716), including its `seen` guard, because the UI has to know
 * what a destroy would take with it BEFORE asking for confirmation.
 */
export function descendantIds(nodes: readonly FileNode[], id: string): string[] {
  const byParent = new Map<string | null, FileNode[]>();
  for (const n of nodes) {
    const arr = byParent.get(n.parentId) ?? [];
    arr.push(n);
    byParent.set(n.parentId, arr);
  }
  const out: string[] = [];
  const queue = [...(byParent.get(id) ?? [])];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next || seen.has(next.id)) continue;
    seen.add(next.id);
    out.push(next.id);
    queue.push(...(byParent.get(next.id) ?? []));
  }
  return out;
}

/**
 * The directories `node` may be moved into, root included.
 *
 * Mirrors what `FileNode/set update { parentId }` will actually accept
 * (filenode.ts:603-621): a directory, not the node itself, and not anywhere on
 * the node's own descendant chain — the server calls that last one
 * "move would create a cycle" and refuses. Offering a target the server is
 * certain to reject is the greyed-out-button bug in reverse.
 *
 * The current parent is excluded too: "move it where it already is" is not a
 * destination, it is a no-op with a confirmation dialog.
 */
export function moveTargets(nodes: readonly FileNode[], node: FileNode): Crumb[] {
  const barred = new Set([node.id, ...descendantIds(nodes, node.id)]);
  const dirs = nodes
    .filter((n) => n.nodeType === "directory" && !barred.has(n.id) && n.id !== node.parentId)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    .map((n) => ({ id: n.id, name: n.name }) satisfies Crumb);
  return node.parentId === null ? dirs : [ROOT_CRUMB, ...dirs];
}

/** A node's full slash-joined path, for a title or a copy-paste. */
export function pathOf(byId: Map<string, FileNode>, id: string): string {
  const trail = breadcrumb(byId, id);
  return trail.crumbs
    .slice(1)
    .map((c) => c.name)
    .join("/");
}
