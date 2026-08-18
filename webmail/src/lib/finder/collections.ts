// The Finder's CollectionColumn feed (s20 T5, on the s24 substrate): three
// groups — Saved queries, Sessions, By date — as `CollectionGroup[]` for the
// shared `<CollectionColumn>`. Pure: model in, rows out; the island maps a
// clicked row id back through `parseCollectionId`.
//
// Honesty rules this module enforces IN the row text:
//   • A saved query's count is stamped with when it was measured ("12 on
//     Aug 12") — a bare badge would imply a live number nobody computed.
//   • The date groups come from the CURRENT session's fetched page, so their
//     heading says "By date" over results that exist, and an idle session
//     gets a disabled explanatory row, never a silent absence.
//   • Empty groups keep a disabled row with the reason (the planned-section
//     idiom, `../shell/collections.ts`) — an empty collection still exists.

import type { CollectionGroup, CollectionItem } from "../shell/collections";
import { MONTH_NAMES, monthLabel, type YearGroup } from "./dateGroups";
import { describeSession, type FinderSession } from "./session";
import type { SavedQuery } from "./store";

/** "Aug 12" — deterministic, UTC (same reasoning as `dateGroups.ts`). */
export function shortDate(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "?";
  const d = new Date(ms);
  return `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** The count badge text for a saved query — count and measurement time
 *  together, or the honest "never run". */
export function savedNote(saved: SavedQuery): string {
  if (saved.lastRunAt === undefined || saved.lastCount === undefined) return "never run";
  return `${saved.lastCount} on ${shortDate(saved.lastRunAt)}`;
}

/** The session row's annotation: last-run count and when, or when it began. */
export function sessionNote(session: FinderSession): string {
  if (session.lastRunAt !== undefined && session.resultCount !== undefined) {
    return `${session.resultCount} · ${shortDate(session.lastRunAt)}`;
  }
  return shortDate(session.startedAt);
}

export interface FinderCollectionsInput {
  saved: readonly SavedQuery[];
  /** Recent sessions, newest first (the store's order). */
  sessions: readonly FinderSession[];
  /** The active session, so its row can be marked. */
  currentId?: string;
  /** Year › Month derived from the current session's results. */
  dateGroups: readonly YearGroup[];
}

export function buildFinderCollections(input: FinderCollectionsInput): CollectionGroup[] {
  return [
    { id: "saved", label: "Saved queries", items: savedItems(input.saved) },
    { id: "sessions", label: "Sessions", items: sessionItems(input.sessions, input.currentId) },
    { id: "dates", label: "By date", items: dateItems(input.dateGroups) },
  ];
}

function savedItems(saved: readonly SavedQuery[]): CollectionItem[] {
  if (saved.length === 0) {
    return [
      {
        id: "saved:none",
        label: "No saved queries",
        disabled: true,
        reason: "save a find to keep it",
      },
    ];
  }
  return saved.map((s) => ({ id: `saved:${s.id}`, label: s.name, note: savedNote(s) }));
}

function sessionItems(sessions: readonly FinderSession[], currentId: string | undefined): CollectionItem[] {
  if (sessions.length === 0) {
    return [
      {
        id: "session:none",
        label: "No finds yet",
        disabled: true,
        reason: "search above to start one",
      },
    ];
  }
  return sessions.map((s) => ({
    id: `session:${s.id}`,
    label: describeSession(s),
    note: sessionNote(s),
    ...(s.id === currentId ? {} : { muted: true }),
  }));
}

function dateItems(groups: readonly YearGroup[]): CollectionItem[] {
  if (groups.length === 0) {
    return [
      {
        id: "date:none",
        label: "No dates",
        disabled: true,
        reason: "dates come from the current find",
      },
    ];
  }
  return groups.map((y) => ({
    id: `date:${y.year}`,
    label: String(y.year),
    count: y.count,
    children: y.months.map((m) => ({
      id: `date:${m.year}-${String(m.month).padStart(2, "0")}`,
      label: monthLabel(m.year, m.month),
      count: m.count,
    })),
  }));
}

/** What a clicked collection row means, decoded from its id. */
export type FinderCollectionTarget =
  | { type: "saved"; id: string }
  | { type: "session"; id: string }
  | { type: "year"; year: number }
  | { type: "month"; year: number; month: number };

export function parseCollectionId(id: string): FinderCollectionTarget | undefined {
  if (id.startsWith("saved:") && id !== "saved:none") return { type: "saved", id: id.slice("saved:".length) };
  if (id.startsWith("session:") && id !== "session:none") {
    return { type: "session", id: id.slice("session:".length) };
  }
  const date = /^date:(\d{4})(?:-(\d{2}))?$/.exec(id);
  if (date) {
    const year = Number(date[1]);
    return date[2] === undefined ? { type: "year", year } : { type: "month", year, month: Number(date[2]) };
  }
  return undefined;
}
