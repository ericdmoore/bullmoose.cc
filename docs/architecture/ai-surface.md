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

## 4. Sequencing

1. **AI Gateway** — near-term, alongside the next agent-worker touch.
2. **Cherry-picked scheduling** (`agents-sdk.md` §3) — when per-agent
   deadlines/backoff outgrow the `*/5` sweep.
3. **AI Search RAG** (`ai-search-rag.md`) — a new opt-in Phase 6; do the
   isolation design first, the embeddings second.

The `AIChatAgent` surface (`agents-sdk.md` §3) is deferred until there's a
human-facing chat modality to justify it.
