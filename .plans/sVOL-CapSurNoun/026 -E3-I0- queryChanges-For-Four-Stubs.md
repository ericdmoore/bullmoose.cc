# 026 -E3-I1- `queryChanges` for the four stubs

| | |
|---|---|
| **Kind** | capability |
| **Effort** | **E3** — a sync contract other code must respect, and probably a new table |
| **Impact** | **I0** — neither factor holds. On completion this is a JMAP method with no surface emitting a JSON delta (the rubric's own example of *test*-verifiable), and `s03.C` `arch.md:57` names `queryChanges` without being blocked by it — the re-query fallback is mandatory regardless. Regraded from `I1` at review; the ledger now agrees. ⚠️ Low impact ≠ safe to ignore: see `readme.md` § *Where the rule fails* |
| **Owner** | `sVOL` |
| **Depends on** | `002` (shared fake-D1) if built — nothing blocks it today |
| **Status** | **deferred**, and I believe correctly so |

## Cells covered

`Mailbox × queryChanges` · `Email × queryChanges` · `ContactCard × queryChanges` ·
`CalendarEvent × queryChanges`

Not CRUD cells — this is the incremental-delta half of the query surface, tracked
separately in `_index.md:149` because it is a distinct capability from `Foo/query`.

## This is not a bug

All four stubs are **deliberate and spec-conformant**. Each `Foo/query` advertises
`canCalculateChanges: false`, and each `Foo/queryChanges` answers the method by throwing
`cannotCalculateChanges` rather than `unknownMethod` — which is what RFC 8620 §5.6 asks
for. Verified individually:

| Method | stub | advertised `canCalculateChanges: false` | comment |
|---|---|---|---|
| `Mailbox/queryChanges` | `services/jmap/src/methods/mailbox.ts:93` | `:84` | `:91-92` |
| `Email/queryChanges` | `services/jmap/src/methods/email.ts:54` | `:206` | `:53` |
| `ContactCard/queryChanges` | `services/jmap/src/methods/contacts.ts:559` | `:551` | `:558` |
| `CalendarEvent/queryChanges` | `services/jmap/src/methods/calendars.ts:392` | `:385` | **none** |

All four refs in the brief and in `_context.md:67-68` are correct. The only discrepancy is
cosmetic: three carry an explanatory comment and `calendars.ts:392` does not, which is why
it is the one most likely to be mistaken for an oversight.

**So this unit is an unimplemented optimization, not a defect.** A conformant client that
sees `canCalculateChanges: false` re-runs the query, and everything works.

## Why these grades

**E3.** Not line count — semantics. To answer *"what entered and left this result set
since state N"* you must know the result set **at state N**. The changelog gives you the
ids that changed (`services/jmap/src/methods/common.ts:69-104` → the AccountDO's
`/changes`), but not whether each of those ids satisfied the filter *before* the change.
Two honest implementations, both E3:

- **Store query-state snapshots.** A new table keyed by (account, query hash, state) →
  a migration, and this repo has **no migration framework** (`tools/README.md:10-11`).
  E3 by the migration cliff (`readme.md:75-78`).
- **Restrict to changelog-decidable filters** and return a conservative `removed` set.
  No schema change, but it is a new sync contract every client and every future surface
  must respect — E3 by the second clause of the anchor (`readme.md:72`), and tests
  mandatory.

**Impact — the ledger says `I1`; I think both legs fail.** Argued in *Open questions*.

## What it would unlock

One named consumer, and it is already written down: `s03.C`'s architecture specifies the
virtualized thread list as *"virtualized; `Email/query` + `queryChanges`"*
(`.plans/s03.C-webmail-floor/arch.md:57`). That plan is currently written against a method
that always throws. Unit `022`'s contact and event lists would want the same thing.

**But it is a soft unlock, and that is the crux of the deferral.** A client must implement
the re-query fallback *anyway*, for reasons that have nothing to do with these stubs:

- The AccountDO changelog is a bounded window — `LOG_WINDOW = 4096`
  (`packages/account-do/src/index.ts:39`) — and `/changes` returns **409
  `cannotCalculateChanges`** whenever the client's state has aged out below the floor
  (`packages/account-do/src/index.ts:274-278`). Full resync is a normal, expected path.
- So the fallback is not a workaround; it is required code. `queryChanges` only makes the
  common case cheaper.

## Why deferring is probably right

1. **The fallback is mandatory regardless** (above). Building `queryChanges` first means
   two code paths where one is already required.
2. **Scale doesn't justify it yet.** `Mailbox/query` filters in memory over the account's
   mailbox rows (`mailbox.ts:78-88`, with `applyMailboxFilter` at `:98`) — re-running it
   costs nothing at personal scale, where an account has tens of mailboxes. Of the four,
   only `Email/query` runs over a set large enough for the delta to matter.
3. **It has no human-visible surface and cannot cheaply be given one.** `readme.md:110`
   says to pair a capability with its cheapest human-visible surface. Here that surface is
   webmail, which does not exist — the pairing would make this `E4`. This is exactly the
   case `readme.md:116-117` says *not* to bundle.
4. **Correctness risk is asymmetric.** A wrong `queryChanges` produces a list view that
   silently drops or duplicates rows and is nearly impossible to reproduce. A missing one
   produces a re-query. The failure modes are not comparable.

**The right sequence:** build `s03.C` T2's re-query fallback, measure it on a real
mailbox, and only then decide. If re-query is imperceptible — likely at personal scale —
this unit stays deferred permanently, which is a fine outcome.

## Done when *(if ever built)*

1. `Email/query` advertises `canCalculateChanges: true` and `Email/queryChanges` returns
   correct `added`/`removed` for a filtered, sorted query across an arrival, a flag
   change, and a deletion.
2. It returns `cannotCalculateChanges` — not a wrong answer — for any filter or sort
   outside the supported set, and the `canCalculateChanges` flag on `Foo/query` reflects
   that per-query rather than globally.
3. A client that alternates `queryChanges` and full re-query converges to the same list.
   This is the assertion that catches a subtly wrong delta; a passing single delta does
   not.
4. Aging past the changelog floor still yields a clean 409 and full resync.

## Bread-crumbs

- `proxyChanges` (`common.ts:69-104`) is the shared `Foo/changes` path and the natural
  place to hang a query-delta helper; note it derives the auth domain from the collection
  name at `:83-89`.
- The changelog collapse rules (created→destroyed cancels, created→updated stays created)
  are already implemented in the DO at `packages/account-do/src/index.ts:291-299`. Query
  deltas need the same collapse *plus* filter membership, which is the part that isn't
  there.
- `CalendarEvent/query` supports only `inCalendar|uid|after|before|text|title` and sorts
  only on `start|updated|created` (`calendars.ts:344` and below). `ContactCard/query` is
  `contacts.ts:529`. The supported-filter surface is small, which makes the
  "changelog-decidable filters only" option more attractive than it first sounds.
- Zero test coverage exists for any JMAP method (`_context.md` §5). Unit `002` is a hard
  prerequisite in practice even though nothing formally blocks this unit.

## Open questions / where this could be wrong

1. **⚠️ I think `I1` is wrong and the grade should be `I0`.** Apply the two factors
   (`readme.md:84-94`):
   - *Human can verify?* **No.** On completion this unit is a JMAP method with no surface.
     Its output is a JSON delta — the rubric's own example of test-verifiable rather than
     human-verifiable (`readme.md:96-97`), and `readme.md:93-94` forbids judging it
     hypothetically against a future webmail.
   - *Unlocks other work?* **Also no**, on the strict reading: `s03.C` names `queryChanges`
     (`arch.md:57`) but is not blocked by it, because the re-query fallback is mandatory
     anyway. It removes no *stated blocker*.

   Neither leg holds ⇒ **`I0`**. If you accept the softer reading of "unlocks" it is
   `I2` — but `I1` is unreachable either way, since `I1` requires human-verifiability.
   **If accepted:** rename to `026 -E3-I0-` and update `_index.md:77`, the I0 note at
   `:173` (currently "1 | 027"), and the totals at `:171-173`. Left as filed per
   `readme.md:148-150`.
2. **`E3` assumes the snapshot approach.** If the changelog-decidable-filters route turns
   out to cover `Email/query`'s real usage with no new table, the *implementation* could
   be E2-sized. It stays E3 because the sync contract is the expensive part, but a
   reviewer could reasonably push back.
3. **I did not check what real clients do.** himalaya, Apple Mail, and Bulwark may never
   call `queryChanges` at all, in which case even the soft unlock evaporates and the only
   consumer is our own webmail. That is a cheap thing to find out and would settle this.
4. **Nothing here was run.** All claims read from source, per `_context.md` §7.
