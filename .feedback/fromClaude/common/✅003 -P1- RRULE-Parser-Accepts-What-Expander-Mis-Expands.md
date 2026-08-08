# 003 -P1- RRULE parser accepts rules the expander silently mis-expands

**Subsystem:** common (`packages/calendar-core`) · **Severity:** HIGH (silent wrong data) · **Fix class:** CHANGE-CODE

## The defect

The **parser's** supported set and the **expander's** supported set are two independent definitions
with nothing keeping them in sync.

- `packages/calendar-core/src/ical.ts:129-150` parses `BYDAY`, `BYMONTHDAY`, `BYSETPOS`
  **unconditionally**, regardless of `FREQ`.
- `packages/calendar-core/src/index.ts:393-419` — the `yearly` branch reads only `byMonth` and
  `start.day`. `byDay`, `byMonthDay`, and `bySetPosition` are **never referenced**.
- `:318-345` — the `weekly` branch reads `byDay` but ignores `nthOfPeriod`.
- `applySetPos` is called from exactly one place: the `monthly` branch (`:377`).

## Why this is worse than a missing feature

`ical.ts:153-154` has an explicit *reject-what-we-can't-do* rule (`default: return null`) — so the
module already knows the right pattern. But because the BY* parts are parsed without checking
`FREQ`, an unsupported combination parses **clean** and then expands to the wrong dates.

Concrete: `FREQ=YEARLY;BYMONTH=11;BYDAY=4TH` — US Thanksgiving, a shape **Apple Calendar emits** —
parses successfully and expands to `start.day` of November every year. The user sees a recurring
event on confidently wrong dates, with no error anywhere.

Given the CLI is about to gain calendar write commands (`.plans/s05-cli-crud`), round-tripping such
a rule would also silently rewrite it.

## Doc drift

`packages/calendar-core/README.md:7-11` and the module header `src/index.ts:13-17` both advertise
`BYDAY` (incl. nth-of-period), `BYMONTHDAY`, `BYMONTH`, `BYSETPOS` with **no per-frequency
qualification** — so the docs promise what only the `monthly` branch delivers.
