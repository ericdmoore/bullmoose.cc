# 003 -E2-I3- Recurrence correctness before calendar writes

| | |
|---|---|
| **Kind** | prerequisite |
| **Effort** | **E2** — two files in `packages/calendar-core` plus its first test file; no schema change, no migration |
| **Impact** | **I3** — unlocks *and* human-verifiable (a Thanksgiving event lands on the right date in Apple Calendar) |
| **Owner** | **`.feedback/fromClaude/common/003`** — the defect and the fix are filed there; this file carries the cell mapping, the grades, the dependency edges, and the test work the issue does not cover |
| **Depends on** | — |
| **Blocks** | `013` (Calendar + Contacts over MCP — recurring events only) · `018` (Calendar CRUD over CLI — s05 T3) |
| **Status** | todo |

## Cells covered

**None.** No cell is missing — `CalendarEvent × CRUD` is already `CRUD` on both JMAP and DAV
(`_index.md` §1). The capability exists and is **wrong for a common class of input**, which the
grid cannot express. This is the one place in the volume where a filled cell is a liability.

It **gates the recurring-event half** of:

- `013` — `CalendarEvent × C/U × MCP`. `013:106-113` already scopes itself to single-instance
  events and names this unit as the reason.
- `018` — `CalendarEvent × C/U × CLI` (`s05` T3). The fix note
  (`003 -P1- ….fix.md:45-46`) flags the same edge from the other direction: T3 plans iCal
  round-trip tests, and if those land first they will encode the bug as expected behaviour.

Single-instance calendar writes are **not** blocked by this and should not wait for it.

## Why these grades

**E2.** The code change is confined to `packages/calendar-core` — a shared table in `index.ts`
and a guard in `rruleToRule` (`ical.ts:99-158`). Two source files, one new test file, no new
method, no table, no migration. The package has zero external imports (`ical.ts:1-9` imports
only from `./index.js`; nothing else in either file imports anything), so nothing else has to
be rebuilt or re-wired.

**I3, both factors:**

- *Unlocks* — `013` and `018` both name it. `013` is explicitly reduced in scope until it lands.
- *Human-verifiable*, and unusually cleanly so: create a Thanksgiving event in Apple Calendar,
  let it sync, and look at what the next four years show. A non-engineer can do that and can
  tell the difference. Contrast most `I3` claims in this volume, which need a CLI reader.

## What exists today

**Read the filed issue first:**
`.feedback/fromClaude/common/003 -P1- RRULE-Parser-Accepts-What-Expander-Mis-Expands.md`
and its `.fix.md` sibling. This section does not restate them. The one-line version:

> The parser's supported set and the expander's supported set are two independent definitions
> with nothing keeping them in sync, so an unsupported `(FREQ, BY*)` combination parses **clean**
> and then expands to the wrong dates.

The `.fix.md` proposes one shared `SUPPORTED_PARTS: Record<Frequency, ReadonlySet<RulePart>>`
consulted by both sides, with `rruleToRule` returning its existing `null` signal
(`ical.ts:153-154` already has a `default: return null` for unknown *keys*; this extends the
same convention to unsupported *combinations*). It recommends **(a) reject now, extend later**
over (b) implementing yearly `BYDAY` first. I agree with (a) and have nothing to add to the
reasoning.

### What I verified, by running it

I copied `index.ts` and `ical.ts` out of the tree and executed them under Node 24. This is the
only unit in `sVOL` whose central claim is confirmed by execution rather than by reading.

```
FREQ=YEARLY;BYMONTH=11;BYDAY=4TH   parsed: {"frequency":"yearly","byMonth":["11"],
                                            "byDay":[{"day":"th","nthOfPeriod":4}]}
  master start 2026-11-26 (Thu, correct) →
    Fri, Nov 26, 2027     truth: Thu, Nov 25
    Sun, Nov 26, 2028     truth: Thu, Nov 23
    Mon, Nov 26, 2029     truth: Thu, Nov 22
    Tue, Nov 26, 2030     truth: Thu, Nov 28
```

Wrong by up to four days, on a weekday that isn't Thursday, silently, for a rule **Apple
Calendar emits**. The `byDay` field is parsed, stored, serialized back out by `ruleToRrule`
(`ical.ts:83-89`), and never read by the expander.

**Three cases the filed issue does not name.** Same method, same run:

| RRULE | expands to | should be |
|---|---|---|
| `FREQ=MONTHLY;BYMONTH=11;BYDAY=4TH` | 4th Thursday of **every** month — Nov 26, **Dec 24, Jan 28, Feb 25** | November only |
| `FREQ=DAILY;BYDAY=MO` | every single day | Mondays |
| `FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=25` from a Dec 20 start | Dec **20** every year | Dec 25 |

