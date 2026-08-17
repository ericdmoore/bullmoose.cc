# 022 -E4-I3- Contacts + Calendar over WebUI

|                |                                                                                                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Kind**       | projection                                                                                                                                                                   |
| **Effort**     | **E4** — only because the WebUI stack does not exist. See _Why these grades_.                                                                                                |
| **Impact**     | **I3** — unlocks _and_ human-verifiable                                                                                                                                      |
| **Owner**      | **`sVOL`** — unowned by any `sNN` section                                                                                                                                    |
| **Depends on** | `021` (the `s03.C` shell + `JmapClient`) · optionally `012` for list filtering                                                                                               |
| **Status**     | **✅ done** (closed 2026-08-14) — `webmail/src/pages/{contacts,calendar}.astro` over `webmail/src/lib/{contacts,calendar}/`, live against real routes rather than `?demo=1`. |

## Cells covered

`AddressBook × CRUD × WebUI` · `ContactCard × CRUD × WebUI` ·
`Calendar × CRUD × WebUI` · `CalendarEvent × CRUD × WebUI`

16 cells — the entire Contacts and Calendar columns under WebUI.

## Why this unit exists at all: nobody owns it

This is a hole the matrix found, not a re-slicing of someone else's plan.

The parent arc names **four** data realms in its framing question:

> _What are the data realms we can build for humans + agents to co-exist in an inbox?_
> — Email · Contacts · Calendars · Files
> — `.plans/s03-webAccess/readme.md:18-19`

The arc then decomposes into five slices, and **the two that build WebUI surfaces build
two of the four realms**:

| Slice                 | Realms it surfaces             |
| --------------------- | ------------------------------ |
| `s03.C` webmail floor | Email, Files (`arch.md:54-61`) |
| `s03.E` console       | Agents, Secrets                |

Verified by grep, not by reading:

```
grep -rni "contact\|calendar" .plans/s03.C-webmail-floor/
  → arch.md:18: "A single module owns **all** protocol contact:"     ← one hit, unrelated
grep -rni "contact\|calendar" .plans/s03.E-console/
  → no matches
```

One hit across both slices, and it is the word _contact_ in the sense of "touches the
wire". `s03.C`'s surface inventory (`arch.md:54-61`) is six rows — Mailbox list, Thread
list, Thread view, Compose, Search, Files browser — and none of them is a contact or an
event. `s03.C/readme.md:60-61` lists what is out of scope and does not mention them
either; they were not deferred, they were never in frame.

Contacts and Calendars appear all over the _rest_ of the arc — as live JMAP capabilities
(`s03-webAccess/arch.md:18,44-45`), as realms needing provenance
(`s03.A/readme.md:17-18`), as approval-queue subjects (`s03.D/arch.md:22-23`). Every
slice assumes the human can see them somewhere. No slice builds the somewhere.

## Why these grades

**E4 — and this is the whole point of the unit.** The capability is _complete_: full CRUD
on both JMAP and DAV (`_context.md` §2). There is no schema work, no new method, no new
semantics. This unit is pure projection under `readme.md`'s law, and it grades E4 for
exactly one reason: `readme.md:73` puts _"anything on a stack that does not exist yet"_ at
E4, and the WebUI stack does not exist.

> **Said plainly: if `s03.C`'s shell and `JmapClient` already existed, this would be an
> `E2`.** Several files in one workspace, new surfaces over live methods, no migration.
> The grade is inherited from `021`, not earned here. That is also why `022` is filed
> separately rather than folded into `s03.C` — once the shell lands, this is a small,
> independently shippable slice, and pricing it as part of an XL blocks it behind one.

**I3, both factors:**

- _Human-verifiable_ — a person opens a browser, creates a contact, and sees the same
  card in Contacts.app over CardDAV. Three independent readers already exist for these
  nouns (WebUI, CLI, DAV), which makes cross-surface verification nearly free — the same
  triangulation `013` relies on.
- _Unlocks_ — `s03.D`'s approval queue proposes `"create-event"` and `"create-contact"`
  actions (`s03.D/arch.md:22-23`; the queue's own scope line is
  `s03.D/readme.md:19-20`). Approving a proposed contact has to land somewhere the human
  can then look at it. Without this unit, `s03.D` can render a proposal it cannot show
  the result of. This is an inference from `s03.D`'s scope rather than a sentence `s03.D`
  writes — flagged in _Open questions_.

## What exists today

**Capability: complete.** Every method this unit needs is registered
(`services/jmap/src/methods/index.ts:15-30`, 38 methods total):

|                 | get                | changes | set    | query  | queryChanges |
| --------------- | ------------------ | ------- | ------ | ------ | ------------ |
| `AddressBook`   | `contacts.ts:69`   | `:104`  | `:116` | —      | —            |
| `ContactCard`   | `contacts.ts:254`  | `:298`  | `:317` | `:529` | stub, `:559` |
| `Calendar`      | `calendars.ts:57`  | `:74`   | `:76`  | —      | —            |
| `CalendarEvent` | `calendars.ts:170` | `:195`  | `:199` | `:344` | stub, `:392` |

