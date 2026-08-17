# bullmoose-agent

The cloud runtime for agent-backed mailboxes (EditorEmily on
`editor@`, Allen the Analyst on `analyst@`). Full category docs:
**`docs/agents/README.md`** — this file is the worker-level view.

## Queue mechanics

The `agent_invocations` D1 table IS the queue: ingest inserts `pending`
rows, then pokes `POST /drain` via service binding (fast path, ~1s to
claim). A `*/5` cron sweep retries anything a poke missed and fails
stale 15-min claims. Claims are optimistic `pending→running` UPDATEs —
the homelab runner (`bullmoose agent serve`) uses the same guard, so
both runtimes can serve one mailbox and whoever claims first wins —
inside the s11 eligibility gate (`@bullmoose/scheduling`), which makes
this drain a PAID claimant that sits on far-from-due work.

Two watchdog triggers backstop that optimism (agent-integration.md §8):

- **SLA silence** — the AccountDO responder fires at SLA unless an
  invocation went active. Untouched by s11.
- **overdue** (s11 T3, `escalateOverdue`) — `due_at` passed and the row
  is still `pending` → the cron claims it OUTSIDE the policy gate, so
  budget exhaustion cannot strand work past its deadline. Two terms
  survive that bypass: the privacy **pin** (pinned work sits, however
  overdue — privacy beats liveness) and **fit**. What it may not claim
  it MARKS instead (`alert_kind` = `overdue-pinned` | `overdue-unfit`,
  raised once, visible in `bullmoose agent invocations` and
  `AgentInvocation/query {alerted: true}`) — the invariant is "no
  past-due invocation sits pending _silently_".

The same cron logs two aggregates when they have something to say: a
queue held behind a disabled binding, and pinned work pending with no
free runtime seen in 15 min ("your homelab is down", inferred from
recent claims rather than a heartbeat).

**Budget stranding is a question, not a marker** (s11 T9,
`proposeBudgetOverruns`, last on the same cron). A binding whose
`budgets.spendPerMonth` is spent holds off every paid claimant, so its
work waits for the month to roll when no free runtime is live — and the
overdue backstop cannot help work with no deadline. The rule the two
mechanisms split on: **marker when nothing can be decided; proposal when
something can.** Privacy admits no human override, so T3 marks; _"spend
anyway?"_ has a real answer, so this ASKS — one `budget-overrun`
proposal per binding per period (never one per invocation), carrying the
waiting count, the spend against the ceiling and the cost to clear it
from the s07 T5 history (`null` when there is no paid history — reported
unknown, never guessed). The T3 marker is reused as the idempotence key
(`alert_kind` = `budget-stranded:<YYYY-MM>` on one representative row,
raised by a guarded UPDATE), so the sweep asks once and not every tick.
Approving lands a BOUNDED, period-scoped overage in
`agent_budget_overages` that the claim gate adds to the cap; declining
leaves the work queued and records nothing against the agent.

## Pipelines (per binding `config_json.pipeline`)

- **reply** (default) — persona reply to allowlisted senders. Front
  matter picks a model alias (`model:`) and adds author steering
  (`prompt:` — joins the user turn under an attributed label, never the
  system prompt). Unknown alias → menu + did-you-mean, zero tokens.
- **ledger** (`ledger.ts`) — receipts → `spend_facts` → aggregate
  digest to a configured target (plus-tag selected). Model extracts and
  narrates; SQL does all arithmetic. Non-receipts forward intact with a
  note — never dropped, never replied to.

## Model routing (`models.ts`)

Alias → candidate list, ranked by blended models.dev pricing (slim
cache in KV; rebuild with `POST /internal/refresh-pricing`), fall-through
on provider errors. Providers: `workers-ai` (env.AI, free allocation),
`gateway` (AI Gateway OpenAI-compat endpoint, BYOK — needs
`GATEWAY_COMPAT_URL` var + `GATEWAY_TOKEN` secret), `mock`.

All outbound mail carries RFC 3834 auto-generation headers plus
`X-Bullmoose-Model` / `X-Bullmoose-Invocation` for inbox-level audit.