The monthly branch (`index.ts:347-391`) reads `byDay`, `byMonthDay` and `bySetPosition` but
**never references `rule.byMonth`** — so `byMonth` is a no-op on the one frequency where
`applySetPos` works. The daily branch (`index.ts:303-316`) references no `BY*` part at all. The
third row is the dangerous direction: the wrong date is *earlier* than the true one.

`FREQ=WEEKLY;BYDAY=2MO` → every Monday, `nthOfPeriod` dropped. That one **is** in the filed
issue (`:14`).

### Why this must land before writes, not after

`eventSpan` (`index.ts:444-470`) runs at **write** time on both write surfaces —
`services/jmap/src/methods/calendars.ts:532` and `services/anglebrackets/src/dav.ts:952` — and
its `startMs`/`endMs` are persisted into the `calendar_events.start_at` / `end_at` index
columns. Measured, for `FREQ=YEARLY;BYMONTH=11;BYDAY=4TH;COUNT=3` starting 2026-11-26:

```
eventSpan().endMs  →  Nov 26, 2028        truth: Nov 23, 2028
```

`Mailstore.queryCalendarEvents` filters candidates on those columns
(`packages/mailstore/src/index.ts:1682-1689`) under a documented invariant
(`:1662-1666`): *"the span can over-include, never miss."* A mis-computed span can miss. And
because the value is written into an indexed column at write time in a repo with **no migration
framework** (`tools/README.md:10-11`), every event written before the fix carries a wrong
`end_at` that a code fix does not correct. Landing this after `013`/`018` means a backfill with
no backfill mechanism.

### Why the volume's own acceptance test cannot catch this

`_index.md:118-122` names the wave-2 acceptance moment: an event created over MCP, read back by
Codex over MCP, by `bullmoose calendar agenda`, and by a CalDAV `PROPFIND` — *"three
independent projections over one write — the difference between self-consistent and correct."*

For recurrence, those three projections are **not** independent. All three call the same
`expandOccurrences`: `calendars.ts:378` and `:433` (JMAP query + `getOccurrences`), and
`dav.ts:888` (CalDAV `time-range` REPORT). Every bullmoose surface agrees on Nov 26 because
every bullmoose surface asks the same wrong function. The only reader that disagrees is Apple
Calendar's own RFC 5545 expander running on the device — which is exactly the fourth reader this
unit's human-verification step uses, and exactly why that step is the acceptance criterion here
rather than the triangulation.

### The test gap — this is the part the filed issue does not own

`packages/calendar-core` has **zero tests**. Two source files, 35 KB, and it is the package the
project's own docs single out as the concentrated risk.

It is also the **cheapest test target in the repo**, by some distance (`README.md:3-5` calls it
*"where the calendar risk concentrates"*):

- Pure functions. `expandOccurrences`, `eventSpan`, `rruleToRule`, `ruleToRrule`, `parseICal`,
  `serializeICal` take data and return data.
- **No D1, no R2, no Durable Object, no `Env`, no network.** The package's only external
  contact is `Intl`, `Date`, `TextEncoder` and `crypto.randomUUID()` — all Node globals.
- Therefore **no dependency on `002`.** Every other write-path test in this volume waits on the
  fake-D1 work; this one needs `vitest` and nothing else. It is the only substantial test in
  `sVOL` that can be written today, with no prerequisite, by one person, in one sitting.

`vitest.config.ts:9` already includes `packages/**/*.test.ts`, so
`packages/calendar-core/src/index.test.ts` is collected with no config change.

## What to build

### 1. The guard — see `003 -P1- ….fix.md`

Implement option (a) from the fix: one `SUPPORTED_PARTS` table, `rruleToRule` returns `null` for
an unsupported `(frequency, part)` pair. Two additions to the table the fix proposes, from the
cases above:

- `monthly` must **not** list `byMonth` — the monthly branch ignores it (verified).
- `daily` must list only `interval`/`count`/`until` — which the fix already has right.

`parseICal` already handles a `null` from `rruleToRule` by dropping the rule with a warning
(`ical.ts:485-489`: *"unsupported RRULE kept out"*), so the rejection path exists and is wired.
Confirm the warning actually surfaces to a CalDAV `PUT` rather than being discarded — I did not
trace `ParsedICal.warnings` past `dav.ts`.

### 2. The test table — this unit owns it

The fix note sketches it (`.fix.md:42-44`); make it the deliverable. A table of real-world
RRULEs, each asserting **exactly one of two outcomes**:

- it parses **and** expands to dates verified against an external authority, or
- `rruleToRule` returns `null`.

**No third outcome.** "Parses and expands to something we didn't check" is the bug.

Minimum table, all five reproduced above plus the shapes that currently work:

| RRULE | after the fix |
|---|---|
| `FREQ=YEARLY;BYMONTH=11;BYDAY=4TH` | `null` (Thanksgiving — Apple emits it) |
| `FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=25` | `null` |
| `FREQ=MONTHLY;BYMONTH=11;BYDAY=4TH` | `null` |
| `FREQ=DAILY;BYDAY=MO` | `null` |
| `FREQ=WEEKLY;BYDAY=2MO` | `null` |
| `FREQ=MONTHLY;BYDAY=-1FR` | expands — last Friday, dates asserted |
| `FREQ=MONTHLY;BYDAY=TU;BYSETPOS=2` | expands — 2nd Tuesday, dates asserted |
| `FREQ=WEEKLY;BYDAY=MO,WE,FR;INTERVAL=2` | expands |
| `FREQ=DAILY;COUNT=10` / `;UNTIL=…Z` | expands, both bounds honoured |

Expected dates must come from **outside this codebase** — a hand-checked calendar, or `python3
-c "from dateutil.rrule import …"`. Generating them from `expandOccurrences` and pasting them in
produces a test that asserts the code does what it does.

### 3. Cover the rest of the package while you are there

The guard is the fix; the table is the regression net. But the same sitting should cover what
else is untested and cheap, because the marginal cost is near zero and the package will not get
a second visit:

- **DST wall-clock** — the module's headline promise (`index.ts:6-9`, `README.md:12-14`): a
  9am weekly standup stays 9am across a US DST transition. `zonedToUtc` (`index.ts:142-153`)
  does a three-pass offset resolution and documents spring-forward-gap behaviour; assert it.
- **`MAX_OCCURRENCES = 1000`** (`index.ts:51`) and `MAX_ITERATIONS = 20000` (`:53`): an
  unbounded daily rule with a far-future window returns at most 1000 and **terminates**. The
  `skipToMs` fast-forward (`:301-309`, `:325-329`) exists because the free-tier CPU budget is
  10 ms; it is untested arithmetic on a hot path.
- **`eventSpan` unbounded** → `endMs: null` (`:461-462`), and the `>= MAX_OCCURRENCES` →
  `endMs: null` fallback (`:467`). Both feed the index column.
- **iCal round-trip**: `parseICal(serializeICal(e))` preserves the event. This is what `s05` T3
  plans to write; write it here, after the guard, so it cannot encode the bug.
- **`recurrenceOverrides`**: excluded (`:249`), patched (`:229-236`), and RDATE-style additions
  for keys the rule never generated (`:252-257`). Three distinct branches, none exercised.

### 4. The docs the fix names

`packages/calendar-core/README.md:7-11` and the module header `src/index.ts:13-17` both
advertise `BYDAY` (incl. nth-of-period), `BYMONTHDAY`, `BYMONTH`, `BYSETPOS` with **no
per-frequency qualification** — they promise the union of what only `monthly` delivers. Qualify
both per frequency. `SUPPORTED_PARTS` should be the thing the README describes, so they cannot
drift again.

## Done when

1. `FREQ=YEARLY;BYMONTH=11;BYDAY=4TH` returns `null` from `rruleToRule`, and `parseICal` on a
   VCALENDAR containing it produces an event with no `recurrenceRules` and a warning.
2. The RRULE table passes, with every expected date sourced from outside this codebase.
3. Every combination the table declares unsupported is *rejected*, not silently mis-expanded —
   assert on `null`, never on "no exception thrown".
4. `packages/calendar-core` coverage goes from 0% to a number worth reporting. `npm run
   coverage` writes `coverage/coverage-summary.json` (`vitest.config.ts:18`), which CI diffs
   across runs; this is the first entry in it that means anything.
5. **The human check.** Create a repeating Thanksgiving event in Apple Calendar against a real
   bullmoose account, sync, and confirm the next four years land on Nov 25 2027, Nov 23 2028,
   Nov 22 2029, Nov 28 2030 — *or* that the client is told the rule was refused. Both are
   acceptable outcomes of option (a); silently showing Nov 26 is not.
6. `README.md` and the `index.ts` header describe supported parts **per frequency**, generated
   from or checked against `SUPPORTED_PARTS`.

## Bread-crumbs

- The parse path is `rruleToRule` (`ical.ts:99-158`). It is a flat `switch` over `;`-separated
  parts (`:106`) with no cross-part validation; the only check is `return rule.frequency ? rule
  : null` at `:157`. The guard belongs after the loop, where `frequency` is finally known —
  parts can appear before `FREQ` in the string.
- `expandOccurrences` always seeds the master start into `baseStarts` (`index.ts:217`) before
  any rule runs. So a rejected or mis-expanded rule still yields **one** occurrence at the
  master start. That is why the bug looks like "the series drifted" rather than "the event
  vanished", and it is why a smoke test that checks "the event exists" passes.
