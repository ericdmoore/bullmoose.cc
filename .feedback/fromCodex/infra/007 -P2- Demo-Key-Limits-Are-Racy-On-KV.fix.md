# FIX - 007 -P2- Demo key mint/use limits are racy on KV

## Proposal

Move mutable counters behind a serialization point.

Good options:

- Durable Object per IP bucket / phrase key: strongest fit for atomic counters on Workers.
- D1 transaction-like single-row updates: acceptable if the expected volume is low and SQL constraints can enforce limits.

For the smallest robust version:

1. Keep phrase records in KV for cheap lookup if desired.
2. Add a `DemoKeyDO` responsible for:
   - per-IP daily mint count
   - per-phrase sender set / uses / revoked flag
3. Route `/demo/request` and `/demo/verify` mutations through that DO.

## If staying on D1

Use conditional updates instead of get-then-put:

- `UPDATE demo_ip_limits SET count = count + 1 WHERE count < ?`
- `INSERT ... ON CONFLICT ...`
- sender rows keyed by `(phrase_hash, sender)` and a count query before adding a new sender

## Docs

Update `services/demo-keys/README.md` to say whether limits are hard or best-effort. Right now the comments describe them as enforcing controls, which overstates the KV implementation.
