# 006 -E2-I3- `Identity/set` + CLI signatures

| | |
|---|---|
| **Kind** | capability |
| **Effort** | **E3** — `identities` (`control-plane.sql:41-47`) has exactly four columns (`id, account_id, email, name`); signatures/`replyTo`/`bcc` need new ones, and this repo has no migration framework. Regraded from `E2` at review; open question 1 argues the `E2` case (column additions riding the documented `ALTER` convention) and it is not settled |
| **Impact** | **I3** — unlocks *and* human-verifiable |
| **Owner** | `sVOL` |
| **Depends on** | `002` (shared fake-D1 with `.batch()`) |
| **Status** | todo |

## Cells covered

`IdentitySetup × Update × JMAP` · `IdentitySetup × Create/Delete × JMAP` ·
`IdentitySetup × Update × CLI` · `HumanSettings × Update` (the signature half)

The `_index.md` §4 coverage table maps *"HumanSettings × U (`Identity/set`)"* to this unit.

**Signatures and send-as/alternate-from are unreachable on every surface today.** Not "thin",
not "partial" — there is no code path in this repository, on any protocol, that can set a mail
signature or add a second From address to an account after it is provisioned.

## Why these grades

**E2.** `services/jmap/src/methods/identity.ts` is **41 lines** and registers one method. The
work is: extend that file, add three `Mailstore` methods, add columns to one control-plane
table, add a CLI command. Several files, one service plus the CLI, no new dependency edge, no
new service. That is the E2 anchor (`readme.md:71`) almost verbatim — **except for the
columns**, which is the whole argument. See open question 1; I have graded it E2 to match the
ledger and I am not fully convinced.

**I3, both factors:**

- *Unlocks* — `024` (HumanSettings over WebUI) lists `006` as a dependency in the ledger
  (`_index.md:75`). That is a named edge, not a preference. Secondarily, a real `Identity` table
  is what lets `EmailSubmission/set`'s identity check (`submission.ts:120-128`) stop leaning on
  a synthesized fallback.
- *Human-verifiable* — **because of the bundled CLI**, exactly as `readme.md:110-114` describes
  (that passage uses `Identity/set` as its worked example, and this is the unit it was written
  about). Set a signature, send yourself mail, read the mail: the signature is at the bottom.
  Any mail client on earth will show it, because it is just text in the body. No engineer, no
  JSON.

Contrast `005` in this same volume, which does **not** get the bundle and stays `I2` — there,
the cheapest human-visible surface would print a constant. Here it prints something a person
chose and can immediately see travel end-to-end. That contrast is the rubric working.

## What exists today

**`Identity/set` is not registered anywhere.** `identity.ts:4-5`:

```ts
export function registerIdentityMethods(registry: MethodRegistry<RequestContext>): void {
  registry.register("Identity/get", async (args, ctx) => {
```

That is the entire surface. The file has no second `registry.register` call.

**`Identity/get` synthesizes a default when the table is empty** (`identity.ts:9-16`):

```ts
let identities = await store.getIdentities(access.accountId);
// Until provisioning seeds the identities table, synthesize one from
// the principal so sending works out of the box for the dev account.
if (identities.length === 0) {
  identities = [{ id: "identity_default", email: ctx.principal.username, name: access.name }];
}
```

`submission.ts:120-128` carries the matching special case — it accepts the literal id
`"identity_default"` even when no row exists. Any `Identity/set` has to decide what happens
when a client patches an id that is not in the table (open question 3).

**Four properties are hardcoded in the response** (`identity.ts:22-31`):

```
identity.ts:26   replyTo: null,
identity.ts:27   bcc: null,
identity.ts:28   textSignature: "",
identity.ts:29   htmlSignature: "",
identity.ts:30   mayDelete: false,
```

> ⚠️ `_context.md` §2 footnote 17 cites these as `:31-34` and `:35`. **Those line numbers are
> wrong** — the file is 41 lines and the block is `:26-30`. The claim is correct; the citation
> is off by five. Fix it in `_context.md` when convenient.

**The table has nowhere to put them.** `packages/mailstore/sql/control-plane.sql:41-47`:

```sql
-- From-addresses an account may send as (JMAP Identity objects).
CREATE TABLE IF NOT EXISTS identities (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id),
  email       TEXT NOT NULL,               -- must be on an active domain
  name        TEXT NOT NULL DEFAULT '',
  UNIQUE (account_id, email)
);
```

