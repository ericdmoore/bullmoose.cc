# 002 -E2-I2- Shared fake-D1 with `.batch()`

| | |
|---|---|
| **Kind** | prerequisite |
| **Effort** | **E2** — a new test-fake module plus its first two consumers; no schema change, no migration |
| **Impact** | **I2** — unlocks, not human-verifiable (test infrastructure has no user-facing surface at all) |
| **Owner** | `sVOL` |
| **Depends on** | — |
| **Blocks** | `004` (`Mailbox/set`) · `006` (`Identity/set`) · `007` (AgentInvocation trigger) · `013` (Calendar + Contacts over MCP) · `014` (Email over MCP) |
| **Status** | **✅ done** — shipped as `packages/test-fakes` (`@bullmoose/test-fakes`) |

> ## Shipped — what actually landed, and where this file was wrong
>
> **Option (c) as recommended**, plus two things this file did not scope. See
> *§ Outcome* at the bottom for the decision record and the answers to the Open
> Questions.
>
> | This file said | Reality when built |
> |---|---|
> | "Two test files in the entire repo" | 16 files / 284 tests. Written against `8ba3fe3`; the P1 security work landed in between. |
> | one fake to extract (`mcp.test.ts`) | **six** divergent fakes, in `services/agent`, `services/jmap` (×3), `services/jmap/src/methods` (×2 — one had grown a `batch` router) and `services/provision`. Consolidating divergence was the job, not extraction. |
> | test files are excluded from `tsc` | they are typechecked in both configs now, so the `as unknown as` casts were live code, not invisible. |
> | `packages/auth-core/src/principal.test.ts` — "check whether it rolls its own D1 fake" (OQ #5) | it does not. It tests the pure `authorizeAccount` path and needed no change. |

## Cells covered

**None.** Test infrastructure has no cell in the grid and never will — it is not a noun and not
a surface. `_index.md` §4 lists nothing that maps here.

It **gates the write-path tests** for every unit above. More precisely, it gates any test that
reaches a `Mailstore` write, because nine of `Mailstore`'s write methods go through
`db.batch()` and the only fake D1 in the repo does not implement it. That is not a subset of
the write paths; with one exception it is all of them.

## Why these grades

**E2.** More than one file and more than one package: the fake itself, a package or module to
hold it, `mcp.test.ts` migrated onto it, and at least one new test proving a `.batch()` path
works. No schema change, no new method, no migration — so it does not reach `E3`. It is
comfortably past `E1`'s "one file, no new dependency" anchor.

**I2, both factors:**

- *Unlocks* — five ledger units name it. `013:146-148` states the edge explicitly: `Mailstore`
  calendar writes use `.batch()` and the existing fake does not implement it.
- *Not human-verifiable* — a non-engineer cannot observe a test fake by any interface. This is
  the clearest `I2` in the volume; there is no judgement call in it.

## What exists today

**Two test files in the entire repo:**

```
packages/auth-core/src/principal.test.ts
services/agent/src/mcp.test.ts
```

`find packages services -name '*.test.ts' -not -path '*/node_modules/*'` returns exactly those
two. `packages/cli` — 19 top-level commands — has no test directory, and is additionally
excluded from coverage reporting (`vitest.config.ts:24`), so its 0% does not even appear in the
number CI diffs.

### The fake

`fakeD1` is a local, **non-exported** function at `services/agent/src/mcp.test.ts:19-43`. Its
entire routing logic:

```ts
async first() {
  if (sql.includes("FROM tokens t JOIN principals")) return rows.token ?? null;
  return null;
},
async all() {
  if (sql.includes("FROM accounts WHERE principal_id")) return { results: rows.accounts ?? [] };
  if (sql.includes("FROM grants g")) return { results: rows.grants ?? [] };
  return { results: rows.tool ?? [] };      // :35 — catch-all
},
async run() { writes.push({ sql, args: bound }); return { meta: { changes: 1 } }; },
```

Three properties matter:

1. **It routes by SQL substring match.** Three literal fragments, then a catch-all at `:35` that
   returns whatever the fixture put in `rows.tool` for *any unmatched query*. That is precisely
   right for four analytics tools whose only assertion is "a row came back", and precisely wrong
   for anything that reads back what it wrote — the catch-all cannot distinguish
   `SELECT … FROM calendar_events` from `SELECT … FROM contact_cards`, so a test can pass while
   the code under test queries the wrong table.
2. **It has no `.batch()`.** `D1Database` declares `prepare`, `batch`, `exec`, `withSession` and
   `dump` (`node_modules/@cloudflare/workers-types/index.d.ts`, `declare abstract class
   D1Database`); the fake implements one of five. Calling `.batch()` on it is a
   `TypeError: db.batch is not a function` — the test doesn't fail an assertion, it throws.
3. **It is not type-checked and cannot be.** `mcp.test.ts:89-90` carries the comment *"Test file
   is excluded from tsc; the env only needs DB for this handler"* and casts through
   `as unknown as`. That is accurate: `tsconfig.json:33` excludes `**/*.test.ts`. So the fake's
   divergence from the real `D1Database` shape is invisible to the compiler by construction.

### What actually needs `.batch()`

Nine `Mailstore` methods and one provisioning path:

| method | `Mailstore` | `.batch()` at |
|---|---|---|
| `insertEmail` | `:564` | `:604` |
| `replaceEmailSets` | `:608` | `:640` |
| `destroyEmail` | `:643` | `:646` |
| `setDefaultAddressBook` | `:788` | `:789` |
| `insertContactCards` | `:1019` | `:1021` |
| `destroyContactCards` | `:1074` | `:1086` |
| `setDefaultCalendar` | `:1385` | `:1386` |
| `insertCalendarEvents` | `:1511` | `:1513` |
| `destroyCalendarEvents` | `:1565` | `:1577` |
| account seed | `services/provision/src/index.ts:375` | — |

(All in `packages/mailstore/src/index.ts` unless noted.) Note the shape: **create and destroy
batch; update does not** — `updateCalendarEvent` (`:1540`) is a single prepared `UPDATE`. So a
test suite that only exercises updates would never notice, which is a plausible way to build a
false sense of coverage.

### What the config says about the alternative

`vitest.config.ts:3-6`:

> *Fast unit tests, no workerd/miniflare: per `.plans/devPrinciples.md` the core logic is pure
> and clients are injected, so tests run in plain Node with fakes and need no network.
> Worker-level integration (miniflare/D1) can be added later for the shell paths that resist
> faking.*

`environment: "node"` (`:11`), include `packages/**/*.test.ts` + `services/**/*.test.ts` (`:9`).
The "can be added later" is a deferred decision with no owner. **This unit is the forcing
function** — write-path tests are exactly the "shell paths that resist faking" that clause
names.

## What to build

### The fork

Three real options, not two.

**(a) Extract and improve the substring fake.** Move `fakeD1` somewhere shared, add a `batch()`
that maps statements and returns `D1Result[]`, add more SQL fragments to the router.
*Cheapest by far — perhaps an afternoon.* But the routing table grows one fragment per query
per test, every fragment is a duplicate of a string literal in production SQL, and it rots
silently: change a `WHERE` clause in `Mailstore` and the fake keeps matching on the old
substring. Worse, a write followed by a read is not modelled at all — `run()` pushes to an array
and `all()` never consults it, so round-trip assertions are impossible without hand-wiring each
one. Every unit blocked on `002` wants a round-trip assertion.

**(b) Adopt miniflare / `@cloudflare/vitest-pool-workers`.** True D1, true workerd, true
`.batch()` semantics including atomicity. It is the only option that tests what actually
deploys. Costs: a pool change in `vitest.config.ts` that affects the whole repo, workerd in CI,
a per-test-file worker boot, and a deliberate reversal of the config's stated stance. It also
does not compose cleanly with `packages/auth-core/src/principal.test.ts`, which is pure and
wants to stay in the Node pool.

**(c) A `node:sqlite`-backed fake implementing the `D1Database` shape.** Real SQL, real tables,
real joins, real round-trips, still `environment: "node"`, no workerd.

### Recommendation: (c), and it is verified to work

`node:sqlite` is already load-bearing in this repo — `packages/cli/src/db.ts:1` imports
`DatabaseSync` from it, and four more CLI modules import its types. The environment runs Node
v24.18.1.

I loaded both live schema files into an in-memory `node:sqlite` database:

```
OK   packages/mailstore/sql/control-plane.sql
OK   packages/mailstore/sql/data-plane.sql
tables: 32  accounts address_books agent_bindings agent_invocations calendar_events calendars
            contact_cards credentials dav_tombstones domains email_keywords email_mailboxes
            email_submissions emails emails_fts … tenants tokens vault_credentials
```

Zero errors, including the FTS5 virtual table at `packages/mailstore/sql/data-plane.sql:44` —
`node:sqlite` in Node 24 ships with FTS5 compiled in (I checked that separately before trusting
it). **This is the only claim in this file I verified by execution rather than by reading.**

That means the fake can be seeded from the same `.sql` files wrangler applies, so the test
schema cannot drift from the deployed schema — which, in a repo with no migration framework
(`tools/README.md:10-11`), is worth more than it would be elsewhere.

Shape:

```ts
export function fakeD1(opts?: { schema?: string[]; seed?: (db) => void }): D1Database & {
  writes: Array<{ sql: string; args: unknown[] }>;   // keep the assertion affordance
  raw: DatabaseSync;                                  // escape hatch for arrange/assert
}
```

- `prepare(sql)` → a statement object with `bind`, `first`, `run`, `all`, `raw` matching
  `D1PreparedStatement`.
- `batch(statements)` → run them **inside a `BEGIN`/`COMMIT`**, returning `D1Result[]`. D1's
  `batch` is atomic; a fake that executes sequentially without a transaction will let a test
  pass on code that would leave a half-written row in production. Model the rollback.
- Keep the `writes` array from the current fake. `mcp.test.ts:199,218,250-253` assert on it, and
  those assertions ("no `grant_audit` row was written") are genuinely good — a real DB would
  make them clumsier, not better. Keep both affordances.

### Where it lives

`packages/*` and `services/*` are npm workspaces (root `package.json:5-8`) and the symlinks in
`node_modules/@bullmoose/` are how `mcp.test.ts:2`'s `@bullmoose/auth-core` import resolves at
runtime. A new `packages/test-fakes` would need:

- `package.json` with `"exports"` (runtime resolution, via the workspace symlink), **and**
- an entry in `tsconfig.json:17-27` `paths` (compile-time resolution).

Both are needed; they are separate mechanisms. Note the side effect: unlike a `.test.ts` file,
`packages/test-fakes/src/*.ts` **is** matched by `tsconfig.json:29` and by the coverage
`include` at `vitest.config.ts:23`. So the fake gains type-checking against the real
`D1Database` — which is most of its value, since that is exactly what today's fake lacks — and
it shows up in the coverage report as a source file, which is noise. Add it to the coverage
`exclude` at `vitest.config.ts:24` alongside `packages/cli/**`.

The zero-ceremony alternative is a plain relative import from a repo-root `test/` directory —
vitest resolves it with no manifest at all. It works, it's ugly, and it forfeits the
type-checking. See Open Questions #2.

### Migrate `mcp.test.ts` in the same change

All ten existing cases must pass against the new fake **unmodified except for the import and
the fixture setup**. That is the regression net for the fake itself. If a case needs its
assertion loosened to pass, the fake is wrong — investigate rather than loosen.

## Done when

1. The fake is importable from one place, satisfies `D1Database` under `tsc --noEmit` **without
   an `as unknown as` cast**, and `mcp.test.ts:89-90`'s cast and its apologetic comment are both
   gone.
2. `mcp.test.ts`'s ten cases (`:94-254`) pass with no assertion changed.
3. A new test calls `Mailstore.insertCalendarEvents` (`:1511`) against the fake, then reads the
   rows back through `Mailstore.getCalendarEvents` and asserts on the returned event — a real
   round-trip through `.batch()`, which is impossible today by two independent mechanisms
   (no `batch`, and `run()` writes to an array `all()` never reads).
4. A `.batch()` whose second statement violates a constraint leaves **no** rows from the first
   statement. This is the atomicity assertion; without it the fake is a lie about D1 in the
   direction that matters.
5. `npm test` still runs in the Node pool. No workerd, no wrangler, no network. If the run time
   for the whole suite exceeds a couple of seconds, something is wrong with the approach.

## Bread-crumbs

- `D1Database` is a `declare abstract class` with no private members, so a plain object
  satisfies it structurally — no `implements` needed, but **all five** of `prepare`, `batch`,
  `exec`, `withSession`, `dump` must be present or `tsc` rejects it. `withSession` and `dump`
  can throw `new Error("not implemented in fake")`; that is honest and takes two lines.
  `D1PreparedStatement` needs `bind`, `first` (two overloads — with and without a column name),
  `run`, `all`, `raw`.
- `.plans/devPrinciples.md` explicitly authorizes this: *"leverage 3rd party fake-clients &
  fake-db-mocks, and harnesses for testing - make them as needed"* and *"By injecting
  fake-clients most of the shell code can get coverage too without the need for real network
  access."* This unit is that line being cashed.
- `Mailstore`'s constructor is `new Mailstore(ctx.env.DB, ctx.env.BLOBS)`
  (`services/jmap/src/methods/common.ts:58-60`) — the fake D1 is only half of what a `Mailstore`
  test needs. An R2 fake is a second, smaller thing.
- The `writes`-array assertion style in `mcp.test.ts:199,218` is checking a **negative** ("no
  `grant_audit` row"). With a real SQLite backend the equivalent is `SELECT COUNT(*) FROM
  grant_audit`, which is better. Migrate those assertions rather than preserving the array
  idiom for its own sake — but keep the array available, because asserting on the *exact SQL
  text* is occasionally the point.
- `services/agent/package.json` does not declare `@bullmoose/auth-core` even though
  `mcp.test.ts:2` imports it. It resolves by hoisting. Adding a `devDependencies` entry for the
  new fake package to each consumer is the correct-but-optional hygiene step; hoisting will make
  it work either way, which is precisely why it gets forgotten.
- `packages/auth-core/src/principal.test.ts` is the other existing test file — check whether it
  rolls its own D1 fake too before designing the interface. I did not read it.

## Open questions / where this could be wrong

1. **"Unlocks every write-path test" is overstated, including in this file's own dependency
   list.** A write-path test that goes through the JMAP method layer — which is what `013`
   requires, per `_context.md` §3 and `013:55-74` — needs more than D1. `requireAccount`'s
   siblings in the same module reach `ACCOUNT_DO` for the changelog (`common.ts:62-66`,
   `:102`), and `storeFor` needs `BLOBS` (`common.ts:58-60`). The `Env` for `services/agent`
   declares `DB`, `BLOBS`, `ROUTES`, `SUBMIT`, `ACCOUNT_DO`, `AI` (`services/agent/src/models.ts:7-20`).
   So `013`'s done-when #2 — *"the write appears in `CalendarEvent/changes`"* — is not testable
   with a D1 fake alone; it needs a Durable Object fake. Either `002`'s scope should widen to
   "the fake-client harness" or the ledger's dependency edge from `013` to `002` is necessary
   but not sufficient, and something is missing from the ledger entirely. **I think the ledger
   is incomplete here and this is the most useful thing in this file.**

2. **`E2` is arguably wrong if the fake becomes a package.** `readme.md`'s `E4` anchor is *"New
   workspace, service, or protocol surface"* — and `packages/test-fakes` is literally a new
   workspace. I do not believe that is what the anchor means: it exists to capture WebUI and
   GraphQL, where the cost driver is a stack that does not exist and a deployment that does not
   exist. A 200-line test helper has neither. But the rubric as written does not say that, and a
   reviewer applying it literally gets `E4` for this unit, which would be absurd. Either the
   anchor needs a carve-out for non-deployed workspaces, or the fake should live in an existing
   package (`packages/mailstore/src/testing/d1.ts`) to dodge the question. I lean carve-out; I
   would not fight about it.

3. **`node:sqlite` is not D1, and I have not mapped the gap.** I verified the schema loads and
   FTS5 works. I did **not** check: D1's `D1Result.meta` fields (`changes`, `last_row_id`,
   `duration`, `rows_read`, `rows_written`) against what `node:sqlite` reports; whether any SQL
   in `Mailstore` uses a D1-specific dialect quirk; whether error messages differ in ways a test
   might assert on; or D1's session-consistency semantics, which the fake will not model at all.
   A test that passes against `node:sqlite` and fails against real D1 is the failure mode this
   whole option risks, and I cannot bound it from reading alone.

4. **I may be wrong to defer miniflare.** Option (b) is the only one that tests the thing that
   deploys, and there is a real argument that a repo with two test files should not be building
   its own D1 emulator as its third act of testing. The counter-argument I am relying on —
   that `@cloudflare/vitest-pool-workers` would change the pool for `principal.test.ts` too and
   slow the loop — is an assumption I did not measure. I also did not check whether the pool can
   be scoped per-project via a vitest workspace config, which if it can would substantially
   weaken my objection. Someone should spend twenty minutes on that before committing to (c).

5. **I did not read `packages/auth-core/src/principal.test.ts`.** It is one of the two tests in
   the repo and it tests the pure `authorizeAccount` path, so it probably needs no D1 at all —
   but "probably" is doing work there, and if it has its own fake, this unit should absorb that
   one too and I have not accounted for it.

6. **One citation in `_context.md` §5 is off by one.** It cites `vitest.config.ts:25` for the
   `packages/cli/**` coverage exclusion; the `exclude` line is `:24` (`:25` is the closing brace
   of the `coverage` block). The claim is correct, the line is not.

---

## Outcome — the decision record

### The fork: (c), and (b) is now a *cheaper* future step, not a foregone one

**Chose (c), a `node:sqlite`-backed fake.** `packages/test-fakes/src/d1.ts` loads
`packages/mailstore/sql/{control-plane,data-plane}.sql` — the same files wrangler applies —
into an in-memory `DatabaseSync` and implements all five `D1Database` members.

Why not **(a) extract-and-improve**: the union of what the six fakes routed is ~12 SQL
fragments, and every one is a duplicate of a string literal in production SQL. More decisively,
(a) cannot satisfy done-when #3 or #4 *at all*: `run()` writes to an array `all()` never reads,
so a round-trip is not expressible, and there is no transaction to roll back. The two
acceptance criteria that make this unit worth doing are the two (a) cannot meet.

Why not **(b) miniflare / `@cloudflare/vitest-pool-workers`**, and the twenty minutes OQ #4
asked for: the pool **can** be scoped per-project via a vitest workspace, so that objection was
indeed weak — as suspected. The reasons that survive are different ones:

1. **It is not on the critical path.** (b) tests the *shell*: bindings, DO placement, real D1
   wire semantics. The units blocked on `002` (`004`, `006`, `007`, `013`, `014`) are blocked
   on the *write choreography* — mutate → bump ctag → commit changelog — which is method-layer
   logic. A workerd boot per test file buys nothing for that and costs a second of loop time
   per file forever.
2. **The `AccountDO` half is better under (c) than it looks.** The fake runs the **real**
   `AccountDO` class over in-memory storage, so `/changes` collapse semantics and the 409
   window are the shipped code, not a re-implementation. That was the part (b) was supposed to
   win, and (c) wins most of it for ~90 lines.
3. **The whole suite is 333 ms.** Done-when #5's bar was "a couple of seconds". Adopting (b)
   repo-wide would trade that for a boot cost paid on every run by every test, including the
   ~180 pure ones that want nothing to do with a Worker.

**(b) is still the right answer for a different question** — "does this deploy?" — and it is
now *cheaper* to adopt, because the fixtures are real SQL against the real schema rather than
substring routers. A future integration suite can seed the same rows through wrangler's local
D1 and reuse the fixture builders verbatim. Filing that is `_verify.sh`'s job, not this unit's.

### Where it lives, and why it is not a workspace

`packages/test-fakes/`, with **no `package.json`**. That is deliberate and load-bearing:

- npm's `packages/*` workspace glob only matches directories that contain a `package.json`, so
  nothing is linked into `node_modules/@bullmoose/`. Resolution exists **only** in
  `tsconfig.json`'s `paths` and `vitest.config.ts`'s `resolve.alias` — under `tsc` and under
  vitest, and nowhere else. The module imports `node:sqlite`, which workerd does not have; a
  wrangler build that reached this specifier now fails loudly instead of bundling a Node
  builtin into a Worker.
- It is still fully typechecked — root `tsconfig.json`'s `include` covers every package's
  `src` — so `FakeD1 implements D1Database` is verified against the real `@cloudflare/
  workers-types`, with **no `as unknown as`**. That was most of the value and exactly what the
  six local fakes could not do.
- It also settles **OQ #2** without needing the rubric carve-out: this is not a new workspace,
  so the `E4` anchor never fires. `E2` stands as filed.
- The location was checked against every consumer. `packages/cli` **cannot** import it — its
  tsconfig is Node-typed with no `paths`, which is why it is excluded from the root program in
  the first place. No CLI test needs a D1 fake today (they use `node:sqlite` directly); if one
  ever does, it needs a relative import, not this specifier.

### What became newly testable

The harness must catch something the old fakes could not. It does, in four ways:

1. **The write choreography.** `services/jmap/src/methods/calendars.test.ts` now asserts that
   `CalendarEvent/set` shows up in `CalendarEvent/changes`, commits under that collection and
   no other, bumps the calendar's `ctag`, and commits **nothing** when the write is rejected.
   This is `_context.md` §3's failure mode — a write that lands the row and skips `commitChanges`
   reads back fine and is invisible to every incremental consumer — and it is exactly `013`'s
   done-when #2. The old `ACCOUNT_DO` stub returned a canned `{oldState:"s1", newState:"s2"}`,
   which answers "did the changelog record it?" identically whether or not it did.
2. **Round-trips and atomicity.** `Mailstore.insertCalendarEvents` → `getCalendarEvents` through
   a real `.batch()`, and a batch whose second statement violates `UNIQUE (account_id, uid)`
   leaves **no** rows from the first. Impossible before by two independent mechanisms.
3. **Negative assertions that mean something.** "Nothing was written" used to mean "no INSERT
   was attempted". It can now mean "the table is empty", which is the claim anyone reading the
   test thinks it makes.
4. **Wrong-table bugs fail.** The old catch-all answered *any* unmatched query from a fixture.
   An unpreparable query is now an error, and account scoping is enforced by real `WHERE`
   clauses rather than assumed.

Side effect worth recording: line coverage went **~11% → 21.8%**, most of it
`packages/mailstore` (0% → 22.9%), because the store's SQL now actually executes.

### Four fidelity bugs the review caught, and what they teach

A review pass over the diff found four places where the fake would have let a test pass on
code that fails in production — the worst possible defect in a harness. All four are fixed with
regression tests, and all four were verified against `node:sqlite` before being believed:

1. **`undefined` bound as NULL.** Real D1 throws `D1_TYPE_ERROR`, and `undefined` is exactly
   what a fixture missing an optional key produces. The fake would have written a clean row.
2. **`.run()` on a read.** `node:sqlite`'s `run()` reports a *stale* `sqlite3_changes` value, so
   `SELECT … .run()` returned `changes: 1` and no rows. `run()` and `batch()` now share one
   kind-aware executor.
3. **Rollback masking the real error.** `ON CONFLICT ROLLBACK` unwinds the transaction itself,
   so the fake's own `ROLLBACK` threw *"no transaction is active"* and replaced the constraint
   violation with it.
4. **The DO stub dropped headers.** `services/jmap/src/index.ts:96` passes a `Request` as the
   *init* argument and `AccountDO.upgradeWebSocket` reads `Upgrade`, so header loss produces a
   426 only the fake sees.

The pattern is worth naming for anyone extending this: **every convenience the fake offers the
caller is a potential lie about what deploys.** Three of the four were coercions or shortcuts
that made the fake easier to use. When in doubt, throw.

### Answers to the Open Questions

1. **"Unlocks every write-path test" was overstated — correct, and the scope was widened.**
   Built: `BLOBS` (a real in-memory R2) and `ACCOUNT_DO` (the real `AccountDO`), alongside D1
   and KV. `_index.md` footnote 1 already recorded the widening; it is now discharged.
2. **`E2` stands.** Not a workspace — see above.
3. **`node:sqlite` is not D1 — gap now partly mapped, not closed.** Mapped: `D1Meta.changes` /
   `last_row_id` are real, the rest are fillers; `batch` is atomic and reports per-statement
   meta by statement kind; foreign keys are ENFORCED (node:sqlite's default, and D1's), which
   is stricter than the fakes it replaces and forced every fixture to seed a coherent
   control-plane spine — hence `seedAccount()`. Still unmapped and documented in the source:
   D1's session consistency (`withSession` throws), and the fact that both schema planes load
   into **one** database where production has two.
4. **The miniflare deferral is defended above, on different grounds than this file guessed.**
   The pool *can* be scoped per-project; that argument is withdrawn.
5. **`principal.test.ts` has no D1 fake.** Pure; untouched.
6. Citation fixed by not restating it.

### Operational note

`node:sqlite` needs Node **>= 22.13**, where `--experimental-sqlite` was dropped (added
flagged in 22.5). CI pins `node-version: 22`, which resolves to the latest 22.x, so `verify` is
satisfied — but pinning an exact older 22.x would break `npm test` with a module-not-found.
Recorded in `packages/test-fakes/src/node-builtins.d.ts` too.

### Out of scope, worth filing

- **`services/agent/src/index.ts:329`** (`finish`) writes terminal invocation state with raw SQL
  and bypasses `commitChanges`, so invocation completion never reaches the changelog.
  `_context.md` footnote 13 already flags it as live in the tree. It is now *testable* — the
  choreography assertions in `calendars.test.ts` are the template — and it deserves a
  `.feedback` issue independent of this volume.
- **`services/anglebrackets`, `services/ingest`, `services/submit`** are still at 0% and all
  three are shell paths this harness now makes cheap to reach. No unit owns that.
