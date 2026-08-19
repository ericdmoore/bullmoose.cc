# s29 — model-selection ladder + eval set

> **Status: DESIGN.** How we start mapping `(task, desired outcome, usable MCPs) →
> cheapest sufficiently-good model` without shipping a black-box classifier on day one.
> Continues s26's frontier program (T5a assignment landed; T5b join + T5c learned router
> still open) and feeds the spend breakouts in `.plans/s27-usage-and-spending/`.

## The margin model (why this exists)

Hosted agents sit on a price-elasticity curve for *tasks* against a token supply curve from
OpenRouter / Workers AI / gateway / `@local`. Margin is roughly:

> **(what the task can bear) − (cheapest reliable tokens to clear the quality bar)**

OpenRouter picks **hosts** behind a slug; **model choice is ours**. A static alias menu ranked
by price is the floor we already have. The ladder is how we walk that supply curve
*per task kind* without paying frontier prices for extract-shaped work — or underpaying and
shipping wrong payroll math.

Token meter ≠ product margin. Efficient routing protects COGS; the agent SKU still captures
value above commodity inference. This doc is the COGS half.

## Recommendation: rubric + cascade first, learned router later

**Do not start with an LLM-as-router or a trained classifier.** Start with:

1. an explicit **task schema**
2. a hand-ranked **cheap→dear ladder per `kind`**
3. a tiny **eval set** that defines "sufficiently good"
4. a **cascade** (try cheap → validate → escalate)
5. reuse **`frontier.exploreRate` / T5a arms** to detect when a cheaper model has caught up
6. only then learn `P(pass | model, features)` and rewrite the ranked menu (s26 T5c)

That last step enters as a **menu rewrite**, not a new mechanism — fallback chains and budget
gates stay unchanged.

## 1. Task schema (router inputs)

Keep it boring. Prefer signals we already have (pipeline, binding, bureau/MCP grants, risk
tier) over free-text "classify this job":

```text
task:
  kind: extract | draft | judge | plan | tool_orchestrate | brief | classify
  outcome: schema | email_prose | approval_proposal | ranked_list | label
  risk: read | draft | mutate          # maps to approval tiers
  mcps: [payroll.read, handbook.search, …]
  human_facing: true | false
  max_latency_ms?: number
  max_cost_usd?: number
```

**Rules of thumb:**

- `pipeline: extract` / ledger fact-extract → `kind: extract`, usually `human_facing: false`
- Emily-class reply → `kind: draft`, `human_facing: true`
- bouncer mid-band → `kind: classify`
- HR benefits answer with handbook MCP → `kind: draft` or `judge`, MCPs listed, often
  `risk: read` until it would write payroll
- Anything `mutate` (payroll write, send, provision account) raises the **floor** of the
  ladder regardless of `kind` — cheap wrong is worse than dear right

Agent + pipeline + tool set already carry most of the signal. The schema makes that
legible to the ladder.

## 2. Cost ladder per `kind` (v0 = config)

For each `kind`, order candidates **cheapest → dearest** that can clear the bar. Pin beside
today's `modelAliases` / `modelMenu` — same shape as Emily's `cheap` → `sonnet` menu, but
**chosen by kind**, not by the sender's `model:` front matter.

| kind | typical ladder intent |
|---|---|
| extract / classify / route | small OR / Workers AI / `@local` scout |
| tool-arg fill + structured JSON | small–mid |
| human-facing email prose | mid |
| multi-step plan / judgment under grants | mid–frontier |
| mutate + external write | mid floor minimum; frontier on failure |

Exact slugs are **eval outputs**, not guesses in this doc. Seed from the live menus
(`bullmoose agent model …`, dossier economics) and from models.dev / OR pricing — then let
the eval set reorder.

Scout/troops (s26) is the same idea on the host×claimant axes: scouts = CLI × `@local`,
troops = cloud × frontier host. The ladder here is the **model** half of that story.

## 3. Eval set — what "sufficiently good" means

