// The Looking Ahead stack for `/` — the next horizon across realms (s07 T0).
//
// One time-ordered list built from three kinds of thing, and the whole reason
// this is tested pure TS is that two of them carry DIFFERENT CLOCKS that the
// devPlan is emphatic must never be conflated (s07 §T0):
//
//   event      a calendar occurrence today or tomorrow. No countdown — it is
//              just when it is.
//   expiring   a PENDING proposal whose decision deadline (`expiresAt`) is
//              near. "How long until I lose the chance to decide." SHRINKS.
//   hold       a HELD proposal whose tier-2 retraction window (`holdUntil`) is
//              near. "How long until my decision becomes irreversible" — a
//              window in which an already-approved action can still be pulled
//              back. Different meaning, different field.
//
// The distinctness is not asserted by hand here; it is INHERITED from
// `rowClocks` (../approvals/clocks.ts:58), which sources `expiresInMs` from
// `expiresAt` on `pending` only and `holdRemainingMs` from `holdUntil` on
// `held` only. So `expiringItems` gates on `expiresInMs !== null` and can never
// pick up a held row's `holdUntil`, and `holdItems` gates on `holdRemainingMs`
// and can never pick up a pending row's `expiresAt` — a proposal carrying BOTH
// timestamps yields exactly one item, of the kind its status dictates.
//
// ⚠️ Calendar placement is NOT re-derived either. `segmentsByDay`
// (../calendar/place.ts) already forks all-day (civil) from timed (instant in
// the viewer's zone) correctly, over occurrences the SERVER expanded — no RRULE
// interpreter reaches this file, and none may.

import { expiryLabel, holdLabel, rowClocks } from "../approvals/clocks";
import { summarizeProposal } from "../approvals/rows";
import type { ActionProposal } from "../approvals/types";
import {
  addDays,
  dayKey,
  formatClock,
  minutesOfDay,
  zonedFields,
  type CivilDate,
} from "../calendar/civil";
import { segmentsByDay, segmentsOn } from "../calendar/place";
import type { Occurrence } from "../calendar/types";

/** "About to" — proposals whose deadline or hold window falls in the next two days. */
export const HORIZON_MS = 2 * 24 * 60 * 60_000;

/** All-day items sort ahead of any timed minute within their day. */
export const ALLDAY_MINUTE = -1;

export type HorizonKind = "event" | "expiring" | "hold";

export interface HorizonItem {
  kind: HorizonKind;
  /** Stable render key. */
  id: string;
  title: string;
  /** The item's own clock line — DISTINCT per kind (see module header). */
  clockLabel: string;
  /** Where the row drills down. */
  href: string;
  /** The agent behind a proposal-derived row; absent for a calendar event. */
  agent?: string;
  // ── sort coordinates, all in the VIEWER's zone ──────────────────────────
  /** "YYYY-MM-DD" of the item; string order is chronological order. */
  dayKey: string;
  allDay: boolean;
  /** Minutes past local midnight; `ALLDAY_MINUTE` for all-day. */
  minute: number;
}

/** Today and tomorrow as civil dates in the viewer's zone — the event window. */
export function horizonDays(now: number, viewerZone: string): [CivilDate, CivilDate] {
  const f = zonedFields(now, viewerZone);
  const today: CivilDate = { year: f.year, month: f.month, day: f.day };
  return [today, addDays(today, 1)];
}

/** The instant the proposal horizon extends to. */
export function horizonEnd(now: number): number {
  return now + HORIZON_MS;
}

/**
 * Calendar occurrences that fall on the given days, as horizon items. Reuses
 * `segmentsByDay`, so a multi-day span shows once per day it covers and the
 * all-day/timed placement fork is the calendar's, not a copy of it.
 */
export function eventItems(
  occurrences: readonly Occurrence[],
  viewerZone: string,
  days: readonly CivilDate[],
): HorizonItem[] {
  const byDay = segmentsByDay([...occurrences], viewerZone);
  const items: HorizonItem[] = [];
  for (const day of days) {
    for (const seg of segmentsOn(byDay, day)) {
      items.push({
        kind: "event",
        id: `event:${seg.eventId}:${seg.recurrenceId}:${seg.day}`,
        title: seg.title,
        // No countdown on an event: it is when it is. The label is the time of
        // day, or "continues" when the occurrence spilled in from an earlier
        // day (its `fromMinute` is a clipped 0, not a real start).
        clockLabel: seg.allDay
          ? "all day"
          : seg.continuesBefore
            ? "continues"
            : formatClock(seg.fromMinute),
        href: "/calendar",
        dayKey: seg.day,
        allDay: seg.allDay,
        minute: seg.allDay ? ALLDAY_MINUTE : seg.fromMinute,
      });
    }
  }
  return items;
}

