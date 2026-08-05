# @bullmoose/account-do

`AccountDO` — the single-writer Durable Object behind each account
(SQLite-backed, free-plan eligible). Everything state-visible funnels
through it so JMAP `/changes` and push stay consistent.

Owns, per account:

- the monotonic **state sequence** (JMAP state strings)
- a bounded **changelog** (window 4096) powering `*/changes` methods;
  overflow → `cannotCalculateChanges` → clients resync
- **hibernatable WebSocket** connections for StateChange push (RFC 8887)
- **armed responders** (agent-integration.md §8): `POST /arm` stores a
  `PendingResponse`, `alarm()` fires it unless canceled — vacation is
  `wait=0`, the agent watchdog is `wait=SLA, cancelIf=invocation-active`.
  Fire-time re-checks: enabled, date range, invocation activity,
  per-sender suppression (RFC 3834), then relays MIME via the SUBMIT
  service binding.

Internal HTTP API (worker → DO only): `GET /state`, `POST /commit`,
`GET /changes`, `GET /ws`, `POST /arm`.

Helpers for other workers: `accountStub()`, `commitChanges()`,
`armResponder()`. The class is *declared* by `services/jmap`
(migrations live there); ingest/agent bind it cross-script via
`script_name`.
