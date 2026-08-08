# 004 -E3-I3- `Mailbox/set` + CLI

| | |
|---|---|
| **Kind** | capability |
| **Effort** | **E3** — new semantics every other write path must respect; tests mandatory |
| **Impact** | **I3** — unlocks *and* human-verifiable |
| **Owner** | `sVOL` |
| **Depends on** | `002` (shared fake-D1 with `.batch()`) |
| **Status** | todo |

## Cells covered

`Mailbox × Create × JMAP` · `Mailbox × Update × JMAP` · `Mailbox × Delete × JMAP` ·
`Mailbox × Create × CLI` · `Mailbox × Update × CLI` · `Mailbox × Delete × CLI`

Six cells — the whole `Mailbox` row on both surfaces that exist for mail. **This is the
biggest single gap in the repo**: mail is the flagship noun and folders are frozen at
whatever `services/provision/src/index.ts:390-405` seeds when the account is created.

## Why these grades

**E3.** Not because of line count and not (necessarily) because of a migration — see below.
Because of the third E3 limb in `readme.md:72`: *new semantics that other code must respect.*
Today nothing in the repo can create, rename, reparent, or delete a mailbox, so nothing has
ever had to answer "what happens to the mail inside a folder you delete", "may the Inbox be
destroyed", or "does a folder tree deeper than the advertised limit get rejected". Four call
sites already assume mailboxes are immutable and permanent:

- `services/ingest/src/index.ts:125` calls `store.ensureRoleMailbox(accountId, "inbox", "Inbox")`
  on **every** inbound message. Destroy the Inbox and the next delivery silently recreates it
  under a **new id**, orphaning every client that cached the old one.
- `services/jmap/src/methods/email.ts:362-364` enforces "an email must belong to at least one
  mailbox" on patch. A mailbox destroy has to honour the same invariant or it leaves rows in
  `email_mailboxes` pointing at nothing.
- `packages/cli/src/sync.ts:153-158` mirrors mailboxes with a blind `DELETE` + re-`INSERT`
  from `Mailbox/get`. It has never had to reconcile a *destroy*.
- `packages/cli/src/main.ts:884-890` (`bullmoose mailboxes`) reads the local mirror by raw
  SQL, not JMAP — so it is a second consumer of the same assumption.

Whether it is *also* a schema change is a judgement call. The `mailboxes` DDL
(`packages/mailstore/sql/data-plane.sql:6-16`) carries `id, account_id, parent_id, name, role,
sort_order` and nothing else — no `is_subscribed`, no `created_at`, no `updated_at`. You can
ship without touching it by continuing to hardcode `isSubscribed: true` (`mailbox.ts:38`). If
you decide `isSubscribed` must be real, you are on the migration cliff (`_context.md` §0.2)
and E3 is over-determined rather than arguable.

**I3, both factors:**

- *Unlocks* — ⚠️ **contested, and an earlier draft of this line was factually wrong.** It
  claimed `019` and `014` have "no folders to move to," making this a hard precondition for
  triage. That is false: `services/provision/src/index.ts:391-397` seeds **six** role
  mailboxes including `archive`, which is the single most-used triage verb. So triage works
  today; this unit unlocks **custom** folders, not triage itself.

  On the strict rubric — "removes a *named* blocker" — no unit and no `sNN` section lists
  `Mailbox/set` as a dependency, which would make this `I1`, not `I3`.

  **That result is worth arguing with rather than accepting.** This is the largest capability
  gap in the repo (`_context.md` §2 fn 4: the session already advertises `maxMailboxDepth`,
  `mayCreateTopLevelMailbox`, `mayRename`, and `mayDelete` while providing no method to act on
  any of them), and the rubric grades it below a CLI flag. If `I1` is the honest answer here,
  the rubric is under-weighting "closes a glaring absence in the flagship noun" — see
  `readme.md` § *Where the rubric is known to mislead*. **Left at `I3` pending that call.**
