# _index — the grid and the ledger

**Start here.** `_context.md` is the audited evidence behind every claim on this page.
`readme.md` defines the grades and the capability/projection law.

---

## 1. The grid

Every noun × surface. `CRUD` = built · `-` = absent · `n/a` = not meaningful ·
`~` = partial. Footnotes and `file:line` evidence live in `_context.md` §2.

| Noun | JMAP | CLI | MCP | DAV | WebUI | GraphQL | Transport |
|---|---|---|---|---|---|---|---|
| Email | `CRUD` | `-R~-` | `CRUD` | `----` | `----` | `----` | `C---` |
| Mailbox | `CRUD` | `CRUD` | `-R--` | `----` | `----` | `----` | `~` |
| Thread | `-R--` | `----` | `----` | `----` | `----` | `----` | n/a |
| EmailSubmission | `CR--` | `C---` | `----` | `----` | `----` | `----` | `C---` |
| AddressBook | `CRUD` | `~R--` | `-R--` | `CRUD` | `----` | `----` | n/a |
| ContactCard | `CRUD` | `CR--` | `CRUD` | `CRUD` | `----` | `----` | n/a |
| Calendar | `CRUD` | `-R--` | `-R--` | `CRUD` | `----` | `----` | n/a |
| CalendarEvent | `CRUD` | `-R--` | `CRUD` | `CRUD` | `----` | `----` | n/a |
| **FileNode** | `CRUD` | `----` | `----` | `----` | `----` | `----` | n/a |
| Agents | `-RU-` | `-RU-` | `----` | n/a | `----` | `----` | `C---` |
| Secrets | n/a | `CRUD` | `----` | n/a | `----` | `----` | n/a |
| HumanSettings | `~R~-` | `-RU-` | `----` | n/a | `----` | `----` | n/a |
| IdentitySetup | `CRUD` | `CRUD` | `----` | `~` | `----` | `----` | n/a |
| SystemAdmin | `CRUD` | `CRUD` | `----` | n/a | `----` | `----` | n/a |

**What the grid says at a glance:**

- **Contacts and Calendar are finished at the expensive layer** — full CRUD on JMAP, DAV and
  now MCP. What remains for them is the CLI and WebUI columns, plus collection C/U/D over MCP.
- **`Mailbox` was the outlier and no longer is.** It used to read *"mail is the flagship noun
  and the least mutable thing in the system — no create, rename, move or delete on any
  surface."* `004` shipped `Mailbox/set` plus the CLI verbs.
- **The MCP column is no longer empty.** `013` landed ten tools and MCP's first WRITE of any
  kind: full CRUD on `CalendarEvent` and `ContactCard`, Read on `Calendar` and `AddressBook`.
  `014` then added eight Email tools — read, search, body, and triage (flag / move / destroy)
  plus `Mailbox` Read — and deliberately **no send tool**, an invariant asserted over the tool
  table. `015` added seven read-only introspection tools over the authorization state itself
  (`Agents × Read`, `SystemAdmin × Read`), narrowed to accounts the caller **owns**. Note the
  shape of what
  shipped — the two *collection* nouns are `R` only, because the unit's own tool list maps
  `calendar_list` → `Calendar/get` and `contacts_list_books` → `AddressBook/get` and stops
  there; creating and deleting calendars and address books over MCP is unfiled (see §4).
