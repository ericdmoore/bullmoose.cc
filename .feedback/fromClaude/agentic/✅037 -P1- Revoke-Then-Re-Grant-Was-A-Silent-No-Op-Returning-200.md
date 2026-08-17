# 037 -P1- Revoke, then re-grant was a silent no-op that returned 200

**Subsystem:** agentic-components · **Severity:** HIGH (silent authorization failure) · **Fix class:** FIXED — recorded for the pattern

## What happened

s03.A changed grant revocation from a hard `DELETE` to a tombstone (`UPDATE grants SET
revoked_at = ?`). Nothing updated `grants_tuple`, which was a plain unique index on
`(grantee_account_id, target_account_id, COALESCE(collection,''), COALESCE(collection_id,''))`.

The tombstoned row keeps occupying that tuple. Forever. So **re-granting a previously
revoked pair was impossible** — and because `createGrant` inserts with `ON CONFLICT DO
NOTHING`, it did not fail loudly:

```
1. grant allen->eric         : ok
2. revoke it (s03.A tombstone): ok, row survives
3. re-grant allen->eric      : ✗ UNIQUE constraint failed: index 'grants_tuple'
```

With `ON CONFLICT DO NOTHING` swallowing that, the handler then **returned HTTP 200 with a
freshly generated `grantId` that no row carried.** The operator is told access was restored,
gets an id to quote back, and nothing exists.

## Why it survived review

The author _knew_ about the no-op case — `grant_lifecycle` is already guarded on
`res.meta.changes > 0`, with a comment explaining that a duplicate tuple is a silent no-op.
The guard was applied to the audit log and not to the response. So the system's own record
was honest while the answer to the caller was not, which is the inversion that made it
invisible: `grant_lifecycle` correctly showed no `created` event.

## The fix

`grants_tuple` is now **partial** on `revoked_at IS NULL`, so a tombstone stops occupying
the tuple, and the conflict branch returns **409 naming the live grant that is actually in
the way** instead of inventing an id. Verified both directions: re-grant after revoke
succeeds; a genuinely-duplicate live grant is still refused.

## The part worth remembering

I assumed `bureau_grants_tuple` had the identical bug and made it partial too. It does not —
that table's writer **upserts** (`ON CONFLICT (principal_id, cred_name, verb) DO UPDATE SET
revoked_at = NULL`), resurrecting its own tombstone. SQLite matches a conflict target against
a unique index, so a partial index there breaks every Bureau grant write; 14 tests failed to
even _prepare_. Two tables, same tombstone concept, two correct-but-different answers.

**Generalisation:** when a schema changes what a row _means_ (present → present-or-tombstoned),
every unique index over that table, and every `ON CONFLICT` clause naming one, is part of the
change. Grep for both. See [[034-bureau-allowlist-accepts-link-local-and-metadata-ips]] for
the other case where an omission looked like a decision.

## Related

`introspectTools.ts` had the reporting half of the same s03.A fallout — `renderGrant().live`
ignored `revoked_at`, and `access_log`'s `grant_live` used `SELECT COUNT(*) … WHERE g.id = ?`,
which counts the tombstone, so `underRevokedGrants` was permanently 0. Enforcement was never
affected (`auth-core/principal.ts` filters `revoked_at IS NULL`); it was purely a lie told by
the surface whose entire job is letting a human verify who can reach their mail. Fixed in the
same change.
