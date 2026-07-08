# @bullmoose/calendar-core

The recurrence/timezone engine under the [JSCalendar](https://datatracker.ietf.org/doc/html/rfc8984)
(RFC 8984) core, plus iCalendar translation. This is where the calendar
risk concentrates.

- **recurrence expansion** — on-demand and **capped** (never pre-compute an
  unbounded series). Supports `FREQ` daily/weekly/monthly/yearly,
  `INTERVAL`, `COUNT`, `UNTIL`, `BYDAY` (incl. nth-of-period like "2nd
  Monday" / "last Friday"), `BYMONTHDAY`, `BYMONTH`, `BYSETPOS`, plus
  `recurrenceOverrides` (excluded, patched, and added occurrences).
- **wall-clock correctness** — events carry a local `start` +
  IANA `timeZone`; recurrence steps in wall-clock (a 9am standup stays 9am
  across DST), converting each occurrence to UTC via the zone's offset at
  that instant — derived from `Intl`, no bundled tz database.
- **iCalendar codec** — `parseICal` / `serializeICal`, `ruleToRrule` /
  `rruleToRule`, and `vtimezone` (a generated VTIMEZONE so clients expand
  correctly across DST).

Emits `Occurrence`s (`recurrenceId`, `startMs`, `endMs` in UTC epoch ms).
Used by the calendar JMAP methods and `services/anglebrackets` (CalDAV).
Design + the free-tier CPU story:
[`docs/architecture/capacity-and-scaling.md`](../../docs/architecture/capacity-and-scaling.md).