- **`SystemAdmin` closed its `~~` on both surfaces, with two asterisks worth keeping.** `008`
  landed rename, suspend/resume, and delete for tenant, domain, account and agent-binding.
  Account delete is **soft** (a `deleted_at` tombstone plus a route/KV teardown — the mail is
  on a shard this worker cannot reach), and `principals`, `credentials` and `identities` still
  have no delete of their own; they go when their tenant does. Also note the row's **`agent
  disable`** — the one route here that is a safety control rather than an ergonomic one, and
  the reason this unit moved from wave 4 to wave 3 (footnote ⁵).
- **`Agents × D` is deliberately still open in §4 even though `agent unbind` shipped.** `008`
  built binding delete; `007` owns *invocation* create/delete. `config.yml` files both under
  `Agents`, which is the disagreement `✅008`'s own header records — resolving it is a ledger
  decision, not a code one.
- **The WebUI and GraphQL columns are empty because the surfaces don't exist.** Every cell
  there is `E4` by definition.
- **DAV is read-write end to end, at both levels.** Cards and events PUT/DELETE with proper
  ETags; collections gained create/delete in `009` (`MKCALENDAR` / extended `MKCOL` /
  collection `DELETE`) and update in `common/026` item 3 (`PROPPATCH`). Both DAV collection
  columns now read `CRUD` — a client can create, rename, recolour and delete a calendar or
  address book. This bullet used to end *"the one remaining `-` is Update"*.

---

## 2. The ledger

`kind`: **cap** = capability · **proj** = projection · **pre** = prerequisite.
`owner`: `sVOL` = this volume owns it · otherwise the section that already does.

| # | Unit | kind | E | I | owner | depends on | status |
|---|---|---|---|---|---|---|---|
| 001 | MCP `ToolDef` scope + domain | pre | E1 | I2 | sVOL | — | **✅ done** |
| 002 | Shared test harness — fake D1 (`.batch()`) + DO/blob stubs ¹ | pre | E2 | I2 | sVOL | — | **✅ done** |
| 003 | Recurrence correctness before calendar writes | pre | **E3** ⁶ | I3 | `common/003` | — | **✅ done** |
| 004 | `Mailbox/set` + CLI | cap | E3 | I3 | sVOL | 002 ⁷ | **✅ done** |
| 005 | `EmailSubmission/get` | cap | E1 | I2 | sVOL | — | **✅ done** ⁸ |
| 006 | `Identity/set` + CLI signatures | cap | **E3** ² | I3 | sVOL | 002 | **✅ done** |
| 007 | `AgentInvocation` on-demand trigger | cap | E2 | I3 | sVOL | 002 | **✅ done** |
| 008 | Admin lifecycle — update + delete | cap | **E3** ⁵ | **I3** ⁵ | sVOL | — | **✅ done** |
| 009 | DAV collection creation (`MKCOL`/`MKCALENDAR`) | cap | E2 | I3 | sVOL | — | **✅ done** |
| 010 | Blob lifecycle — enumerate, delete, revoke share | cap | E2 ⁸ | I1 | sVOL | — | **✅ done** |
| 011 | The `FileNode` noun | cap | E4 | I3 | **s03.B** | s03.A | **T1+T2 done; T3 deferred** |
| 012 | `AddressBook/query` + `Calendar/query` | cap | E1 | I1 ³ | sVOL | — | **wontfix** ³ — neither method exists in RFC 9610 §2 / draft-jmap-calendars-27 §4 |
| 013 | **Calendar + Contacts CRUD over MCP** | proj | E2 | I3 | sVOL | 001, 002, 003 | **✅ done** |
| 014 | **Email read + triage over MCP** | proj | E2 | I3 | sVOL | 001, 002 | **✅ done** |
| 015 | **Self-introspection over MCP (`help@`)** | proj | E2 | I1 | sVOL | 001 | **✅ done** |
| 016 | **CLI I/O contract** | proj ⁹ | E2 | I3 | **s05** T1 | — | **✅ done** |
| 017 | Contacts CRUD over CLI | proj | E2 | I3 | **s05** T2 | ~~016~~ **unblocked** | **✅ done** |
| 018 | Calendar CRUD over CLI | proj | E2 | I3 | **s05** T3 | ~~016, 003~~ **unblocked** | **✅ done** ¹⁰ |
| 019 | Email triage verbs over CLI | proj | E2 | I3 | sVOL | ~~016~~ **unblocked** | **✅ done** |
| 020 | Creds mint-time fields | proj | E2 | I2 | **s05** T4 + **s04** | ~~s04 spec~~ **decomposed** | **✅ done** |
| 021 | Email + Files over WebUI | proj | E4 | I3 | **s03.C** | s03.A, s03.B | todo |
| 022 | Contacts + Calendar over WebUI | proj | E4 | I3 | sVOL | 021 | todo |
| 023 | Agents + Secrets over WebUI | proj | E4 | **I1** ⁴ | **s03.E** | s04 spec, 021 | todo |
| 024 | HumanSettings over WebUI | proj | E1 | I1 | sVOL | 006, 021 | todo |
| 025 | GraphQL facade | proj | E4 | I2 | `common/022` | spike first | todo |
| 026 | `queryChanges` for the four stubs | cap | E3 | **I0** ⁴ | sVOL | — | deferred |
| 027 | `Thread/changes` | cap | E2 | I0 | sVOL | — | deferred |

¹ **`002` was widened after review.** As first scoped it was "shared fake-D1 with `.batch()`",
which is necessary but **not sufficient**: `storeFor` requires `env.BLOBS`
(`services/jmap/src/methods/common.ts:58`) and the changelog commit requires `env.ACCOUNT_DO`
(`common.ts:62-63`). Any acceptance criterion of the form *"…and the write appears in
`Foo/changes`"* — which is the criterion that catches the skipped-choreography bug — is
untestable without DO stubs too. The unit file still carries the narrower title; its Open
Questions section owns the discrepancy.

  **Shipped as `@bullmoose/test-fakes`.** The widened scope was built: D1 (real SQLite on the
  live schema, atomic `.batch()`), R2, KV, and `ACCOUNT_DO` — the last running the **real**
  `AccountDO` class over in-memory storage, so `Foo/changes` is answered by the deployed
  changelog rather than a canned `{newState}`. Six local fakes were consolidated, not one: the
  count grew to `services/provision/src/mintScopes.test.ts` as well. `013`'s done-when #2 is now
  a supported assertion, and `services/jmap/src/methods/calendars.test.ts` demonstrates it.

² **`006` was regraded `E2` → `E3` after review.** `identities`
(`packages/mailstore/sql/control-plane.sql:41-47`) has exactly four columns —
`id, account_id, email, name`. Signatures, `replyTo`, and `bcc` have nowhere to go, so this
needs new columns in a repo with no migration framework. That is the literal `E3` anchor.
The mitigating precedent — `contact_cards.dav_name` (`data-plane.sql:187-190`) shipped a new
column with its `ALTER TABLE` written in a comment — is real but thin.

**The same review inverted the schema attribution on `004`.** `mailboxes`
(`data-plane.sql:6-16`) *already* has `parent_id`, `name`, `role`, and `sort_order` — every
column `Mailbox/set` writes. `004` needs a schema change only if `isSubscribed` (hardcoded
`true` at `mailbox.ts:38`) must become real. It stays `E3`, but on the **"new semantics other
code must respect"** limb, not the migration limb: four call sites currently assume mailboxes
are immutable (`ingest/src/index.ts:125`, `email.ts:362-364`, `cli/src/sync.ts:153`,
`cli/src/main.ts:884`).

**Confirmed on delivery.** `004` shipped with no schema change: `isSubscribed` stayed hardcoded
and the write path *rejects* `isSubscribed: false` rather than accepting a property it discards,
which was the open question's worry and costs no column. All four call sites turned out to need
no edit — see the unit file's Status note.

⁷ **`004` did NOT wait for `002`.** The dependency was on a shared fake-D1 with `.batch()`;
`004` carries a local, self-contained one (a *stateful* one — the destroy assertions need reads
to see prior writes, which a write-recording fake cannot express) so as not to conflict with
`002` consolidating the others in parallel. `002`'s scope grows by one more implementation to
absorb; the edge was soft, not hard.

³ **`012`'s `I1` is contested and probably wrong.** As scoped it ships two JMAP methods,
observable only by an engineer — which `readme.md`'s verifiability bar disqualifies, making it
`I0`. `I1` survives only if a human-drivable CLI filter ships alongside. Left at `I1` because
nothing downstream depends on the difference; the unit file argues it. A sharper doubt is
recorded there too: `contacts.ts:25-26` enumerates RFC 9610 as *"AddressBook/get·set·changes"*,
implying the spec may define **no** `AddressBook/query` at all — in which case this unit is not
low-value but ill-formed. **Verified 2026-08 against the RFC text and the doubt is confirmed:**
RFC 9610 §2 defines only `AddressBook/get` (§2.1), `AddressBook/changes` (§2.2), `AddressBook/set`
(§2.3) — no `AddressBook/query`; `draft-ietf-jmap-calendars-27` §4 defines only `Calendar/get`
(§4.1), `Calendar/changes` (§4.2), `Calendar/set` (§4.3) — no `Calendar/query`. `/query` is a
container-vs-item asymmetry the specs make on purpose (`ContactCard/query` RFC 9610 §3.3,
`CalendarEvent/query` calendars-27 §5.11 both exist). Building either method would invent
non-standard surface, so the unit is **wontfix**, not `todo`. The unit file carries the full
citation and per-noun verdict.

⁴ **`023` and `026` were regraded down at review, on the reviewers' own argument.**
`023` (`I2` → `I1`): it *is* human-verifiable (the rubric names "a browser" — revoke a grant,
reload, watch the answer change) and it unlocks nothing, because `s03.E` is the terminal leaf
of the arc: `s03.C` blocks it, `s04` gates it, nothing follows.
`026` (`I1` → `I0`): `I1` requires human-verifiability, and on completion this is a JMAP method
with no surface emitting a JSON delta — the rubric's own example of *test*-verifiable. Its
"unlocks" leg also fails strictly: `s03.C` `arch.md:57` *names* `queryChanges` but is not
blocked by it, since the re-query fallback is mandatory anyway (the changelog window 409s below
the floor, `account-do:274-278`).

⁵ **`008` contains one route that is not `I1` and must not wait for wave 4.**
`agent_bindings.enabled` (`data-plane.sql:104`) is written `1` at creation
(`provision/src/index.ts:638`) and **never written again** — no route reaches it. Both drain
paths filter on it (`agent/src/index.ts:110`, `ingest/src/index.ts:169`), so it *is* the agent
kill switch, merely unreachable. `007` hands a human an on-demand agent trigger into a system
with no off switch, which makes binding-disable a named de-risking dependency of `007` — `I3`,
wave 3. The rest of `008` (tenant/domain/account lifecycle) stays `I1`/wave 4.

  **Resolved by shipping, not by splitting — and BOTH grades moved.** `008` and
  `.feedback/fromClaude/✅023` landed as one commit, because the kill switch and the rest of the
  unit are the same two files (`services/provision/src/index.ts`, `packages/cli/src/admin.ts`)
  and the split this footnote proposed would have put two agents in one file. So `008a` never
  became a separate ledger row; the wave-3 sequencing this footnote asked for was honoured by
  moving the *whole* unit forward.

  - **`I1` → `I3`**, on this footnote's own argument. `007`'s named de-risking dependency is met.
  - **`E2` → `E3`**, on the unit file's Open Question #2. The tombstone design was adopted for
    `accounts` (`deleted_at`), which is the literal `E3` anchor: one hand-run
    `ALTER TABLE accounts ADD COLUMN deleted_at INTEGER` (`docs/DEPLOY.md` §1), and it must run
    **before** the workers deploy — `deleted_at IS NULL` is now in `verifyBearer`'s account
    resolution, so a worker ahead of the column authenticates nobody.

  Scope note: `tokens` and `grants` deliberately keep their hard `DELETE`. `s03.A` T2 owns their
  tombstones *and* the `grant_lifecycle` log; doing the column half here would have bought this
  repo two hand-run schema events instead of one, which is the exact thing the unit's tier-2
  warning says to avoid. **`s03.A` T2 is therefore still the only outstanding schema event**, and
  it now has a precedent to follow rather than a coordination problem to solve.

⁶ **`003` shipped as `E3`, not the `E2` the ledger predicted** — and the earlier note that
this grade was "contestable" was right. The guard had to move to `eventSpan` (the parser was
the wrong side: `CalendarEvent/set` takes JSCalendar directly and never validated
`recurrenceRules`), a `Set<RulePart>` could not express several of the needed predicates, and
`calendar-core` went from zero tests to 100 with an external oracle. See
`.feedback/fromClaude/✅003`.

⁸ **`005` shipped as spec conformance ONLY, deliberately — it does not wire delivery status.**
The triage in its unit file is correct: `undo_status` is a near-constant and nothing correlates
SES events back onto a submission. `/get` therefore returns `deliveryStatus: null` rather than a
synthesized `"unknown"` map, and the reasoning is pinned by a test so a later patch cannot
quietly "fix" it into a confident lie. Wiring real delivery status was scoped and rejected as a
**separate `E3`** unit, not smuggled in: it needs a new column on a deployed table (no migration
framework), an `ACCOUNT_DO` binding the submit worker deliberately lacks (circular with jmap's
`SUBMIT` binding, `services/submit/src/index.ts:96-99`) without which the update never reaches
`/changes`, and SNS signature verification that is still a `TODO` (`:106`). That unit is
**unfiled** — the original file's Open Question 1 says it should have been, and it still should.
The `I2` grade survives delivery intact and the unit file explains why it is the rubric's clean
teaching case.

⚠️ **`002` shipped, but two suites arrived after its base and are NOT migrated.**
`services/anglebrackets/src/dav.test.ts` (`009`) and `services/jmap/src/methods/mailbox.test.ts`
(`004`) landed while `002` was in flight, each carrying its own local fake. `mailbox.test.ts`'s
is deliberately **stateful** — writes are visible to later reads — which the six originals were
not, and which its destroy assertions cannot be written without. That is a capability
`@bullmoose/test-fakes` should absorb, not a duplicate to delete. Tracked here rather than
reopening the unit; whoever touches either suite next should migrate it.

⁸ **`010` shipped at `E2` — the KV fork in its §2 was taken, so no migration and no
regrade.** The tie-break was NOT effort: a share record is useful for exactly as long as its
link is valid, so `expirationTtl` reaps it at that instant and Done-when #6 ("expired records
disappear on their own — no sweeper, no cron") is the storage engine's default rather than a
cron job this repo has nowhere to put. The `shares` table would also have put a D1 read on the
hot path of `GET /share/*`, the one route in the jmap worker an anonymous client can reach.
`packages/cli/src/admin.ts:18`'s *"needs the shares table"* is corrected in place.

  Two calls the unit file did not anticipate. §2(a)'s advice to bind a **separate** KV
  namespace is not available: `infra/bootstrap.mjs`'s `wireText` (`:160`) rewrites only the
  first `"id"` after `"kv_namespaces"`, so a second binding deploys unwired — records live in
  `ROUTES` under `share:`, as `login:` already does. And Open Question #5 resolved as **flush**:
  `shareId` is inside the signed payload, so every link minted before this change 403s, by
  design.

  ⚠️ **The `s03.B` edge in `011:62-65` is narrowed, not closed.** `handleBlobDelete` now
  refuses while a live share points at the blob, but `FileNode/set {destroy}` will not travel
  through that route — `011` must call revoke on destroy or the leak `011` warned about
  survives this unit.

⁹ **`016` is filed as a projection and isn't one.** It projects no capability onto a new
surface — it is a prerequisite that reshapes an existing one, and `017`/`018`/`019` all
depend on it. The unit's own open question 1 says so. Left as `proj` to match the ledger's
history; worth reclassifying when the ledger is next revised.

¹⁰ **`018` shipped `create/rename/rm`, `event create/edit/rm`, `export [--ics]`** over the live
JMAP methods, honouring the `016` I/O contract. Two deliberate calls, both recorded in the unit
file: single-occurrence editing (`--occurrence`) is **deferred with a clean refusal** (the s05
Risk-section v1), and the CLI **vendors a compact local iCal/RRULE codec** rather than importing
`@bullmoose/calendar-core` — the compiled CLI cannot resolve workspace packages at runtime (no
`node_modules/@bullmoose`), exactly why `contacts.ts` vendors `vcard.ts`. Open question 1's
"gate `018` on `003`" is honoured: the recurrence guard is enforced CLIENT-SIDE (exit 2, naming
the part), so `agenda` and `--rrule` cannot write what the expander mis-expands.

**Owned elsewhere (9 of 27):** 003, 011, 016, 017, 018, 020, 021, 023, 025 point at an
existing section or filed issue rather than restating the work. Their files here carry the
cell mapping, the grades, and the dependency edges — nothing else.

⚠️ **Two more grades are contested in their unit files and left as filed:** `004`'s `I3` (no
unit names `Mailbox/set` as a blocker, so the strict test says `I1` — see `readme.md` § *Where
the rubric is known to mislead*) and `019`'s `I3` (nothing lists it as a dependency either).
Both are cases where impact and priority genuinely diverge.

---

## 3. Sequencing

Grade is not priority. `001` is `I2` and goes first because it blocks four `I3` units.

```
wave 1 — unblock everything, cheap
  001  MCP ToolDef scope+domain       E1  ← blocks 013,014,015          ✅
  002  shared fake-D1 + .batch()      E2  ← blocks every write-path test ✅
  016  CLI I/O contract (s05 T1)      E2  ← blocks 017,018,019

wave 2 — the first thing a human can see
  013  Calendar+Contacts over MCP     E2  I3   ← ✅ done (MCP's first write surface)
  003  recurrence correctness         E2  I3   ← ✅ done
  018  Calendar CRUD over CLI         E2  I3
  017  Contacts CRUD over CLI         E2  I3

wave 3 — close the capability holes
  004  Mailbox/set + CLI              E3  I3   ← ✅ done (was the biggest single gap)
  019  Email triage over CLI          E2  I3
  014  Email over MCP                 E2  I3   ← ✅ done (read + triage; no send tool)
  009  DAV collection creation        E2  I3   ← DONE
  006  Identity/set + signatures      E3  I3   ← ✅ done (+ Identity/changes)
  008  admin lifecycle + kill switch  E3  I3   ← ✅ done; 008a/008b never split — see ⁵
  007  AgentInvocation trigger        E2  I3   ← unblocked: the off switch exists now

wave 4 — cheap cleanup, any time
  005 · ~~008b~~ (folded into 008) · 010 ← ✅ DONE, pulled forward · 012
  015  self-introspection over MCP    E2  I1   ← ✅ done, pulled forward
wave 5 — the unbuilt stacks
  011 (s03.B) → 021 (s03.C) → 022 → 024 → 023 (s03.E)
  025 GraphQL — only after the common/022 spike returns a number
```

**Wave 2 is the acceptance moment for the whole volume.** `013` + `018` together produce the
demo that motivated this: Claude creates a calendar event over MCP; Codex reads it back;
`bullmoose calendar agenda` and a CalDAV `PROPFIND` from Apple Calendar both agree. Three
independent projections over one write — the difference between *self-consistent* and
*correct*.

**Half of it has landed.** `013` shipped the write, and the reason the triangulation should
hold is structural rather than lucky: the MCP tools do not write — they call
`CalendarEvent/set` and `ContactCard/set` in process (`services/agent/src/jmapBridge.ts`), so
the ctag bump and the changelog commit that CalDAV and the CLI mirror depend on are the *same
code path* the JMAP worker runs, not a second implementation of it. What is still unproven is
the *live* leg: the tests drive real SQLite and the real `AccountDO`, but nothing has been run
against `wrangler dev` or a real Apple Calendar. `018` closes the CLI third of the triangle.

---

## 4. Coverage check

Every non-`n/a` gap cell in §1 maps to at least one unit:

| Gap | Unit |
|---|---|
| Email × U/D × CLI | 019 |
| Email × CRUD × MCP | 014 ✅ |
| Mailbox × C/U/D × all | 004 |
| Thread × changes | 027 |
| EmailSubmission × R | 005 ✅ |
| AddressBook/Calendar × query | 012 — **wontfix**: no such method in RFC 9610 §2 / calendars-27 §4 (see §2 fn 3) |
| ContactCard/CalendarEvent × C/U/D × CLI | 017, 018 |
| ContactCard/CalendarEvent × CRUD × MCP | 013 ✅ |
| AddressBook/Calendar × C/U/D × MCP | — (unfiled; `013` shipped Read only) |
| AddressBook/Calendar × C × DAV | 009 ✅ |
| AddressBook/Calendar × U × DAV (`PROPPATCH`) | ✅ done — `common/026` item 3 |
| FileNode × everything | 011 → 021 |
| Blob delete / share revoke | 010 ✅ |
| Agents × C/D | 007 |
| Agents/Secrets × MCP | 015 ✅ (Agents × Read + SystemAdmin × Read; `Secrets × Read` is out of scope by `bureau.md` invariant 1 and always will be) |
| HumanSettings × U (`Identity/set`) | 006 |
| SystemAdmin × U/D | 008 ✅ (⚠️ `_verify.sh` asserts nothing here — `services/provision` is not JMAP, so this row is invisible to the executable grid in both directions) |
| every noun × WebUI | 021, 022, 023, 024 |
| every noun × GraphQL | 025 |
| `queryChanges` × 4 | 026 |

**Deliberately uncovered** — not gaps:
- `Secrets × Read` is **forbidden by design**, not missing (`bureau.md` invariant 1 — there is
  no "reveal password" button). Marked `n/a`, never `todo`.
- `Thread × C/U/D` — derived from Email; no independent CRUD exists or should.
- `* × Transport` beyond delivery — inbound/outbound are pipelines, not CRUD surfaces.
- The **egress** axis (`s04`/Bureau), the **provenance** plane (`s03.A`), the **protocol**
  axis (`s01`), and **approval semantics** (`s03.D`) have no cell in this grid at all. See
  `readme.md` § *Relationship to the sNN sections*.

---

## 5. Totals

Recounted from the ledger above — an earlier draft of this table was arithmetically wrong.

| | count | notes |
|---|---|---|
| E1 | 4 | 001, 005, 012, 024 |
| E2 | 14 | the bulk — mostly projection over live capability |
| E3 | 4 | 004, 006, 026, **008** (regraded on delivery — footnote ⁵) |
| E4 | 5 | 011, 021, 022, 023, 025 — all on stacks that don't exist |
| **I3** | **15** | **008** joined them on delivery — footnote ⁵ |
| I2 | 5 | |
| I1 | 5 | |
| I0 | 2 | 026, 027 |
| owned by `sVOL` | 18 | |
| owned elsewhere | 9 | pointers only |

**Read on the shape:** 19 of 27 units are `E1`/`E2`, because Contacts, Calendar, and Email
already have their expensive layer built. The volume is front-loaded with cheap, visible wins
and back-loaded with two genuinely large builds (`FileNode`, WebUI). Nothing in waves 1–4
requires a new service, and exactly one unit (`006`) requires a schema change.

⚠️ **`003` is graded `E2` here and that is contestable.** Its `.feedback` fix is small, but the
`calendar-core` test suite it also carries is the first real test suite in the repo. An earlier
draft of this table smuggled it into the `E3` count. `E2` is the call; the unit file argues
both sides.
