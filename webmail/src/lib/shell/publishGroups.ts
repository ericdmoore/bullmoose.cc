import type { CollectionGroup } from "./collections";
import { publishCollections, publishedHref, type PublishedItem } from "./publish";

/**
 * `CollectionGroup[]` → the tray, in one call (#226).
 *
 * s25 T4 built the publish contract and three surfaces adopted it; five did
 * not, so their tray rows render as plain rows with no leaf-nodes — which
 * IS the headline feature of T4. Each remaining surface had "roughly ten
 * lines apiece" of the same mapping in front of it, and five hand-written
 * copies of one mapping is how the next realm gets it subtly wrong.
 *
 * So: one adapter over the shape every realm ALREADY computes for its
 * `CollectionColumn`. A realm that renders a column can publish its tray in
 * a single line, and the two can never disagree about what the collections
 * are — they are the same array.
 *
 * Flattening is deliberate. The tray is a flat list of leaf-nodes; groups
 * are a column affordance. Where a group carries a label, it prefixes the
 * item ("Saved ▸ Unread") so two groups' same-named items stay
 * distinguishable — the one thing flattening could otherwise lose.
 */
export function publishGroups(realm: string, path: string, groups: readonly CollectionGroup[], at = Date.now()): void {
  const items: PublishedItem[] = [];
  for (const g of groups) {
    for (const item of g.items) {
      items.push({
        id: item.id,
        label: g.label ? `${g.label} ▸ ${item.label}` : item.label,
        // `count: null` means "not counted" in a column and must not render
        // as 0 in the tray; absent and 0 both render nothing there anyway.
        ...(typeof item.count === "number" ? { count: item.count } : {}),
        href: publishedHref(path, item.id),
      });
    }
  }
  publishCollections(realm, items, at);
}
