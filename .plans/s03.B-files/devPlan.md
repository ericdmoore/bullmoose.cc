# s03.B — Files: dev plan

> Scope: [`readme.md`](./readme.md) · structure: [`arch.md`](./arch.md).
> **Depends on s03.A** (provenance).

---

## T1 — `file_nodes` schema + blob pinning

**Blocks:** D1 data plane · `packages/mailstore` · R2 GC path.

- Inode table: `id, account_id, parent_id, name, node_type, blob_id, size, type,
  created, modified, accessed, changed, executable, is_subscribed, role` +
  the `last_writer_*` columns from s03.A.
- **Sibling-name uniqueness as a DB constraint** — `UNIQUE(account_id, parent_id, name)`,
  with the case-insensitivity option handled at the method layer.
- **Blob pinning** — a blob referenced by a live FileNode must survive GC. Lands *with*
  the schema (`arch.md` §3).

**Done when:** tree CRUD holds at the DB level; a pinned blob is not collectable;
`parent_id` cycles are rejected; provenance columns populate.

---

## T2 — `FileNode/*` methods

**Blocks:** `services/jmap/src/methods/` · session capabilities · AccountDO.

- `get` (+`fetchParents`), `set` (+`onDestroyRemoveChildren`, `onExists`,
  `compareCaseInsensitively`), `query` (depth recursion), `changes`, `queryChanges`,
  `copy`.
- Advertise `urn:ietf:params:jmap:filenode` in the session **only when enabled**.
- `myRights` = owner rights; `shareWith` = `null` (`arch.md` §4).
- `commitChanges(collection: "FileNode")` so `/changes` + push work like every other
  collection.
- Authorization through the existing `requireAccount` gate — Files is not special.

**Done when:** a conformance suite drives create-dir → upload → attach blob → move →
rename → copy → destroy-with-children, with `/changes` reflecting each step; the
capability is absent from the session when disabled.

---

## T3 — Attachment sidestep

**Blocks:** `services/ingest` (inbound) · compose helper (outbound, server-side so the
CLI gets it too).

- **Outbound:** upload → `FileNode/set` → `/api/share` → link in body. Four of five
  steps already exist.
- **Inbound:** ingest rule — attachment ≥ `N` → FileNode under the Attachments role,
  link retained in the message, message cross-linked to the node.
- `N` configurable per account, conservative default.

**Done when:** a >25 MB send produces a message with a working expiring link and no
attachment; a large inbound attachment appears in Files cross-linked to its message;
both paths exercised in tests with a fake R2/D1.

---

## Sequencing

```
s03.A ─▶ T1 schema+pinning ─▶ T2 FileNode/* ─▶ T3 sidestep
```

Strictly linear — T2 needs the table, T3 needs the methods.

## Verification

Beyond unit tests: drive the whole thing from `bullmoose` CLI / curl against
`wrangler dev` with a seeded D1. **This slice is deliberately UI-free**, so a green
end-to-end run here is the real acceptance signal, not a screenshot.

## Risk

**Draft churn.** Mitigated by pinning the version and isolating FileNode behind the
method registry (`arch.md` §1). If -15 lands mid-build, re-read the diff before
adopting — a WG draft can change field semantics, not just add fields.
