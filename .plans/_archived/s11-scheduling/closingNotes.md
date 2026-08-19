---
plan: s11-scheduling
status: closed
closed_at: 2026-08-19
closing_pr: none          # docs-only; .plans/*.md lands straight on main
acceptance: met           # every shipped task's clauses hold; T4 retired, T5 deferred with a successor
residues: 1
reversals: 1
---

# s11 — closing notes

s11 was pitched as scheduling: let work sit hoping a free runtime picks it up,
spend paid budget only as a deadline approaches. That much shipped, and the
pure policy function it centres on (`mayClaim`) is now folded into every claim
UPDATE in both workers. But the section grew a second half nobody planned for.
Three of its nine tasks — T6 facets, T7 Jobs, T8 the fleet host — arrived via
`jobs-and-facets.md`, written mid-flight on 2026-08-13, and **those** are what
later sections actually consume: T7's DAG became the spine of Goals (s20 T6)
and of agent-to-agent handoff (s17), and T6's facet columns became the thing
bouncer@ stamps (s12).

The other thing this section produced is a reusable sentence. T9's *"marker
when nothing can be decided, proposal when something can"* was written to
distinguish a pinned-overdue invocation from a budget-stranded one, and it has
since been cited by s12 to decide that the mid-band produces a proposal rather
than a pile. A scheduling plan turned out to be where the queue's philosophy
got written down.

## Acceptance ledger

