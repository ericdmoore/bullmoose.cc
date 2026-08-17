# ✅ 023 -P1- The agent kill switch exists but no route can reach it

**Subsystem:** agentic · **Severity:** HIGH (safety control, unreachable) · **Fix class:** CHANGE-CODE

> **FIXED.** Shipped inside `.plans/sVOL-CapSurNoun/✅008` — the same two files, so
> splitting it would have put two agents in one file.
>
> - `POST /agent-bindings/{id}/disable` · `/enable`, admin-token gated like every other
>   provision route. Two verbs, not `PATCH {enabled}`, per the fix.
> - `bullmoose admin agent disable|enable <binding-id> [--account <email>]`, plus
>   `agent unbind` which **409s while invocations are queued** rather than stranding them
>   behind the drain's `JOIN agent_bindings`.
> - The drain logs a held-backlog count on every wake-up, so "disabled" and "broken" stop
>   looking identical from outside.
> - **The queue question, decided: HELD, not cancelled.** Disable is a pause with a matching
>   enable, those rows are the evidence of what the agent was about to do, and they are inert
>   while disabled. The cost — an invisible backlog — is paid down by *reporting* rather than
>   by deleting: both verbs return `pendingInvocations`, the CLI prints it, the drain logs it,
>   and `docs/DEPLOY.md` carries the SQL to clear them if they go stale.
>   The refinement review forced: **a pause holds, a terminal verb terminates.** `disable`
>   holds the queue, but `DELETE /accounts` *cancels* it — the drain skips tombstoned
>   accounts, so rows left `pending` there could never reach a terminal status, which would
>   have blocked `agent unbind` forever and inflated the held-backlog log with work nobody
>   could act on.
> - Deviation from the fix note: the route takes a **bare binding id**, not
>   `/accounts/{accountId}/agent-bindings/{id}`. Reasoning in `✅008` § *judgement call 5*.
> - Proved by `services/provision/src/adminLifecycle.test.ts`: create a binding, disable it,
>   assert **ingest's own enqueue query** returns zero rows — plus a source-level assertion
>   that both drain paths still carry the `enabled = 1` gate the switch rides on.

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
