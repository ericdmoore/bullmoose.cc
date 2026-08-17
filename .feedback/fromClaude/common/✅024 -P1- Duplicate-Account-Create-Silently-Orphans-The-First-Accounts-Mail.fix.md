# FIX — 024 -P1- Duplicate account create orphans mail

## Recommendation: reject on conflict, adopt on exact match

```
existing route for (domain, localpart)?
├── no                    → create, insert route            201
├── yes, same target      → return the existing account     200  (idempotent retry)
└── yes, different target → 409 Conflict, change nothing
```

That covers the case that actually bites (a retried or re-run bootstrap) without ever
silently moving delivery. **The silent repoint is the defect; preserve everything else.**

Do **not** make `identities.email` globally `UNIQUE` as the primary fix. Two reasons:

1. It is the wrong constraint. Aliases and future send-as (`.plans/sVOL-CapSurNoun/006`,
   `Identity/set`) legitimately want one address usable from more than one place. The thing
   that must be unique is the **delivery route**, not the identity row.
2. This repo has **no migration framework** — schema is re-run `CREATE TABLE IF NOT EXISTS`
   (`tools/README.md:10-11`). Adding a `UNIQUE` to an existing table has no automated path,
   and would fail outright on any deployment that already has duplicates.

## Where

`services/provision/src/index.ts` — `POST /accounts` (`:67`), around the account-creation
batch that ends with the route write at `:387`.

Read `routes` for `(domain, localpart)` **before** the batch, then branch. The check and the
write must be in the same D1 batch (or a transaction) or two concurrent creates race straight
through it.

### The narrower guard, if you want defence in depth

Change `:387` from `INSERT OR REPLACE INTO routes` to `INSERT INTO routes` and let the PK
conflict throw. That single-word change removes the _silent_ part even if the pre-check is
skipped or races — a 500 is vastly better than vanished mail. Worth doing regardless of the
route-check above, because it converts the failure mode from silent to loud at zero cost.

Check the `routes` PK first: confirm `(domain, localpart)` is actually the key, or the
conflict will not fire.

## Bread-crumbs

- **`INSERT OR REPLACE` is delete-then-insert in SQLite**, so any future FK referencing the
  old `routes` row would `ON DELETE` cascade. Nothing does today — worth not relying on.
- `:409` writes a KV key alongside the route (the ingest fast path). Whatever branch you take,
  keep the two consistent — a rejected create must not leave a KV entry pointing at an account
  that was never wired, and an adopted one must not double-write.
- **Grep for other `INSERT OR REPLACE`** in the provision worker before assuming this is the
  only one; the pattern tends to repeat once someone reaches for it.
- **Recovery for anyone already hit:** the orphaned account still holds its mail. Repointing
  is a single `routes` row plus the matching KV key — worth writing down in `docs/DEPLOY.md`
  as a runbook note, since there is no delete route to clean up the duplicate account
  (`.plans/sVOL-CapSurNoun/008`).
- No test infrastructure covers `services/provision`. The cheapest proving assertion is a
  two-call integration test: create the same address twice, assert the second returns 409 (or
  200 with the _same_ account id) and that `SELECT target FROM routes` is unchanged.