| Done-when (verbatim) | verdict | evidence |
|---|---|---|
| T1 "an invocation carries an inferred `due_at`" | ✅ met | `packages/mailstore/sql/data-plane.sql:290` + migration `invocation-due-at` (`infra/migrations.mjs:452`); deterministic extraction at the boundary, no model call, in `packages/scheduling/src/dueDate.ts`; #91 |
| T1 "it renders on the approval row and is correctable" | ✅ met | `webmail/src/lib/approvals/clocks.ts:125-127` (`dueLabel`, "no due date" for NULL); the correction is a status-free `{ dueAt }` patch — `webmail/src/lib/approvals/api.ts:173-196`. This is also the human override, per the reversal below |
| T1 "NULL means never-urgent" | ✅ met | `dueDate.ts:15-21` — every ambiguous or relative-without-anchor form returns NULL by design ("tomorrow", "ASAP", "by next Friday"), and a resolved-to-past deadline returns NULL rather than summoning the backstop |
| T2 "the claim path consults `mayClaim`" | ✅ met | and in **both** workers, as one shared SQL fragment: `services/agent/src/index.ts:299` and `:326` (the drain and the direct claim), `services/jmap/src/methods/agent.ts:412` (the JMAP claim). `claimGateSql`/`claimGateBinds` come from `@bullmoose/scheduling` so the two cannot drift; #93 |
| T2 "a `@local` daemon claims deferred work a paid runtime declines; near-due, the paid runtime picks up unclaimed work" | ✅ met | table-tested pure, then agreement-tested against the SQL: `packages/scheduling/src/mayClaim.test.ts` and `claimGateAgreement.test.ts`. `services/agent/src/defaultCase.test.ts:172` proves the paid drain refuses a pinned, far-due, vision-requiring row |
| T3 "a `due_at`-passed invocation is always claimed" | ✅ met | the backstop claims **outside** `claimGateSql` on purpose (`services/agent/src/index.ts:390-391`) — a gated backstop would refuse exactly the rows it exists for, which would make it decorative |
| T3 "the two triggers (SLA silence and overdue) both reach the watchdog" | ✅ met | `services/agent/src/index.ts:65`, both armed off the 5-minute cron (`services/agent/wrangler.jsonc:9`); ordering is deliberate — the backstop runs before T9's sweep so the sweep only ever sees what optimism left behind (`index.ts:206-211`) |
| T6 "facets persist on the invocation; mechanical facets are stamped by ingest" | ✅ met | columns at `packages/mailstore/sql/data-plane.sql:291-294`, migration `invocation-facet-columns` (`infra/migrations.mjs:461`); stamping in `services/ingest/src/facets.ts`; #91 |
| T6 "`mayClaim` reads them" | ✅ met | the `fit` term of the three-way gate, folded into the same `claimGateSql` (`services/jmap/src/methods/agent.ts:412`) |
| T6 "a floor test proves a stamp cannot lower a binding's privacy class" | ✅ met | `services/ingest/src/facets.test.ts` — the max-wise composition is the hard invariant of that file (`facets.ts:12`) |
| T6 "an unfaceted invocation behaves byte-identically to today" | ✅ met | pinned against the **real** drain, not a stub: `services/agent/src/defaultCase.test.ts:124-171` asserts the exact claim UPDATE issued and that no facet is ever written |
| T7 "a planner's output becomes claimable sibling tasks that two different runtimes process in parallel" | ✅ met | `packages/scheduling/src/jobGraph.test.ts:406` — the same node claimable by both runtimes once its need is done; `:399` proves a blocked node is refused to both, i.e. ordering is structural, not policy; #113 |
| T7 "the aggregate budget stops a runaway fan-out" | ✅ met | `jobGraph.test.ts:212-348` (SQL ≡ pure agreement on job-budget exhaustion), and `:413` — an exhausted node is refused the paid cloud yet still claimable by a free runtime, which is the budget rule composing with the DAG rather than overriding it |
| T7 "the attenuation test refuses an amplifying child" | ✅ met | `packages/scheduling/src/attenuation.test.ts:67-131` — refuses, never truncates (`:85`); an omitted tools list is the empty set, not the parent's (`:90`); a child cannot ask for "unrestricted" (`:111`) |
| T7 "Job progress renders from the derived view" | ✅ met | `jobGraph.test.ts:460+` — Job status is derived from its nodes and stored nowhere |
| T8 "one daemon process serves two bindings on two accounts with one login" | ✅ met | `packages/cli/src/agent.ts:41-48` (`--fleet`), `fleetDrain` at `:282`; the single-config case is expressed as a one-binding fleet (`fleetFromSingle`, `:189`) so there is one loop, not two; #90 |
| T8 "a revoked claim grant stops claims for that binding without a restart" | ✅ met | discovery is per-drain from grants, not declared at startup — that is the whole shape of `fleetDrain`; #90 |
| T9 "a budget-stranded binding produces exactly one proposal per period" | ✅ met | `services/agent/src/budgetOverrun.ts` — batched per binding (`:49`), keyed to the period (`:383-388`); #103 |
| T9 "approving releases a bounded overage the claim gate honors" | ✅ met | `agent_budget_overages` (migration `budget-overage-table`, `infra/migrations.mjs:506`), summed into the effective cap by the same terms the gate uses (`budgetOverrun.ts:234`, `surplusBackfill.ts:19-24`) |
| T9 "the marker prevents a second ask" | ✅ met | T3's marker is the idempotence key, and it never clobbers `overdue-pinned`/`overdue-unfit` (`budgetOverrun.ts:270`, markers set at `services/agent/src/index.ts:517`) |
| T9 "no proposal is created when nothing is stranded (DefaultCase)" | ✅ met | `services/agent/src/budgetOverrun.test.ts`; the sweep is gated on `dueWindowSql` (`budgetOverrun.ts:157`, `:209`) |

**T4** was retired before it was built (see Reversals). **T5** was deferred by
name in the plan — see Carried forward.

## Carried forward

