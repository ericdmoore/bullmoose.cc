# 018 -E2-I3- Calendar CRUD over CLI

| | |
|---|---|
| **Kind** | projection |
| **Effort** | **E2** — one CLI module over live methods; no schema, no new JMAP method |
| **Impact** | **I3** — unlocks *and* human-verifiable |
| **Owner** | **`s05-cli-crud`** T3 |
| **Depends on** | `016` (I/O contract) · `003` (recurrence correctness — see below) |
| **Status** | todo |

## Cells covered

`Calendar × CRUD × CLI` · `CalendarEvent × CRUD × CLI`

Both read `-R--` today. `packages/cli/src/calendar.ts` is **97 lines** with exactly two JMAP
calls — `Calendar/get` at `:33` and `CalendarEvent/getOccurrences` at `:50`. **Zero `/set`
calls in the module.**

## Why these grades

**E2.** One module, reusing `packages/calendar-core/src/ical.ts` rather than reimplementing
conversion (`s05/arch.md:118-119`). The server side is live: `Calendar/set` at
`services/jmap/src/methods/calendars.ts:76`, `CalendarEvent/set` at `:199`.

**I3, both factors.** *Unlocks* — T3 feeds T5 (`s05/devPlan.md:104-108`), and `_index.md` §3
makes `018` half of the wave-2 acceptance moment: one write, three independent readers
(MCP, `bullmoose calendar agenda`, CalDAV `PROPFIND`). *Human-verifiable* — create an event
in the CLI, open Apple Calendar, see it.

## Owned by

**`s05` T3** (`s05/devPlan.md:43-58`): `calendar create|rename|rm`,
`calendar event create|edit|rm` over iCal or JSON on stdin, `calendar export [--ics]`, and
the recurrence **write** decision — bare `edit` hits the master, `--occurrence
<recurrenceId>` writes a `recurrenceOverrides` entry, a bare edit aimed at an occurrence id
is refused. Command → method table at `s05/arch.md:121-128`; the recurrence reasoning at
`arch.md:130-158`.

## What sVOL adds

**1. The `003` dependency, which s05 does not name.** `s05/devPlan.md:50-51` asserts the read
model is "already decided *and built*" and scopes T3 to the write side only. That is true of
the *storage* model and false of the *expander*. `common/003` (P1, open) is a live
correctness bug: `calendar-core`'s RRULE parser accepts rules the expander silently
mis-expands — `FREQ=YEARLY;BYMONTH=11;BYDAY=4TH` (Thanksgiving, **a shape Apple Calendar
emits**) parses clean and expands to `start.day` of November every year (`_context.md` §5).

That lands on T3 in a way its own done-when cannot catch. `--occurrence <recurrenceId>` keys
an override off a `recurrenceId` the CLI got from the expander, so a wrong expansion attaches
the override to a date the series does not have — a write that succeeds and does nothing
visible. Meanwhile "`agenda` reflects writes immediately" (`devPlan.md:58`) reads through that
same expander, so the CLI agrees with itself while disagreeing with Apple Calendar; and the
iCal → JMAP → iCal round-trip (`devPlan.md:56`) compares RRULE strings, not expansions, so it
passes either way.

`rruleToRule` returning `null` on unsupported parts (`arch.md:143-144`) does not help here:
these rules are *supported* by the parser. Build `003` first, or accept that T3's tests
cannot distinguish a correct write from a wrong one on any repeating event.

**2. T3 has two contradictory definitions of done.**

- `devPlan.md:56-57` — "editing one occurrence leaves the other occurrences untouched
  (**asserted in a test, not assumed**)"
- `devPlan.md:132-134`, under *Risk* — "If it gets hard, ship create/delete plus whole-series
  edit, and **defer single-occurrence editing** — a clear refusal is a perfectly good v1"

Both verified verbatim. One task, two acceptance bars, and the escape hatch deletes the
hardest clause of the primary one. Someone should pick: either single-occurrence editing is
in T3's scope or it is a follow-on unit with its own number. As written, T3 is done whenever
its builder decides it was hard.

## Open questions / where this could be wrong

1. **The `003` edge may be over-strong.** Single-instance calendar CRUD — probably most
   real use — is unaffected by the expander bug. A reviewer could argue `018` should ship
   without `003` and gate only `--occurrence` on it. I made it a hard edge because
   `agenda` is T3's own verification surface and it is the thing that is wrong.
2. **The recurrence contradiction might be intentional layering** — done-when as the goal,
   Risk as the fallback. But `devPlan.md:56` says "asserted in a test, not assumed", which
   is not language you fall back from silently.
3. **`Calendar/set` at `:76` and `CalendarEvent/set` at `:199` are registration lines.** The
   refs circulating elsewhere in `sVOL` (`:101`, `:220`) point *inside* those handlers, at
   the create phase. Both forms are real; the registration lines are the ones to grep for.
4. **Nothing was run**, and no CalDAV request from a real Apple Calendar was made against
   this deployment — the human-verifiable claim rests on `dav.ts` handlers alone.
