# s26 — agent config: the dossier, the settings, and the frontier

> Eric, 2026-08-18, the morning the extractor flipped: what are an agent's config/params, where
> do they live in the UI, and who tunes the models? Three threads: **the dossier vs settings
> split**, **the work-ledger/cursor (and the missing backfill verb)**, and **Allen's
> price-quality frontier program**.

## The split, and the discriminator

Eric's realization, sharpened into a rule: **"just because the data is settable doesn't make it
a Settings."** The test for where a value lives:

> **If this agent were deleted, would the value still mean anything?**
> Yes → the **Settings realm** (Agents domain): platform policy that outlives any one agent.
> No → the **agent's dossier** (`AgentItemDetails`, the Agents realm's detail panel).

Settable is a VERB on the dossier, not a location — swapping Emily's model is an action on
Emily's page, the way renaming a contact happens on the card. Settings keeps the boring bits:

| Settings realm (Agents domain) — policy | The dossier — one agent's page |
|---|---|
| default model menu for NEW agents | this agent's model menu + swap verb |
| default budget for NEW agents | this agent's budget, spent vs remaining |
| BYOK provider credentials (per tenant, via the Bureau) | which credential this binding uses |
| correction/training toggles (when learning loops land) | this agent's correction stats |
| — | everything below |

## Found while capturing: the supervisory-grant annotate gap

Eric hit "insufficient scope — needs annotate" in the UI. Diagnosed live (2026-08-18): his own
token is the `mail` bundle and passes the annotate gate (probe-verified against production);
the refusal comes on **grant-reached agent accounts**, where effective scopes = token ∩ grant
and `SUPERVISORY_GRANT_SCOPES = ["read", "draft"]` — no `annotate`. Marking an agent's mail
read, flagging, or any keyword flip in a supervised mailbox is correctly refused under today's
grant.

*Recommendation (Eric to confirm — it widens an authz default):* add `annotate` to the
supervisory grant — keyword flips are reversible, non-egress, and "triage my agent's mailbox"
is squarely what supervision is for. Note the migration wrinkle: grants freeze scopes at mint,
so existing supervisors need revoke + re-grant (or a one-time UPDATE); `superviseBinding`'s
idempotent adopt will NOT widen an existing row. Until then the UI should grey these actions
from effective scopes (the approvals rowAuthority pattern, applied to mail triage).

## The dossier — what an agent's page carries

All of this EXISTS in the schema today; s26 T1 is a read surface, not new state:

- **Identity**: binding name, account/address, persona (L1), pipeline (`reply | ledger |
  bouncer | remind | extract`), trigger (`mailbox-delivery`; `mention` later).
- **State**: enabled/disabled (the kill switch, two explicit verbs), SLA, the learned
  escalation window, privacy pins.
- **Bounds**: `allowedSenders`, the governing recipients book (s10 T1), supervisory grant(s) —
  who answers its questions, grants held/target (s03.A).
- **Economics**: budget cap (`$.budgets.spendPerMonth`), month spend vs remaining, overage
  history (s11 T9), per-invocation cost history (s07 T5 — flowing since the µUSD work).
- **Work ledger / cursor**: pending / running / done / failed counts, oldest-pending age (the
  cursor IS the queue — s11), failure rate, last N invocations with cost.
- **History**: the binding lifecycle chain (`GET /agent-bindings/{id}/lifecycle`), decline
  reasons received (decline-taxonomy), approved-after-edit rate.

**Config verbs on the dossier** (the settable subset): enable/disable · swap model
(re-provision-in-place, the sanctioned path) · set budget · approve/decline its overage ask ·
**backfill** (below) · manage its book (existing chokepoint flows).

## The cursor's missing half: BACKFILL

The queue-as-cursor answers FORWARD progress (pending invocations wait, oldest-first, budget-
gated, overage-asks in approvals — all shipped). But an agent enabled TODAY has processed
nothing HISTORICAL: pointX = enablement time while data runs back to PointP. The extractor will
never touch the archive on its own.

**The behaviour Eric wants (2026-08-18), in three rules:**

1. **The historical floor is `created_at`.** A new agent is bounded to current + future work by
   default — it never reprocesses old news. Moving the floor BACKWARD is an explicit act that
   needs approval (a tier-1 proposal: "crm@ asks to read mail back to 2023 — allow?"). Whether
   backfill fits is per-agent character: crm@ perusing the whole archive makes sense; Allen
   backfilling three-year-old spending does not ("I either didn't care, or I dealt with it") —
   the floor default encodes that, and the approval is where the exception is granted.
2. **Surplus burns the backlog.** Near the end of a budget cycle, when the projected surplus is
   safely estimable (spend rate vs days remaining), the agent works its backlog with the
   surplus — newest-first, NULL-due (so a homelab runtime may eat it free), stopping at the
   floor. v1: the cron computes surplus and mints backfill invocations inside it; the dossier
   ledger shows "backfilling: surplus $0.83 of $2.00, 41 of 210 messages". No new approval —
   the human already approved the budget; this spends the APPROVED money instead of wasting it.