| what | why it did not ship | owner |
|---|---|---|
| The `$/work` optimiser — *which* model a deadline-pressed run escalates to, tokens/work × $/token against the deadline | T5 was deferred deliberately and correctly: it needs cost history that did not exist when s11 was written, plus a quality signal to define "cheapest that meets the bar". Building it early would have been curve-fitting on an empty table | `.plans/s29-optimizations/model-selection-ladder.md` (rubric + cascade first, learned router later) **and** `.plans/s26-agent-config/devPlan.md` **T5c** — the learned router, which enters as a menu rewrite, not a new mechanism. s26 T5a landed 2026-08-18 (#182), so the assignment data this needs is now accruing |

## Reachability

- **Deployed?** Yes — the policy is a library (`@bullmoose/scheduling`) folded
  into `services/agent` and `services/jmap`, both shipped by
  `.github/workflows/deploy-mail.yml`. The sweeps run off the agent worker's
  5-minute cron (`services/agent/wrangler.jsonc:9`).
- **Migrations applied?** Eight, all registered with executable checks:
  `invocation-due-at`, `invocation-facet-columns`, `invocation-claimant-columns`,
  `invocation-alert-columns`, `budget-overage-table`, `invocation-job-columns`,
  `jobs-table` (`infra/migrations.mjs:452-570`), plus `goals-table` for the
  entry point s20 later attached. **Whether they have run on production is not
  established here** — `migrate.yml` is manual (`workflow_dispatch`) and now
  applies by default (#180), but this note has not checked the live shard.
- **Switched on?** Structurally yes, behaviourally near-inert: the gate
  narrows claimants only when something is *set*. No binding sets
  `spendPerMonth` (the plan says so and T9 exists because of it), so the budget
  arm of the policy has nothing to bite on in practice. `due_at` is stamped only
  when deterministic extraction matches deadline-shaped text.
- **Verified live?** **No.** Every clause above is verified against code and
  tests. Nothing in this section has been observed running against production —
  no fleet host is known to be serving, and the free-vs-paid escalation has not
  been watched happen.

## Authority-surface delta

Substantial, and mostly *narrowing* — which is the right direction for a
scheduler:

- **A third term joined the claim.** `eligible = authority ∧ fit ∧ policy`. Only
  `authority` is security; `fit` is self-declared (safe, because over-claiming is
  punished by history) and `policy` is economics. The important discipline is
  that claimant preference is an `ORDER BY` **within** the eligible set and
  never a widener.
- **Attenuation became monotonic and enforced.** A Job's child may hold a subset
  of its parent's tools, credentials and budget — never more, and the refusal
  never silently clamps (`packages/scheduling/src/attenuation.ts`). This is the
  wall that makes a runtime-produced plan safe to execute at all.
- **The backstop deliberately claims outside the gate.** That is an escalation
  of *spend*, not of authority: it moves work to a paid runtime that already
  held the grant. Worth stating plainly, because "claims outside the gate" reads
  alarming until you see which term it bypasses.
- **Budget exhaustion narrows, it does not fail.** An out-of-budget invocation
  stays claimable by free runtimes. T9 then turns the residual stranding into a
  human question rather than a dead row.

## Deviations from `devPlan.md` / `arch.md`

- **T7's production entry point came from another section.** The plan assumed
  the Jobs DAG would be driven from within s11; in the end `Goal/set` →
  `createGoal` → `startJobRows` (`services/jmap/src/methods/goal.ts:284`) is the
  live caller, built by s20 T6 (#216). The `startJob` wrapper s11 wrote is still
  called only by tests and by s17's handoff machinery
  (`services/agent/src/handoff.ts:529`) — the production path goes through
  `startJobRows` directly, because `Goal/set` commits its own changelog entry.
- **T9 was not in the plan at all** when the plan was written. It exists because
  T3 found the hole: an invocation with `due_at = NULL`, a binding out of
  budget, and no free runtime listening, sits until the month rolls. The overdue
  backstop cannot help a row with no deadline.
- **The escalation window is not a tunable.** The plan describes "within an
  escalation window of `due_at`"; the implementation folds it into
  `dueWindowSql` as a shared SQL fragment rather than a per-binding setting.
  Nobody has asked for the knob.

## Reversals

**T4, `defer`, retired before it was built** (2026-08-13, Eric's call). The
decline taxonomy will not grow a `defer` row. The reasoning is worth preserving
because it generalises: the only use anyone could name was queue hygiene ("hide
this until tomorrow"), which is a **display** concern with no taxonomy standing,
and recording it as a *decision* would feed a learning loop a signal about the
human's calendar dressed up as a signal about the agent's judgment. The
capability survives as a field edit — correcting `due_at` on the approval row
*is* deferring (`webmail/src/lib/approvals/api.ts:173`). Do not re-file `defer`
as a missing verb; it is a decided absence. See
`.plans/s03.D-coexistence/decline-taxonomy.md`.

## Absorbed / donated

- **Absorbed from s07 T5** (#86): the cost facts. The plan is explicit that it
  "sits on s07 T5" — you cannot preserve budget for near-due work without
  knowing what work costs. s11 is the second consumer of those facts, after the
  score that s07 never rendered.
- **Absorbed from s10:** the grant machinery T8's runtime-as-principal model
  reuses wholesale (`authorizeAccount`), and the chain/proposal patterns T9's
  batched ask follows.
- **Donated → s12:** T6's facet columns are what bouncer@ stamps, and T9's
  *"marker when nothing can be decided, proposal when something can"* is the
  line s12 cites to turn the mid-band into a proposal instead of a second pile.
- **Donated → s20 T6 (#216):** the Jobs DAG, which Goals drives. **s20's note
  should record that it gave s11 T7 its production entry point** — without that
  cross-reference s11 reads as shipped-but-dead, which is what its own readme
  said until today.
- **Donated → s17 (#214):** the same DAG, for agent-to-agent handoff
  (`services/agent/src/handoff.ts` builds on `startJob` and the attenuation
  chain). Note that s17's machinery is itself recorded as having no production
  caller — so this donation is real code, not yet a live path.
- **Donated → s26:** `claimGateSql`'s budget terms are reused verbatim by the
  surplus-backfill work (`services/agent/src/surplusBackfill.ts:19-24`), which
  is the clearest evidence the gate was factored at the right seam.

## What grew stale during the build

- **The readme's headline warning went stale on 2026-08-18 and was still there
  this morning.** It reads: *"⚠️ T7 (Jobs) shipped but has NO production entry
  point — `startJob` is called only from tests."* That was true when written and
  is not true now. `Goal/set` → `createGoal` → `startJobRows`
  (`services/jmap/src/methods/goal.ts:284`) is production; the drain runs job
  nodes (`services/agent/src/index.ts:675` → `runJobNode` → `expandPlan`,
  `services/agent/src/jobNode.ts:150`); and the webmail drives the whole thing
  from the Goals surface (`webmail/src/lib/goals/api.ts:124`, `Goal/set` over
  JMAP). #216, 2026-08-19.
  **The narrow claim survives the correction**: the `startJob` *symbol* still
  has no production caller outside s17's handoff, because `Goal/set` calls
  `startJobRows` and commits its own changelog. That is a difference in seam,
  not in reachability — and it is exactly the kind of distinction a warning
  banner flattens.
- **"No binding sets `spendPerMonth`"** (T9's narrowness argument) predates
  s26's BYOK and budget work (#198, #203, #204). The hole T9 closed is less
  hypothetical now than when it was closed.
- **T5's "do not build until the cost history is real"** — the history is real
  as of #182/#183, which is why the successor is a live plan rather than a
  backlog note.

## Traps for the next section

- **A backstop that runs inside the gate it backstops is decorative.** It will
  refuse precisely the rows it exists to rescue, and it will look correct in
  every test that does not construct a gated row.
- **Prove the SQL and the pure function agree, don't just test both.** The whole
  `claimGateAgreement.test.ts` / `jobGraph.test.ts` pattern exists because a
  policy expressed twice drifts silently, and the drift shows up as work that
  never gets claimed by anyone. Fold **one** fragment; never re-implement it in
  the second worker.
- **A DefaultCase test must run against the real handler.** `defaultCase.test.ts`
  asserts the exact UPDATE the real drain issues — a stub would have passed
  while the shipped query filtered rows nobody meant to filter.
- **Ask whether the thing you are recording is a decision or a display
  preference.** T4 died on that question, and the answer saved a taxonomy row
  and a poisoned training signal.
- **A "⚠️ NOT WIRED" banner in a plan folder is a liability with a half-life.**
  This one was correct for four days and misleading for one; it was the loudest
  sentence in the file the whole time.