- *Human-verifiable* — **only because of the bundled CLI**. This is the `readme.md:110` design
  rule doing real work: `Mailbox/set` alone is `I2` (a JMAP method with no surface; `curl`
  JSON is test-verifiable, `readme.md:96`). With `bullmoose mailbox create Receipts` in the
  same unit, a non-engineer runs one command, runs `bullmoose sync`, and reads the new folder
  out of `bullmoose mailboxes`. That is the whole difference between `I2` and `I3` here, and
  the CLI half is perhaps 15% of the work.

## What exists today

**`Mailbox/set` is not registered anywhere.** `buildRegistry`
(`services/jmap/src/methods/index.ts:15-28`) wires `registerMailboxMethods` at `:18`, and that
function (`mailbox.ts:5-96`, 124 lines total) registers exactly four things:

```
Mailbox/get           mailbox.ts:6
Mailbox/changes       mailbox.ts:51   (proxies the AccountDO changelog)
Mailbox/query         mailbox.ts:54   (in-memory filter + sort over getMailboxes)
Mailbox/queryChanges  mailbox.ts:93   (always throws cannotCalculateChanges)
```

**The read path already advertises the policy the write path would enforce.** `Mailbox/get`
returns `myRights` with `mayCreateChild: true` (`:33`), `mayRename: true` (`:34`), and —
the good one — **`mayDelete: r.role === null`** (`:35`). The server already tells every client
that role mailboxes are undeletable. There is simply no method in which to enforce it.

**The session already promises the limits.** `mailCapability`
(`packages/jmap-core/src/capabilities.ts:40-47`) advertises `maxMailboxDepth: 10`,
`maxSizeMailboxName: 200`, `maxMailboxesPerEmail: null`, and `mayCreateTopLevelMailbox: true`,
attached per-account at `services/jmap/src/session.ts:48`. A client reading the session today
is told it may create top-level folders ten deep. It cannot create one.

**`Mailstore` has no mailbox write path.** Grepping `packages/mailstore/src/index.ts` for
mailbox SQL returns four hits: two `SELECT`s in `getMailboxes` (`:306`, `:316`), one `SELECT`
and one `INSERT` inside `ensureRoleMailbox` (`:335`, `:343`). There is **no** update, no
delete, and no general insert. `mailboxCounts` is `:352`.

**Known cosmetic defect in the same file:** `mailbox.ts:25` returns
`totalThreads: counts.totalEmails, // TODO: real thread counts`, and `:26` does the same for
`unreadThreads`. Not this unit's job, but you will be in the file.

**The in-repo reference shape is `AddressBook/set`** (`contacts.ts:116-250`). Copy its
skeleton, not its sharing model:

```
requireAccount(ctx, args, "contacts", "contacts")   :117
reject grant-reached callers                        :118-122
ifInState guard → stateMismatch                     :126-128
ChangeEntry accumulators, one per collection        :137-138
create loop → validateNewBook → insert → entry      :146-161
update loop → validateBookPatch → update → entry    :165-177
destroy loop → onDestroyRemoveContents guard        :180-209
default-book repair after a destroy                 :231-235
commitContactEntries(...) → newState                :237
per-object errors via toSetError                    :579-590
```

## What to build

### 1. `Mailbox/set` — the semantics that are actually undecided

**Role-mailbox protection.** `mailbox.ts:35` already publishes `mayDelete: role === null`.
Enforce it: destroying a mailbox with a non-null role returns a `forbidden` SetError, not a
throw. Renaming one should be *allowed* (a user may want "Bin" instead of "Trash"); the
`role` is the contract, the `name` is a label. **Setting or changing `role` on update must be
rejected** — `role` is server-set, and the DB will not let you win the argument anyway (see
next).

**Role uniqueness is enforced in SQLite, so a create that collides raises a raw constraint
error.** `data-plane.sql:15-16`:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS mailboxes_role
  ON mailboxes (account_id, role) WHERE role IS NOT NULL;
