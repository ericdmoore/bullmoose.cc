# 030 -P2- FileNode follow-ups: copy OOM, grant divergence, top-level uniqueness race

**Subsystem:** common (`services/jmap` + `packages/mailstore`) · **Severity:** MEDIUM (one production OOM, two correctness edges) · **Fix class:** MIXED

Filed as a bundle from sVOL `011` (FileNode T1+T2). The unit shipped a complete, tested
CRUD surface; these are the E4 rough edges it flagged rather than papered over. Sequenced
highest-risk first.

## 1 — `FileNode/copy` reads the whole file into memory (the one that bites)

`services/jmap/src/methods/filenode.ts` copies content by `obj.arrayBuffer()` → `putBlob`. A
Worker has a **128 MB** memory ceiling, so a large cross-account copy OOMs and kills the
request. Metadata copy and small-file copy are correct; large-file copy is the gap.

The real fix is a server-side R2 object copy (no round trip through Worker memory), but the R2
binding does not currently expose one. Options: cap copy size and return `tooLarge` above the
cap (honest, cheap, immediate), or stream through a bounded buffer. **At minimum add the cap**
so the failure is a clean 4xx rather than an OOM — an OOM on one request can evict others.

## 2 — top-level sibling uniqueness is method-enforced, not DB-enforced

`file_nodes` has `UNIQUE(account_id, parent_id, name)`, but SQLite treats NULLs as distinct,
so the index is a **no-op for `parent_id IS NULL`** (top-level nodes). `onExists` +
`compareCaseInsensitively` cover it in the method layer, but that check is racy under
concurrent `set`s — two simultaneous top-level creates of the same name can both pass.

Fix: a `UNIQUE(account_id, COALESCE(parent_id,''), lower(name))` index closes it at the DB. It
deviates from the literal schema in `s03.B`'s devPlan, so it wants a nod — but the DB is the
only non-racy place to enforce this.

## 3 — over-revocation when two nodes share one content-addressed blob

Blobs are content-addressed, so two FileNodes can reference one blob. Destroying one node
revokes **all** live shares for that blob (the `010` obligation), killing the surviving node's
share links too. `011` chose over-revoke (a dead link) over under-revoke (the `010` leak),
deliberately. Correct default; worth revisiting if dedup makes shared blobs common — revocation
should probably be refcounted against remaining referencing nodes.

## 4 — grant divergence from Calendar, needs a ruling

`Calendar/set` refuses **all** grant-reached access. `FileNode/set` **allows** whole-account
grants holding the `files` scope to write. `011` argues delegation is meaningful for a shared
drive and that `matchingGrants` already enforces `collection === null` + `files`. It is a
deliberate divergence and reasonable, but two write surfaces now answer "may a grant write?"
differently. Pick one policy or document why they differ. Ties into `common/027` (the scope
model is already under review).

## Also noted, lower stakes
- Whole account tree loaded into memory per `set`/`copy`/`fetchParents` — O(nodes), fine for a
  personal drive, not for a large one.
- `compareCaseInsensitively` is a per-call `set` arg, not the per-directory property the draft
  models — mixed clients can disagree on collation.
- Capability advertised unconditionally (like calendars); `s03.B` devPlan's "absent when
  disabled" acceptance is unmet. Mitigated by the pinned `draft-ietf-jmap-filenode-14` version.

## Deferred by the unit (not defects — scope)
T3 attachment sidestep · s03.A `last_writer_*` provenance columns · CLI `files` verbs ·
named-principal `shareWith` (ACL epic). `packages/cli/src/help.ts` still omits `files` from
its scope vocabulary — the CLI files-verbs unit should fix the wording.

## Related
- `.plans/sVOL-CapSurNoun/011` — the unit; its Status block lists what shipped vs deferred.
- `010` — the share-revoke obligation `011` discharges on destroy.
- `common/027` — the scope-model decision that item 4 depends on.
