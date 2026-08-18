// The CollectionColumn's pure selection model (s24 T1). The component is
// markup; what a collection IS — groups of items, a valid selection, keyboard
// order — lives here where it can be tested as functions.

export interface CollectionItem {
  id: string;
  label: string;
  /** Right-aligned count badge; absent and 0 both render nothing (a zero is
   *  noise in a picker — the group still exists, it is just empty). */
  count?: number | null;
  /** A short right-aligned annotation badge — "default", "read-only". Text
   *  where `count` is numbers; a row may carry either (count wins if both). */
  note?: string;
  /** A small leading text glyph — Mail's role marks (✉ ✎ ➤). Decorative. */
  glyph?: string;
  /** Tree indent steps (Mail's folder nesting). Rendered as a discrete
   *  padding class, clamped — never inline style (CSP). */
  depth?: number;
  muted?: boolean;
}

export interface CollectionGroup {
  id: string;
  /** Group heading; omit for an ungrouped run of items (Mail's folders). */
  label?: string;
  items: CollectionItem[];
}

/** Every item, in visual order — the keyboard order by construction. */
export function flattenItems(groups: readonly CollectionGroup[]): CollectionItem[] {
  return groups.flatMap((g) => g.items);
}

/**
 * A selection that is always valid: the requested id if it exists, else the
 * first item, else undefined (an empty column selects nothing). The same
 * self-repair the approvals master-detail does — a row leaving must not strand
 * the detail pane on a ghost.
 */
export function ensureSelection(
  groups: readonly CollectionGroup[],
  selectedId: string | undefined,
): string | undefined {
  const items = flattenItems(groups);
  if (items.length === 0) return undefined;
  return items.some((i) => i.id === selectedId) ? selectedId : items[0]!.id;
}

/** The id `delta` steps away in visual order, clamped to the ends — ArrowUp/
 *  ArrowDown on the picker. */
export function stepSelection(
  groups: readonly CollectionGroup[],
  selectedId: string | undefined,
  delta: 1 | -1,
): string | undefined {
  const items = flattenItems(groups);
  if (items.length === 0) return undefined;
  const at = items.findIndex((i) => i.id === selectedId);
  if (at === -1) return items[0]!.id;
  const next = Math.min(items.length - 1, Math.max(0, at + delta));
  return items[next]!.id;
}
