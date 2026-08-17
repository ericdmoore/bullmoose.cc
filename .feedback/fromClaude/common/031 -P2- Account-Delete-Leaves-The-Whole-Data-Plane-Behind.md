# 031 -P2- Account soft-delete strands the entire data plane, and no unit owns cleanup

**Subsystem:** common (provision + data-plane shards) · **Severity:** MEDIUM (silent data retention) · **Fix class:** DESIGN + CHANGE-CODE

Surfaced by sVOL `008`, which shipped account/domain/tenant lifecycle and answered its own
open question #4 with "not here."

## What `008` did, and the gap it names

`DELETE`-ing an account is a **soft delete** — `accounts.deleted_at` is set, `verifyBearer`
refuses the principal, every `routes` row and KV key for the address is torn down, and
credentials are revoked. That is the right control-plane behaviour: the account stops
authenticating and stops receiving mail immediately.

**But the data plane is untouched.** The account's messages, calendars, contacts, and R2
blobs all remain — on a shard the provision worker cannot reach. `008` is explicit that it
leaves them and says so in the delete response, but:

- **nobody owns the teardown.** There is no unit, no route, and no job that removes a deleted
  account's data-plane rows or blobs.
- soft delete was chosen *specifically because* the data is unreachable from here — dropping
  the `accounts` row would strand the data unattributable, which is worse. So the soft delete
  is correct **and** it is the thing that guarantees the data lingers.

## Why P2, not lower

Two reasons it is more than housekeeping:

1. **Retention / privacy.** "Delete my account" that leaves every message and every uploaded
   file intact indefinitely is a promise the product visibly breaks. R2 blobs in particular
   cost money to retain and may carry content a user expected gone.
2. **Address reuse.** A future account provisioned on the same address (now that `common/024`
   makes that a deliberate adopt-or-409) shares a shard namespace with the tombstoned one.
   Whether old rows can bleed into the new account depends on how shard keys are scoped —
   worth verifying, not assuming.

## What this needs

A **data-plane teardown** path that the control-plane delete can trigger across the shard
boundary. Candidates, roughly in order:

1. A teardown queue/job: control-plane delete enqueues `{accountId, shard}`; a worker with the
   shard binding drains it (delete rows by `account_id`, delete R2 blobs by prefix), then
   optionally hard-deletes the `accounts` row once the data is provably gone. This is the only
   shape that respects the shard boundary that forced the soft delete.
2. A retention window: soft-delete now, teardown after N days, giving an undo. Pairs naturally
   with (1).

This is genuinely a **new unit**, not a patch — it crosses the control/data plane boundary that
the whole architecture is organized around. It should be sequenced with `s03.A` (which already
introduces `deleted_at`/tombstone thinking) rather than bolted onto `008`.

## Related
- sVOL `008` — shipped the control-plane half; its open question #4 is this.
- `common/024` — address reuse after delete; the adopt-or-409 path that makes shard-namespace
  overlap reachable.
- `s03.A-foundations` — owns tombstones/provenance; the natural home for the retention model.
- `010` / `030` — blob lifecycle; R2 teardown overlaps the blob-delete path those built.
