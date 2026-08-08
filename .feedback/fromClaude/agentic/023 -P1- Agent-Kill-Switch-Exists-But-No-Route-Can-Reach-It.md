# 023 -P1- The agent kill switch exists but no route can reach it

**Subsystem:** agentic · **Severity:** HIGH (safety control, unreachable) · **Fix class:** CHANGE-CODE

## The defect

`agent_bindings.enabled` (`packages/mailstore/sql/data-plane.sql:104`) is the agent kill
switch. Both drain paths honour it:

- `services/agent/src/index.ts:110` — `WHERE inv.status = 'pending' AND b.enabled = 1`
- `services/ingest/src/index.ts:169` — `WHERE account_id = ? AND enabled = 1 AND trigger_on = 'mailbox-delivery'`

Set it to `0` and that agent stops being invoked and stops draining. It is exactly the
control you want at 3am.

**No code path can set it to 0.** `agent_bindings` appears in exactly two SQL statements in
the entire repo:

| | |
|---|---|
| `services/provision/src/index.ts:637` | `INSERT INTO agent_bindings (…, enabled, …)` |
| `services/provision/src/index.ts:674` | `SELECT … FROM agent_bindings` |

No `UPDATE`. No `DELETE`. The value is written `true` at creation
(`services/provision/src/index.ts:191`) and is immutable thereafter.

## Why this is worse than a missing feature

The control is **designed, implemented, and load-bearing on the read side** — two independent
workers already gate on it. Someone built the off switch and never wired the handle. That is
worse than not having one, because the schema and the drain logic both imply an operator
capability that does not exist.

Today the only ways to stop a misbehaving agent are:

1. direct SQL against the D1 shard, or
2. revoke the agent principal's token (`DELETE /auth/tokens/{id}`) — which stops it acting
   but does **not** stop `services/ingest` from continuing to enqueue `pending` invocation
   rows on every delivery, so the queue grows while the agent fails.

Neither is a documented incident procedure. Both require more presence of mind than an
incident affords.

## Why it is P1 now rather than later

`.plans/sVOL-CapSurNoun/007` (`AgentInvocation` on-demand trigger) hands a human a button to
invoke an agent on demand. Shipping an on-demand trigger into a system whose off switch is
unreachable is the wrong order. `sVOL`'s own ledger flags this — see `_index.md` footnote 5,
which sequences the disable route ahead of `007`.

The blast radius also grows with the agent roster: `docs/agents/motivatingExamples.md` sketches
agents that **send to third parties** (`unsubscribe@`, `schedule@`, `intro@`). An agent that
can send is an agent you may urgently need to stop.

## Related

- `.plans/sVOL-CapSurNoun/008` — admin lifecycle (update + delete). This issue is the one
  route in that unit that is not `I1`; see `_index.md` footnote 5.
- `infra/012` — deploy-order/doc drift in the same provision worker.
- `.plans/s04-AgentOS/bureau.md` §11 — invariants about agent authority. An unreachable kill
  switch undercuts the "revoke without the others, mid-incident" test in §5.2.