- `applySetPos` (`index.ts:424-432`) is called from exactly one place, the monthly branch
  (`:377`). It is already generic; it is the branch that is special-cased around it, not the
  function. Relevant only if someone takes option (b).
- `ruleToRrule` (`ical.ts:75-96`) serializes every field it finds regardless of frequency, so a
  rule that got in before the guard round-trips back out intact. The guard on the parse side
  does not clean stored data.
- Both write surfaces go through `eventSpan`, and both wrap it in try/catch converting a throw
  into a 400-ish error (`calendars.ts:530-536` → `SetErrorSignal("invalidProperties", …)`;
  `dav.ts:950-955` → HTTP 400). So the write path is already prepared to reject an event on
  recurrence grounds — the guard has somewhere to land. (Exact spans: `calendars.ts:530-537`,
  `dav.ts:950-955`.)
- The expander's four branches, for reference: daily `index.ts:303-316`, weekly `:318-345`,
  monthly `:347-391`, yearly `:393-419`. The yearly branch's whole use of the rule is `byMonth`
  at `:394-397` and `{ ...start, year, month }` at `:403` — `start.day`, carried through the
  spread. That single spread is the Thanksgiving bug.
- `.plans/s05-cli-crud` T3 is the other consumer. Coordinate, per `.fix.md:45-46`.

## Open questions / where this could be wrong

1. **The ledger contradicts itself on this unit's effort.** `_index.md:54` grades it `E2`;
   `_index.md:169` writes *"E3 | 3 | 004, 026 — plus 003's test work"* — which counts it as `E3`
   and is how the totals reach 3. Both cannot be right. I kept `E2` in the filename because the
   change is two files in one package with no migration and no new table, and because §5 is
   arithmetic rather than a grade. But the `E3` case is real: `readme.md`'s `E3` anchor includes
   *"new semantics that other code must respect"*, and `SUPPORTED_PARTS` is exactly a contract
   the parser, the expander, and the README must all respect, with *"Tests mandatory"* attached.
   Someone should pick one. **This affects the totals table either way** — see the report.

2. **Option (a) breaks a working-looking import, and I am recommending it on the fix note's
   authority rather than my own evidence.** After the guard, an Apple Calendar Thanksgiving event
   stops syncing instead of syncing wrong. That is correct, and I believe it. But I do not know
   what Apple Calendar *does* with a `PUT` whose RRULE the server drops — silently accept the
   truncated event, retry, show an error, or fall out of sync in a way the user cannot recover
   from. That behaviour determines whether (a) is acceptable or whether (b) is forced, and I
   could not determine it by reading. **This is the largest unverified thing in the unit.**

3. **The `.fix.md` scopes the guard to the parse path only.** `CalendarEvent/set` accepts
   JSCalendar directly over JMAP and MCP — a `recurrenceRules` array can arrive without ever
   passing through `rruleToRule`. `013` would let an agent construct one from natural language.
   The guard as designed does not cover that path. Either `SUPPORTED_PARTS` is also checked in
   `eventSpan`/`expandOccurrences`, or `013` and `018` can reintroduce the exact bug through the
   front door. The filed issue does not raise this and I think it is a genuine hole.

4. **I did not verify the "Apple Calendar emits this" claim.** It is asserted in the filed issue
   and in `_context.md` §5, and it is the load-bearing justification for the whole unit's
   priority — if Apple emits `BYDAY=4TH` only rarely, or emits `BYMONTHDAY` instead, the
   urgency changes. I did not capture a `PUT` body from a real device. Everything else about the
   defect I reproduced; this one input-frequency claim I took on trust.

5. **My "cheapest test in the repo" claim is comparative and I only checked one comparison.**
   `calendar-core` needs no D1 — verified, it imports nothing. `packages/contacts-core`,
   `packages/mime`, and `packages/jmap-core` may be equally pure and equally cheap, and one of
   them might be a better first test. I did not look. The claim I am confident in is the weaker
   one: `calendar-core` is cheap **and** it is where a known P1 lives, which is the combination
   that matters.

6. **My reproduction ran the sources outside the build.** I copied `index.ts` and `ical.ts` to a
   scratch directory and rewrote the `./ical.js` / `./index.js` specifiers to `.ts` so Node's
   type-stripping could resolve them (`moduleResolution: "Bundler"`, `tsconfig.json:6`, means the
   `.js` specifiers only resolve under vitest or wrangler). The logic is byte-identical, but it
   is not the module graph that deploys. A reviewer wanting certainty should re-run it as a real
   `packages/calendar-core/src/index.test.ts` — which is this unit's deliverable anyway.

7. **`vitest.config.ts:23` includes `packages/**/src/**/*.ts` in coverage**, so `calendar-core`
   is already being reported at 0% today. I am asserting that as a fact about the config, not
   from having run `npm run coverage`.
