# bullmoose — use-case cookbook

Everything below is **live in production** on the Cloudflare free tier.
Each section is one mailbox, what it does, and the exact commands that
set it up — with the cloud config each relies on.

The platform is five Workers (`jmap`, `ingest`, `submit`, `provision`,
`agent`) + D1 + R2 + KV, plus two homelab pieces on `alpaca`
(`popcorn` and the hermes bridge). Architecture: `architecture/`.
Per-component detail: each `packages/*/README.md` and `services/*/README.md`.
Agent internals: `agents/README.md`.

Prereqs for every recipe:

```sh
# operator CLI, once:
bullmoose admin init \
  --url https://bullmoose-provision.eric-d-moore.workers.dev \
  --token "$ADMIN_TOKEN"
# a domain must be wired first (DNS + SES + routing, idempotent):
bullmoose admin domain add bullmoose.cc --tenant t_bullmoose
```

Legend: **who talks to it**, **what runs it**, **cloud config it uses**.

---

## 1. `eric@bullmoose.cc` — a human mailbox (deliver-and-forward)

A normal inbox that also keeps Gmail as a live backup: every message is
stored in bullmoose **and** forwarded a copy, so trialing the platform
never risks losing mail.

- **talks to**: you, from any JMAP client / the CLI / popcorn
- **runs on**: `jmap` + `ingest` workers (no agent)
- **cloud config**: an Email Routing rule → `ingest`; a KV route whose
  `forwardTo` lists a *verified* Email Routing destination

```sh
# account + login password
bullmoose admin account create eric@bullmoose.cc --tenant t_bullmoose --name "Eric Moore"
bullmoose admin password eric@bullmoose.cc          # prompts

# a device/app password (never the login password) for clients:
bullmoose token create --name laptop --scopes mail   # → bm_… , shown once
```

Deliver-and-forward is a property of the KV route value
(`route:bullmoose.cc:eric`):

```jsonc
{ "kind": "mailbox", "accountId": "…", "tenantId": "t_bullmoose",
  "forwardTo": ["ericdmoore+bullmoose/eric@gmail.com"] }   // Gmail keeps a copy
```

The ingest worker stores the message first, then `message.forward()`s the
copies — a forward failure never bounces mail already delivered. Point a
JMAP client at `jmap.bullmoose.cc` (or `bullmoose login eric@bullmoose.cc`,
which finds it by SRV).

---

## 2. `editor@bullmoose.cc` — EditorEmily (reply agent)

Email her a draft; she returns it marked up inline, a `---`, then a
clean final version. Per-message model choice via front matter.

- **talks to**: allowlisted senders only; she replies to the sender
- **runs on**: `agent` worker, `pipeline: "reply"` (cloud)
- **cloud config**: an `agent_binding` with a persona + model-alias menu;
  ingest creates an `AgentInvocation` per delivery and pokes the worker

```sh
bullmoose admin account create editor@bullmoose.cc --tenant t_bullmoose --name "EditorEmily"

bullmoose admin agent bind editor@bullmoose.cc --name EditorEmily \
  --sla 300 --reply-mode send \
  --allow "eric@bullmoose.cc,eric@moore.coffee,eric.d.moore@gmail.com,hermes.a.moore@gmail.com" \
  --config docs/examples/editor-emily.config.json
```

`--sla 300` arms a watchdog responder (fires "Emily appears offline" if
nothing claims within 5 min). The config (`docs/examples/editor-emily.config.json`)
carries the persona and the alias menu; senders steer per message:

```
---
model: opus4.8                 # picks from the alias menu; typo → menu + did-you-mean
prompt: keep it under 100 words # author steering; joins the user turn, never the system prompt
---
Hi Sarah, ...
```

Free `cheap`/`llama`/`mock` aliases work today (Workers AI). The
`opus4.8`/`sonnet`/`gpt5.5`/`minimax` aliases need the AI Gateway lit up
(see §5).

---

## 3. `analyst@bullmoose.cc` — Allen the Analyst (ledger agent)

Forward receipts; Allen extracts the spend, records it, and forwards a
running digest (YTD, per-vendor, year-over-year, an email-safe chart once
there are ≥10 data points). Non-receipts are forwarded intact with a
note — never dropped, never replied to.

- **talks to**: any vendor (receipts from `noreply@` are fine); digests
  go to a configured target, **never** the sender
