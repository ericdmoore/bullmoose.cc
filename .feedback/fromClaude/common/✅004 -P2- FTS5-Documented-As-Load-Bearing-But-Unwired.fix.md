# ✅ FIX — 004 -P2- FTS5 documented as load-bearing but unwired

> **SHIPPED, with the split collapsed.** This proposal argued for UPDATE-DOC now and
> BUILD-later as separate items. Both landed at once — see the resolution note on the
> issue file. The reasoning that survived: the doc was indeed the drifted side, but
> "designed-not-built" was a marker with a short shelf life, and marking it would have
> cost most of the work of removing it.

## Proposal: UPDATE-DOC now, and file the build work separately

The doc is the thing currently lying, and it is a one-paragraph fix. The underlying capability gap
is real but is a *feature*, not a correction — conflating them is how this drifted in the first
place.

### 1. Mark the doc as designed-not-built

`docs/architecture/serverless-jmap.md:30` and `:299` — add an explicit status marker, matching the
`[live]`/`[proposed]` convention `mcp-auth.md` already uses:

> **[proposed]** D1 + FTS5 full-text. **Today:** `Email/query`'s `text` condition is a LIKE scan over
> subject/preview/from/to (`mailstore/src/index.ts:518-526`); `emails_fts` exists in the schema
> (`data-plane.sql:44-48`) but is neither written nor read. Message **bodies are not searchable** —
> `preview` is capped at 256 chars. Consequence today: clients that need body search must over-fetch
> and post-filter.

That last sentence is the important one — it tells a client author what to expect.

### 2. File the implementation as its own item

Sketch, so the reader knows the shape:

- populate `emails_fts` in `insertEmail` (`:564-605`) — the body text is already parsed at ingest
  (`PostalMime` output), so the content exists; it is currently discarded after `preview` is cut
- add `body`/`header` members to `EmailFilterCondition` (`:78-91`)
- route `text` through FTS5 `MATCH` with the LIKE path as fallback for short/prefix queries

**Sizing caveat worth capturing before anyone commits:** an FTS index over full bodies changes the
D1 storage profile materially, and `docs/architecture/capacity-and-scaling.md` budgets per-message
storage without it. Re-run that math first — this may be the reason it was deferred.

## Bread-crumbs

- `data-plane.sql:42-43`'s TODO is the original intent; read it before designing.
- `packages/mailstore/README.md:9` is already accurate — use its wording as the model for the
  architecture-doc fix.
- Check whether `services/anglebrackets` (DAV search) has the same expectation before changing the
  filter surface.
