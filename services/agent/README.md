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
  past-due invocation sits pending *silently*".

The same cron logs two aggregates when they have something to say: a
queue held behind a disabled binding, and pinned work pending with no
free runtime seen in 15 min ("your homelab is down", inferred from
recent claims rather than a heartbeat).

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
