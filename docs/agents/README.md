# Agent mailboxes

An agent mailbox is an ordinary bullmoose account with an **agent binding**
attached: mail delivered to it creates an `AgentInvocation`, and a runtime
(the `bullmoose-agent` cloud worker, or a homelab `bullmoose agent serve`)
claims the invocation and does the work. Both runtimes share one queue —
the `agent_invocations` D1 table — with an optimistic `pending→running`
claim, so they can serve the same mailbox and whoever claims first wins.
Every binding can carry an SLA (`--sla <seconds>`): if nothing claims in
time, an armed watchdog responder tells the sender the agent is down.

**Naming convention:** accounts get ROLE localparts (`editor@`,
`analyst@`); alliterative persona names ("EditorEmily", "Allen the
Analyst") live only in the binding name and signatures. Human-name
localparts stay reserved for actual humans.

## Categories

| | reply (Emily-class) | ledger (Allen-class) | armed responder |
|---|---|---|---|
| example | `editor@bullmoose.cc` | `analyst@bullmoose.cc` | vacation, watchdog |
| state | none — request→reply | accumulates `spend_facts` | none |
| talks to | the (allowlisted) sender | a configured digest target — **never** the sender | the sender, once per window |
| LLM use | persona reply | extract one fact + narrate computed numbers | none (template) |
| trust gate | `allowedSenders` + RFC 3834 | SPF/DKIM pass + receipt prefilter + dedup | RFC 3834 + suppression |
| config | `pipeline: "reply"` (default) | `pipeline: "ledger"` | `responders` table |

### Reply agents (`pipeline: "reply"`)

Persona-driven: the binding's `persona` (L1) rides on top of the immutable
platform preamble (L0, the injection pin). The reply goes back to the
sender as a send or a draft (`replyMode`). Senders steer per message with
**front matter** at the top of the body:

```
---
model: opus4.8        # picks from the binding's alias allowlist; typos get a menu + did-you-mean
prompt: keep it under 100 words   # author steering — joins the USER turn, never the system prompt
---
Hi Sarah, ...
```

Front matter is routing metadata: stripped before the model sees the
draft, and `model:` only resolves against `modelAliases` — never a raw
provider string. Unknown alias → menu reply, zero tokens spent.

### Ledger agents (`pipeline: "ledger"`)

Structured-data extractors with strict division of labor: **the model
extracts one fact and narrates; SQL does every sum.** Pipeline per
message: auth gate (Authentication-Results must show spf/dkim pass) →
vocabulary prefilter (no model cost for obvious non-receipts) → JSON
extraction with schema validation and one retry → dedup insert
(`vendor|amount|date` hash — re-forwarded receipts no-op) → SQL
aggregates (YTD, vendor YTD, same-period-last-year, monthly series) →
digest to the configured target with an email-safe table-bar chart once
`chartMinPoints` (default 10) facts exist.

Non-receipts are never eaten: anything that fails a gate (no auth pass,
no receipt vocabulary, extraction says not-a-receipt, duplicate) is
**forwarded to the digest target intact** with a one-line note ("Could
not discover spending metrics in this message — forwarding it along.").
The agent still never replies to the *sender* — receipts come from
`noreply@` addresses and answering them is backscatter.

**Plus-tag routing:** give a vendor `analyst+eric@bullmoose.cc`; the tag
selects a target from `digestTargets` (`eric` → `eric@bullmoose.cc`).
The tag is a *selector*, never an address — unknown tags fall back to
`digestTo`, so mail content can never steer digests to a stranger.

**Bootstrap:** email a CSV (subject starting `bootstrap`, attachment
`vendor,amount,currency,date[,category]`, header row optional) to seed
history — that's how year-over-year comparisons work from day one.

### Armed responders

The zero-LLM category (see `docs/architecture/agent-integration.md` §8):
a template reply armed at delivery, fired by the AccountDO alarm unless a
cancel condition holds. Vacation mode is `wait=0`; the agent watchdog is
`wait=SLA, cancelIf=invocation-active`. Same RFC 3834 etiquette and
per-sender suppression as everything else.

## Provisioning cookbook

```sh
# 1. account (role localpart)
bullmoose admin account create editor@bullmoose.cc --tenant t_bullmoose --name "EditorEmily"

# 2. binding: reply agent
bullmoose admin agent bind editor@bullmoose.cc --name EditorEmily --sla 300 \
  --reply-mode send --allow "eric@bullmoose.cc,eric@moore.coffee" \
  --config emily-config.json

# 2'. binding: ledger agent
bullmoose admin agent bind analyst@bullmoose.cc --name "Allen the Analyst" --sla 300 \
  --config allen-config.json
```

`--allow` and `--reply-mode` are flags over the `--config` JSON; flags win.

## config_json reference

```jsonc
{
  "pipeline": "reply" | "ledger",     // default "reply"
  "persona": "You are ...",           // L1 (reply)
  "replyMode": "send" | "draft",      // reply; default draft
  "allowedSenders": ["a@b"],          // reply; empty = anyone (don't)
  "defaultModel": "cheap",            // alias used without front matter
  "modelAliases": {                   // the per-message menu
    "cheap":   [{ "provider": "workers-ai", "model": "@cf/meta/llama-3.3-70b-instruct-fp8-fast" }],
    "opus4.8": [{ "provider": "gateway",    "model": "anthropic/claude-opus-4-8" }],
    "mock":    [{ "provider": "mock",       "model": "echo" }]
  },
  "maxTokens": 2048,
  // ledger-only:
  "digestTo": "eric@bullmoose.cc",            // default digest target
  "digestTargets": { "eric": "eric@bullmoose.cc" },  // plus-tag map
  "requireAuth": true,                        // spf/dkim gate on ledger writes
  "categories": ["saas", "pool", "..."],      // extractor vocabulary
  "chartMinPoints": 10
}
```

Aliases with multiple candidates rank by blended models.dev pricing (slim
cache in KV; refresh with `POST /internal/refresh-pricing` on the agent
worker) and fall through on provider errors. `workers-ai` runs on the
free allocation; `gateway` needs an AI Gateway (`GATEWAY_COMPAT_URL` var
+ `GATEWAY_TOKEN` secret) with provider keys stored BYOK.

## Operational notes

- Replies/digests carry `Auto-Submitted` + `X-Auto-Response-Suppress`
  (RFC 3834), `X-Bullmoose-Model`, `X-Bullmoose-Invocation`, and a
  model-attribution footer — auditable from the recipient's inbox.
- Ingest pokes the agent worker after invocation inserts; a `*/5` cron
  sweep retries anything a poke missed and fails stale claims (15 min).
- Inspect work: `SELECT id, status, note, result_json FROM
  agent_invocations ORDER BY created_at DESC` — every drop states why.
- While SES is sandboxed, digest/reply targets must be SES-verified.