Plus `CalendarEvent/getOccurrences` (`calendars.ts:402`) — a bullmoose extension, not in
the draft spec, which is what the CLI's `calendar agenda` already renders.

⚠️ **STALE, and this unit is now BUILT.** Both halves shipped under `s07` T3 —
`/contacts` and `/calendar` are live pages with ~300 tests between them. The paragraph
below was the E4 justification and every clause of it is now false: `webmail/` exists,
and `tsconfig.json:33` is a closing brace.

**Regrade E4 → E2**, which this unit already conceded would be right once the shell
existed ("if s03.C's shell and JmapClient already existed, this would be an E2").

Three bread-crumbs this unit did not have, learned by building it:

1. **The group model.** A group is a **ContactCard** — not an AddressBook, not a property
   on member cards — carrying `kind: "group"` and `members` keyed by **UID** (RFC 9553
   §2.1.5), so membership needs a uid-filtered query and never a `/get`. Groups do **not**
   round-trip over CardDAV in either direction; see `.feedback` `common/039`.
2. **`ifInState` is not free.** This unit says threading `newState` from one write into the
   next makes optimistic concurrency free. It does not — the state is **account-wide**, so
   unrelated _mail_ advances it. Re-read, verify, write with that state, retry once.
3. **Recurrence must not be expanded in the browser.** Use `CalendarEvent/getOccurrences`.
   And `getOccurrences` returns two spellings — `start` (wall clock) and `utcStart` (the
   instant); all-day events must read `start` and **never** parse `utcStart`, or every
   viewer west of UTC sees the wrong day.

> ~~**Surface: nothing.** The WebUI column is empty for every noun. `ls webmail` fails;
> `tsconfig.json:33` excludes a directory that has never existed.~~

**Two capability edges to know about before designing screens:**

1. **There is no `Calendar/query` and no `AddressBook/query`** — see the table above, and
   the full registry list. Collection pickers must call `Calendar/get` / `AddressBook/get`
   with `ids: null` and filter client-side. That is fine at personal scale and is what the
   CLI does. Unit `012` adds the query methods if server-side filtering is ever wanted;
   it is **not** a blocker, which is why it is listed as optional above.
2. **`ContactCard/queryChanges` and `CalendarEvent/queryChanges` always throw**
   (`contacts.ts:559`, `calendars.ts:392`), consistent with the advertised
   `canCalculateChanges: false` (`contacts.ts:551`, `calendars.ts:385`). Incremental list
   updates come from `Foo/changes` + re-query, not from query deltas. See unit `026`.

## What to build

Four surfaces inside the `s03.C` shell, reusing its injected `JmapClient` (`arch.md:16-38`)
and its capability gate (`arch.md:69-77`).

| Surface                      | Methods                                                              |
| ---------------------------- | -------------------------------------------------------------------- |
| **Address book list**        | `AddressBook/get(ids:null)`, `AddressBook/set` create/rename/destroy |
| **Contact list + card view** | `ContactCard/query` + `ContactCard/get`, `ContactCard/set`           |
| **Calendar list**            | `Calendar/get(ids:null)`, `Calendar/set` create/rename/destroy       |
| **Agenda / month view**      | `CalendarEvent/query` + `getOccurrences`, `CalendarEvent/set`        |

Three constraints inherited from the audit, all of which are cheap to honour up front and
expensive to retrofit:

- **Write through the JMAP methods, always.** `_context.md` §3: `Mailstore` is a thin data
  layer that maintains no invariants. A write that skips `CalendarEvent/set`'s
  choreography (`calendars.ts:199-341` → `bumpCalendarCtags` `:329` → `commitCalendarEntries`
  `:330` → changelog) lands in the table, reads back on a direct `get`, and is invisible to every
  incremental consumer. For a browser client that means the JMAP endpoint, which is the
  only thing the shell can reach anyway — the trap here is smaller than it is for MCP, but
  the same rule applies to any "quick" REST helper someone adds later.
- **Batch.** `s03.C`'s invariant 5 (`arch.md:85`) — a view open is one round trip. JMAP
  back-references make this real: `packages/jmap-core/src/dispatch.ts:63-89` resolves
  `#key` / `resultOf` per RFC 8620 §3.7, so _query then get those ids_ is one POST.
- **Sync via `/changes`, not polling.** `AddressBook/changes`, `ContactCard/changes`,
  `Calendar/changes`, and `CalendarEvent/changes` all proxy to the AccountDO changelog
  (`services/jmap/src/methods/common.ts:69-104`), and `/api/ws`
  (`services/jmap/src/index.ts:89`) pushes the `StateChange`. This is the same machinery
  `s03.C` T1 already builds for mail; it needs the collection names added, nothing more.

