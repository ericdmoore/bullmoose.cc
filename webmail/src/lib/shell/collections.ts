import type { JSX } from "preact";

// The CollectionColumn's pure selection model (s24 T1, grown by s25 T2). The
// component is markup; what a collection IS — groups of items, one level of
// nesting, a valid selection, keyboard order — lives here where it can be
// tested as functions.

export interface CollectionItem {
  id: string;
  label: string;
  /** Right-aligned count badge; absent and 0 both render nothing (a zero is
   *  noise in a picker — the group still exists, it is just empty). */
  count?: number | null;
  /** A short right-aligned annotation badge — "default", "read-only". Text
   *  where `count` is numbers; a row may carry either (count wins if both). */
  note?: string;
  /** A small leading icon — Mail's role marks, as a component from
   *  `components/icons` (never a text glyph: dingbats render as tofu on any
   *  machine missing the font, and the Tailwind UI look is SVG). Decorative. */
  icon?: (props: { class?: string }) => JSX.Element;
  /** Tree indent steps (Mail's folder nesting). Rendered as a discrete
   *  padding class, clamped — never inline style (CSP). */
  depth?: number;
  muted?: boolean;
  /**
   * ONE level of nesting (s25 T2) — "by agent ▸" → the agents. Children are
   * hidden until their parent's id is in the expansion set the renderer
   * passes to `flattenItems`. Deliberately one level: a picker is a map, not
   * a filesystem, and Mail's deeper folder trees already render flat via
   * `depth`. A child's own `children` are ignored by every renderer.
   */
  children?: CollectionItem[];
  /**
   * The planned-section idiom (lib/app/sections.ts), extended to collection
   * items (s25 T2): a disabled row renders greyed WITH its `reason`, never as
   * a dead row and never hidden — an empty collection still exists. Disabled
   * rows are skipped by selection and keyboard order.
   */
  disabled?: boolean;
  /** WHY the row is disabled — always shown beside the label. */
  reason?: string;
}

export interface CollectionGroup {
  id: string;
  /** Group heading; omit for an ungrouped run of items (Mail's folders). */
  label?: string;
  items: CollectionItem[];
}

const NO_EXPANSION: ReadonlySet<string> = new Set();

/**
 * Every VISIBLE item, in visual order — the keyboard order by construction.
 * `expanded` is the renderer's expansion state: a parent's children appear
 * (immediately after it) only while its id is in the set. The default is the
 * empty set, which is also the s24 behaviour — no caller passed children
 * before s25, so nothing changes for them.
 */
export function flattenItems(
  groups: readonly CollectionGroup[],
  expanded: ReadonlySet<string> = NO_EXPANSION,
): CollectionItem[] {
  return groups.flatMap((g) =>
    g.items.flatMap((item) =>
      item.children && item.children.length > 0 && expanded.has(item.id) ? [item, ...item.children] : [item],
    ),
  );
}

/** Selectable items that carry a glyph — the collapsed CollectionColumn rail.
 *  Realms without icons (Approvals' lifecycle states) keep the expand-only strip. */
export function iconRailItems(
  groups: readonly CollectionGroup[],
  expanded: ReadonlySet<string> = NO_EXPANSION,
): CollectionItem[] {
  return flattenItems(groups, expanded).filter((i) => !i.disabled && i.icon !== undefined);
}

/** Selectable = visible and not disabled. A disabled row is announced, never
 *  landed on. */
function selectable(groups: readonly CollectionGroup[], expanded: ReadonlySet<string>): CollectionItem[] {
  return flattenItems(groups, expanded).filter((i) => !i.disabled);
}

/**
 * A selection that is always valid: the requested id if it is visible and
 * enabled, else the first enabled item, else undefined (a column of nothing
 * but planned rows selects nothing). The same self-repair the approvals
 * master-detail does — a row leaving must not strand the detail pane on a
 * ghost, and a row becoming disabled must not strand it on a grey.
 */
export function ensureSelection(
  groups: readonly CollectionGroup[],
  selectedId: string | undefined,
  expanded: ReadonlySet<string> = NO_EXPANSION,
): string | undefined {
  const items = selectable(groups, expanded);
  if (items.length === 0) return undefined;
  return items.some((i) => i.id === selectedId) ? selectedId : items[0]!.id;
}

/** The id `delta` steps away in visual order, skipping disabled rows and
 *  clamped to the ends — ArrowUp/ArrowDown on the picker. */
export function stepSelection(
  groups: readonly CollectionGroup[],
  selectedId: string | undefined,
  delta: 1 | -1,
  expanded: ReadonlySet<string> = NO_EXPANSION,
): string | undefined {
  const items = selectable(groups, expanded);
  if (items.length === 0) return undefined;
  const at = items.findIndex((i) => i.id === selectedId);
  if (at === -1) return items[0]!.id;
  const next = Math.min(items.length - 1, Math.max(0, at + delta));
  return items[next]!.id;
}

/** Expansion toggled as a VALUE — a new Set with `id` flipped, so a Preact
 *  state setter sees a fresh reference (mutating the old Set renders
 *  nothing). The one write path all three renderings share. */
export function toggleExpansion(expanded: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(expanded);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}