3a. **Scouts, then troops (Eric).** Backfill need not pay frontier prices for every old
   message: run a CASCADE. Pass 1 — a cheap scout (an `@local` model, or the free-tier cloud
   model) sweeps the backlog and marks `data-of-potential-interest`; pass 2 — the
   efficient-frontier model circles back to ONLY the flagged items. Surgical backfill: the
   paid spend lands where a scout already found signal. This is the bouncerClassify tiering
   (regex → cheap classifier → expensive judgment) applied to history, and it composes with
   the claim system for free: scout invocations are NULL-due free-runtime-preferred work (the
   homelab eats them at $0), and each flag mints a paid invocation carrying the scout's note
   as evidence. The scout's verdict is itself assignment data for the frontier program (T5) —
   scouts that flag well are measurable.

3. **Manual backfill stays available**: `POST /agent-bindings/{id}/backfill {sinceDays,
   budgetMicros}` — its own envelope, never the monthly cap, idempotent per (binding, email);
   crossing the floor triggers the rule-1 approval.

## Provider credentials: BYOK via the Bureau

Today the OpenRouter key is one platform worker-secret. Eric's guardrail discovery (his OR
privacy-redaction feature produced the `[ADDRESS]` artifact) makes the multi-tenant shape
obvious: **each tenant may seal their OWN provider key in the Bureau** (s04 — the credential
vault the agent worker can only reach by hop), and their provider-side guardrails ride their
key. `callModel` resolves: binding credential ref → Bureau unseal → else platform secret.
Platform key stays the default; BYOK is opt-in per tenant. (T4.)

## Model routing: the frontier program (Allen's job)

**Fact, confirmed**: OpenRouter picks HOSTS for the model you chose (cheapest/available
provider behind the slug, within constraints) — it does not pick models. Model choice is ours,
and today it is a static alias menu ranked by price.

