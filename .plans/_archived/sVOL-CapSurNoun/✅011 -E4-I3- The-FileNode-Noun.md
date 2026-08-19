# 011 -E4-I3- The FileNode noun

| | |
|---|---|
| **Kind** | capability |
| **Effort** | **E4** — a noun from zero: new table, new JMAP capability urn, new blob-lifecycle rule, changes in three services |
| **Impact** | **I3** — unlocks *and* human-verifiable |
| **Owner** | **`s03.B-files`** |
| **Depends on** | `s03.A` (provenance columns — `file_nodes` should carry them from birth) |
| **Status** | **✅ done** (closed 2026-08-13). T1 + T2 + T3 all shipped — `services/jmap/src/methods/filenode.ts` (`get changes query queryChanges set copy`). The **outbound** attachment half is out of scope by design and tracked in `.backlog/compose-attachments.md`, not here. |

## What shipped (T1 + T2)

- **T1 — schema + accessors + pinning.** `file_nodes` inode table in
  `packages/mailstore/sql/data-plane.sql` (`UNIQUE(account_id, parent_id, name)`,
  four epoch-ms timestamps, `file_nodes_{parent,blob,changed}` indexes). Mailstore
  accessors `getFileNodes`, `getFileNodeChildren`, `insertFileNode`,
  `updateFileNode`, `deleteFileNodes`, `queryFileNodes`, `fileNodesReferencingBlob`.
  **Blob pinning landed with the schema:** `handleBlobDelete`
  (`services/jmap/src/index.ts`) now refuses (409 "blob pinned") while any live
  FileNode references the blob, alongside the existing mail-reference and
  live-share guards.
- **T2 — `FileNode/*` methods** in `services/jmap/src/methods/filenode.ts`:
  `get` (+`fetchParents`), `set` (+`onExists`, `compareCaseInsensitively`,
  `onDestroyRemoveChildren`, cycle rejection, **010 revoke-on-destroy**), `query`
  (+`ancestorId` depth recursion), `changes`, `queryChanges` (always-throw stub),
  `copy`. Full write choreography — mutate → `commitChanges(collection:"FileNode")`
  → `newState`. Advertised as `urn:ietf:params:jmap:filenode` (pinned to
  `draft-ietf-jmap-filenode-14`) in the session and `SUPPORTED_CAPS`.
- **Scope.** New realm scope `files` in `REALM_SCOPES` (+ CLI mirror) and
  `MethodDomain` — reads gate `("read","files")`, writes `("files","files")`,
  mirroring calendar/contacts (`_context.md` §4).
- **Tests.** `services/jmap/src/methods/filenode.test.ts` — 29 tests, including the
  write-choreography counterfactual and the 010 obligation. 746 total (was 715).

## Deferred (explicit follow-ups)

- **T3 — the attachment sidestep** (in `services/ingest`, out via a compose helper).
  Not started. The metadata + link primitives it needs now exist.
- **s03.A provenance** — `file_nodes` carries no `last_writer_*` columns. Adding
  them later is an ALTER, which this repo has no framework for — but the table is
  new, so a fresh deploy that includes them would be clean.
- **CLI `files` verbs** (the projection cell this unit flagged) — still unwritten.
- **Named-principal sharing** — `shareWith` is hardcoded `null` (ACL/"teams" epic).
- **Conditional capability advertisement** — advertised unconditionally (like
  calendars); the draft-churn mitigation is the pinned-version constant, not a flag.

## Cells covered

`FileNode × CRUD × JMAP` — the entire FileNode row of the grid, which is `----` on every
surface today (`_context.md` §2 footnote 12: the noun does not exist; what exists is
attachment-blob plumbing).

Plus two things that are not cells: the `file_nodes` schema + blob pinning (a storage-plane
change beneath the cell) and the attachment sidestep (a cross-noun flow touching Email and
Transport).

## Why these grades

**E4.** Above the E3 migration cliff on three counts, any one of which would do it: a new
table in the data plane; a new protocol surface — `urn:ietf:params:jmap:filenode` advertised
in the session (`s03.B/devPlan.md:32`); and a new semantic other code must respect — a blob
referenced by a live FileNode becomes **pinned** against GC (`s03.B/arch.md:56-61`), which is
a rule the R2 collection path did not previously have.

**I3, both factors.** *Unlocks* — `s03.B/readme.md:39` names s03.C's Files browser as blocked
on it; that is unit `021` in this ledger. *Human-verifiable* — acceptance #3
(`s03.B/readme.md:46`) is a >25 MB send that produces a working link and no attachment. A
non-engineer sends the mail and the recipient clicks.

## Owned by

**`s03.B-files`.** Three strictly linear tasks (`s03.B/devPlan.md:63-65`):

- **T1** — `file_nodes` schema + blob pinning (`devPlan.md:8-22`)
- **T2** — `FileNode/{get,set,query,changes,queryChanges,copy}` (`devPlan.md:25-41`) ← the cell
- **T3** — the attachment sidestep, in and out (`devPlan.md:44-58`)

The shape decision is `s03.B/arch.md:9` — implement `draft-ietf-jmap-filenode-14` pinned to a
constant rather than invent `urn:bullmoose:files`. `shareWith` is always `null` in this slice
(`arch.md:100`); named-principal ACLs go to the teams epic.

## What sVOL adds

**One cell in this ledger is claimed by implication and specified by nobody:
`FileNode × CRUD × CLI`.**

- s03.B says the slice is "Drivable by CLI/curl" (`readme.md:29`) and makes a CLI/curl run
  its real acceptance signal (`devPlan.md:71-73`) — but none of T1, T2 or T3 lists a single
  `bullmoose` command. CLI is the *test harness* there, not a deliverable.
- s05 excludes it explicitly and points back: "Files CLI surface (arrives with **s03.B**)"
  (`s05/devPlan.md:139`), and again at `s05/readme.md:96`.

Each section points at the other. No task anywhere writes `bullmoose files ls`. Whoever
builds T2 should either add the CLI verbs to s03.B or file them here as a separate projection
unit — but not leave the loop closed.

Second, smaller: `arch.md:69` lists link-sharing as ✅ already built, and invariant 1 pins a
blob while its FileNode lives. Neither says what happens on `FileNode/set destroy` — a minted
share URL stays valid until `exp` with no kill switch (`_context.md` §2 footnote 12). That is
unit `010`, and it becomes a data-leak path once Files exists rather than merely untidy.

## Open questions / where this could be wrong

1. **E4 vs E3 is arguable.** T2 is "several files in one service over a new table" — E3's
   anchor. I graded E4 on the protocol-surface clause in `config.yml`, because advertising a
   new capability urn commits us to a spec we do not control. Someone could reasonably call
   the whole slice E3 + a big T1.
2. **The draft-churn risk is real and unpriced.** `arch.md:16-17` states it plainly: draft-14
   expires 2026-11-16 and carries a *"create real-world clients to test this"* TODO. If -15
   lands mid-build the effort grade is wrong and nothing in the ledger notices.
3. **I did not verify the s03.A dependency is load-bearing.** It is stated
   (`readme.md:33-36`) as "should carry it from birth rather than be retrofitted", which is
   an ordering preference, not a hard gate. FileNode is buildable without provenance columns;
   it is just worse. The edge in `_index.md` reads harder than the source does.
4. **Nothing here was run**, and the blob-pinning claim in particular is read from `arch.md`,
   not from an R2 lifecycle rule I inspected.
