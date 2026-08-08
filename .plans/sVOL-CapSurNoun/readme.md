# sVOL — Capability × Surface × Noun

The volume of work implied by asking, for every **noun** in bullmoose, on every **surface**
we expose: *can you create, read, update, and delete it?*

This folder is a **ledger of record**, not a competing plan. It enumerates every cell. Cells
already owned by an existing `sNN` section point there instead of restating the work.

---

## Layout

```
_index.md      the exhaustive grid + the work-unit ledger    ← start here
_context.md    audited ground truth (what is actually built) ← read before reviewing
_verify.sh     the grid, as executable assertions            ← run it
config.yml     authoritative noun / surface / grade lists
readme.md      this file — process and rubrics

NNN -E{n}-I{n}- Work-Unit-Name.md    the pile
```

**`_verify.sh` is the grid's executable form.** `_context.md` §7 admits nothing here was ever
run; this closes that. It asserts both directions — present cells run, **absent cells are still
absent** — and the absences are the point. When someone lands `Mailbox/set`, the
`expected: unknownMethod` assertion fails, and *that failure is the signal to update the grid*.
It is designed to decay loudly rather than rot quietly.

```bash
BM_TOKEN=bm_… BM_ACCOUNT=acc_… ./_verify.sh      # 44 assertions
./_verify.sh --list                              # show them, run nothing
./_verify.sh calendar                            # filter by label
```

Set `BM_RO_TOKEN` to a `read`-only token to enable the scope-gate suite, which is a live
regression test for `common/001` (P1): if a read-scoped token can call `CalendarEvent/set`,
the gate is open. Exit code = failure count.

One file in the pile = **one buildable work unit**, which may cover several cells. Cells are
not independently buildable (see *Why not one file per cell*, below), so the pile is grained
to what someone can actually pick up and finish. The exhaustive grid lives in `_index.md`.

Filenames mirror `.feedback`: `{NNN} -E{effort}-I{impact}- {Name-With-Dashes}.md`. Numbers
are identity — assigned once, never reused, never renumbered. Sequence lives in `_index.md`.

Mark a shipped unit with a leading ✅ in the filename, same as `.feedback`.

---

## The two work-kinds

The single most important distinction in this volume:

| | Shape | Cost driver | Batches by |
|---|---|---|---|
| **Capability** | can the system do this *at all* — schema, core logic, and the JMAP method that owns the write choreography | new tables, new semantics | **noun** |
| **Projection** | expose a capability that already exists on one more surface | mechanical mapping | **surface** |

**The law: a projection unit may only contain cells whose capability already exists.**

This is `s05`'s class-(a) / class-(b) split (`.plans/s05-cli-crud/readme.md:18-19`) promoted
to a general rule. It is what keeps the grid from exploding: a cell's cost is *not a property
of the cell*.

> `Contacts × Update × CLI` — `ContactCard/set` and CardDAV PUT both already work. ~20 lines.
> `Mailbox × Create × CLI` — `Mailbox/set` **does not exist on any surface**. Not CLI work at all.
>
> Same row, same column, two orders of magnitude apart.

If a unit needs both, it is a **capability** unit and says so. Never file a projection unit
against a capability that isn't built — file the capability unit and let the projection
depend on it.

---

## Grades

Both grades are in the filename so the pile sorts and greps like `.feedback`.

### Effort — `E1`–`E4`

T-shirt sizes, **anchored to observable scope** rather than time, so they survive being wrong
about velocity.

| | Size | Anchor |
|---|---|---|
| **E1** | S | One file. No schema change, no new method, no new dependency. |
| **E2** | M | Several files inside one package/service. New methods over existing tables, or a new tool/command surface. No migration. |
| **E3** | L | New table or column + migration, **or** new semantics that other code must respect (write choreography, auth gate, sync contract). Tests mandatory. |
| **E4** | XL | New workspace, service, or protocol surface. Includes anything on a stack that does not exist yet (WebUI, GraphQL). |