**The Host → Model hierarchy, with Eric's correction adopted:** Host is choice 1 —
`[openrouter | workers-ai | gateway | @local]` — and models are subordinate to the host
(`ModelCandidate {provider, model}` is that pair; "provider" in code = host). The first cut of
this doc called @local "a claimant, not a provider" — **wrong factoring**. Eric's model is
cleaner and is now the house model: **HOST = where models live** (@local is a host: the machine
whose LiteLLM/Ollama serve a model list) and **CLAIMANT = the runtime that takes work off the
queue** (the cloud worker, or the CLI runner). They are orthogonal axes joined by
REACHABILITY: the cloud claimant can reach openrouter/workers-ai/gateway but not @local; the
CLI claimant runs beside @local and can reach every host (it may carry an OR key too). An
ALIAS is a portfolio across hosts (the fallback chain), and which candidates a given claimant
may attempt is the reachability matrix — which is also exactly why scout/troops works: scouts
= CLI claimant × @local host, troops = cloud claimant × frontier host. **Discovery per host** (the dossier's model picker and the CLI both need it): OpenRouter
`GET /api/v1/models`; Workers AI the CF catalog API; the gateway depends on its BYOK providers;
`@local` speaks OpenAI-compat `/v1/models` — probe in order **LiteLLM (:4000) → Ollama
(:11434/v1) → vLLM (:8000) → llama.cpp (:8080)**, LiteLLM first because on this homelab it IS
the hub (nothing talks to Ollama directly; `hermesModels` is the prior art). CLI verb:
`bullmoose models [--host]`.

**Eric's program**: Allen A/B tests models to discover the platform's price-quality frontier,
and builds the dataset — human + agent outcomes — that could train our own task→model
classifier. The judgment data ALREADY accrues; what is missing is assignment and the join:

- **Outcome signals (existing)**: frozen per-invocation cost + tokens + model (s07 T5); decline
  reasons (wrongContent/wrongAction — decline-taxonomy's negative signal, with the no-fault
  kinds correctly excluded); approved-after-edit diffs (quality miss that still shipped);
  annotation dismissals (extractor false positives); yanks; needsInfo rounds.
**What to A/B (Eric's question, answered from the call sites that exist):**

| Arena | The outcome label (already recorded) |
|---|---|
| **Extraction** (extract.ts) | annotation dismissals vs resolutions; human filings the model missed |
| **Reply drafting** (Emily) | approved-clean vs approved-after-EDIT (the diff!) vs declined-wrongContent |
| **Mid-band classify** (bouncerClassify) | rescues / confirms — actual ham/spam ground truth |
| **Ledger extraction** (Allen) | digest corrections |
| **Contact merge** (crm@, when it lands) | merge proposals are approvals — every decision is a label |
| **needsInfo answers** | rounds-per-question (chronic rounds = poor answers) |
| **Finder retrieval** (later) | did the human open a result |

And not only MODELS: prompt variants (EXTRACT_SYSTEM versions), cue-filter thresholds and
confidence floors are arms in the same harness — (model × prompt × pipeline), one assignment
mechanism.

- **T5a — assignment**: per-invocation variation over the alias menu (deterministic split by
  invocation id; the menu already supports candidates), recorded on the row it already stamps.
- **T5b — the join + report**: a periodic Allen digest — cost vs correction-rate per model per
  pipeline — the price-quality frontier, delivered as mail (Allen's native medium).
- **T5c — the learned router (later)**: when the frontier is stable, a per-task model policy
  replaces the static menu. Enters as a ranked menu rewrite, not a new mechanism — the
  fallback chain and budget gates hold unchanged.

## @local is a PEER dependency — the onboarding ladder

Is ollama a dependency? **No — a peer.** The product is COMPLETE without any local host: the
cloud path (free-tier Workers AI + BYOK OpenRouter) is the zero-install default, and @local is
an enhancement (privacy pins, free backlog/scout work, out-of-budget drainage). Nothing may
ever require it, and nothing installs it without consent. The ladder, one strategy that
generalizes from the West-Wing-loving suburban mom (techie among her friends, first time in a
terminal) to the terminal-native:

- **Rung 0 — never opens a terminal.** The web app is the whole product; the staff works from
  the cloud. She is not a degraded user; she is the DEFAULT user.
- **Rung 1 — one guided command.** `bullmoose local setup`: the CLI PROBES first (LiteLLM
  :4000, Ollama :11434/v1, vLLM :8000, llama.cpp :8080 — the /v1/models sweep); if a host is
  already running it connects and stops. If none, it OFFERS the managed install — "I can
  install Ollama (one program, ~a coffee's worth of download) and pull a starter model —
  proceed?" — and does it for her on yes (brew/winget under the hood). Do it WITH her, never
  hand her a page of commands.
- **Rung 2 — already runs something.** `bullmoose local connect --host http://…` points at any
  OpenAI-compat endpoint; discovery does the rest. No opinions about her stack.

Detect → connect → offer → install-with-consent, in that order. Ollama is the managed-install
choice only because it is the simplest single binary — not a blessed runtime; the probe order
treats every OpenAI-compat host as equal once running.

## Tasks

T1 — **the dossier read surface**: Agents realm detail panel (quad-panel pattern, T0 primitives)
     over data that exists; config VERBS wired to the existing endpoints.
     ✅ **LANDED 2026-08-18 (#186)** — read-only dossier quad; the session-reachable write door
     was honestly punted to T2.
T2 — **Settings/Agents domain**: the policy page (defaults for new agents; the discriminator
     rule documented in-page).
T3 — **backfill**: the verb + envelope + ledger progress.
     ✅ **LANDED 2026-08-18** — v1 routes + floor-request approval door (#184); v2 surplus-burns-
     the-backlog + scouts-then-troops (#187). The true per-request budget envelope (claim-gate
     term) deferred by #184 is in build.
T4 — **BYOK via Bureau**: per-tenant provider credentials; guardrails ride the key.
T5 — **the frontier**: a/b assignment → outcome join → Allen's digest → (later) learned router.
     ✅ **T5a assignment LANDED 2026-08-18** — `chooseArm` (deterministic FNV-1a per invocation)
     in `models.ts`, arm recorded in result_json; extract is the first arena (explore arm live on
     eric@'s extractor). ✅ **Digest LANDED (#183)**. Outcome join + learned router still open.
T6 — **CLI parity**: `bullmoose agent …` learns the extract pipeline (Eric's @local
     out-of-budget path), the dossier verbs (`show`, `budget`, `model`, `backfill`), and the
     @local ladder (`local setup` / `local connect`, `models [--host]`).
     ✅ **LANDED 2026-08-18 (#192)** — extract in the runner (byte-drift-guarded prompt), `models`,
     `local connect`/`local setup` (install-with-consent, rung-0 default); live-smoked on alpaca.

Sequencing: T1 first (it is the reading surface every other task's knobs land on); T3 and T6
are independent; T4 waits for a second tenant to want it; T5a can start accruing assignments
any time — data compounds, so earlier is better.

## Decisions
1. **Dossier vs Settings split** — RESOLVED (Eric + the discriminator above). Critique window
   stays open until T1 renders it.
2. **Backfill envelope default** — *recommendation: 90 days, $1, newest-first.*
3. **Assignment ratio for T5a** — *recommendation: 10% exploration over the menu's non-primary
   candidates; 0% for tier-3-producing pipelines.*
4. **Where Allen's frontier digest lands** — *recommendation: mail (his medium), monthly.*

## References
- `services/provision/src/index.ts` — bindings CRUD, enable/disable, lifecycle, extractor
- `packages/scheduling` — budgets, claim gate, the queue-as-cursor
- `services/agent/src/{models,extract}.ts` — the menu, callWithFallback, the pipelines
- `.plans/s04-*/` Bureau — the credential vault T4 rides
- `.plans/s24-collection-column/devPlan.md` — the IA the Agents realm renders under
