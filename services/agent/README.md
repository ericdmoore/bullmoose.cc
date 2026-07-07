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
both runtimes can serve one mailbox and whoever claims first wins. The
AccountDO watchdog responder backstops them both (fires at SLA unless
an invocation went active).

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
