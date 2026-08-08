# _index — the grid and the ledger

**Start here.** `_context.md` is the audited evidence behind every claim on this page.
`readme.md` defines the grades and the capability/projection law.

---

## 1. The grid

Every noun × surface. `CRUD` = built · `-` = absent · `n/a` = not meaningful ·
`~` = partial. Footnotes and `file:line` evidence live in `_context.md` §2.

| Noun | JMAP | CLI | MCP | DAV | WebUI | GraphQL | Transport |
|---|---|---|---|---|---|---|---|
| Email | `CRUD` | `-R~-` | `~` | `----` | `----` | `----` | `C---` |
| **Mailbox** | **`-R--`** | `-R--` | `----` | `----` | `----` | `----` | `~` |
| Thread | `-R--` | `----` | `----` | `----` | `----` | `----` | n/a |
| EmailSubmission | `C---` | `C---` | `----` | `----` | `----` | `----` | `C---` |
| AddressBook | `CRUD` | `~R--` | `----` | `CR-D` | `----` | `----` | n/a |
| ContactCard | `CRUD` | `CR--` | `----` | `CRUD` | `----` | `----` | n/a |
| Calendar | `CRUD` | `-R--` | `----` | `CR-D` | `----` | `----` | n/a |
| CalendarEvent | `CRUD` | `-R--` | `----` | `CRUD` | `----` | `----` | n/a |
| **FileNode** | **`----`** | `----` | `----` | `----` | `----` | `----` | n/a |
| Agents | `-RU-` | `-RU-` | `----` | n/a | `----` | `----` | `C---` |
| Secrets | n/a | `CRUD` | `----` | n/a | `----` | `----` | n/a |
| HumanSettings | `~R~-` | `-RU-` | `----` | n/a | `----` | `----` | n/a |
| IdentitySetup | `CR-D` | `CR-D` | `----` | `~` | `----` | `----` | n/a |
| SystemAdmin | `CR~~` | `CR~~` | `----` | n/a | `----` | `----` | n/a |

**What the grid says at a glance:**

- **Contacts and Calendar are finished at the expensive layer** — full CRUD on both JMAP and
  DAV. Everything remaining for them is cheap projection.
- **`Mailbox` is the outlier.** Mail is the flagship noun and the least mutable thing in the
  system: no create, rename, move, or delete on *any* surface.
- **The MCP column is empty.** Not "thin" — empty of noun CRUD. This is the largest
  value-per-effort block in the volume, because the capability beneath it is already built.
- **The WebUI and GraphQL columns are empty because the surfaces don't exist.** Every cell
  there is `E4` by definition.
- **DAV is read-write end to end.** Cards and events PUT/DELETE with proper ETags, and since
  `009` collections do too — `MKCALENDAR` / extended `MKCOL` / collection `DELETE`. The one
  remaining `-` in both DAV columns is Update: there is no `PROPPATCH`, so a client can create
  and delete a calendar but not rename or recolour one.

---

## 2. The ledger

`kind`: **cap** = capability · **proj** = projection · **pre** = prerequisite.
`owner`: `sVOL` = this volume owns it · otherwise the section that already does.

| # | Unit | kind | E | I | owner | depends on | status |
|---|---|---|---|---|---|---|---|
| 001 | MCP `ToolDef` scope + domain | pre | E1 | I2 | sVOL | — | **✅ done** |
| 002 | Shared test harness — fake D1 (`.batch()`) + DO/blob stubs ¹ | pre | E2 | I2 | sVOL | — | todo |
| 003 | Recurrence correctness before calendar writes | pre | **E3** ⁶ | I3 | `common/003` | — | **✅ done** |
| 004 | `Mailbox/set` + CLI | cap | E3 | I3 | sVOL | 002 | todo |
| 005 | `EmailSubmission/get` | cap | E1 | I2 | sVOL | — | todo |
| 006 | `Identity/set` + CLI signatures | cap | **E3** ² | I3 | sVOL | 002 | todo |
| 007 | `AgentInvocation` on-demand trigger | cap | E2 | I3 | sVOL | 002 | todo |
| 008 | Admin lifecycle — update + delete | cap | E2 | I1 ⁵ | sVOL | — | todo |
| 009 | DAV collection creation (`MKCOL`/`MKCALENDAR`) | cap | E2 | I3 | sVOL | — | **✅ done** |
| 010 | Blob lifecycle — enumerate, delete, revoke share | cap | E2 | I1 | sVOL | — | todo |
| 011 | The `FileNode` noun | cap | E4 | I3 | **s03.B** | s03.A | todo |
| 012 | `AddressBook/query` + `Calendar/query` | cap | E1 | I1 ³ | sVOL | — | todo |
| 013 | **Calendar + Contacts CRUD over MCP** | proj | E2 | I3 | sVOL | 001, 002, 003 | todo |
| 014 | Email read + triage over MCP | proj | E2 | I3 | sVOL | 001, 002 | todo |
| 015 | Self-introspection over MCP (`help@`) | proj | E2 | I1 | sVOL | 001 | todo |
| 016 | CLI I/O contract | proj | E2 | I3 | **s05** T1 | — | todo |
| 017 | Contacts CRUD over CLI | proj | E2 | I3 | **s05** T2 | 016 | todo |
| 018 | Calendar CRUD over CLI | proj | E2 | I3 | **s05** T3 | 016, 003 | todo |
| 019 | Email triage verbs over CLI | proj | E2 | I3 | sVOL | 016 | todo |
| 020 | Creds mint-time fields | proj | E2 | I2 | **s05** T4 + **s04** | s04 spec | todo |
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