20–50 golden tasks per `kind` before claiming a ladder is real.

Each fixture:

| field | purpose |
|---|---|
| `id` | stable name |
| `kind` + schema fields above | router features |
| prompt / mail fixture | frozen input |
| MCP stubs or recorded tool transcripts | no live side effects in CI |
| expected | JSON schema / required fields / rubric for prose |
| `max_cost_usd` (optional) | refuse a pass that only works at absurd spend |

**Pass** = clears the rubric, not "sounds smart."

Seed arenas from outcomes we already record (s26 T5 table):

| Arena | Label we already (or will) accrue |
|---|---|
| Extraction | annotation dismissals vs resolutions |
| Reply drafting (Emily) | approved-clean vs approved-after-edit vs declined-wrongContent |
| bouncerClassify | rescues / confirms |
| Ledger (Allen) | digest corrections |
| Contact merge (crm@) | merge approvals |
| needsInfo | rounds-per-question |

Offline eval set = the **calibration** instrument. Production decline/approve signals = the
**ongoing** instrument (T5b join). Don't wait for production volume to define the ladder;
don't ignore production once it exists.

## 4. Cascade router (ship this)

```text
features ← (kind, risk, human_facing, mcps, …)
ladder   ← config[kind]  # filtered by risk floor + claimantability
for model in ladder:     # cheapest first
  result ← run(model, task)
  if validate(result): return result
escalate or park on approval queue
```

Optional: 5–10% `exploreRate` on the next model up (T5a `chooseArm`) so we keep measuring
whether the cheap arm is still enough. Record model + µUSD + pass/fail on the invocation
row we already stamp.

**Validators are load-bearing.** Schema validation + one retry already exists on ledger
extract — generalize that instinct. No validator ⇒ no cascade, only vibes.

## 5. Learn only after logs exist

When `(task features → model → pass → $)` is dense enough:

1. Rules + thresholds first (`tools ≥ 3 ∧ mutate → bump one tier`)
2. Small scorer: `P(pass | model, features)`
3. Policy: `argmin cost  s.t.  P(pass) ≥ threshold`
4. Emit as **ranked menu rewrite** (T5c) — same fallback/budget machinery

LLM-as-router is optional meta-spend; skip until rules + scorer fail you.

## 6. What not to do first

- One global "smartest model"
- Routing only on user `model:` front matter (steering stays; defaults shouldn't)
- Optimizing $ without a validator
- Treating MCP lists as decoration — **mutate + external write** forces a higher floor
- Training a classifier before 20–50 goldens per kind exist
- Confusing OR host-routing with our model ladder (OR does not pick the model)

## Relationship to neighboring plans

| Plan | Relationship |
|---|---|
| **s26** frontier T5a/b/c | This is the concrete start for T5c; assignment (T5a) is the explore arm |
| **s27** usage-and-spending | Ladder + eval produce the by-task µUSD / tokens breakouts worth reporting |
| **s28** full-SMB-cast | Role agents (`hr@`, `accounting@`, …) are *consumers* of kinds — they don't each need a private router |
| **s29-code-hygiene** | Unrelated CI/hot-path note; different folder on purpose |

## Suggested build slices

1. **Schema + ladder config** — typed `TaskKind`, per-kind menus in binding/settings defaults
2. **Golden fixtures** — start with extract + draft (live pipelines); add classify from bouncer
3. **Cascade + validate** — wire into claim/run path; keep budget gate
4. **Allen digest (T5b)** — cost vs correction-rate per model per kind, as mail
5. **Menu rewrite (T5c)** — only when the frontier plot is boringly stable

## Open questions

- Does `kind` live on the binding (static), the invocation (per message), or both (default + override)?
- Risk floor: hard refuse cheap models on `mutate`, or allow with mandatory approval-queue park?
- Who owns ladder edits — operator dossier verbs (`agent model`), Settings defaults for new agents, or Allen's digest proposing rewrites?
- Eval hosting: CI-only with stubs, or a periodic paid bake-off budget under the platform commons (s27)?