Four columns. `IdentityRow` matches it exactly (`packages/mailstore/src/index.ts:106-110`:
`{id, email, name}`), and `getIdentities` selects only those three
(`packages/mailstore/src/index.ts:1740-1746`). **There is no insert, update, or delete for
identities in `Mailstore`** — the grep returns one `SELECT` and nothing else.

**Rows are written exactly once, at account creation.** `services/provision/src/index.ts:383-384`,
inside the account-create `env.DB.batch([...])` that starts at `:375`:

```ts
env.DB.prepare(`INSERT INTO identities (id, account_id, email, name) VALUES (?, ?, ?, ?)`)
  .bind(`identity_${crypto.randomUUID().slice(0,8)}`, accountId, address, displayName),
```

One identity, from the account's own address. There is no provisioning route to add a second.

**The CLI reads identities but cannot write them.** `packages/cli/src/main.ts:366-379`, inside
`cmdSend`:

```ts
const idRes = await client.one("Identity/get", { accountId: sendAccount, ids: null });
// ...
const identity = opts.identity
  ? identities.find((i) => i.id === opts.identity || i.email === opts.identity)
  : ...
```

The `--identity` flag exists (`main.ts:56`) and selects among identities that **can only ever
be the one provisioning created**. The command switch (`main.ts:122-229`) has no `identity`
case, and `packages/cli/src/help.ts`'s `COMMANDS` catalog has no entry for one.

**Where a signature would have to be applied, if the server did it.** `cmdSend` builds the MIME
locally and sets `from` at `main.ts:419` from the selected identity, uploads the blob, and
`Email/import`s it. `EmailSubmission/set` then hands the **already-built blob id** to the
submit worker (`submission.ts:150`), which fetches the raw bytes from R2
(`services/submit/src/index.ts:72`) and relays them to SES unmodified (`:94`). **`services/submit`
never parses MIME.** Server-side signature injection would mean parsing and rebuilding a signed,
possibly multipart message in the relay path. That is the strongest available argument that
signatures are a client concern — see open question 2.

## What to build

### 1. Columns on `identities`

```sql
reply_to_json   TEXT,                       -- JSON EmailAddress[] or NULL
bcc_json        TEXT,                       -- JSON EmailAddress[] or NULL
text_signature  TEXT NOT NULL DEFAULT '',
html_signature  TEXT NOT NULL DEFAULT '',
may_delete      INTEGER NOT NULL DEFAULT 1  -- 0 for the provisioned primary
```

`reply_to`/`bcc` are JSON arrays to match how the repo already stores address lists
(`emails.from_json` etc., `data-plane.sql:26-29`) and what `Identity/get` returns.

**Follow the repo's documented column-addition convention.** There is no migration framework
(`_context.md` §0.2), but there *is* a precedent, and it is in the schema files themselves —
`packages/mailstore/sql/data-plane.sql:187-190`:

```sql
  -- CardDAV resource name (client-chosen filename minus .vcf on PUT).
  -- NULL → the card id serves as the resource name. Existing DBs:
  --   ALTER TABLE contact_cards ADD COLUMN dav_name TEXT;
  dav_name        TEXT,
```

New columns go in the `CREATE TABLE` (so fresh deploys are correct) **with the `ALTER` written
in a comment beside them** (so an operator on an existing DB has the one-liner). Every column
above is nullable or defaulted, which is what makes the `ALTER` safe on SQLite.

### 2. `Identity/set` (RFC 8621 §6.3)

Register alongside `Identity/get` in `registerIdentityMethods` (`identity.ts:4`). Model on
`AddressBook/set` (`contacts.ts:116-250`) for the skeleton — `ifInState` guard (`:126-128`),
per-collection `ChangeEntry` accumulators (`:137-138`), create/update/destroy loops each
wrapped so one bad object does not fail the batch, per-object errors through `toSetError`
(`:579-590`), single `commitChanges` at the end (`:237`).

Semantics that need deciding, not just coding:

- **`email` is immutable on update.** RFC 8621 says so, and it is also the right call here
  because `email` is half the `UNIQUE (account_id, email)` key (`control-plane.sql:46`). A
  patch touching it returns `invalidProperties`.
- **Create must validate the address against an active domain.** The DDL comment already
  states the rule — `-- must be on an active domain` (`control-plane.sql:44`) — and nothing
  enforces it. The `domains` table is `control-plane.sql:12`. **Without this check
  `Identity/set` becomes a self-service open relay identity: anyone with a token could add
  `ceo@yourbank.com` as a From address.** SES will refuse to send it, so the blast radius is
  a confusing failure rather than actual spoofing — but do not rely on that.
