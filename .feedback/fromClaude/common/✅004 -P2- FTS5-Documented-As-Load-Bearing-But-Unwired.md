# ✅ 004 -P2- FTS5 documented as load-bearing, but `emails_fts` is never written or read

> **FIXED — and the fix went further than the proposal.** The `.fix.md` recommended
> UPDATE-DOC now and BUILD later. Both landed together, because the doc's claim turned out
> to be the cheaper thing to make TRUE than to qualify.
>
> - `emails_fts` is written by `Mailstore.insertEmail` and retracted by `destroyEmail`, so
>   every write path inherits it: ingest, `Email/set` create, `Email/import`, the agent
>   worker. `NewEmail.bodyText` (optional) carries the parse that was previously discarded
>   after `preview` was cut; HTML-only mail is stripped to words rather than skipped.
> - `Email/query`'s `text` condition is an FTS5 `MATCH`, not a `LIKE` scan.
>   `ftsMatchQuery()` quotes every whitespace run as a phrase, so `AND`/`OR`/`NEAR`/`*`/`"`
>   are literal words and cannot parse-error or boolean-surprise. Punctuation-only input
>   (`--`) has no FTS5 representation at all and keeps the old LIKE.
> - Two new schema objects: `contentless_delete=1` on `emails_fts` (without it SQLite
>   refuses to delete a row, and the body text needed to retract one lives in R2, not D1),
>   and `emails_fts_map` for the rowid↔email-id join a contentless table cannot hold itself.
>   Both need a hand-run migration — `docs/DEPLOY.md`.
> - Backfill: `POST /admin/fts/backfill` on the ingest worker, resumable and idempotent
>   (work queue = "messages with no map row"), `deep=1` re-reads R2 for full bodies.
>
> **The sizing caveat the `.fix.md` asked for was re-run, not waved through.** Measured on
> 50K- and 200K-message shards: ~0.6 KB of index per message (~26% of body size), so the
> single-shard ceiling moves ~300K → ~200K. Bought back on budget #2 — a selective search
> is 200×–7500× faster and reads matching rows instead of every row.
> `capacity-and-scaling.md` §1 and §2.2 carry both halves.
>
> **Still not built:** `body`/`header` members on `EmailFilterCondition`. `text` covers
> bodies now, and a body-ONLY condition would need a second index for no known caller.
> `services/anglebrackets` was checked and does not touch the filter surface.

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
