# 009 -E2-I3- DAV collection creation (`MKCOL` / `MKCALENDAR`)

| | |
|---|---|
| **Kind** | capability |
| **Effort** | **E2** — three files in `services/anglebrackets`, no schema change, no new JMAP method. ⚠️ **E3 if the collection-id problem needs a column** — see *What to build* §1 |
| **Impact** | **I3** — human-verifiable beyond argument; *unlocks* is the weak half (Open Questions #1) |
| **Owner** | `sVOL` |
| **Depends on** | — |
| **Status** | todo |

## Cells covered

`AddressBook × Create × DAV` · `Calendar × Create × DAV`

Two cells — the only `-` left in the `AddressBook` and `Calendar` DAV columns, which read
`-R--` today.

This unit also argues for `AddressBook × Delete × DAV` and `Calendar × Delete × DAV` (two more
cells the grid marks absent). Whether they ship together is *What to build* §4; they are cheap
and symmetric, and a client that can create but not delete is a strange half-state.

## Why these grades

**E2.** The capability beneath is complete and this unit adds none of it. `AddressBook/set`
handles create (`services/jmap/src/methods/contacts.ts:116` register, create branch `:145`,
`insertAddressBook` at `:150`), and `Calendar/set` does the same (`calendars.ts:76` register,
create branch `:101`, `insertCalendar` at `:105`). Both run the full choreography — validation,
default-collection bookkeeping, `commitChanges`. This is WebDAV verb plumbing over live logic,
in one worker: `index.ts` (the `Allow`/`DAV` headers), `dav.ts` routing, `dav.ts` handlers.

It is **not E1** — three files, a routing inversion (§1), and a real spec surface. And it is
**not obviously E2 either**: §1 describes a collection-id collision that, taken one way,
requires a `dav_name` column on `address_books` and `calendars` and pushes this to E3. The
grade is a bet on the cheap resolution being acceptable.

**I3:**

- *Human-verifiable* — the strongest case in the volume. Open Apple Calendar, `File → New
  Calendar → <account>`, name it, watch it appear. Then create an event in it and see it in
  `bullmoose calendar list`. `config.yml` marks the `AngleBracket` surface
  `human_verifiable: true` for exactly this.
- *Unlocks* — **this is the weak half and I do not want to oversell it.** No unit in
  `_index.md` names `009` as a dependency, and `grep -rn 'MKCOL\|MKCALENDAR' .plans docs`
  returns only `sVOL`'s own files. What it removes is a *product* blocker rather than a *work*
  blocker: today a new user cannot get to a usable multi-calendar setup without leaving their
  client for the CLI. Whether that satisfies `config.yml`'s "STATED blocker from at least one
  other unit" is a judgement call, and I think a strict reading says no. See Open Questions #1.

## What exists today

**DAV is read-write at the resource level and read-only at the collection level.** That
asymmetry is precise and worth stating exactly:

| | PROPFIND | REPORT | GET | PUT | DELETE | MKCOL/MKCALENDAR |
|---|---|---|---|---|---|---|
| address book collection | `dav.ts:293` | `:314` | — | — | — | **405** `:322` |
| card resource | — | — | `:500` | `:514` | `:595` | n/a |
| calendar collection | `:709` | `:729` | — | — | — | **405** `:737` |
| event resource | — | — | `:914` | `:927` | `:1005` | n/a |

Resource writes are properly done — `If-Match` / `If-None-Match` ETag preconditions
(`:522-529`, `:933-940`), UID-immutability enforcement (`:536-538`, `:959`), account-wide UID
uniqueness per RFC 9610 (`:564-567`, `:980-981`), ctag bumps (`:556`, `:588`, `:604`, `:973`,
`:998`, `:1014`) and `commitChanges` on every path. The collection level has none of it.

**`notAllowed()` is `dav.ts:1229-1234`** and returns
`Allow: OPTIONS, GET, PUT, DELETE, PROPFIND, REPORT`. The same string is served by the global
`OPTIONS` handler at `services/anglebrackets/src/index.ts:40-48`, alongside
`DAV: 1, 3, addressbook, calendar-access`. **A client reads that header to decide whether it
may offer a "New Calendar" menu item**, so this unit is not done until both strings change.

**The module comment does not claim this is deliberate.**
`services/anglebrackets/src/index.ts:10-14` says the worker is *"deliberately
barely-conforming (locked decision Q4)"* and lists what is intentionally absent:
*"LOCK/UNLOCK, COPY/MOVE, and ACLs."* `MKCOL` and `MKCALENDAR` are not on that list. This is an
omission, not an overridden decision — which matters, because reversing a locked decision would
be a different conversation.

**The specs.** `MKCALENDAR` is RFC 4791 §5.3.1 (CalDAV). For address books, RFC 6352 §5.2 uses
**extended `MKCOL`** (RFC 5689) with an `addressbook` resourcetype in the body, not a bespoke
verb. So the two paths are not symmetric: one new method token, one existing method token with
a body to parse.

## What to build

### 1. The collection-id problem — read this before estimating anything

Both specs require the collection to be created **at the Request-URI**. Apple Calendar invents
that URI itself: it `MKCALENDAR`s to `/dav/calendars/{accountId}/{a-uuid-it-chose}/`.

The JMAP create path **refuses to accept a client-supplied id**:

```ts
const CAL_SERVER_SET = ["id", "isDefault", "myRights"] as const;   // calendars.ts:45
const BOOK_SERVER_SET = ["id", "isDefault", "myRights"] as const;  // contacts.ts:63
```

`validateNewCalendar` (`calendars.ts:554-580`) throws `invalidProperties` if `spec.id` is set
(`:555-559`) and mints `cal_${crypto.randomUUID()}` at `:566`. `validateNewBook`
(`contacts.ts:617-625`) is identical.

And unlike resources, **collections have no DAV-name column**. Cards and events carry
`davName` and the path uses `ref.davName ?? ref.id` (`dav.ts:302`, `:717`); collection paths use
the raw id. `address_books` (`data-plane.sql:159-171`) and `calendars` (`:206-219`) have no such
column.

Three ways out, in order of my preference:

- **(a) Let the DAV layer supply the id.** Add an internal-only escape to
  `validateNewCalendar` / `validateNewBook` accepting a caller-provided id when it matches a
  strict charset (`^[A-Za-z0-9_-]{1,64}$`) and is unused in the account. No column, no
  migration, **stays E2**. Cost: the id namespace stops being `cal_`/`ab_`-prefixed UUIDs, so
  anything that pattern-matches on the prefix breaks. `grep` for that before committing.
- **(b) Add `dav_name` to both collection tables**, mirroring the resource model exactly. The
  cleanest design, consistent with what is already there — and a **migration**, so **E3**
  (`readme.md:75-78`; no framework, `CREATE TABLE IF NOT EXISTS` only,
  `tools/README.md:10-11`).
- **(c) Create at a server-chosen id and 301 to it.** Cheapest to write, and wrong: the client
  believes the collection exists at the URI it asked for and will `PUT` resources into a 404.
  Listed only so the reviewer knows it was considered and rejected.

**I recommend (a), and this is the load-bearing call in the unit.** If a reviewer prefers (b),
the effort grade is `E3` and the ledger needs updating.

### 2. Invert the routing — the non-obvious part

`handleBook` resolves the collection **before** it branches on method:

```ts
const book = await requireBook(store, access, bookId);   // dav.ts:290
```

`requireBook` (`:212-220`) throws `DavError(404, "no such address book")` when the id is
unknown. `handleCalendar` does the same at `:706` via `requireCalendar` (`:625-633`).

So a `MKCALENDAR` to a *new* path — which by definition does not resolve — **404s at `:706`
and never reaches the `notAllowed()` at `:737`**. Anyone who patches the bottom of these
functions will watch their new verb return 404 and go looking in the wrong place. The
create branch must sit in the dispatcher at `dav.ts:111-116` / `:125-130`, or at the very top
of the handler, ahead of the `require*` call.

### 3. Body parsing and the props that matter

Both verbs may carry a `<D:set><D:prop>` block. Map only what the tables hold:

| DAV prop | column | note |
|---|---|---|
| `displayname` | `name` | required by `validateNewCalendar` `:560-563` (1..255 chars); `validateNewBook` `:623-625` measures **octets** via `utf8Octets`, not chars |
| `calendar-description` / `addressbook-description` | `description` | |
| `calendar-color` (Apple) | `color` | calendars only — `address_books` has no colour column (`:159-171`) |
| `calendar-timezone` | — | **no column.** Accept-and-drop, and say so in the response; silently discarding a client's default timezone is a data-loss surprise |
| `supported-calendar-component-set` | — | we serve `VEVENT` only (`dav.ts:658`). Reject a request asking for `VTODO`/`VJOURNAL` with `403` + a precondition element rather than creating a calendar that will refuse its own writes |

An empty body is legal and means "defaults" — handle it.

⚠️ **Do not let a new collection become the default.** Both tables carry
`CREATE UNIQUE INDEX … WHERE is_default = 1` (`data-plane.sql:172-173`, `:220-221`), and
`validateNewCalendar(spec, becomeDefault)` takes the flag from `!hasDefault` at the call site
(`calendars.ts:101-103`). A DAV-created collection on an account that already has a default
must pass `false`, or the insert violates the index and surfaces as a 500.

### 4. `DELETE` on a collection — yes, and it is nearly free

`AddressBook/set` already implements destroy with the full semantics
(`contacts.ts:179-209`): an `addressBookHasContents` guard unless `onDestroyRemoveContents`
(`:180,:187-188`), cascade to the contained cards (`:192`), `deleteAddressBook` (`:194`),
**cleanup of any `grants` scoped to that book** (`:196-201`), and promotion of the oldest
survivor when the default was destroyed (`:233`). `Calendar/set` mirrors it with
`onDestroyRemoveEvents` (`calendars.ts:127`), `deleteCalendar` (`:139`) and
`setDefaultCalendar` (`:150`) — but note it has **no grants cleanup**, because grants can only
be scoped to `AddressBook` today (`services/provision/src/index.ts:545-547`).

DAV `DELETE` on a collection means "delete it and everything in it" unconditionally, so map it
to destroy **with** the `onDestroy*` flag set. Refuse deleting the default collection with
`403` rather than silently promoting a replacement under a client that is not expecting one.

Symmetric with §3: without this, a client can create a calendar and never remove it, which is a
worse state than not being able to create one.

### 5. ctag and sync-token — the part most likely to be got wrong

Two different things are in play and they behave differently:

- **`ctag` is per-collection** (`address_books.ctag` `:167`, `calendars.ctag` `:215`), served as
  `getctag` (`dav.ts:272`, `:657`). It is the O(1) idle-poll short-circuit the module header
  justifies at `index.ts:16-19`. A **new** collection starts at `ctag: 0`
  (`calendars.ts:576`), which is correct — the client has never seen it.
- **`sync-token` is per-account, not per-collection.** `syncToken(await doState(env,
  access.accountId))` (`dav.ts:297`, `:712`) resolves one AccountDO state value
  (`doState:1096-1100`) and stamps it on **every** collection resource, including inside
  `handleHome` (`:252-253`). The schema comment says this explicitly: *"The JMAP sync-token
  stays the AccountDO global state sequence; ctag is DAV-only"* (`data-plane.sql:157-158`).

Consequence: **creating a collection bumps the account state, which changes the sync-token on
every other collection**, so every subscribed client re-runs `sync-collection` against
everything. That is pre-existing behaviour (any card PUT does it too) and not this unit's bug —
but this unit makes collection churn a client-initiated operation, so note it.

What this unit **must** get right:

- Return the new collection's `ctag` and the account sync-token in the `MKCALENDAR` /
  `MKCOL` response where the spec allows, so the client does not immediately re-`PROPFIND`.
- Call `commitChanges` with `{ collection: "Calendar", created: [id] }` — which
  `Calendar/set` already does, so route through the method and this is free. Skipping it is
  `_context.md` §3's failure mode: the collection appears on a direct `PROPFIND` and is
  invisible to `/changes`, so the CLI mirror never learns about it.
- On `DELETE`, prune tombstones as the REPORT paths already do
  (`store.pruneTombstones(accountId, TOMBSTONE_TTL_MS)` — `dav.ts:334`, `:747`,
  `TOMBSTONE_TTL_MS` = 30 days at `:44`), or a client syncing later gets deletions for cards in
  a collection that no longer exists.

### 6. Advertise it

`services/anglebrackets/src/index.ts:45` and `dav.ts:1232` both need
`MKCOL, MKCALENDAR` added to `Allow`. Add `extended-mkcol` to the `DAV:` header at `:44`
(RFC 5689 §5) if extended MKCOL is implemented for address books, which §3 assumes.
⚠️ The `OPTIONS` handler at `:40` runs **before** `authenticate` at `:50`, so the advertisement
is unauthenticated and account-independent. That is fine — but it means the header cannot be
conditional on what a given principal may do.

## Done when

1. In **Apple Calendar**: `File → New Calendar` on the bullmoose account creates a calendar,
   it appears in the sidebar, an event created in it syncs, and `bullmoose calendar list`
   (`packages/cli/src/calendar.ts:32`) shows both. A non-engineer performs every step.
2. In **Contacts.app**: `File → New Group`/new address book, same round trip, verified with
   `bullmoose contacts` output.
3. The created collection appears in `Calendar/changes` / `AddressBook/changes` — **not just in
   a PROPFIND**. This is the assertion that proves the write went through the method layer and
   not a bare `Mailstore` insert (`_context.md` §3).
4. `MKCALENDAR` to a path that already exists returns **405**, and to a malformed id returns
   **403** — neither creates a row and neither 500s.
5. `MKCALENDAR` on an account that already has a default calendar does **not** violate
   `calendars_default` (`data-plane.sql:220-221`).
6. `OPTIONS /dav/` advertises the new verbs, and a client that reads `Allow` (rather than
   probing) offers the menu item.
7. `DELETE` on a collection removes it and its contents, is refused on the default collection,
   and the client's next `sync-collection` is coherent rather than an error.

## Bread-crumbs

- Dispatcher: `handleDav:46`. Address books branch `:104-117`, calendars `:119-131`. Path
  segments are `decodeURIComponent`'d at `:56` — a client-chosen id arrives already decoded,
  which is where §1's charset validation belongs.
- Collection paths are built from the raw id, resource paths from `davName ?? id`
  (`dav.ts:302`, `:717`). That inconsistency is the whole of §1.
- `visibleBooks` / `visibleCalendars` (`:616+`) are what `requireBook`/`requireCalendar` filter;
  they honour grants, so a **sharee** must not be able to `MKCOL` into the owner's home.
  `AddressBook/set` already refuses this — `contacts.ts:118-122`, throw at `:121`: *"v1:
  sharees edit contents (per mayWrite), never the books themselves"*; `Calendar/set` has the
  twin at `calendars.ts:79`. Routing through the methods gives you the right answer for free.
  Do not reimplement the check.
- Scope gates differ by realm: contacts writes go through `requireWrite` (used at `:515`,
  `:596`), calendar writes through `requireCalWrite` (`:635-641`, gating on
  `principalHasScope(principal, "calendar")`). Collection create should use the same two.
  ⚠️ `common/001`: a `mail` token satisfies both, so these read stronger than they are.
- `audit(env, principal, access, "dav:…")` is called on every handled request
  (`:232`, `:291`, `:707`). Give the new verbs their own strings — `dav:mkcol`,
  `dav:mkcalendar` — so the audit log distinguishes structural changes from content changes.
- `DavError` (`:143-157`) carries an optional `xmlBody`; both specs want precondition elements
  (`CALDAV:calendar-collection-location-ok`, `DAV:valid-resourcetype`) rather than bare text.
  `uidConflict`/`calUidConflict` (`:1024`) are the existing examples of building one.
- Tests: `services/anglebrackets` has **zero** test coverage — `_context.md` §5 lists the two
  test files in the repo and neither is here. `002` is not a stated dependency of this unit and
  probably should be, since `Calendar/set` create reaches `Mailstore` writes.

## Open questions / where this could be wrong

1. **`I3` is probably half-earned, and the ledger should say so.** The human-verifiable factor
   is the strongest in the volume. The *unlocks* factor is the weakest `I3` in the volume: no
   unit and no `sNN` section names DAV collection creation as a blocker — I grepped `.plans`
   and `docs` and the only hits are `sVOL`'s own files. Compare `013`, which earns its
   *unlocks* honestly because `014` and `015` inherit its tool-shape decisions. By a strict
   reading of `config.yml`'s `impact_definitions.unlocks`, **this unit is `I1`**. I left it at
   `I3` because "a plain client can be the only client" is the product claim the whole DAV
   surface exists to make, and I would rather argue about it in the open than quietly regrade
   the file. **This is the most arguable call here.**

2. **§1(a) — accepting a client-supplied id — punches a hole in a deliberate invariant.** `id`
   is in `CAL_SERVER_SET`/`BOOK_SERVER_SET` on purpose. An internal escape hatch is exactly the
   kind of thing that is safe on the day it is written and becomes a bug when someone reaches
   it from a second caller. Option (b) is the honest design; it costs a migration. If the
   reviewer picks (b), this file's `E2` is wrong.

3. **The Apple client behaviour is inferred, not observed.** I have not driven a real
   `MKCALENDAR` against this deployment or captured what Calendar.app actually sends — the
   claim that it invents a UUID path segment is from the specs and general knowledge, not from
   a packet. If it instead expects a `Location` header or tolerates a redirect, §1(c) becomes
   viable and this unit gets much cheaper. **Someone should capture one real request before
   building.** `_context.md` §7 already flags that no CalDAV claim in this repo was exercised
   against a real client.

4. **Extended `MKCOL` for address books may be more work than `MKCALENDAR`.** RFC 6352 routes
   address-book creation through RFC 5689's extended `MKCOL`, which means parsing a
   `<D:mkcol><D:set><D:prop><D:resourcetype>` body and returning a `mkcol-response`
   multistatus. `dav.ts` has XML helpers (`requestedProps:1110`, `multistatus`, `response`) but
   no `mkcol-response` builder. The two halves of this unit are not equal and the `E2` averages
   them.

5. **`DELETE` on a collection might belong in its own unit.** It is symmetric and cheap, but it
   is also the only *destructive* client-initiated operation on the DAV surface, and
   `AddressBook/set`'s destroy path cascades into cards **and deletes grants** (`:193-198`) —
   i.e. a CardDAV `DELETE` can silently unshare a book from another user. That deserves more
   scrutiny than "cheap and symmetric" gives it, and it is the sort of thing that should be
   discovered before shipping rather than after.

6. **Nothing was run.** All line numbers verified by reading `dav.ts`, `index.ts`,
   `contacts.ts`, `calendars.ts` and `data-plane.sql` at the working tree. No `wrangler dev`,
   no client, no request.

7. **`_context.md`'s two citations for this gap are exact.** Footnote 9 (`:115-116`) cites
   `dav.ts:322` and `dav.ts:737`; both are the `return notAllowed();` lines in `handleBook` and
   `handleCalendar` respectively. No drift here — unlike `007` and `008`, where the audit's
   offsets have moved.