- **runs on**: `agent` worker, `pipeline: "ledger"` (cloud)
- **cloud config**: an `agent_binding` (ledger config) + the `spend_facts`
  D1 table (in the shipped schema). The model extracts and narrates; SQL
  does every sum.

```sh
bullmoose admin account create analyst@bullmoose.cc --tenant t_bullmoose --name "Allen the Analyst"

bullmoose admin agent bind analyst@bullmoose.cc --name "Allen the Analyst" \
  --sla 300 --config docs/examples/analyst-allen.config.json
```

Give a vendor the plus-tagged address `analyst+eric@bullmoose.cc`: the tag
**selects** a digest target from `digestTargets` (`eric` → your inbox); it
never builds an address from mail content. Seed history so YoY works from
day one by emailing a CSV (subject starting `bootstrap`, columns
`vendor,amount,currency,date[,category]`).

---

## 4. `hermes@bullmoose.cc` — the hermes agent, over CF infra (local agent)

Email hermes@ and it's like chatting with `hermes.a.moore@gmail.com` —
same agent (tools, memory, skills) — but reached through bullmoose/CF
instead of Gmail. This one is a **homelab** agent: it runs on `alpaca`,
not in the cloud.

- **talks to**: allowlisted humans; replies to the sender
- **runs on**: `bullmoose watch` + the hermes CLI + `popcorn` SMTP, all on
  alpaca — glued by `docs/examples/hermes-bridge.sh`
- **cloud config**: **none** — no agent binding. It leans on the plain
  `jmap`/`ingest`/`submit` workers plus popcorn's kettle-corn SMTP.

Flow: JMAP push (`watch`) → full body (`read`) → the real hermes
(`hermes -z --continue <per-sender-session>`) → reply out through
popcorn's SMTP submission (`:9587` → JMAP → SES). A 45-second watchdog
sends a "hermes may be down" note if the agent doesn't answer in time.

```sh
# account + credentials
bullmoose admin account create hermes@bullmoose.cc --tenant t_bullmoose --name "Hermes"
bullmoose admin password hermes@bullmoose.cc
bullmoose admin token create hermes@bullmoose.cc --name hermes-bridge --scopes mail

# on alpaca (has the hermes CLI + popcorn):
#   - bullmoose CLI installed under hermes' node, logged in as hermes@
#   - popcorn kettle-corn SMTP running (see packages/popcorn)
#   - bridge script + a launchd agent keep it alive:
launchctl load ~/Library/LaunchAgents/cc.bullmoose.hermes-bridge.plist
```

The bridge (`docs/examples/hermes-bridge.sh`) holds the allowlist, the
per-sender session naming, RFC 3834 loop guards, and the watchdog timer.
Because it's homelab, an alpaca outage takes hermes@ offline — the cloud
agents (§2, §3) are unaffected.

---

## 5. Cloud config lit up along the way

- **Domain wiring** (`admin domain add`): Email Routing catch-all →
  ingest, SES identity + DKIM + MAIL FROM (`bounce.bullmoose.cc`) + DMARC,
  and the `_jmap._tcp` SRV record for `bullmoose login` autodiscovery.
- **AI Gateway** (for the paid-model aliases): create a gateway named
  `bullmoose`, store provider keys BYOK, then set `GATEWAY_COMPAT_URL`
  (var) + `GATEWAY_TOKEN` (secret) on the `agent` worker. Until then only
  the free Workers-AI aliases resolve.
- **Model pricing**: alias candidates rank by blended models.dev cost
  (KV cache; `POST /internal/refresh-pricing` on the agent worker rebuilds
  it).
- **Secrets**: `INTERNAL_TOKEN` (shared, worker→worker), `SHARE_SIGNING_KEY`
  (jmap), `ADMIN_TOKEN` (provision), SES key pairs (submit runtime /
  provision deploy). See `DEPLOY.md`.

## Client protocols

| protocol | endpoint | auth | notes |
|---|---|---|---|
| JMAP | `jmap.bullmoose.cc` | Bearer or Basic (token) | modern clients, the CLI |
| POP3S | `alpaca…ts.net:9995` (popcorn) | app-password | legacy download clients |
| SMTP submission | `alpaca…ts.net:9587` (popcorn) | app-password | legacy send; kettle-corn |

All three take a `bm_…` app-password from `bullmoose token create` —
never the login password.
