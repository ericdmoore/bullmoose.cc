/**
 * Count rows per facet value, busiest first, ties by name (#225).
 *
 * Shared rather than inlined because "by agent" and "by realm" are the same
 * question twice, and a saved-view list that ordered one differently from
 * the other would look like a bug in whichever the reader met second.
 */
export function tally<T>(
  rows: readonly T[],
  of: (row: T) => string | undefined | null,
): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = (of(row) ?? "").trim();
    if (!key) continue; // an unattributed row joins no facet — never an "" view
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