Note the migration cliff at E3: this repo has **no migration framework** — schema is applied
by re-running `CREATE TABLE IF NOT EXISTS` (`tools/README.md:10-11`). Adding a column to a
deployed table has no automated path. That is why E3 is a real step up from E2 and not a
matter of line count.

### Impact — `I0`–`I3`

Two independent factors, exactly as specified:

|  | **unlocks other work** | **unlocks nothing** |
|---|---|---|
| **human can verify** | **I3** — highest | **I1** |
| **not human-verifiable** | **I2** | **I0** |

**"Unlocks other work"** — completing this unit removes a stated blocker from at least one
other unit or `sNN` section. Not "would be nice to have first"; a named dependency.

**"Human can verify"** — a non-engineer could confirm it works through a normal interface:
a mail client, Apple Calendar, a browser, or CLI output they can read. Judged **on completion
of this unit**, not hypothetically once some future surface renders it.

`curl` returning correct JSON is **not** human-verifiable. It is test-verifiable. This is a
deliberately harsh line, and it produces the right signal — it is why CalDAV work grades high
(you can point Apple Calendar at it) and why a JMAP method with no surface grades lower than
it feels.

### Impact is not priority

A blocker with `I2` still gets sequenced before the `I3` it unblocks. `_index.md` carries the
sequence; the grade describes the cell, not the calendar.

---

## Design rule that falls out of the rubric

**Pair a capability with its cheapest human-visible surface in the same unit.**

`Identity/set` alone is `I2` — real, invisible, verifiable only by test. `Identity/set` *plus*
the four-line CLI subcommand is `I3`, because now you can set a signature, send mail, and see
it. The second version is barely more work and worth a full grade more.

Where the cheapest human-visible surface is CLI or DAV, bundle it. Where it is WebUI, don't —
that stack doesn't exist and the bundle would become `E4`.

### Where the rule fails — read before sequencing

The pairing rule optimises for *visible* wins, and this volume's **hard data flows are
concentrated in the low-graded units**, precisely because they are invisible. Grading them
low is correct under the rubric; **skipping their design is not.** The known cases, all
verified:

| Unit | Grade | The flow that is actually hard |
|---|---|---|
| `026` `queryChanges` | E3 **I0** | The real sync design. And `s03.C`'s virtualized thread list is planned *on* `Email/queryChanges` (`arch.md:57`) — a method that always throws (`email.ts:54`). T2 must build the re-query fallback or land this. |
| `010` blob lifecycle | E2 **I1** | Share links are **stateless HMAC** (`services/jmap/src/index.ts:185`) — nothing is recorded at mint. Enumeration is therefore exactly as impossible as revocation, and both need the same fix. `s03.B` T3 builds *on* this path, so the gap widens with use. |
| `005` `EmailSubmission/get` | E1 I2 | There is no delivery-status flow to expose. `undo_status` is written `'final'` once (`submission.ts:169`) and never updated; the SNS bounce handler writes a KV suppression list keyed by **recipient** (`services/submit/src/index.ts:129-137`) and never correlates on `relay_message_id`. |
| `027` `Thread/changes` | E2 **I0** | `proxyChanges`' collection union **already includes `"Thread"`** (`common.ts:75`) — the only occurrence of that string in the tree. Registering the method today compiles and returns an eternally empty delta, which is *worse* than `unknownMethod`. |
| `008` admin lifecycle | E2 **I1** | `agent_bindings.enabled` (`data-plane.sql:104`) is written `1` at creation and **never written again** — no route reaches it. Both drain paths filter on it (`agent/src/index.ts:110`, `ingest/src/index.ts:169`), so it *is* the agent kill switch, just unreachable. |

That last row is the sharpest instance of the failure mode: **`007` (I3) hands a human an
on-demand agent trigger into a system whose off switch is unreachable, and the unit that
reconnects it grades `I1`.** Sequence `008`'s binding-disable route with `007`, not in wave 4.

**The rule for reviewers:** a low impact grade licenses *deferring* a unit. It never licenses
designing the high-impact unit as though the deferred flow does not exist.

### Where the rubric is known to mislead