- **`mayDelete` is server-set.** The identity provisioning created should be undeletable
  (`may_delete = 0`); ones a user adds should not be. Right now `identity.ts:30` returns
  `false` for everything, which is accidentally correct today because there is only ever one.
- **Duplicate email on create** hits the `UNIQUE (account_id, email)` index and raises a raw
  D1 constraint error. Map it to `invalidProperties`, not `serverFail` — same trap as `004`'s
  `mailboxes_role` index.
- **Changelog.** `Identity` is **not** in `proxyChanges`'s collection union
  (`common.ts:72-81`) and `Identity/changes` is not registered. RFC 8621 §6.2 defines it. The
  minimum viable choice is to commit an `{collection: "Identity", ...}` entry anyway so the
  account state advances and `Identity/get`'s `state` (`identity.ts:36`) changes after a write
  — otherwise a client that caches on `state` never re-reads. Registering `Identity/changes`
  is a two-line follow-on once the entry exists; I would do both.

### 3. `Mailstore` methods

`insertIdentity`, `updateIdentity`, `deleteIdentity`, and widen `getIdentities`
(`packages/mailstore/src/index.ts:1740`) plus `IdentityRow` (`:106-110`) to carry the new
columns. Bare SQL, no invariants — the validation belongs in the method
(`_context.md` §3).

⚠️ `getIdentities` reads `identities`, a **control-plane** table, through the same
`Mailstore` instance that reads data-plane tables. The source comment says so:
`packages/mailstore/src/index.ts:1738` — *"Identities (control plane, same shard for MVP)"*.
That works because the jmap worker binds one `DB` (`common.ts:58-60`). If the planes are ever
split, every method added here moves with them.

### 4. The CLI surface — what makes this `I3`

```
bullmoose identity list
bullmoose identity show <id-or-email>
bullmoose identity signature <id-or-email> [--text <file|-> ] [--html <file>] [--clear]
bullmoose identity add <email> [--name <n>] [--reply-to <addr>]
bullmoose identity rm <id-or-email>
```

Module shape: copy `cmdContacts` (`packages/cli/src/contacts.ts:36-45`) —
`(db, positionals, opts)`, `requireSettings`, `pickAccount`, `new JmapClient(...)`,
`client.one(...)` (`packages/cli/src/jmap.ts:52`). `cmdVacation` (`main.ts:540-557`) is the
smaller model if you prefer inline: it is a JMAP-backed settings verb with a `status`
subcommand, which is the same shape as `identity list`. Add the `case "identity"` to the switch
(`main.ts:122-229`) and the catalog entry to `packages/cli/src/help.ts` (`COMMANDS` from `:55`,
`SubCommand` interface at `:26-30`).

**Then make `send` apply it.** `cmdSend` already has the identity object in hand at
`main.ts:369-379` and builds the body just after. Appending `textSignature` (separated by the
conventional `\n-- \n`) is a handful of lines in the client, where the MIME is actually being
constructed. That is the change that closes the loop from "set a signature" to "see a
signature". Without it this unit is `I2` with extra steps.

## Done when

1. `bullmoose identity signature default --text ~/.signature`, then `bullmoose send` to
   yourself, then read the message in any mail client: the signature is there. Performed by
   someone who has not read this file.
2. **`Identity/get` returns a different `state` after the write than before it**, and — if you
   registered it — `Identity/changes` reports the id. This is the assertion that catches the
   raw-SQL / skipped-choreography shortcut (`_context.md` §3): an `UPDATE identities SET ...`
   that skips `commitChanges` lands the row, reads back correctly on a direct `Identity/get`,
   and leaves every state-caching client showing the old signature indefinitely. A passing
   `/get` proves nothing on its own.
3. `Identity/set` create with an address on a domain this tenant does not own is **refused**,
   and no row is written.
4. Destroying the provisioned primary identity is refused (`mayDelete: false`), and
   `EmailSubmission/set` still resolves `identityId` afterwards.
5. Adding a second identity and sending with `--identity <the-second-one>` produces mail whose
   `From:` is the second address — verified by reading the received message, not the API
   response.
6. An account with a signature set no longer returns `textSignature: ""` from `Identity/get`;
   an account provisioned before this unit still does, and does not error.

## Bread-crumbs

- `identity.ts` is 41 lines. It is the smallest method file in `services/jmap/src/methods/`
  (compare: `contacts.ts` 1081, `calendars.ts` 717, `email.ts` 626). Nothing in it is load
  bearing except the synthesis block.
