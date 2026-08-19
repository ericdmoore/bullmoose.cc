# Cloudflare AI surface — what we adopt, and why

Status: **design / decision.** Evaluates four Cloudflare products against
the agent runtime we already have (`services/agent`) and the composition
model in [`capability-roadmap.md`](capability-roadmap.md) §1. Companion
deep-dives: [`agents-sdk.md`](agents-sdk.md) and
[`ai-search-rag.md`](ai-search-rag.md).

---

## 1. Two principles that decide everything below

**Provider trust is a boundary you cross once.** Choosing Cloudflare to
run the platform *is* the trust decision. Adopting more of Cloudflare's
product surface — Gateway, Vectorize, AutoRAG — moves data no further than
the Workers/D1/R2 it already lives on. So these are **not** evaluated as
privacy trade-offs; they're evaluated on *fit, coherence, and cost*. We do
not add metadata-only-logging ceremony to placate a boundary we already
crossed.

**Multi-tenant isolation is the binding constraint.** The one thing a new
AI feature can genuinely break is the boundary between accounts and
tenants. The JMAP core already enforces it: effective rights =
`token ∩ grant`, grants narrowable to a `collection`
([`auth-core/src/principal.ts:13`](../../packages/auth-core/src/principal.ts),
`:130`), and R2 keys namespaced `mail/${tenantId}/${accountId}/…`
([`mailstore/src/index.ts:257`](../../packages/mailstore/src/index.ts)).
**Every AI feature must enforce the same boundary — no feature is allowed
to become the one path that reads across it.** This is the whole reason
`ai-search-rag.md` is mostly about isolation, not about embeddings.

## 2. The composition test

`capability-roadmap.md` §1 holds that every workflow is one point in a
four-axis space (data · trigger · runtime · output), and *"if a proposed
feature can't be expressed as a composition of axis-values, that's the
signal it would make the architecture incoherent."* Applying it:

| product | expressible as… | verdict |
|---|---|---|
| **AI Gateway** | the `model.baseURL` axis-value agents already carry (`agent-integration.md` §2) | **adopt now** — already coded, just unconfigured |
| **AI Search / AutoRAG** | a new **data** value (*semantic archive*) + a `tools[]` MCP server | **opt-in, roadmap** — isolation-first |
| **Agents SDK patterns** | a sharper **trigger** value (per-agent alarms) + a new interactive surface | **cherry-pick** |
| **Agents SDK (framework)** | *not expressible* — it wants to own the DO and replace the axes | **reject wholesale** |

The reject falls out of the test itself: the SDK isn't a value on an axis,
it's a *different coordinate system*. Details in `agents-sdk.md`.

## 3. AI Gateway — adopt now (no separate doc needed)

This isn't a build; it's a config flip. The `gateway` provider is already
implemented ([`models.ts:81‑98`](../../services/agent/src/models.ts)), the
env vars are already declared (`models.ts:15‑17`), and `bootstrap.mjs`
already lists `GATEWAY_TOKEN` as an optional external secret. What it buys
us maps cleanly onto code we hand-rolled:

- **Caching** — the ledger extractor and reply drafter send near-identical
  prompts across similar mail; a cache hit is zero model latency and zero
  wall-clock, which is exactly the 10ms-CPU / $0-month discipline of
  [`capacity-and-scaling.md`](capacity-and-scaling.md).
- **Provider-level retry/fallback** — *complements* our app-level
  `callWithFallback` (`models.ts:102`): the gateway retries *within* a
  provider before our loop ever sees an error and swaps aliases.
- **Real spend/latency logs** — we approximate pricing from models.dev
  (`rankByPrice`, `models.ts:125`); the gateway reports *actual* per-request
  cost, which can validate or replace that cache and feed the analytics MCP.
- **Rate limiting** — a guardrail on a runaway SLA loop burning quota.

**Turn-on steps** (fold into `docs/DEPLOY.md` §6 hardening):

1. Create a gateway named `bullmoose` (dashboard or API).
2. Set on the agent worker: var `GATEWAY_COMPAT_URL =
   https://gateway.ai.cloudflare.com/v1/<acct>/bullmoose/compat`, secret
   `GATEWAY_TOKEN` (gateway auth). Promote `GATEWAY_COMPAT_URL` into
   `bootstrap.mjs`'s external-secret matrix so it installs in the same pass.
3. Add `{ provider: "gateway", model: "<provider>/<model>" }` candidates to
   an agent's `modelAliases`; ranked fallback picks them up for free.
