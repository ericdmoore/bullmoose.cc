# 004 -P2- FTS5 documented as load-bearing, but `emails_fts` is never written or read

**Subsystem:** common (`packages/mailstore`) · **Severity:** MEDIUM-HIGH · **Fix class:** UPDATE-DOC

## The drift

`docs/architecture/serverless-jmap.md:299` states:

> "This is why the D1 + FTS5 index is **load-bearing** … the server evaluates the filter (including
> full-text `text`/`subject`/`body` conditions) … Implement a rich `text` full-text condition over
> FTS5 to keep the residue near-empty."

And `:30` — "**D1 (SQLite + FTS5)** = `Email/query` filter/sort + full-text search map cleanly to SQL."

## The reality

`emails_fts` is created at `packages/mailstore/sql/data-plane.sql:44-48` and **referenced nowhere
else in the repo** — the `CREATE` is the only occurrence outside `node_modules`.

- `insertEmail` (`packages/mailstore/src/index.ts:564-605`) writes no FTS row.
- The `text` condition is a **LIKE scan** over `subject`/`preview`/`from_json`/`to_json`
  (`:518-526`).
- `EmailFilterCondition` (`:78-91`) has **no `body` or `header` member at all**.
- `preview` is capped at 256 chars (`services/jmap/src/methods/email.ts:466`), so message bodies are
  effectively unsearchable.

## Why this matters beyond tidiness

`serverless-jmap.md:299`'s own argument is that thin filter support forces clients (himalaya
specifically) to over-fetch and filter client-side — "slow, more egress". That consequence is live
right now, and the doc reads as though it is not.

The `.plans/s03-webAccess` search surface assumes server-side search works.

## The honest side

`data-plane.sql:42-43` carries a TODO, and `packages/mailstore/README.md:9` correctly says
"LIKE-based text search". So the code and its local docs are truthful — **the architecture doc is
the drifted side.**