**Recurring events: watch `common/003`.** The RRULE parser accepts rules the expander
mis-expands — `FREQ=YEARLY;BYMONTH=11;BYDAY=4TH` parses clean and expands to the wrong
dates (`_context.md` §5). A calendar UI is where a human first _notices_ that. Unit `003`
is not a hard dependency for building the screen, but it is a hard dependency for
trusting what the screen shows.

## Done when

1. A person creates an address book and a contact in the browser, then opens Contacts.app
   over CardDAV and sees both. **The address book used to be the interesting half** — until
   `009` shipped `MKCOL`/`MKCALENDAR`, the WebUI would have been the _only_ human surface
   that could create a collection. It no longer is, which lowers this screen's urgency: the
   remaining collection gap is _rename_ (`PROPPATCH`), not create.
2. Same for a calendar and a single-instance event, verified in Apple Calendar and in
   `bullmoose calendar agenda`.
3. An edit made in Contacts.app appears in the browser **without a reload** — proving the
   `/changes` + `/api/ws` path, not just the read path.
4. Deleting an event in the browser removes it from Apple Calendar on next sync, i.e. the
   `ctag` bumped. A passing `CalendarEvent/get` proves nothing here.
5. Nothing errors when the session lacks `urn:bullmoose:agent` — `s03.C`'s invariant 4
   (`arch.md:84`) applies to these surfaces too.

## Bread-crumbs

- `CalendarEvent/query` accepts only `inCalendar|uid|after|before|text|title` and sorts
  only on `start|updated|created` (`calendars.ts:344`, and the filter/sort handling
  below it). Do not build a UI filter the method will reject.
- Exactly one calendar per event is enforced server-side — `singleCalendarId`, defined at
  `calendars.ts:629` and applied on create (`:233`) and update (`:301`). A
  drag-between-calendars gesture is a move, not a multi-membership edit.
- All four `/set` methods honour `ifInState` (`contacts.ts:126,324`,
  `calendars.ts:84,204`). Thread the `newState` from a write into the next write and
  optimistic concurrency is free — the same advice `013` gives for MCP tools.
- Contact photos already round-trip through R2 per RFC 9610
  (`s03-webAccess/arch.md:23`, `mailstore:1771-1806`). The avatar path is blob upload,
  not a new mechanism.
- `getOccurrences` (`calendars.ts:402`) is the right call for a month/week grid; expanding
  recurrence in the browser would duplicate `calendar-core` and diverge from the CLI and
  DAV views.
- Zero test coverage exists for any of these methods (`_context.md` §5). Unit `002`
  (shared fake-D1 with `.batch()`) is what makes server-side regressions catchable; this
  unit's own tests use `s03.C`'s `FakeJmapClient` and need no D1 at all.

## Open questions / where this could be wrong

1. **The `I3` "unlocks" leg rests on an inference.** `s03.D` lists `"create-contact"` and
   `"create-event"` as approval-queue kinds (`arch.md:22-23`) but never writes _"and
   therefore we need contact/calendar views"_. If you read `s03.D` as only ever rendering
   proposals — never the approved result — then this unit unlocks nothing named and drops
   to **I1**. I think that reading is wrong (approving an action you cannot then inspect
   is not a coherent product), but it is a judgement call, not a citation.
2. **Should this be folded into `s03.C` instead?** The counter-argument is real: four
   realms in one shell with one client is one coherent build, and splitting it invites a
   webmail that ships "done" with two realms missing. I split it because `s03.C` is
   already the largest slice in the arc by its own admission (`devPlan.md:73`) and because
   the split is what made the hole _visible_. If `s03.C` ever adopts these surfaces, this
   file should become a pointer, not disappear.
3. **Scoping the E4→E2 claim.** I assert this is E2 once the shell exists. That assumes
   the shell's `JmapClient` is realm-agnostic — which `arch.md:21-27` implies
   (`request(methodCalls[])`, `sync(collection, sinceState)`) but which will only be true
   if T1 is built that way. If T1 hard-codes mail collections, this unit inherits shell
   work and the estimate is wrong.
4. **A calendar UI is not a small UI.** Month grid, drag-to-reschedule, timezone display,
   all-day vs timed, and recurrence _editing_ (this-event / this-and-future / all) are a
   genuinely large surface. The E2-once-the-shell-exists claim covers the data plumbing
   confidently and the interaction design much less so. Recurrence editing in particular
   may deserve its own unit.
5. **Nothing here was run.** All claims read from source. In particular I have not
   verified that Contacts.app round-trips against this deployment; the DAV half of
   _Done when_ rests on `dav.ts` handlers alone, the same caveat `_context.md` §7 states.
