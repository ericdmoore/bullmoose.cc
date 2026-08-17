# @bullmoose/calendar-core

The recurrence/timezone engine under the [JSCalendar](https://datatracker.ietf.org/doc/html/rfc8984)
(RFC 8984) core, plus iCalendar translation. This is where the calendar
risk concentrates.

- **recurrence expansion** — on-demand and **capped** (never pre-compute an
  unbounded series). What is supported is declared **per frequency**, not as a
  union — the expander has a separate branch per `FREQ` and they do not read the
  same parts:

  | `FREQ`    | rule parts the expander reads                                                     |
  | --------- | --------------------------------------------------------------------------------- |
  | `DAILY`   | `INTERVAL` `COUNT` `UNTIL`                                                        |
  | `WEEKLY`  | `INTERVAL` `COUNT` `UNTIL` `BYDAY` — day only, **no** nth-of-period               |
  | `MONTHLY` | `INTERVAL` `COUNT` `UNTIL` `BYDAY` (incl. `2MO` / `-1FR`) `BYMONTHDAY` `BYSETPOS` |
  | `YEARLY`  | `INTERVAL` `COUNT` `UNTIL` `BYMONTH`                                              |

  Plus `recurrenceOverrides` (excluded, patched, and added occurrences).

- **anything outside that table is refused, not approximated.** `SUPPORTED_PARTS`
  - `unsupportedRuleReason` are the single source of truth; `eventSpan` throws
    `UnsupportedRecurrenceError` (both write surfaces turn it into a 4xx) and
    `rruleToRule` returns `null`. So `FREQ=YEARLY;BYMONTH=11;BYDAY=4TH` — US
    Thanksgiving, which Apple Calendar emits — is **rejected** rather than
    expanded to "the start day of every November". A rejected rule still yields
    its own `DTSTART`: the event does not vanish, it stops repeating.

  **If you add a branch to `expandRule`, add the part to `SUPPORTED_PARTS` in the
  same commit.** The table drifting from the code is the original defect
  ([`003 -P1-`](../../.feedback/fromClaude/common)).

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

## Known-bad rows written before the guard existed

Rows stored while an unexpandable rule still parsed clean carry a
`calendar_events.end_at` derived from the wrong expansion. There is no migration
framework in this repo, so nothing rewrites them. What that does and does not
cost, in order:

- **Reads are already correct.** `expandOccurrences` drops an unexpandable rule
  instead of throwing, so a stored bad row now returns exactly its `DTSTART` —
  no more wrong dates in `CalendarEvent/query`, `CalendarEvent/getOccurrences`
  or the CalDAV time-range `REPORT`. It deliberately does not throw: one bad row
  would otherwise fail every one of those calls for the whole collection.
- **A stale `end_at` can only over-include.** A mis-expansion always produced
  _extra, later_ occurrences on top of the seeded master start, so every stale
  value is ≥ the correct one. `end_at` is used solely as the widening pre-filter
  `(end_at IS NULL OR end_at > ?)` in `queryCalendarEvents`, and both windowed
  read paths then re-check with a real expansion — so the over-inclusion is
  corrected, at the cost of examining a few rows that will not match.
- **Any rewrite repairs or rejects.** The next `CalendarEvent/set` or CalDAV
  `PUT` for the row re-derives `end_at` through `eventSpan`, which now throws —
  the client is told, loudly, that the rule is unsupported.

To enumerate affected rows without changing anything, run `eventSpan` over the
stored `event_json` and collect the throws; `UnsupportedRecurrenceError.reason`
names the offending part.
