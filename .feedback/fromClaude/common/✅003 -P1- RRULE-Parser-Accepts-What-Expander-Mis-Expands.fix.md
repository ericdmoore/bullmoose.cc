# FIX — 003 -P1- RRULE parser accepts rules the expander mis-expands

## Proposal

**One shared declaration of supported `(frequency, part)` pairs**, consulted by both the parser and
the expander — so an unsupported combination fails at _parse_ time instead of mis-expanding.

```ts
// packages/calendar-core/src/index.ts — single source of truth
export const SUPPORTED_PARTS: Record<Frequency, ReadonlySet<RulePart>> = {
  daily: new Set(["interval", "count", "until"]),
  weekly: new Set(["interval", "count", "until", "byDay"]), // no nthOfPeriod
  monthly: new Set(["interval", "count", "until", "byDay", "byMonthDay", "bySetPosition"]),
  yearly: new Set(["interval", "count", "until", "byMonth"]), // today's real capability
};
```

`rruleToRule` (`ical.ts:99`) then returns `null` — its existing "unsupported" signal — when a parsed
part isn't in the set for that `FREQ`. This reuses the module's own established convention rather
than inventing an error path.

## The decision this forces (worth making deliberately)

Returning `null` means **an Apple-Calendar Thanksgiving rule stops importing**. That is strictly
better than importing it wrong, but it is a visible behaviour change.

Two options, and I'd take (a) first:

- **(a) Reject now, extend later.** Ship the guard; unsupported rules are dropped with a warning.
  Honest, small, and unblocks the s05 calendar-write work safely.
- **(b) Implement `yearly` + `BYDAY`/`BYSETPOS` first**, then guard. Larger — `applySetPos` already
  exists and would need lifting out of the `monthly` branch to be reusable.

Either way the guard is what prevents the class of bug; (b) just narrows what it rejects.

## Bread-crumbs

- `applySetPos` (`index.ts:377`) is already generic enough to lift — it's the `monthly` branch that
  is special-cased around it, not the function.
- The `weekly` + `nthOfPeriod` case ("2nd Monday, weekly") is arguably meaningless in RFC 5545 terms;
  confirm against the spec before deciding whether it belongs in the supported set at all.
- **Test shape:** a table of real-world RRULEs (Thanksgiving, "last Friday monthly", "every 2nd
  Tuesday", `FREQ=YEARLY;BYDAY=…`) asserting each either expands to _correct_ dates or returns
  `null`. No third outcome. That table is the regression net for any future expander work.
- Coordinate with `.plans/s05-cli-crud` T3 — it plans calendar write commands and iCal round-trip
  tests; this guard should land first or the round-trip test will encode the bug.

## Docs to update

`packages/calendar-core/README.md:7-11` and `src/index.ts:13-17` — qualify the supported parts
**per frequency**, so the README stops promising the union.
