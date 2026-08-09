# 024 -P1- Creating an account twice for one address silently orphans the first account's mail

**Subsystem:** common (provision + control plane) · **Severity:** HIGH (silent data loss) · **Fix class:** CHANGE-CODE

## The defect

`POST /accounts` is not idempotent and has no uniqueness guard on the mail address. Run it
twice for the same address and the second call **succeeds**, creating a second account —
then repoints delivery to it.

Two facts combine:

1. **The address is not unique.** `packages/mailstore/sql/control-plane.sql:46` —
   `UNIQUE (account_id, email)` on `identities`. That constrains an address *within* an
   account, not across accounts. Compare `principals.login_email` at `:27`, which **is**
   globally `UNIQUE` — so the schema knows how to express this and does so one table away.

2. **Delivery is last-write-wins.** `services/provision/src/index.ts:387` —
   `INSERT OR REPLACE INTO routes (domain, localpart, kind, target) VALUES (?, ?, 'mailbox', ?)`.
   `INSERT OR REPLACE` is a *delete-then-insert* in SQLite, so the previous row for that
   `(domain, localpart)` is destroyed, not merged.

## What actually happens

- Mail for the address now delivers to account #2.
- Account #1 still exists, still holds every message it ever received, and is no longer
  reachable by any address.
- Nothing errors. Nothing warns. The API returns 201.

The user-visible symptom is **"my mail stopped arriving"** with a healthy-looking system —
the exact shape that is expensive to diagnose, because every component reports success and
the old messages are still sitting there in D1/R2.

## Why it is reachable

`POST /accounts` is gated by `ADMIN_TOKEN` (`services/provision/src/index.ts:47`), so this is
an operator footgun, not a remote vulnerability. That is what keeps it at P1 rather than P0 —
but the triggers are mundane:

- a retried request after a timeout (no idempotency key anywhere in the provision worker)
- re-running a bootstrap or seed script
- a typo corrected by "just run it again"

And per `infra/011`'s sibling finding, provisioning is **one-way**: there is no delete route
for accounts, so cleaning up the duplicate afterwards requires direct SQL.

## What would make the answer clear

Whether the correct behaviour is *reject* or *adopt*:

- **Reject** (409 on an address that already routes somewhere) is safer and matches
  `principals.login_email`'s existing posture.
- **Adopt** (make the call idempotent — return the existing account) is friendlier to retries
  and bootstrap re-runs, which is where this actually bites.

These are not exclusive: reject on a *different* target, adopt on the *same* one.

## Related

- `.plans/sVOL-CapSurNoun/008` — admin lifecycle. Account delete does not exist, which is why
  recovery is manual.
- `infra/012` — deploy order / doc drift in the same worker.
- `services/ingest/src/index.ts` resolves delivery through `routes`, so this is the table that
  decides where mail lands.
