# s03.B — Files: architecture

> Slice-specific structure. System-wide architecture (realm model, invariants, client)
> is in [`../s03-webAccess/arch.md`](../s03-webAccess/arch.md); this covers only what
> Files adds.

## 1. Decision: implement the draft, pinned

Target **`draft-ietf-jmap-filenode-14`**, capability `urn:ietf:params:jmap:filenode`.

**Why conform:** Files is the one realm where third-party JMAP clients are plausibly
useful (Bulwark speaks FileNode); the draft's inode model is the right shape anyway; and
it makes a future conformance probe meaningful.

**The risk, stated plainly:** draft-14 is **not an RFC**. Fourteen revisions, expires
2026-11-16, and it carries a _"create real-world clients to test this"_ TODO.

**Mitigation.** Pin the targeted version in a constant. Keep FileNode behind the same
method-registry indirection every other collection uses. **Do not leak FileNode shapes
into webmail's own types** — the client talks to a thin Files adapter. When -15 lands,
the blast radius is one module.

## 2. The object

```
FileNode {
  id            Id          (immutable, server-set)
  parentId      Id|null     (null = top level)
  name          String      (unique among siblings)
  nodeType      String      "file" | "directory" | "symlink"   (immutable)
  blobId        Id|null     (required for files; null otherwise)
  size          UInt|null   · type String|null (IANA media type) — files only
  created / modified / accessed / changed   UTCDate
  executable    Boolean     · isSubscribed Boolean
  myRights      FilesRights (server-set)
  shareWith     Id[FilesRights]|null   ← always null in this slice, §4
  role          String|null ("root" | "home" | "trash" | …)
}
FilesRights { mayRead, mayAddChildren, mayRename, mayDelete, mayModifyContent, mayShare }
```

Methods: `/get` (+`fetchParents`), `/set` (+`onDestroyRemoveChildren`, `onExists`,
`compareCaseInsensitively`), `/query` (depth recursion), `/changes`, `/queryChanges`,
`/copy`.

## 3. Mapping onto our substrate

| Concern         | Where                                                                                              |
| --------------- | -------------------------------------------------------------------------------------------------- |
| Inode metadata  | **D1** — `file_nodes` in the data plane; sibling-name uniqueness is a DB constraint, not app logic |
| Content bytes   | **R2** — existing blob path + `Mailstore` put/get. **No new storage code.**                        |
| Change tracking | **AccountDO** — `commitChanges` with `collection: "FileNode"` gives `/changes` + push for free     |
| Provenance      | inherited from s03.A — the table carries `last_writer_*` from birth                                |

### The blob-pinning hazard

The draft is explicit: _"A blob referenced by a FileNode MUST NOT be expired or garbage
collected by the server while the FileNode exists."_

Uploaded blobs today are **transient by intent**. A referenced blob becomes **pinned**.
This is the one non-obvious storage change, and it must land **with** the schema — not
after — or the first GC pass eats live files.

## 4. Sharing: three tiers, two in this slice

| Tier            | Mechanism                                                                | Here?            |
| --------------- | ------------------------------------------------------------------------ | ---------------- |
| Private         | owner-only; `myRights` from ownership                                    | ✅               |
| **Link-shared** | `POST /api/share/{accountId}/{blobId}` **[live]** — expiring public link | ✅ already built |
| Named-principal | draft's `shareWith` + hierarchical `FilesRights` inheritance             | ❌ → ACL epic    |

`shareWith` is a genuine multi-principal ACL that partly overlaps our `grants` model —
that's the "teams" epic, not this. Returning `shareWith: null` with owner `myRights` is a
**conforming subset, not a fork**.

## 5. The attachment sidestep

**Outbound** — the motivating flow; only one step is new:

```
compose → attach 400 MB
  → POST /api/upload/{account}          [live]  → blobId
  → FileNode/set create {file, blobId}  [NEW]   → node under the Sent-Files role
  → POST /api/share/{account}/{blobId}  [live]  → expiring URL
  → link goes in the body; the message carries no attachment
```

**Inbound** — symmetry, nearly free. Ingest already writes attachments to R2; add a rule:
_attachment ≥ N bytes → create a FileNode under the Attachments role, keep the link in
the message._ This is what makes Files useful on day one instead of an empty drive.

**Threshold `N` is a policy value**, not a constant — default it conservatively and make
it configurable per account.

## 6. Invariants this slice adds

1. A blob referenced by a live FileNode is never GC'd.
2. Sibling names are unique within a parent — enforced by the DB.
3. `parentId` cannot form a cycle; destroying a directory honours
   `onDestroyRemoveChildren`.
4. `shareWith` is always `null` until the ACL epic — no partial ACL semantics leak out.
5. FileNode types do not appear in webmail's domain types (§1 mitigation).
