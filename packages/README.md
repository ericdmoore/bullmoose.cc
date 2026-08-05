# Packages

The reusable logic — ten workspace libraries the [services](../services/)
compose into deployed workers. Each row links to that package's own README;
click through for its API and design notes. For *why* it's split this way,
see [`docs/architecture/`](../docs/architecture/README.md); for the wire
standards, the table in the [top-level README](../README.md#the-stack-standard-by-standard).

| package | role |
|---|---|
| [`@bullmoose/jmap-core`](jmap-core/README.md) | JMAP wire types, batched dispatch with back-references, errors, capabilities (RFC 8620) |
| [`@bullmoose/account-do`](account-do/README.md) | the per-account Durable Object: monotonic state, collection-agnostic changelog, push, alarms |
| [`@bullmoose/mailstore`](mailstore/README.md) | D1 schemas + data access, the R2 blob keyspace |
| [`@bullmoose/auth-core`](auth-core/README.md) | tokens, scopes, cross-account grants (`token ∩ grant`), vault envelope crypto |
| [`@bullmoose/contacts-core`](contacts-core/README.md) | vCard ⇄ JSContact translation (RFC 9555) |
| [`@bullmoose/calendar-core`](calendar-core/README.md) | recurrence/timezone engine + iCalendar ⇄ JSCalendar (RFC 8984) |
| [`@bullmoose/mime`](mime/README.md) | RFC 5322 MIME builder (inline images, big-file links) |
| [`@bullmoose/outbound`](outbound/README.md) | SES relay for outbound send |
| [`@bullmoose/cli`](cli/README.md) | the `bullmoose` command — login, sync, send, watch, import, admin |
| [`@bullmoose/popcorn`](popcorn/README.md) | POP3S/SMTPS → JMAP shim (Go) for legacy clients |

Layering, roughly top-down: `jmap-core` (protocol) → `account-do` (state)
→ `mailstore` / `auth-core` (storage + identity) → `contacts-core` /
`calendar-core` / `mime` (codecs) → `outbound` (egress). `cli` and
`popcorn` are the client edges. Nothing here imports a service; services
import these.
