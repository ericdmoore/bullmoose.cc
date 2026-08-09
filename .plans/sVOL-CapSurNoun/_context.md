# _context — audited ground truth

**Originally audited against `8ba3fe3`. Refreshed after the P1 security backlog landed
(PRs #12, #13, #15).** Everything here was read out of the source, not out of the plan docs.

> ## ⚠️ Changes since the original audit — read this first
>
> A single session of security work invalidated several claims below. They are corrected
> inline, but the *shape* of the change matters more than any one line:
>
> | Was | Now |
> |---|---|
> | 2 test files, 19 tests | **31 test files, 769 tests** |> | `calendar-core` had zero tests | **100 tests**, oracle = python-dateutil, not this expander |
> | RRULEs mis-expanded silently | rejected at the `eventSpan` write boundary; reads degrade rather than throw |
> | CI never ran tests | `verify` job runs `npm test` on every push/PR, and it is a **required status check** |
> | test files excluded from typecheck | typechecked in both configs |
> | `mail` satisfied every scope | `mail` = exactly the six mail verbs; `contacts`/`calendar`/`vault` are independent |
> | `Email/set` gated everything on `draft` | per-operation: `draft`/`annotate`/`move`/`delete` |
> | MCP `ToolDef` had no scope/domain | declared per tool; the gate reads it |
> | CI deployed 4 of 7 workers, wrong order | 6 of 7, order derived from the binding graph |
>
> **Eight P1s are closed** (`✅`-prefixed in `.feedback/`). The security posture this volume
> was planned against is materially different — in particular, any unit reasoning about
> scopes must re-read §4 rather than trusting a memory of it.
>
> **Still true and still the point:** there is no WebUI.
>
> ⚠️ *"The MCP column is empty of noun CRUD"* — the line this volume was built around — is
> **no longer true.** sVOL `013` landed Calendar + Contacts CRUD over MCP, routed through the
> JMAP method layer in-process. Email, vault and introspection over MCP are still absent
> (`014`, `015`), as is `Calendar`/`AddressBook` **collection** C/U/D — `013` shipped those
> as `/get` only.
>
> ⚠️ Two items left this list in one batch — **DAV collection creation** (`009`) and
> **`Mailbox/set`** (`004`, with the CLI `mailbox` verbs). Both were headline gaps in the
> original audit. The grid rows and footnotes 4 and 9 are corrected inline.

> **Read this before reviewing or building anything in `sVOL`.**
> Do not re-derive state from `.plans/` — several plan docs overstate what exists, and
> **no existing plan section records its own status**. `s01` is ~90% shipped and `s04` is
> untouched; they read identically on the page.

---

## 0. Traps that cost time

Five things that are not what they look like:

1. **`~/mailstore/sql/*.sql` is a stale July-7 copy** with zero calendar and zero
   `address_books` tables. It is referenced by no code. The live schema is
   `packages/mailstore/sql/{data-plane,control-plane}.sql`.
2. **There is no migration framework.** Schema is applied by re-running
   `CREATE TABLE IF NOT EXISTS` via wrangler (`tools/README.md:10-11`). Adding a column to a
   deployed table has **no automated path**. This is why E3 is a real cliff.
3. **"SMTP" is a misnomer in this repo.** No SMTP server, no SMTP client. Inbound is the
   Cloudflare Email Routing `email()` handler (`services/ingest/src/index.ts:48`); outbound is
   SES v2 over **HTTPS** SigV4 (`services/submit/src/index.ts:46`).
4. **There is no WebUI.** `src/` is the Astro **marketing site**
   (`src/src/pages/{index,apps,connectors,deploy,recipes}.astro`). `tsconfig.json:38` excludes
   a `webmail/` directory that has never existed. Every "web" reference in `.plans/` is
   aspirational.
5. **MCP is far narrower than its docs suggest.** Four read-only analytics tools. An agent on
   MCP today cannot read a message, send mail, or touch contacts, calendar, or the vault —
   despite the vault living in the same worker. The agent's real capability comes from the
   **CLI polling JMAP** (`packages/cli/src/agent.ts`), not from MCP.

---

## 1. Surface inventory

| Surface | State | Where |
|---|---|---|
| JMAP | ✅ live — 40 registered methods | `services/jmap`, registry at `src/methods/index.ts:15-30` |
| CLI | ✅ live — 19 top-level commands, ~5,012 lines | `packages/cli` |
| MCP | ⚠️ live but narrow — 4 read-only tools | `services/agent/src/mcp.ts:55` |
| AngleBracket (CalDAV/CardDAV) | ✅ live — read-write at both *resource* and *collection* level, incl. `PROPPATCH` | `services/anglebrackets/src/dav.ts` |
| WebUI | ❌ does not exist | — |
| GraphQL | ❌ does not exist | design discussion only, `docs/architecture/mcp-auth.md` §14 |
| Transport (in/out) | ✅ live | `services/ingest`, `services/submit` |

**Full JMAP registry** (`services/jmap/src/methods/index.ts:15-30`) — this is the complete list:

```
Core/echo
Mailbox         get changes query queryChanges set
Email           get query set import changes queryChanges
Thread          get                                      ← no changes
Identity        get set changes
EmailSubmission set get changes
AgentInvocation query get set changes
VacationResponse get set
AddressBook     get changes set                          ← no query
ContactCard     get changes set query queryChanges
Calendar        get changes set                          ← no query
CalendarEvent   get changes set query queryChanges getOccurrences
```

Four `queryChanges` methods are **deliberate always-throw stubs** consistent with an
advertised `canCalculateChanges: false` — `mailbox.ts:93`, `email.ts:54`, `contacts.ts:559`,
`calendars.ts:392`. Spec-conformant; no client gets incremental query deltas.

---

## 2. The grid — CRUD by noun × surface

Legend: `C R U D` = implemented · `-` = absent · `n/a` = not meaningful ·
`~` = partial (footnoted).

| Noun | JMAP | CLI | MCP | AngleBracket | WebUI | GraphQL | Transport |
|---|---|---|---|---|---|---|---|
| **Email** | `CRUD` | `-R~-` ¹ | `~` ² | `----` | `----` | `----` | `C---` ³ |
| **Mailbox** | `CRUD` ⁴ | `CRUD` ⁴ | `----` | `----` | `----` | `----` | `~` ⁵ |
| **Thread** | `-R--` | `----` | `----` | `----` | `----` | `----` | n/a |
| **EmailSubmission** | `CR--` ⁶ | `C---` | `----` | `----` | `----` | `----` | `C---` |
| **AddressBook** | `CRUD` ⁷ | `~R--` ⁸ | `-R--` | `CRUD` ⁹ | `----` | `----` | n/a |
| **ContactCard** | `CRUD` | `CR--` ¹⁰ | `CRUD` | `CRUD` | `----` | `----` | n/a |
| **Calendar** | `CRUD` ⁷ | `-R--` | `-R--` | `CRUD` ⁹ | `----` | `----` | n/a |
| **CalendarEvent** | `CRUD` | `-R--` ¹¹ | `CRUD` | `CRUD` | `----` | `----` | n/a |
| **FileNode** | `----` ¹² | `----` | `----` | `----` | `----` | `----` | n/a |
| **Agents** | `-RU-` ¹³ | `-RU-` | `----` | n/a | `----` | `----` | `C---` ¹⁴ |
| **Secrets** | n/a ¹⁵ | `CRUD` ¹⁶ | `----` | n/a | `----` | `----` | n/a |
| **HumanSettings** | `~R~-` ¹⁷ | `-RU-` | `----` | n/a | `----` | `----` | n/a |
| **IdentitySetup** | `CRUD` ¹⁸ | `CRUD` | `----` | `~` ¹⁹ | `----` | `----` | n/a |
| **SystemAdmin** | `CR~~` ²⁰ | `CR~~` | `----` | n/a | `----` | `----` | n/a |

**Footnotes — the ones that matter:**

1. CLI can `read`/`show`/`search`/`mailboxes`/`sync` (`main.ts:681,837,810,879`,
   `sync.ts:264`) and `send` (`main.ts:338` → `Email/import` at `:432`). Update exists **only
   inside the agent worker loop** (`packages/cli/src/agent.ts:196`). **No general
   flag/move/archive/delete command.**
2. MCP is **no longer aggregates-only** (sVOL `013`). The four analytics tools remain
   (`spend_by_month`, `spend_by_vendor`, `top_senders`, `message_volume`) alongside ten noun
   tools for calendar events and contact cards. Still absent: any message body or header
   retrieval (`014`), vault, introspection (`015`).
3. Inbound store to R2 + D1, `services/ingest/src/index.ts:48`.
4. ✅ **CLOSED by sVOL `004`.** `Mailbox/set` is registered inside `registerMailboxMethods`
   (`mailbox.ts`), and `bullmoose mailbox create|rename|move|rm` is the CLI half. This entry
   used to read *"`Mailbox/set` is not registered anywhere — folders are frozen at whatever
   `services/provision/src/index.ts:390-401` seeds at account creation"*, and that was the
   largest capability gap in the repo.

   ⚠️ **The server used to advertise a policy it could not honour** — the sharpest instance of
   `common/005` (advertised-capabilities-not-enforced). `mailCapability`
   (`packages/jmap-core/src/capabilities.ts:40-47`) publishes `maxMailboxDepth: 10`,
   `maxSizeMailboxName: 200`, and `mayCreateTopLevelMailbox: true`; `Mailbox/get` returns
   `mayCreateChild: true`, `mayRename: true`, `mayDelete: r.role === null`. **All of those are
   now enforced by the write path, which reads the same `mailCapability` constants rather than
   re-declaring the numbers**, so the session object and the enforcement cannot drift apart.
   `Mailbox/get`'s `myRights` and the destroy gate are single-sourced through one `rightsFor`.

   Still true: `mailbox.ts` fakes `totalThreads` as `totalEmails` (TODO in source), and
   `isSubscribed` is still hardcoded `true` with no column — but `Mailbox/set` now *rejects*
   `isSubscribed: false` instead of silently discarding it.
5. Role mailboxes seeded at account creation only.
6. Create only — `submission.ts:22`, `args.create` at `:48`. `args.update` and `args.destroy`
   are never read; `destroyed: []` is hardcoded `:101`. ~~`EmailSubmission/changes` is registered with no `/get`~~ (**closed by sVOL `005`**) — a client is told which ids changed and has no method to read
   them. Delivery status is write-and-forget.
7. No `AddressBook/query`, no `Calendar/query`.
8. Implicit create only — `contacts import` auto-creates a missing book
   (`contacts.ts:337`). No explicit `books create`.
9. ✅ **`MKCOL` / `MKCALENDAR` now exist** (sVOL `009`). Both branch in the `handleDav`
   dispatcher *ahead* of `requireBook`/`requireCalendar`, since those resolve the collection
   before looking at the method. Collection `DELETE` shipped with them. The collection id is
   the client-chosen URI segment — collections still have **no `dav_name` column**, so the id
   *is* the path. Reads `CR-D`: there is no `PROPPATCH`, so a client can create and delete a
   collection but not rename one.
10. `contacts import` is create-only, dedups by uid, skips existing (`contacts.ts:120`).
11. `calendar list` (`calendar.ts:32`) and `calendar agenda` (`:45` → `getOccurrences` `:50`).
    **Zero `/set` calls in the CLI calendar module** (97 lines total).
12. **The Files noun does not exist.** What exists is attachment-blob plumbing:
    `POST /api/upload/{accountId}` (`services/jmap/src/index.ts:76`), `GET /api/download/…`
    (`:70`), signed share links (`:83`, minted `:190`). ✅ **CLOSED by sVOL `010`.** Enumeration, blob delete and share revocation all exist
    now (`GET/DELETE /api/blobs/…`, `GET/DELETE /api/share/…`). Share records live in KV with
    `expirationTtl`, so a record cannot outlive its own link and expiry needs no sweeper.
    Verification is **deny-by-default** — `shareId` is inside the HMAC payload, so a link with
    no live record 403s. This entry used to read *"no enumeration, no delete, no share
    revocation — a minted URL is valid until `exp` with no kill switch."*

    ⚠️ **`011` (FileNode) must call revoke on destroy.** `handleBlobDelete` refuses while a
    live share exists, but `FileNode/set {destroy}` does not travel that route — so the leak
    `010` warned about survives unless `011` wires it.
13. `AgentInvocation/set` implements **update only** (`agent.ts:84`); `created: {}` `:128` and
    `destroyed: []` `:132` are hardcoded. Optimistic claim guard at `:92`.
    ❌ **REFUTED — do not re-report this.** An earlier revision of this footnote claimed
    `finish` (`services/agent/src/index.ts`) writes terminal invocation state with raw SQL
    "bypassing `commitChanges`", i.e. that §3's failure mode was already live. **That is
    false.** Read the whole function: the raw `UPDATE` is immediately followed by
    `commitChanges(env.ACCOUNT_DO, job.account_id, [{ collection: "AgentInvocation",
    updated: [job.id] }])`. The changelog invariant holds. Only `Mailstore` is bypassed,
    which is a consistency preference, not a defect.

    Recorded rather than deleted because **three independent agents have now reported it as a
    bug** — the first one's report is what put the false claim in this file, and the next two
    were reading it back out of here and re-deriving it in good faith. If you are about to
    file this, read `finish` in full first.
14. **Inbound mail is the only creator of invocations** —
    `services/ingest/src/index.ts:178`. There is no way to trigger an agent on demand.
15. Vault is a direct HTTP API on the agent worker, not JMAP: PUT `vault.ts:79`,
    GET `:124`, DELETE `:142`. Returns 501 if `VAULT_MASTER_KEY` unset (`:70`).
16. Read returns **names/kind/meta only, never plaintext** — by design
    (`bureau.md` invariant 1). `creds set/list/rm/oauth` at `creds.ts:73,93,106,114`.
17. `VacationResponse` get/set (`vacation.ts:11,32`), singleton upsert.
    **No `Identity/set`** — and `identity.ts:11-16` *synthesizes* `identity_default` from the
    principal when the table is empty, with `replyTo`/`bcc`/`textSignature`/`htmlSignature`
    hardcoded null/empty at **`:26-29`** and `mayDelete: false` at **`:30`** (an earlier draft
    of this file cited `:31-34`/`:35` — the claim was right, the citation was off by five).
    **Signatures and send-as are unreachable everywhere**, and they have nowhere to be stored:
    `identities` (`control-plane.sql:41-47`) has exactly four columns —
    `id, account_id, email, name`. That is why unit `006` is `E3`, not `E2`.
18. `POST /auth/login` (`index.ts:41` → `authRoutes.ts:25`), tokens create/list/revoke
    (`authRoutes.ts:109,99,126`). No token edit; password change is admin-only.
19. Token consumer + well-known discovery only (`services/anglebrackets/src/index.ts:35`).
20. All routes gated by one `ADMIN_TOKEN` (`services/provision/src/index.ts:46`). Update is
    **only** `POST /principals/password` `:79`. Delete is **only** tokens `:101` and grants
    `:118`. **No delete for tenant, domain, account, or agent-binding** — provisioning is
    one-way; a mistyped domain is permanent via the API.

---

## 3. Where the write choreography lives — read this before adding any write surface

`Mailstore` (`packages/mailstore/src/index.ts`, 1912 lines) is a **thin data layer**. It does
**not** maintain invariants. `insertCalendarEvents` (`:1511`) is a bare INSERT.

The choreography lives in the **JMAP method layer**. `CalendarEvent/set` is the reference
shape (`services/jmap/src/methods/calendars.ts:199-341`):

```
mutate rows  →  accumulate ctags  →  store.bumpCalendarCtags(:329)
             →  commitCalendarEntries(...)  →  AccountDO changelog  →  newState
```

**Consequence for every new write surface:** a tool that writes via raw SQL — or even via
`Mailstore` directly — lands the row in the table, reads back fine on a direct `get`, and is
**invisible to every incremental consumer**. Stale `ctag` ⇒ CalDAV clients never re-sync. No
changelog entry ⇒ `/changes` never reports it ⇒ the CLI mirror never sees it.

This failure mode looks like a sync bug and is actually a write-path bug. **New write
surfaces call the JMAP method layer.**

Note the asymmetry that makes this easy to get wrong: the four **analytics** MCP tools query
`env.DB` with **raw SQL** — fine for read-only aggregates, wrong for writes. The ten **noun**
tools added by `013` route through the method layer in-process via
`services/agent/src/jmapBridge.ts`.

⚠️ **`services/anglebrackets` CANNOT reach the method layer** — it binds only `ACCOUNT_DO`
cross-script, and therefore *replicates* the choreography in `dav.ts`. That is an instance of
this failure mode being survived by hand, **not a precedent to copy**. It is also the datum
that settled `013`'s in-process-vs-service-binding question: `services/agent` already binds
`DB`, `BLOBS` and `ACCOUNT_DO`, so the import costs no new deploy-graph edge.

⚠️ **Correction to an earlier draft of this file**, which claimed `services/agent` depends on
neither `Mailstore` nor `calendar-core`. That is wrong for `Mailstore`: it is declared at
`services/agent/package.json:12`, imported at `services/agent/src/index.ts:4`, and constructed
at `:138`. Only **`calendar-core` is absent.** The raw-SQL habit in `mcp.ts` is therefore a
*choice*, not a missing dependency — which makes it cheaper to fix than it first appears, and
weakens any argument that routing an MCP tool through the store is expensive plumbing.

**Testing a write through the JMAP method layer needs more than a fake D1.** `storeFor`
requires `ctx.env.BLOBS` (`services/jmap/src/methods/common.ts:117`) and `accountState` /
`commitChanges` require `ctx.env.ACCOUNT_DO` (`common.ts:120-124`). Any acceptance criterion of
the form "…and the write appears in `Foo/changes`" needs a fake Durable Object too.

✅ **Both exist now.** Unit `002` shipped widened: `fakeEnv()` from `@bullmoose/test-fakes`
supplies `DB`, `BLOBS`, `ROUTES`, `ACCOUNT_DO` and `SUBMIT` in one object, with no cast. The DO
runs the real `AccountDO`, so the changelog assertion is against the deployed class rather than
a canned `{newState}`. Write a `Foo/changes` assertion into any new write surface's tests — it
is the only thing that catches this failure mode, and it is now cheap.

---

## 4. Auth gates

- **JMAP** does it per-method — scope *and* domain, on every call. The convention, verified
  across all three realm modules:

  | | scope | domain | sites |
  |---|---|---|---|
  | calendar reads | `read` | `calendar` | `calendars.ts:58,171,345,403` |
  | calendar writes | `calendar` | `calendar` | `calendars.ts:77,200` |
  | contacts reads | `read` | `contacts` | `contacts.ts:70,255,530` |
  | contacts writes | `contacts` | `contacts` | `contacts.ts:117,318` |
  | mail reads | `read` | *(omitted → `mail`)* | `email.ts:65,192` |
  | mail writes | `draft` | *(omitted → `mail`)* | `email.ts:230,495` |

  ⚠️ **Calendar and contacts do NOT use the mail scope lattice.** One scope named after the
  domain covers create, update, *and* delete. Only mail uses
  `read < annotate < draft < move < send < delete`. Any new surface must mirror this rather
  than invent a mapping — and note the consequence: an agent granted `calendar` in order to
  *add* events can also *destroy* them, with no finer grant available.

  📄 **Doc drift, unfiled** — worth a `.feedback` issue. `packages/auth-core/src/index.ts:10-12`
  declares the vocabulary as `read < annotate < draft < move < send < delete ; "mail" = all of
  them` plus `admin`, and **omits `contacts` and `calendar` entirely**. Those two are real:
  `packages/cli/src/help.ts:105` documents the full list to users, `principal.ts:207` types
  `MethodDomain = "mail" | "contacts" | "calendar"`, and the methods pass them as live scope
  arguments. The code is correct; the header comment is stale. It is a load-bearing comment —
  it is the thing someone reads before adding a scope check.
- ✅ **MCP now declares scope + domain PER TOOL** (`ToolDef` in `services/agent/src/mcp.ts`),
  and the gate reads them — sVOL unit `001`, shipped. All four existing tools declare
  `("read","mail")`, so runtime behaviour is unchanged; the value is that the next tool cannot
  silently inherit a read gate. `TOOLS` is exported and `mcpTools.test.ts` asserts every tool
  declares a scope from the real vocabulary.
- `authorizeAccount` is pure and returns `{ok, access, auditGrant}`
  (`packages/auth-core/src/principal.ts`); the `grant_audit` write stays in the shell.
- ✅ **`common/001` is CLOSED.** `mail` now covers exactly the six mail verbs;
  `contacts`/`calendar`/`vault` are independent realm scopes (`REALM_SCOPES` in auth-core) and
  unknown scopes fail closed. **Scope gates in this volume now actually bite** — the opposite
  of the warning that used to sit here. `bullmoose login --scopes` is the only self-service way
  to widen, because `token create` can only narrow the token it is called with.
- **`services/agent/src/vault.ts:41-66` still hand-rolls its own bearer verification**,
  duplicating the `tokens ⋈ principals` join. This is the unfinished half of `s01` T1.

---

## 5. Test infrastructure — the honest state

**31 test files, 769 tests** (was 2 files / 19 at the original audit). `npm test` runs inwell under a second and is a **required status check** on `main` via the `verify` job.

`vitest.config.ts` pins workspace packages with `resolve.alias`. That is load-bearing for
worktree agents: without it Node's upward `node_modules` lookup escapes the worktree and
resolves `@bullmoose/*` to the **parent checkout**, so tests silently exercise a different
branch's source than `tsc` checks.

✅ **There is now a shared fake-client harness** — `packages/test-fakes`
(`@bullmoose/test-fakes`), sVOL unit `002`. It replaced **six** divergent local fakes
(`services/agent/src/mcp.test.ts`, `services/jmap/src/{authRoutes,mintScopes}.test.ts`,
`services/jmap/src/methods/{submission,calendars}.test.ts`,
`services/provision/src/{mintScopes,accounts}.test.ts`), each routing by SQL substring and each extended
ad hoc. It provides D1 (real `node:sqlite` loading the live `packages/mailstore/sql/*.sql`,
with an atomic `.batch()`), R2, KV, and `ACCOUNT_DO` — the last running the **real** `AccountDO`
class over in-memory storage.

**What that changes for anyone planning a unit:** §3's write-choreography claim is now
*assertable*. A test can drive a JMAP `/set` end to end and then ask `Foo/changes` whether the
changelog recorded it, which is the only way to catch a write that lands the row and skips
`commitChanges`. `services/jmap/src/methods/calendars.test.ts` is the worked example. The
harness is deliberately **not** an npm workspace (no `package.json`), so it resolves only under
`tsc` and vitest and can never be bundled into a Worker; `packages/cli` therefore cannot import
it, and needs a relative import if it ever wants one.

Coverage is ~22% lines overall (was ~11% before `002`; `packages/mailstore` went 0% → 22.9%
because the store's SQL now actually executes). Still at or near zero: `packages/cli` (excluded
from the coverage report entirely, `vitest.config.ts`), `services/anglebrackets` (the whole DAV
surface), `services/ingest`, `services/submit`, and most JMAP methods. `calendar-core`,
`auth-core`, `mime` and the auth/scope paths are genuinely covered.

Coverage is ~21.8% lines overall (was ~11% before `002`; most of the jump is
`packages/mailstore`, 0% → 22.9%, now that fixtures run against the real schema).
`calendar-core`, `auth-core`, `mime`, the auth/scope paths, the mailbox verbs (`004`) and the
DAV collection verbs (`009`) are genuinely covered. Still at or near zero: `packages/cli`
(excluded from the coverage report entirely, `vitest.config.ts`), `services/ingest`,
`services/submit`, and the DAV resource verbs / REPORTs / XML helpers. Those are the shell
paths `002` makes cheap to reach, and **no unit owns them.**


⚠️ `common/003` is **CLOSED**. The RRULE parser/expander mismatch is fixed at the `eventSpan`
write boundary — bad rules are refused on write and dropped (not thrown) on read, so one
legacy row cannot break a whole collection's query. Stale `calendar_events.end_at` values can
only **over-include**, and both windowed read paths re-check with a real expansion, so they
self-correct at read time. Unit `003`'s data-integrity gate on `013`/`018` is discharged.

## 6. Existing `sNN` status — verified from git and source, not from the docs

| Section | Real status | Evidence |
|---|---|---|
| `s01-stateless-MCP` | **~90% shipped** (`c1cdc83`, `b8f1133`). T1–T4 done. Residue: `vault.ts` dedupe never done; the promised curl runbook script does not exist | source + git |
| `s02-mcp-facade` | Not started, **deliberately** — "deferred stub", gated on "the first non-bullmoose client appears". 59 lines, no tasks | `s02/readme.md:3-5` |
| `s03.A-foundations` | Not started — zero `last_writer` / `revoked_at` in code | grep |
| `s03.B-files` | Not started — zero `file_nodes` / `FileNode` in code | grep |
| `s03.C-webmail-floor` | Not started — no `webmail/` workspace | filesystem |
| `s03.D-coexistence` | Not started — zero `ActionProposal` / `urn:bullmoose:agent` | grep |
| `s03.E-console` | Not started **and blocked** on s04 being *specified* | `s03.E/devPlan.md:6` |
| `s04-AgentOS` | Docs only. `bureau.md` (429 lines) is a serious design doc with **zero tasks**; `readme.md` is a 23-line napkin with 4 of 5 bullets undesigned | git: only `docs(...)` commits |
| `s05-cli-crud` | **T1 done** (sVOL `016` — the I/O contract). T2/T3/T5 not started. ⚠️ Its headline claim *"No server work — every method this slice calls is already live"* (`devPlan.md:4`) is **false for T4** — `--kind aws-sigv4` is hard-rejected at `vault.ts:89-91`, there is no `rotate` route, and `--allow`/`--header` have no columns | source |

**Ownership already claimed by existing sections** (do not duplicate in `sVOL`):
`s03.B` → FileNode × CRUD × JMAP. `s03.C` → Email + FileNode × CRUD × WebUI.
`s05` → ContactCard/AddressBook/Calendar/CalendarEvent × CRUD × CLI, plus the CLI I/O contract.
`s03.E` → Agents + Secrets × Read × WebUI. `s04` → the Bureau egress axis.

**Gaps owned by nobody** — these are what `sVOL` is for:
`Identity/set` · any noun × MCP (s02 covers only
*foreign* clients) · Email triage verbs × CLI (s05 punted them: *"worth its own slice"*) ·
ContactCard/CalendarEvent × WebUI (s03.C covers Email + Files only) · DAV collection *update*
(`PROPPATCH` — `009` shipped create/delete only) · admin update/delete ·
AgentInvocation create/destroy.

---

## 7. What I did NOT verify

Stated so a reviewer knows where to be suspicious:

- **Nothing was run.** No `wrangler dev`, no deploy, no live JMAP or CalDAV request. All
  claims are read from source. A method being *registered* is not proof it *works* — in
  particular the CalDAV read-write claims are read from `dav.ts` handlers, not exercised
  against a real client.
- **Effort grades are estimates**, anchored to observable scope but not measured. The E3/E4
  boundary on WebUI units is the least certain — no WebUI exists, so its cost is a guess.
- **Impact grades are judgement calls.** Each unit file states its own reasoning; several sit
  close to a boundary and say so.
- **I did not audit the `docs/` tree** in this pass beyond the files cited. `.feedback` already
  carries 21 filed issues about doc/implementation drift; assume more.
- **`~raw-input`, `fromCodex`, `fromComposer`, `fromGrok`, `fromEric`** feedback folders were
  not cross-referenced against this volume. There may be filed issues that duplicate or
  contradict units here.