`004` (`Mailbox/set`) is the largest capability gap in the repo — the session already
advertises `maxMailboxDepth`, `mayCreateTopLevelMailbox`, `mayRename`, and `mayDelete` while
providing no method to act on any of them — and yet **no unit and no `sNN` section names it as
a blocker**, so the strict "unlocks" test grades it `I1`, below a CLI flag.

Left at `I3` pending a human call. The open question is whether "closes a glaring absence in
the flagship noun" deserves to be a third impact factor, or whether the honest answer is that
impact and priority genuinely diverge here and the sequence in `_index.md` should carry it
instead.

---

## Why not one file per cell

Considered and rejected. 14 nouns × 7 surfaces ≈ 98 noun-surface pairs; roughly half are
already built or genuinely N/A (`Thread × SMTP` is not a thing). More decisively: one
buildable slice routinely spans four cells that **must ship together** — the MCP tool surface
covers Calendar, Contacts, and Email at once, and splitting it into per-noun files would
describe three fake units none of which is independently shippable.

The exhaustive property is what the grid in `_index.md` is for. The pile is for work.

---

## Process

0. **If you are an agent working in a git worktree, sync it before anything else:**

   ```bash
   git fetch origin && git merge origin/main
   ```

   Worktrees branch from `main` at creation and go stale fast. One agent skipped this and
   silently reverted part of another commit — its change was correct against its own base and
   wrong against the branch. Confirm `npm test` is green *before* you change anything, so a
   failure later is unambiguously yours.

   Related, and easy to miss: `vitest.config.ts` pins `@bullmoose/*` with `resolve.alias`.
   Without it, Node's upward `node_modules` lookup escapes the worktree and resolves workspace
   packages to the **parent checkout** — tests then exercise a different branch's source than
   `tsc` checks. If you touch that config, keep the aliases.

1. Read `_context.md` first. It is the audited state of the repo, with `file:line` evidence.
   **Do not re-derive it from the docs** — several plan docs are stale or overstate what
   exists, and *no existing plan records its own status*.

   Note the irony, and take the warning seriously: this volume's own `_context.md` went stale
   within one session of being written. It carries a "Changes since the original audit"
   banner for exactly that reason. **Check that banner's date against `git log` before
   trusting a number in it.**
2. Pick a unit from the `_index.md` ledger whose dependencies are met.
3. Build it. Update the unit file's **Status** line.
4. On commit, prefix the filename with ✅ and update `_index.md`.

### For reviewers (Codex, or a human)

Every unit file ends with **§ Open questions / where this could be wrong**. That section is
the point — it is where I record what I could not verify, what I inferred, and which calls
are genuinely arguable rather than settled.

Disagreements go in a sibling `NNN -E{n}-I{n}- Name.review.md`, mirroring `.feedback`'s
`.fix.md` pairing. Do not silently edit a unit file to remove a claim; leave the claim and
argue with it, so the reasoning survives.

**Highest-value review targets, in order:**
1. The grades. Effort anchors are checkable against the repo; impact grades are judgement
   calls and several are close to the line. Each file states its own reasoning.
2. The dependency edges in `_index.md`. A wrong edge changes the build order.
3. The capability/projection classification. If a unit is filed as projection and the
   capability is actually missing, that unit is unbuildable as written — this is the most
   damaging possible error in the ledger, and `_context.md` is the evidence to check it with.

---

## Relationship to the `sNN` sections

`sVOL` **does not supersede** any existing section, and deliberately does not cover
everything in `.plans/`. Roughly 60% of existing plan content is **off-matrix** — it has no
cell to live in:

| Section | Off-matrix content | Why it has no cell |
|---|---|---|
| `s01-stateless-MCP` | the MCP.2 wire contract | protocol axis — under every cell |
| `s03.A-foundations` | provenance columns, grant tombstones | a plane *beneath* every write path; no surface |
| `s03.D-coexistence` | tier / approval semantics | *mediates* other nouns' writes |
| `s04-AgentOS/bureau.md` | egress credential brokerage | a 4th axis — outbound, third-party; no bullmoose noun on either side |

Those stay where they are. `sVOL` references them where they gate a cell.