/**
 * Pending proposals whose decision deadline is within the horizon — the
 * SHRINKING clock. Gated on `expiresInMs !== null`, which `rowClocks` returns
 * only for a `pending` row, so a held row's `holdUntil` can never surface here.
 */
export function expiringItems(
  proposals: readonly ActionProposal[],
  now: number,
  end: number,
  viewerZone: string,
): HorizonItem[] {
  const items: HorizonItem[] = [];
  for (const p of proposals) {
    const clocks = rowClocks(p, now);
    if (clocks.expiresInMs === null) continue; // not pending, or no deadline
    const at = p.expiresAt !== null ? Date.parse(p.expiresAt) : NaN;
    if (!Number.isFinite(at) || at > end) continue; // beyond the horizon
    const f = zonedFields(at, viewerZone);
    items.push({
      kind: "expiring",
      id: `expiring:${p.id}`,
      title: summarizeProposal(p),
      clockLabel: expiryLabel(clocks.expiresInMs),
      href: "/approvals",
      agent: p.agent,
      dayKey: dayKey(f),
      allDay: false,
      minute: minutesOfDay(f),
    });
  }
  return items;
}

/**
 * Held proposals whose retraction window is within the horizon — the tier-2
 * post-approval clock. Gated on `holdRemainingMs !== null`, returned only for a
 * `held` row, so a pending row's `expiresAt` can never surface here. The label
 * is `holdLabel`, which is worded so nothing reads as egress: while the window
 * runs and after it lapses, nothing has been sent (committing out of the tray
 * is s03.D T2, unbuilt).
 */
export function holdItems(
  proposals: readonly ActionProposal[],
  now: number,
  end: number,
  viewerZone: string,
): HorizonItem[] {
  const items: HorizonItem[] = [];
  for (const p of proposals) {
    const clocks = rowClocks(p, now);
    if (clocks.holdRemainingMs === null) continue; // not held
    const at = p.holdUntil !== null ? Date.parse(p.holdUntil) : NaN;
    if (!Number.isFinite(at) || at > end) continue;
    const f = zonedFields(at, viewerZone);
    items.push({
      kind: "hold",
      id: `hold:${p.id}`,
      title: summarizeProposal(p),
      clockLabel: holdLabel(clocks.holdRemainingMs),
      href: "/approvals",
      agent: p.agent,
      dayKey: dayKey(f),
      allDay: false,
      minute: minutesOfDay(f),
    });
  }
  return items;
}

export interface HorizonInput {
  proposals: readonly ActionProposal[];
  occurrences: readonly Occurrence[];
  viewerZone: string;
  now: number;
  /** Upper bound for proposal items; default `horizonEnd(now)`. */
  end?: number;
  /** The event days; default `horizonDays(now, viewerZone)`. */
  days?: readonly CivilDate[];
}

/** The whole Looking Ahead list, soonest first. */
export function lookingAhead(input: HorizonInput): HorizonItem[] {
  const end = input.end ?? horizonEnd(input.now);
  const days = input.days ?? horizonDays(input.now, input.viewerZone);
  return sortHorizon([
    ...eventItems(input.occurrences, input.viewerZone, days),
    ...expiringItems(input.proposals, input.now, end, input.viewerZone),
    ...holdItems(input.proposals, input.now, end, input.viewerZone),
  ]);
}

/** Chronological: by day, then all-day ahead of timed, then time, then title. */
export function sortHorizon(items: readonly HorizonItem[]): HorizonItem[] {
  return [...items].sort(
    (a, b) =>
      (a.dayKey < b.dayKey ? -1 : a.dayKey > b.dayKey ? 1 : 0) ||
      a.minute - b.minute ||
      a.title.localeCompare(b.title) ||
      a.id.localeCompare(b.id),
  );
}
