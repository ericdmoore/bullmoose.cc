# 012 -E1-I1- `AddressBook/query` + `Calendar/query`

|                |                                                                                 |
| -------------- | ------------------------------------------------------------------------------- |
| **Kind**       | capability                                                                      |
| **Effort**     | **E1** — two in-memory methods over reads that already exist, no schema change  |
| **Impact**     | **I1** — human-verifiable, unlocks nothing (contested — see _Why these grades_) |
| **Owner**      | `sVOL`                                                                          |
| **Depends on** | —                                                                               |
| **Status**     | **wontfix** — the specs define neither method (see _Resolution_ below)          |

## Resolution (2026-08 — verified against the RFC text)

**Both `/query` methods are wontfix. Neither noun's `/query` exists in the specification,
so building it would invent non-standard JMAP surface — not close a gap.** Open Question #1
(_"these methods may not exist in the specs"_) was the single blocking check and it is now
answered from the authoritative source, confirming the doubt the author recorded from
`contacts.ts:25-26`.

**AddressBook/query — does not exist. RFC 9610 (JMAP for Contacts), §2** defines exactly three
AddressBook methods:

- §2.1 `AddressBook/get`
- §2.2 `AddressBook/changes`
- §2.3 `AddressBook/set`

There is no `AddressBook/query`. The item type does have one: §3.3 `ContactCard/query`.
(Source: <https://www.rfc-editor.org/rfc/rfc9610.txt>.)

**Calendar/query — does not exist. `draft-ietf-jmap-calendars-27` (JMAP for Calendars), §4**
defines exactly three Calendar methods:

- §4.1 `Calendar/get`
- §4.2 `Calendar/changes`
- §4.3 `Calendar/set`

There is no `Calendar/query`. The item type does have one: §5.11 `CalendarEvent/query`.
(Source: <https://datatracker.ietf.org/doc/html/draft-ietf-jmap-calendars-27>.)

**Interpretation.** The container-vs-item `/query` asymmetry this file kept circling is
deliberate in the specs, not an accidental omission: both specs give the high-cardinality item
type (`ContactCard`, `CalendarEvent`) a `/query` and withhold it from the low-cardinality
container (`AddressBook`, `Calendar`). The repo's existing surface — `AddressBook/get·set·changes`

- `ContactCard/query`, and the exact mirror on the calendar side — is therefore already the
  complete, conformant set. `Mailbox/query` is not a counter-precedent: it exists because RFC 8621
  §2.3 explicitly defines it. No spec defines these two.

**Decision, per noun (the unit file split them deliberately):**

- **`AddressBook/query`: do not build.** Not in RFC 9610. The grant-filtering concern in
  _What to build_ is moot — there is no method to attach it to.
- **`Calendar/query`: do not build.** Not in calendars-27.

No code was written. No `methods/index.ts` registration was added. `services/jmap` is unchanged;
the pre-existing 769 tests remain the baseline. The genuine-value filter this file floated
(`isShared`/`hasShareWith` on address books, done-when #1's CLI flag) can still be delivered
without inventing a JMAP method — as a CLI-side filter over `AddressBook/get`, which is where the
existing consumers (`packages/cli/src/contacts.ts:318`) already filter — but that belongs to a
CLI unit, not here.

## Cells covered

`AddressBook × Read (query) × JMAP` · `Calendar × Read (query) × JMAP`

Two cells, and they are the two footnote-7 asterisks on the `CRUD` entries in the grid
(`_context.md` §2). Both nouns are otherwise complete on JMAP.

## Why these grades

**This may not be worth doing, and the grades are how you can tell.** `E1`/`I1` is the
lowest-value combination in the volume that is not `I0`. The unit is in the ledger because the
grid is meant to be exhaustive, and an exhaustive grid surfaces cells that are gaps in the
pattern-completion sense without being gaps in the something-is-broken sense. An account has one
address book and one calendar unless the user goes out of their way; `/get` with `ids: null`
returns the whole set in one call, and both existing clients already filter that set in
JavaScript. Nothing is blocked. Nothing is slow. Read _What to build → When it would matter_
before picking this up; if none of those conditions hold, leave the unit in the ledger as
evidence that the cell was considered and rejected.

**E1.** One method added to `services/jmap/src/methods/contacts.ts`, one to
`services/jmap/src/methods/calendars.ts`. No schema change, no new dependency, no new
`Mailstore` method — both would filter and sort in memory over the rows `getAddressBooks` /
`getCalendars` already return, because the sets are tiny. `Mailbox/query`
(`services/jmap/src/methods/mailbox.ts:54-89`) is the working precedent for exactly that
approach and is 36 lines including the filter helper's call site. Two files, so it fails E1's
"one file" wording (`readme.md:69`) — the two halves are independent and could ship separately;
they are one unit because they are the same 36 lines twice.

**I1 — and I am not confident.** The rubric's two factors (`readme.md:84-88`):

- _Unlocks other work: **no**._ No unit in `_index.md` depends on `012`, and I could not
  construct a plausible future one. Both container sets are already reachable. This is the
  clear half of the grade.
- _Human can verify: **arguably not**, which would make this `I0`._ `readme.md:92-96` is harsh
  on purpose: verification means a non-engineer confirming it through a normal interface, and
  "`curl` returning correct JSON is **not** human-verifiable." Shipped alone, `AddressBook/query`
  is observable only by an engineer with a JMAP client. Rewiring `bullmoose contacts list` to
  call `/query` instead of `/get` changes nothing a human sees — same books, same order.

  The `I1` grade survives only if the unit ships a filter a human can actually _drive_ — e.g.
  `bullmoose contacts books --shared` or `--name <substring>`, where the person types a
  constraint and watches the list shrink. That is one more CLI flag, in the spirit of
  `readme.md:110`. **Without it, grade this `I0`.** I left the ledger at `I1` on the assumption
  the flag ships with the method; a reviewer who thinks that assumption is doing too much work
  is right to downgrade it.

## What exists today

**Both `/query` methods are absent.** `registerContactsMethods`
(`services/jmap/src/methods/contacts.ts:66-562`) registers:

```
AddressBook/get       contacts.ts:69
AddressBook/changes   contacts.ts:104
AddressBook/set       contacts.ts:116
ContactCard/get       contacts.ts:254
ContactCard/changes   contacts.ts:298
ContactCard/set       contacts.ts:317
ContactCard/query     contacts.ts:529     ← the item type has one
ContactCard/queryChanges  contacts.ts:559 (always throws)
```

`registerCalendarMethods` (`services/jmap/src/methods/calendars.ts:54-...`) mirrors it exactly:

```
Calendar/get          calendars.ts:57
Calendar/changes      calendars.ts:74
Calendar/set          calendars.ts:76
CalendarEvent/get     calendars.ts:170
CalendarEvent/changes calendars.ts:195
CalendarEvent/set     calendars.ts:199
CalendarEvent/query   calendars.ts:344     ← the item type has one
CalendarEvent/queryChanges  calendars.ts:392 (always throws)
CalendarEvent/getOccurrences  calendars.ts:402
```

**The asymmetry is deliberate on the item side and incidental on the container side.** The item
types got `/query` because clients page through thousands of cards and events. The container
types did not, because nobody paged through one address book.

**Every existing consumer already filters client-side, and it costs nothing.**

- `packages/cli/src/contacts.ts:318` — `client.one("AddressBook/get", { accountId, ids: null }, …)`
  then resolves `--book` by name or id in JavaScript.
- `packages/cli/src/calendar.ts:33` — `client.one("Calendar/get", { accountId, ids: null }, …)`
  for `bullmoose calendar list`.
- The DAV worker does not use JMAP at all for collection listing: `services/anglebrackets/src/dav.ts:207`
  calls `store.getAddressBooks(...)` and `:622` calls `store.getCalendars(...)` directly against
  `Mailstore`. **A `/query` method would not be reachable from CalDAV/CardDAV even if it
  existed.**

**How many containers are there, really?** One, in the normal case.
`ensureDefaultBook` (`contacts.ts:939`) and `ensureDefaultCalendar` (`calendars.ts:652`) each
lazily create exactly one on first `/get`. `contacts import` auto-creates a book if `--book`
names a missing one (`_context.md` §2 fn8). `AddressBook/set` and `Calendar/set` can create
more, but no surface in the repo does so routinely.

**Compare the one container `/query` that does exist and why.** `Mailbox/query`
(`mailbox.ts:54`) was built for a stated external reason, recorded in the source at `mailbox.ts:53`:

```ts
// himalaya enumerates folders via query, not get (§15 punch list).
```

That is the shape of the justification this unit does not have. `docs/architecture/serverless-jmap.md:252`
names himalaya's JMAP conformance tests as the acceptance target for the mail surface; there is
no equivalent third-party client driving the contacts or calendar containers.

## What to build

If you build it, build it as a copy of `Mailbox/query` (`mailbox.ts:54-89`), not as a new
`Mailstore` query path:

```
requireAccount(ctx, args, "read", "contacts" | "calendar")
rows = store.getAddressBooks(accountId)   /  store.getCalendars(accountId)
filtered = applyFilter(rows, args.filter)
sort by args.sort ?? [{ property: "name", isAscending: true }]
slice by position/limit (clamped)
return { accountId, queryState, canCalculateChanges: false, position, ids, [total] }
```

**Filter properties** worth supporting, all backed by real columns
(`packages/mailstore/sql/data-plane.sql:159-171` and `:206-219`): `name` (substring,
case-insensitive), `isSubscribed`, `isDefault`. `AddressBook` additionally has the sharing
facade — a `isShared` / `hasShareWith` condition is the one filter with genuine value, because
it is the only property a client cannot cheaply derive from `/get` for a _sharee_ (they read
`shareWith` as `null` per RFC 9670, enforced at `contacts.ts:81`).

**Sort properties**: `name`, `sortOrder`. Both are columns; the calendar row also has `color`
and `createdAt`, neither of which is a plausible sort key.

**Reuse the filter-operator handling.** `applyMailboxFilter` (`mailbox.ts:98-124`) already
implements the `FilterOperator` recursion and explicitly rejects `OR`/`NOT` with
`invalidArguments` (`:105-107`) — a legitimate simplification for container listing, and
precedent for doing the same here rather than writing a general filter evaluator.

**Mirror the grant restriction on the contacts side.** `AddressBook/get` filters to
`allowedBookIds(access, "read")` (`contacts.ts:72,77`) and `ContactCard/query` passes
`restrictToBooks` (`contacts.ts:545`). A `/query` that skips this leaks the _existence and
names_ of books a sharee cannot read. **This is the only place in this unit where a mistake has
a security consequence**, and it is the reason not to treat the two halves as symmetric —
`Calendar` has no equivalent grant filter in `Calendar/get` (`calendars.ts:57-72`) today.

**Do not** add `AddressBook/queryChanges` or `Calendar/queryChanges`. Return
`canCalculateChanges: false` and let conformant clients re-query, consistent with the four
existing deliberate throws (`_context.md` §1).

**Update the session capabilities if you add them?** No — neither `contactsCapability`
(`packages/jmap-core/src/capabilities.ts:34-37`) nor the calendars capability
(`services/jmap/src/session.ts:52`, `{}`) advertises query support, and the JMAP core spec does
not require a per-method flag.

### When it would matter

Concrete conditions under which this stops being a pattern-completion exercise:

1. **Sharing lands at scale.** The grant model already exists (`contacts.ts:40-48` describes
   `shareWith` as a facade over `AddressBook`-scoped grants; `matchingGrants` is
   `packages/auth-core/src/principal.ts:217-224`). An account that is a sharee on twenty
   colleagues' books has twenty rows in one `/get`, and "show me only the ones I can write to"
   becomes a real query rather than a loop.
2. **A third-party client demands it.** Exactly the `Mailbox/query` story (`mailbox.ts:53`).
   If a JMAP contacts client enumerates books via `/query` and errors on `unknownMethod`, this
   unit stops being optional and its impact grade changes — that would make it a compat fix,
   sequenced immediately.
3. **A WebUI with a container picker** (`022` in the ledger) that wants server-side paging.
   Unlikely at these cardinalities, but it is the scenario where a `total` and a `position`
   earn their keep.

None of these hold today. **If a reviewer wants to strike this unit and record it as
deliberately-uncovered in `_index.md` §4 alongside `Secrets × Read`, that is a defensible call
and I would not fight it hard.** The counter-argument is only that the two container types are
the last two asymmetric cells in an otherwise complete JMAP grid, and asymmetries that nobody
wrote down get rediscovered expensively.

## Done when

1. `bullmoose contacts books --name work` (or whatever the driving flag ends up being) prints a
   filtered list a person typed the constraint for. Without a human-drivable filter this unit
   has no done-when that satisfies `readme.md:92-96`, and should be regraded `I0` — see
   _Why these grades_.
2. `queryState` returned by both new methods **equals** the `state` returned by the
   corresponding `/get` on the same unchanged account, and **changes** after an
   `AddressBook/set` / `Calendar/set` write. This is the read-side form of the choreography
   assertion (`_context.md` §3): both methods must derive state from `accountState(ctx, …)`
   (`common.ts:62-66`, i.e. the AccountDO), not from a locally computed value or a row
   timestamp. Get that wrong and clients cache stale container lists across writes — the same
   failure class as skipping `commitChanges`, arrived at from the read side.
3. A sharee's `AddressBook/query` returns **only** their granted books — verified against the
   same principal's `AddressBook/get`, which must return the identical id set. If the two
   disagree, the `/query` path is missing `allowedBookIds`.
4. An unsupported filter property returns `unsupportedFilter`, and `OR`/`NOT` operators return
   `invalidArguments`, matching `applyMailboxFilter` (`mailbox.ts:105-107`) and
   `CalendarEvent/query`'s property check (`calendars.ts:349-355`).
5. `position` past the end returns an empty `ids` array, not an error.

## Bread-crumbs

- The two files to edit are `services/jmap/src/methods/contacts.ts` (1081 lines) and
  `services/jmap/src/methods/calendars.ts` (717 lines). Add each registration next to its
  sibling `/get` so the file's noun-grouped ordering survives.
- `applyMailboxFilter` (`mailbox.ts:98-124`) is copy-paste-adaptable and is the only in-repo
  example of an in-memory JMAP filter. `validateContactFilter` (`contacts.ts:1047`) and
  `validateContactSort` (`contacts.ts:1065`) are the pushdown-to-SQL style used for items —
  the wrong model here.
- `ContactCard/query`'s response shape (`contacts.ts:548-555`) is the one to match field for
  field, including `canCalculateChanges: false` and the conditional `total` gated on
  `args.calculateTotal === true`.
- The `AddressBook` row shape is `bookToJmap` (`contacts.ts:592-606`); the calendar's is
  `calendarToJmap` (`calendars.ts:483`). Those tell you which properties are even filterable.
- Scope/domain: `"read"` + `"contacts"` and `"read"` + `"calendar"` respectively, matching the
  `/get`s at `contacts.ts:70` and `calendars.ts:58`. ⚠️ `common/001` (P1, open) —
  `hasScope` (`packages/auth-core/src/index.ts:50-53`) makes `mail` satisfy `contacts` and
  `calendar` both.
- Tests: read-only and in-memory, so **no `.batch()` and no hard dependency on `002`** — a
  `SELECT`-routing fake covers it. The grant-filtering case in done-when #3 is the one that
  needs real principal fixtures; `packages/auth-core/src/principal.test.ts` is where those
  live.

## Open questions / where this could be wrong

1. **✅ RESOLVED — CONFIRMED, and it decides the unit (see _Resolution_ at top).** The methods
   do **not** exist in the specs: RFC 9610 §2 defines no `AddressBook/query`,
   `draft-ietf-jmap-calendars-27` §4 defines no `Calendar/query`. This is a vendor extension,
   not a gap, so the unit is **wontfix**. The rest of this question, preserved below, is what
   prompted the check. **⚠️ These methods may not exist in the specs, which would make this a
   vendor extension rather than a gap.** The repo's own doc comment at
   `services/jmap/src/methods/contacts.ts:25-26`
   enumerates the RFC 9610 surface as _"AddressBook/get·set·changes, ContactCard/get·set·query·changes"_
   — i.e. **the author's reading is that RFC 9610 defines no `AddressBook/query`**, and the same
   omission pattern holds for `Calendar` under draft-ietf-jmap-calendars. `Mailbox/query` exists
   because RFC 8621 §2.3 defines it; containers in the newer specs may deliberately not have
   one, for exactly the cardinality reason this file keeps returning to. **I could not verify
   this — I have no offline copy of RFC 9610 and nothing was fetched.** If it is right, this
   unit is not "close a gap", it is "invent two non-standard methods", which is a materially
   worse proposition and a reason to strike the unit rather than build it. **This is the single
   most important thing for a reviewer with spec access to check, and it should be checked
   before any code is written.**
2. **The `I1` grade leans entirely on a CLI flag I described in one sentence.** See
   _Why these grades_. If the unit ships as two JMAP methods and nothing else, it is `I0` by the
   `readme.md:96` line, and I would not argue.
3. **The two halves are not really one unit.** `AddressBook/query` has a grant-filtering
   requirement (`contacts.ts:72,77`) that `Calendar/query` has no analogue for — `Calendar/get`
   applies no book-style restriction at `calendars.ts:57-72`. I bundled them because the code is
   the same shape, but they have different risk profiles and a reviewer could reasonably split
   them, or build only the contacts half.
4. **I did not check whether `Calendar` _should_ have a grant filter.** `Calendar/get`
   (`calendars.ts:57-72`) does not call anything like `allowedBookIds`, while `AddressBook/get`
   does. That is either correct (calendar sharing is not implemented yet) or a pre-existing
   hole. Either way it is **not this unit's job**, but if it is a hole, adding `Calendar/query`
   widens it, and someone should look before shipping.
5. **Nothing was run** (`_context.md` §7). The claim that accounts have one container each is
   read from `ensureDefaultBook`/`ensureDefaultCalendar` and from the absence of any bulk-create
   surface — not from counting rows in a live database.