4. Optional: route the `workers-ai` fast path through the gateway too by
   passing `{ gateway: { id: "bullmoose" } }` to `env.AI.run(...)` — one
   observability pane over *both* providers.

Provider keys: the gateway's BYOK store owns **LLM-provider** keys (it needs
them at call time); the envelope vault (`vault.ts`) keeps owning everything
agents use *as tools* (OAuth refresh tokens, third-party API keys). Don't
split-brain a single key across both.

> Two different things are called BYOK, and s26 T4 added the second. The
> gateway's own is *"provider keys stored in the Cloudflare gateway"* — the
> PLATFORM's account, one set of keys for everyone. Ours is per TENANT: their
> key, sealed in the Bureau, carrying their guardrails. They compose — a
> `gateway` candidate with a `credRef` authenticates with the tenant's gateway
> credential instead of the platform's `GATEWAY_TOKEN` — but they are not the
> same feature and the distinction is worth keeping in the vocabulary.

## 4. Hosts, models, and money — the routing model as built (2026-08-18)

The vocabulary settled during s26 capture (`.plans/s26-agent-config/devPlan.md` is the full
treatment; this is the standing summary):

- **HOST = where models live**: `openrouter | workers-ai | gateway | @local`. Models are
  subordinate to the host — a candidate is the pair `{provider, model}` (`ModelCandidate`,
  services/agent/src/models.ts; "provider" in code means host). `openrouter` is a dedicated
  provider with its OWN secret (`OPENROUTER_API_TOKEN`) rather than a repoint of the dormant
  gateway — it names what it is, and a future gateway user cannot surprise it. OpenRouter picks
  HOSTING for the model you chose; it never picks the model — model choice is ours.
- **CLAIMANT = the runtime that takes work off the queue**: the cloud worker, or the CLI
  runner. Orthogonal to host, joined by REACHABILITY: the cloud claimant reaches
  openrouter/workers-ai/gateway but never @local; the CLI claimant runs beside @local and can
  reach every host. @local is a peer dependency — the product is complete without it
  (onboarding ladder in s26).
- **An alias is a portfolio across hosts** — the fallback chain, ranked free-first
  (`rankByPrice`: Workers AI prices 0 by policy; unpriceable candidates sort last).
- **Money**: a binding's cap lives at `config_json.$.budgets.spendPerMonth` (µUSD). The claim
  gate stops the PAID drain at the cap; pending invocations wait as the durable cursor;
  `proposeBudgetOverruns` raises a bounded, month-scoped ask in approvals. A free claimant
  ignores the cap — out-of-budget backlogs drain at $0 when a homelab runtime is up.
- **WHOSE KEY PAYS is a per-binding fact** (s26 T4, BYOK). A binding's config may name a
  Bureau-sealed credential — `providerCredentials: {openrouter: "<handle>"}`, or `credRef` on
  a single candidate — and then `callModel` proxies that host's request through the Bureau,
  which injects the tenant's key as a header and returns only the response. Resolution order:
  candidate `credRef` → binding `providerCredentials[host]` → the platform's env key. The last
  step is reached only when **nobody named a credential**; a named-but-unresolvable one FAILS
  the call rather than borrowing the platform's key. The payoff is that a tenant's
  provider-side guardrails (OpenRouter's privacy redaction, route allowlists, their own caps)
  apply to their agents automatically — we implement none of it; the request is theirs.
  Operator flow in `docs/DEPLOY.md`; the authorization argument in
  `services/bureau/src/byok.ts`.
- **Cost is frozen at completion** (s07 T5): provider/model/tokens/µUSD stamped on the
  invocation, surfaced on every approval row. **NULL means "not recorded", 0 means "known
  free" — they never collapse.** The models.dev pricing cache must be fresh for dollars to
  book: `POST /internal/refresh-pricing` on the agent worker (a stale cache freezes NULL
  forever on rows completed under it).

## 5. Sequencing

1. **AI Gateway** — near-term, alongside the next agent-worker touch.
2. **Cherry-picked scheduling** (`agents-sdk.md` §3) — when per-agent
   deadlines/backoff outgrow the `*/5` sweep.
3. **AI Search RAG** (`ai-search-rag.md`) — a new opt-in Phase 6; do the
   isolation design first, the embeddings second.

The `AIChatAgent` surface (`agents-sdk.md` §3) is deferred until there's a
human-facing chat modality to justify it.