```

That must surface as an `invalidProperties` SetError on the offending creation id, not as a
`serverFail` string wrapping a D1 exception. `contacts.ts:579-590` shows the mapping shape;
it does **not** have this problem to solve, because address books have no unique index.

**Name uniqueness within a parent.** RFC 8621 §2.5 requires mailbox names to be unique among
siblings. Nothing in the schema enforces it, and the `AddressBook` reference does not have the
constraint at all (`validateNewBook`, `contacts.ts:617-647`, checks type, octet length, and
`sortOrder` — never uniqueness). So this is a check you write, and it must run against the
*post-mutation* sibling set within one `/set` call, not just against what was in the table
when the method started.

**Parent/child hierarchy.** `parent_id` exists (`data-plane.sql:9`) and is faithfully returned
(`mailbox.ts:19`), but nothing has ever written a non-`NULL` value — provisioning inserts
`NULL` explicitly (`services/provision/src/index.ts:401-402`). Three rules to implement:

- depth ≤ `maxMailboxDepth: 10`, because that is what the session already promises;
- `parentId` must name an existing mailbox on the same account, else `invalidProperties`;
- **a reparent must not create a cycle.** With ≤10 levels the honest implementation is to walk
  the chain to the root and fail on a repeat. Do not skip this — a self-parent is one typo away
  and `getMailboxes` will happily return the row while every tree-building client hangs.

**`onDestroyRemoveEmails`.** RFC 8621 §2.5. Default `false` ⇒ destroying a non-empty mailbox
fails with `mailboxHasEmail`. With `true`, the emails must be *destroyed*, not merely
unlinked — because `applyEmailPatch` already declares that an email with zero mailboxes is
invalid (`email.ts:362-364`) and `Email/set` destroy is the only path that cleans up properly
(`email.ts:281-291` → `store.destroyEmail`). Reuse it. A destroy that only runs
`DELETE FROM email_mailboxes` leaves `emails` rows that no query can reach and no client can
delete. `Calendar/set`'s `onDestroyRemoveEvents` (`calendars.ts:127-147`) is the exact pattern:
enumerate children → guard → destroy children → destroy container → record both in the
changelog.

**Child mailboxes on destroy.** RFC 8621 says a mailbox with children may not be destroyed.
Cheapest correct answer, and the one to take.

**`sortOrder`.** Column exists (`data-plane.sql:12`), already returned (`mailbox.ts:22`) and
already the default sort key in `Mailbox/query` (`mailbox.ts:61-73`). Validate as an unsigned
integer exactly like `validateNewBook` does (`contacts.ts:631-634`) and you are done — this is
the one property with no design question in it.

### 2. Write choreography — the part that fails silently if skipped

`_context.md` §3 is the argument; the mailbox-specific version is shorter than the calendar
one because **mailboxes have no ctag**. Compare the DDL: `address_books`
(`data-plane.sql:159-171`) and `calendars` (`:206-219`) both carry a `ctag` column for the DAV
poll short-circuit; `mailboxes` (`:6-14`) does not, and mail has no DAV surface. So:

```
mutate rows → accumulate ChangeEntry{collection:"Mailbox", created/updated/destroyed}
            → commitChanges(ctx.env.ACCOUNT_DO, accountId, entries) → newState