³ **`012`'s `I1` is contested and probably wrong.** As scoped it ships two JMAP methods,
observable only by an engineer — which `readme.md`'s verifiability bar disqualifies, making it
`I0`. `I1` survives only if a human-drivable CLI filter ships alongside. Left at `I1` because
nothing downstream depends on the difference; the unit file argues it. A sharper doubt is
recorded there too: `contacts.ts:25-26` enumerates RFC 9610 as *"AddressBook/get·set·changes"*,
implying the spec may define **no** `AddressBook/query` at all — in which case this unit is not
low-value but ill-formed. Unverified against the RFC text.

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

⁶ **`003` shipped as `E3`, not the `E2` the ledger predicted** — and the earlier note that
this grade was "contestable" was right. The guard had to move to `eventSpan` (the parser was
the wrong side: `CalendarEvent/set` takes JSCalendar directly and never validated
`recurrenceRules`), a `Set<RulePart>` could not express several of the needed predicates, and
`calendar-core` went from zero tests to 100 with an external oracle. See
`.feedback/fromClaude/✅003`.

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
  001  MCP ToolDef scope+domain       E1  ← blocks 013,014,015
  002  shared fake-D1 + .batch()      E2  ← blocks every write-path test
  016  CLI I/O contract (s05 T1)      E2  ← blocks 017,018,019

wave 2 — the first thing a human can see
  013  Calendar+Contacts over MCP     E2  I3   ← needs 003 for recurring events
  003  recurrence correctness         E2  I3
  018  Calendar CRUD over CLI         E2  I3
  017  Contacts CRUD over CLI         E2  I3

wave 3 — close the capability holes
  004  Mailbox/set + CLI              E3  I3   ← the biggest single gap
  019  Email triage over CLI          E2  I3
  014  Email over MCP                 E2  I3
  009  DAV collection creation        E2  I3   ← DONE
  006  Identity/set + signatures      E3  I3
  008a binding-disable route ONLY     E1  I3   ← the agent kill switch; MUST precede 007
  007  AgentInvocation trigger        E2  I3

wave 4 — cheap cleanup, any time
  005 · 008b (tenant/domain/account lifecycle) · 010 · 012 · 015

wave 5 — the unbuilt stacks
  011 (s03.B) → 021 (s03.C) → 022 → 024 → 023 (s03.E)
  025 GraphQL — only after the common/022 spike returns a number
```

**Wave 2 is the acceptance moment for the whole volume.** `013` + `018` together produce the
demo that motivated this: Claude creates a calendar event over MCP; Codex reads it back;
`bullmoose calendar agenda` and a CalDAV `PROPFIND` from Apple Calendar both agree. Three
independent projections over one write — the difference between *self-consistent* and
*correct*.

---

## 4. Coverage check

Every non-`n/a` gap cell in §1 maps to at least one unit:

| Gap | Unit |
|---|---|
| Email × U/D × CLI | 019 |
| Email × CRUD × MCP | 014 |
| Mailbox × C/U/D × all | 004 |
| Thread × changes | 027 |
| EmailSubmission × R | 005 |
| AddressBook/Calendar × query | 012 |
| ContactCard/CalendarEvent × C/U/D × CLI | 017, 018 |
| ContactCard/CalendarEvent × CRUD × MCP | 013 |
| AddressBook/Calendar × C × DAV | 009 ✅ |
| AddressBook/Calendar × U × DAV (`PROPPATCH`) | — (unfiled; see `009`) |
| FileNode × everything | 011 → 021 |
| Blob delete / share revoke | 010 |
| Agents × C/D | 007 |
| Agents/Secrets × MCP | 015 |
| HumanSettings × U (`Identity/set`) | 006 |
| SystemAdmin × U/D | 008 |
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
| E2 | 15 | the bulk — mostly projection over live capability |
| E3 | 3 | 004, 006, 026 |
| E4 | 5 | 011, 021, 022, 023, 025 — all on stacks that don't exist |
| **I3** | **14** | |
| I2 | 5 | |
| I1 | 6 | |
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
