// Year › Month date groups (s20 T5, the s24 IA's "grouped by date") — derived
// from the receivedAt values of the CURRENT session's results, never from a
// server aggregate that does not exist. Clicking a leaf refines the session
// to that window (`windowRefinement`), which re-queries the server with
// `after`/`before` — so the counts here are counts of the page the browser
// holds (capped at the fetch limit), and the collection builder labels them
// as such rather than implying an account-wide histogram.
//
// All arithmetic is UTC. `receivedAt` is an ISO instant (RFC 8621); grouping
// it in the viewer's zone would put the same message in different months on
// different machines, and a saved query is shared state across sessions.

import type { FinderRefinement } from "./session";

export interface MonthGroup {
  year: number;
  /** 1–12, human month — not the Date constructor's 0-based index. */
  month: number;
  /** Messages from the current result page in this month. */
  count: number;
}

export interface YearGroup {
  year: number;
  count: number;
  /** Newest month first, matching the years' own ordering. */
  months: MonthGroup[];
}

/** Locale-free month names — dates here label shared, persisted state, so
 *  two machines must render the identical string. */
export const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** "Aug 2026" — deterministic, locale-free (a test asserts exact strings). */
export function monthLabel(year: number, month: number): string {
  return `${MONTH_NAMES[month - 1] ?? "?"} ${year}`;
}

/** The month as a receivedAt window: `after` inclusive, `before` exclusive —
 *  first instant of the month to first instant of the next (Date.UTC rolls
 *  month 12 into January correctly). */
export function monthWindow(year: number, month: number): { after: string; before: string } {
  return {
    after: new Date(Date.UTC(year, month - 1, 1)).toISOString(),
    before: new Date(Date.UTC(year, month, 1)).toISOString(),
  };
}

export function yearWindow(year: number): { after: string; before: string } {
  return {
    after: new Date(Date.UTC(year, 0, 1)).toISOString(),
    before: new Date(Date.UTC(year + 1, 0, 1)).toISOString(),
  };
}

/** The refinement a date leaf applies — one `window` chip, labelled like the
 *  row that was clicked ("Aug 2026", or "2026" for a whole year). */
export function windowRefinement(year: number, month?: number): FinderRefinement {
  return month === undefined
    ? { kind: "window", label: String(year), ...yearWindow(year) }
    : { kind: "window", label: monthLabel(year, month), ...monthWindow(year, month) };
}

/**
 * Group ISO timestamps into Year › Month, newest first at both levels.
 * Unparseable or missing values are dropped, not invented — a message whose
 * date the server did not supply cannot honestly appear under a month.
 */
export function deriveDateGroups(whens: Iterable<string | undefined>): YearGroup[] {
  const counts = new Map<number, Map<number, number>>();
  for (const when of whens) {
    if (when === undefined) continue;
    const ms = Date.parse(when);
    if (!Number.isFinite(ms)) continue;
    const d = new Date(ms);
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    const byMonth = counts.get(year) ?? new Map<number, number>();
    byMonth.set(month, (byMonth.get(month) ?? 0) + 1);
    counts.set(year, byMonth);
  }

  return [...counts.entries()]
    .sort(([a], [b]) => b - a)
    .map(([year, byMonth]) => {
      const months = [...byMonth.entries()].sort(([a], [b]) => b - a).map(([month, count]) => ({ year, month, count }));
      return { year, count: months.reduce((sum, m) => sum + m.count, 0), months };
    });
}