```

No `bumpCtags` step, no `dav_tombstones` row. Everything else stands. Miss the
`commitChanges` and the mailbox lands in D1, reads back fine on `Mailbox/get`, and is invisible
to `Mailbox/changes` — which means `packages/cli/src/sync.ts` never learns anything happened
and `bullmoose mailboxes` keeps printing the old list. That presents as a sync bug and is a
write-path bug.

Two existing commit sites to imitate: `commitEmailChanges` (`email.ts:308-322`, which already
pushes `{collection: "Mailbox", updated: [...]}` at `:317`) and `commitCalendarEntries`
(`calendars.ts:668-677`, which skips the DO round-trip entirely when every entry is empty —
copy that, it saves a call on a no-op `/set`).

If `onDestroyRemoveEmails` fires, the same commit must carry an `Email` entry with the
destroyed ids. One `commitChanges` call, two entries, as `AddressBook/set` does at
`contacts.ts:237`.

### 3. `Mailstore` methods

New: `insertMailbox`, `updateMailbox`, `deleteMailbox`, `childMailboxIds`, `emailIdsInMailbox`.
Keep them bare — `Mailstore` is a thin data layer and deliberately maintains no invariants
(`_context.md` §3). The validation lives in the method, next to the `SetError` it produces.

### 4. The CLI surface — what makes this `I3`

`bullmoose mailbox create <name> [--parent <id-or-name>] [--sort <n>]`,
`mailbox rename <id-or-name> <new>`, `mailbox move <id> --parent <id|->`,
`mailbox rm <id> [--force]` (`--force` ⇒ `onDestroyRemoveEmails: true`).

Fold them under the existing `mailboxes` command or add a sibling `mailbox` command; the
switch is `packages/cli/src/main.ts:122-229` and the `mailboxes` case is `:205-207`. Follow
`cmdContacts` (`packages/cli/src/contacts.ts:36-45`) for the module shape —
`(db, positionals, opts)`, `requireSettings`, `pickAccount`, `new JmapClient(...)`,
`client.one(...)` (`packages/cli/src/jmap.ts:52`). Register the verbs in the help catalog
(`packages/cli/src/help.ts`, `COMMANDS` from `:55`; the `mailboxes` entry is `:283-285`,
`SubCommand` shape at `:26-30`) or `bullmoose help` will lie about the surface.

⚠️ **Reads and writes will not share a path.** `cmdMailboxes` (`main.ts:879-907`) queries the
**local SQLite mirror** (`:884-890`), while the new verbs must go over JMAP. So a create is not
visible to `bullmoose mailboxes` until `bullmoose sync` runs (`sync.ts:144-158` refreshes the
mailbox table in full from `Mailbox/get` at `:145`). Either the write verbs re-sync
mailboxes inline before returning, or the help text says "run `sync`". Do not leave the user
to discover it.

## Done when

1. `bullmoose mailbox create Receipts` then `bullmoose sync` then `bullmoose mailboxes` shows
   `Receipts`, run by someone who has not read this file.
2. **`Mailbox/changes` with `sinceState` = the state captured *before* the create reports the
   new id.** This is the assertion that catches the raw-SQL / skipped-choreography shortcut —
   a passing `Mailbox/get` proves only that the row exists, which is exactly what the broken
   version also proves. The CLI half of this is the same claim from the other side: a second
   machine running `bullmoose sync` converges on the same folder list.
3. Destroying a role mailbox is refused with a SetError naming the role, and the mailbox is
   still there afterwards. Bonus assertion worth writing: after a *failed* Inbox destroy,
   deliver a message and confirm `ensureRoleMailbox` (`services/ingest/src/index.ts:125`)
   returned the **same** inbox id it used before — i.e. nothing was half-deleted.
4. Destroying a mailbox holding mail fails without `onDestroyRemoveEmails`; with it, the mails
   are gone from `Email/get` *and* reported destroyed in `Email/changes` *and* leave no rows in
   `email_mailboxes`.
5. Creating a child under a parent that would exceed depth 10 fails; creating a sibling with a
   duplicate name fails; a reparent that would form a cycle fails. All three as SetErrors on
   the individual object, with the rest of the batch succeeding.
6. A token holding only `read` cannot create a mailbox.

## Bread-crumbs

- Registry: `services/jmap/src/methods/index.ts:15-28`. Add nothing here — `Mailbox/set` goes
  inside `registerMailboxMethods` (`mailbox.ts:5`) like every other method in the file.
- `requireAccount` is `common.ts:26-56`; `MethodDomain` is `"mail" | "contacts" | "calendar"`
  (`packages/auth-core/src/principal.ts:207`), so mailbox methods take the default `"mail"`
  domain and only the *scope* is a choice. `Email/set` uses `"draft"` for creates, moves **and
  destroys** (`email.ts:230`) even though the lattice has `move` and `delete`
  (`packages/auth-core/src/index.ts:46`). Matching `Email/set` is the consistent call; see
  open question 2.
- ⚠️ `common/001` (P1, open): `hasScope` (`packages/auth-core/src/index.ts:50-53`) returns true
  for any required scope when the token holds `mail` — everything except `admin`. Whatever
  scope you pick is satisfied by a `mail` token today.
- `Mailbox/query` (`mailbox.ts:54-89`) exists only because **himalaya enumerates folders via
  query, not get** — the source comment at `:53` says so, and `docs/architecture/serverless-jmap.md:252`
  names himalaya's JMAP conformance tests as the acceptance target. After `/set` lands, a
  himalaya folder-create is the strongest available external check.
- `applyMailboxFilter` (`mailbox.ts:98-124`) already handles `parentId`, `role`, `hasAnyRole`
  and `name`. Once real hierarchies exist, the `parentId` filter starts mattering; it currently
  can only ever match `null`.
- Tests need `002` first. The only fake-D1 in the repo is local and non-exported
  (`services/agent/src/mcp.test.ts:19-43`) and does not implement `.batch()` — which any
  multi-row mailbox destroy will want, and which `Mailstore`'s existing batched writes already
  use (`packages/mailstore/src/index.ts:384`, `:591-594`, `:614-622`).
- `services/provision/src/index.ts:375-406` is the seeding batch. Once `Mailbox/set` exists,
  consider whether provisioning should call it instead of raw `INSERT`s — see open question 4.

## Open questions / where this could be wrong

1. **Is `isSubscribed` in scope?** `mailbox.ts:38` hardcodes `true` and there is no column. I
   have scoped this unit to *not* add one, which keeps the migration cliff out of the way but
   means a client that unsubscribes a folder gets a silent no-op — arguably worse than
   `invalidProperties`. If a reviewer thinks a write surface must not accept a property it
   discards, the column goes in and the "E3 without a migration" framing above collapses. I am
   about 60/40 on this.
2. **Which scope should `Mailbox/set` require?** I lean `"draft"` to match `Email/set`
   (`email.ts:230`), on the grounds that mailbox management is mail management. But `"delete"`
   for the destroy branch is defensible and the lattice already has the word. Splitting scope
   per branch inside one `/set` is unusual for JMAP and I have not seen it done in this repo.
   Genuinely unsettled.
3. **Reparent as `parentId` patch vs. a separate operation.** RFC 8621 treats `parentId` as a
   plain updatable property. That means one `/set` call can rename, reparent, and reorder
   simultaneously — and the cycle check plus the sibling-name check then have to run against a
   hypothetical post-batch tree, not the current one. I have described that requirement but not
   designed the algorithm; whoever builds this may find the batch semantics are the expensive
   part of the unit rather than an afterthought. **This is the most likely place for the E3
   estimate to be wrong on the high side.**
4. **Should provisioning switch to `Mailbox/set`?** `services/provision/src/index.ts:390-405`
   raw-`INSERT`s six role mailboxes inside the account-creation batch, and commits nothing to
   the AccountDO changelog — which is currently harmless, because the account has no clients
   yet and no prior state to diff against. Routing it through the new method would be tidier
   and would exercise the choreography on day one, but it introduces a provision → jmap
   dependency that does not exist today. I left it alone. Argue with me.
5. **`totalThreads` (`mailbox.ts:25`) is a lie and I did not file it.** It reports the email
   count. Fixing it is unrelated to `/set` and belongs in its own unit, but any test that
   asserts on `Mailbox/get` output will bake the wrong value in.
6. **Nothing here was run** (`_context.md` §7). In particular I have not confirmed that
   himalaya — or any third-party JMAP client — is actually wired against this deployment, so
   done-when #1 leans entirely on the bullmoose CLI. There is **no IMAP or POP3 server in this
   repo** (grep finds the strings only in marketing copy at `packages/cli/src/help.ts` and
   `services/demo-keys/src/index.ts`), so "see the folder in Apple Mail" is *not* available as
   a verification path, and any plan doc implying otherwise is wrong.