- Scope: `VacationResponse/set` — the other "settings" writer — uses `"draft"`
  (`vacation.ts:33`) while its `/get` uses `"read"` (`:12`). Match that. ⚠️ `common/001`
  (P1, open): `hasScope` (`packages/auth-core/src/index.ts:50-53`) makes a `mail`-scoped token
  satisfy any non-`admin` scope, so the gate is weaker than it reads.
- `MethodDomain` is `"mail" | "contacts" | "calendar"` (`packages/auth-core/src/principal.ts:207`).
  Identity is `"mail"`, i.e. the default — no new domain needed.
- `submission.ts:120-128` is the other reader of `getIdentities`. If you widen `IdentityRow`,
  check that this destructure still compiles; it uses `.id` and `.email` only.
- `services/provision/src/index.ts:375-406` is the seeding batch. Once `Identity/set` exists,
  the `INSERT` at `:383` should probably set `may_delete = 0` explicitly rather than relying on
  a default — the provisioned identity is the one that must survive.
- The `domains` table for the active-domain check is `packages/mailstore/sql/control-plane.sql:12`;
  `services/provision/src/index.ts` is where domain status is currently reasoned about.
- Tests: `002` first. Identity writes are simple enough not to need `.batch()`, but the
  provisioning path they interact with does (`services/provision/src/index.ts:375`), and the
  only fake-D1 in the repo (`services/agent/src/mcp.test.ts:19-43`) implements neither
  `.batch()` nor multi-table routing.

## Open questions / where this could be wrong

1. **This may be E3, not E2.** `readme.md:72` puts "new table or column + migration" squarely
   in E3, and this unit adds five columns to a **deployed** control-plane table. My E2 defence
   is the `contact_cards.dav_name` precedent (`data-plane.sql:187-190`): the repo has already
   decided that a nullable/defaulted column plus a commented `ALTER` is a normal-cost change,
   not a migration event. If a reviewer rejects that reading — reasonably, since that precedent
   is one comment in one file and not a written policy — **this is E3** and its position in
   wave 3 of `_index.md` §3 should be re-examined. I think this is the single most likely grade
   error in the four files I wrote.
2. **Does `services/submit` need to apply the signature, or is it a client concern?**
   Unresolved, and it is the real design question in this unit.
   *Client (my lean):* the CLI already builds the MIME (`main.ts:419-435`); the submit worker
   deliberately never parses it (`services/submit/src/index.ts:72,94`) and would need a full
   MIME parse/rebuild to inject anything. *Server:* if signatures are client-applied, then every
   surface has to reimplement them — the CLI, the future WebUI, MCP, and any third-party JMAP
   client — and third-party clients will simply ignore `textSignature`, so the user's signature
   silently vanishes depending on which surface they sent from. That is a bad outcome and it is
   the strongest argument for the server. The middle path — `EmailSubmission/set` appends when
   the message is a `text/plain` single part and declines otherwise — is worse than both,
   because "sometimes" is the one behaviour a user cannot model. **I did not resolve this and
   the unit is buildable either way; whoever picks it up must decide before writing the CLI
   half.**
3. **What happens to `identity_default`?** `Identity/get` synthesizes it (`identity.ts:11-16`)
   and `EmailSubmission/set` accepts it by literal id (`submission.ts:122-125`). Options:
   (a) `Identity/set` materialises a real row on first write, killing the synthesis path;
   (b) keep synthesis and reject writes to the synthetic id. (a) is cleaner and removes two
   special cases; (b) is safer for accounts provisioned before `services/provision/src/index.ts:383`
   existed — **and I could not determine whether any such accounts exist**, since nothing was
   run (`_context.md` §7). I lean (a) with a fallback insert-if-missing, but that is a guess
   about the deployed data.
4. **`replyTo` and `bcc` are in scope here and I nearly cut them.** They are two more columns
   for a feature nobody has asked for, and the unit is `I3` on signatures alone. The argument
   for keeping them: they are hardcoded `null` in the same `.map()` block (`identity.ts:26-27`),
   so they are the same edit, and coming back to `ALTER` this table a second time is exactly the
   cost `_context.md` §0.2 warns about. Cutting them is defensible; cutting them and *then*
   needing them is not.
5. **Nothing was run** (`_context.md` §7). The claim that signatures are unreachable is from
   source only. In particular I did not verify that `services/anglebrackets` has no identity
   surface — I checked that it is a CalDAV/CardDAV worker and that `Identity` appears in no
   JMAP registration, but I did not read all 1234 lines of `dav.ts`.
