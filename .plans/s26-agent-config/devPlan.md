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

**T3 adds the backfill verb**: `POST /agent-bindings/{id}/backfill {sinceDays, budgetMicros}` —
mints pending invocations for historical mail (newest-first, so value lands early), bounded by
its OWN budget envelope (never the monthly cap), NULL-due (so the paid drain treats it as
sit-free work and a homelab runtime may eat it for free), idempotent per (binding, email). The
dossier shows backfill progress as part of the ledger.

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

**Eric's program**: Allen A/B tests models to discover the platform's price-quality frontier,
and builds the dataset — human + agent outcomes — that could train our own task→model
classifier. The judgment data ALREADY accrues; what is missing is assignment and the join:

- **Outcome signals (existing)**: frozen per-invocation cost + tokens + model (s07 T5); decline
  reasons (wrongContent/wrongAction — decline-taxonomy's negative signal, with the no-fault
  kinds correctly excluded); approved-after-edit diffs (quality miss that still shipped);
  annotation dismissals (extractor false positives); yanks; needsInfo rounds.
- **T5a — assignment**: per-invocation model variation over the alias menu (deterministic split
  by invocation id; the menu already supports candidates), recorded on the row it already
  stamps.
- **T5b — the join + report**: a periodic Allen digest — cost vs correction-rate per model per
  pipeline — the price-quality frontier, delivered as mail (Allen's native medium).
- **T5c — the learned router (later)**: when the frontier is stable, a per-task model policy
  replaces the static menu. Enters as a ranked menu rewrite, not a new mechanism — the
  fallback chain and budget gates hold unchanged.

## Tasks

T1 — **the dossier read surface**: Agents realm detail panel (quad-panel pattern, T0 primitives)
     over data that exists; config VERBS wired to the existing endpoints.
T2 — **Settings/Agents domain**: the policy page (defaults for new agents; the discriminator
     rule documented in-page).
T3 — **backfill**: the verb + envelope + ledger progress.
T4 — **BYOK via Bureau**: per-tenant provider credentials; guardrails ride the key.
T5 — **the frontier**: a/b assignment → outcome join → Allen's digest → (later) learned router.
T6 — **CLI parity**: `bullmoose agent …` learns the extract pipeline (Eric's @local
     out-of-budget path) and the dossier verbs (`show`, `budget`, `model`, `backfill`).

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
