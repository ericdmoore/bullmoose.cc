# s03.A — Foundations: dev plan

> Scope and rationale: [`readme.md`](./readme.md). Shared architecture:
> [`../s03-webAccess/arch.md`](../s03-webAccess/arch.md) §4.2, §7.

---

## T1 — Cross-realm provenance

**Blocks touched:** D1 data plane · `packages/mailstore` write path · every `*/set`
method in `services/jmap/src/methods/`.

**Design.** A **column, not a log** — the per-resource forensic view must be one query,
not a reconstruction. Three fields on every mutable record:

```sql
last_writer_principal   TEXT      -- p_eric / p_allen
last_writer_binding     TEXT NULL -- the agent binding name, when a binding acted
last_writer_invocation  TEXT NULL -- agent_invocations.id, when applicable
```

Populate in the **shared write path** (`Mailstore`), not per-method — a per-method
implementation guarantees drift, and drift here is silent.

Tables: emails, mailboxes, address_books, contact_cards, calendars, calendar_events
(+ `file_nodes` when s03.B lands — its schema includes these from birth).

**Done when**
- Every `*/set` writes provenance; a fake-DB unit test asserts an agent-authored write
  records both binding and invocation.
- "Who touched this card?" is answerable from the record alone, without joining
  `grant_audit`.
- A grep-assertable test proves no write path bypasses the provenance helper.

---

## T2 — Grant tombstones

**Blocks touched:** control plane (`grants`) · `services/provision` revoke path ·
grant resolution in `@bullmoose/auth-core/principal`.

**Design.** Soft-delete plus a lifecycle log:

```sql
ALTER TABLE grants ADD revoked_at INTEGER NULL;   -- tombstone
-- grant_lifecycle: (grant_id, event: created|revoked|expired, at, actor)
```

Grant resolution filters `revoked_at IS NULL` **in addition to** the existing
`expires_at` check — so live behaviour is identical while history survives.

**Done when**
- Revoking removes access immediately (resolution excludes tombstoned rows).
- A point-in-time query — *"which grants covered VendorsBook at time T?"* — returns the
  historical set including since-revoked rows.
- `authorizeAccount` is untouched and the s01 suite stays green (this is a resolution-
  layer change, not a decision-layer one).

---

## Sequencing

```
T1 ─┐
T2 ─┴─▶ unblocks s03.B (Files) and s03.C (webmail floor)
```

Independent of each other; either order. Both must precede any slice that writes data.

## Risk

The one real risk is **T1's breadth** — it edits the write path for every realm. Mitigate
by routing all writes through a single provenance helper and asserting that in a test,
rather than patching call sites. Coverage on the touched modules should meet the s01 bar.
