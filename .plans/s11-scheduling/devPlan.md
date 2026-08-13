# s11 — the optimistic work scheduler: dev plan

> Ordered build for [`readme.md`](./readme.md): make the invocation queue claim-**smart** —
> sit for free, escalate near-due, spend paid budget on the next deadline not the first job.
>
> **Guiding constraint:** the scheduler is an *eligibility* layer, not a new queue. It answers
> one question — *"may this runtime claim this invocation yet?"* — over the existing pull queue.
> It must never override the §8 cloud-watchdog liveness backstop.

---

## Tasks (in dependency order)

### T1 — `due_at` on the invocation · *the field the scheduler reads*

**Files:** `packages/mailstore/sql/data-plane.sql` + `infra/migrations.mjs`, `services/agent`
(extraction), `webmail/src/lib/approvals/` (surface it).

- Add `due_at INTEGER` (epoch ms, nullable) to `agent_invocations`. NULL = "no known deadline"
  → the scheduler treats it as *never urgent* (free-runtime-only, indefinitely). Migration with
  an executable check.
- **Extraction happens at the boundary, not in the claiming agent** (jobs-and-facets §6 —
  the discussion caught this: eligibility needs `due_at` BEFORE any claim exists, because
  sit-free-vs-escalate is a pre-claim decision). Deterministic patterns (explicit dates,
  "by Friday", "EOD") at enqueue; model extraction only where a binding opts in; no match →
  NULL (never-urgent). It remains a *proposal*, not a hidden field: it surfaces on the
  approval row beside the two clocks so a human can see and correct a mis-read deadline
  (readme caution 3).
- ⚠️ Distinct from `budgets.deadlineMs` (a loop kill-switch) and from `ActionProposal.expiresAt`
  (the *human's* decide-by). `due_at` is the *work's* business deadline. Three clocks now; keep
  them apart, same discipline as `expiresAt` vs `holdUntil`.

**Done when:** an invocation carries an inferred `due_at`; it renders on the approval row and is
correctable; NULL means never-urgent.

### T2 — The eligibility policy · *sit free, escalate near-due*

**Files:** `services/agent` (the claim gate), `packages/auth-core` or a new `scheduling` module
(pure policy).

A pure function `mayClaim(invocation, runtime, budgetState, now) → bool`. Its full shape is
the three-term gate (jobs-and-facets §6):

```
eligible = authority(runtime.grants)            -- MAY it act     (hard, server-verified)
         ∧ fit(runtime.capabilities, facets)    -- CAN it succeed (self-declared at connect)
         ∧ policy(facets, budgetState, now)     -- SHOULD it, yet (this task)
-- claimant preference = ORDER BY within the eligible set, never a widener
```

`authority` is the existing grant machinery; `fit` compares the claimant's declared
capability vector (vision, context length, tools) against the facets (T6) — safe to
self-declare because it gates fit, not authority, and history punishes over-claiming.
This task builds `policy`, over `(due_at, cost estimate, remaining spendPerMonth,
runtime.isFree)`:

- **Far from due** (`due_at − now` large, or NULL): only `isFree` runtimes may claim. Paid cloud
  holds.
- **Near due** (within an escalation window of `due_at`): paid runtimes become eligible.
- **Out of budget** (`spendPerMonth` spent): only `isFree` runtimes, regardless of due-ness —
  budget exhaustion narrows the claimant set, it does not fail the invocation.
- The **cost estimate** comes from T5: the median `cost_micros` of past invocations of this
  `kind`/binding. No history → treat as unknown, lean conservative (escalate only when due).

Pure and table-tested: given a due-far/free-runtime it claims; due-far/paid-runtime it holds;
due-near/paid it claims; out-of-budget/paid it holds even when due (the watchdog is the backstop
past `due_at`, T3).

**Done when:** the claim path consults `mayClaim`; a `@local` daemon claims deferred work a paid
runtime declines; near-due, the paid runtime picks up unclaimed work.

### T3 — Reconcile with the watchdog · *optimism must not strand work*

**Files:** the cloud watchdog (§8 mechanism).

The scheduler's patience and the watchdog's liveness guarantee must compose, not fight:

- The watchdog already fires when *no runtime* claims within the pickup SLA. s11 adds a second
  trigger: **`due_at` passed with the invocation still `pending`** → the watchdog claims it on
  the paid runtime unconditionally. Optimism ends at the deadline; the backstop takes over.
- Assert the invariant: **no invocation with a past `due_at` sits `pending`.** A test proves a
  deferred-then-overdue invocation gets claimed by the cloud even if every free runtime stayed
  down.

**Done when:** a `due_at`-passed invocation is always claimed; the two triggers (SLA silence and
overdue) both reach the watchdog.

### T4 — `defer` writes `due_at` · *the human override*

**Files:** `services/jmap/src/methods/actionProposal.ts`, `webmail/src/lib/approvals/`.

Land the `defer` action from `decline-taxonomy.md`: a human deferring a proposal sets/extends its
`due_at` (and re-surfaces it later). `defer` is the manual override of the automatic optimism —
same field, same policy, human-driven. It is **not** a decline: excluded from any negative
learning signal (the taxonomy invariant).

**Done when:** `defer` on a proposal writes `due_at`, re-queues it, and records nothing negative;
the scheduler then treats it exactly like an inferred deadline.

### T5 — The `$/work` optimiser · *which model a deadline-pressed run escalates to* — deferred

The escalation in T2 decides *whether* to spend; this decides *what to spend it on* —
tokens/work × $/token against the deadline, picking the cheapest model that meets the quality
bar. Depends on enough T5-cost history to estimate `$/work` per model, and on a quality signal
(the decline taxonomy's approve-rate per model is a candidate). Named, not scoped — this is the
standing "Allen's background loop" the T5 spec forward-referenced. Do not build until the cost
history is real.

### T6 — Facets at the boundary · *what the gate reads*

**Files:** `packages/mailstore/sql/data-plane.sql` + `infra/migrations.mjs` (facet columns on
`agent_invocations`), `services/ingest` (mechanical facets), the boundary agent (judged
facets — s12).

The facet set and its authorship table are `jobs-and-facets.md` §2/§6 — one author class per
facet, nobody hand-authors per message:

- **Mechanical at enqueue** (ingest): size, attachment MIME → derived capability
  requirements (`requires: {contextTokens?, vision?, tools?}`), thread refs, `from`.
- **Judged at enqueue** (bouncer, s12): sender class, privacy stamp, due extraction (T1),
  effort prior.
- **Privacy is a class, not a score** (`open | internal | pinned`) and composes **max-wise
  against the binding's floor**: a stamp may raise, never lower below any implicated floor.
  The floor is config, written once; the stamp is per-message. This is the rule that makes
  boundary stamping safe to concentrate.
- **DefaultCase is structural**: an invocation with no facets is claimable exactly as today.
  Facets tighten, never strand.

**Done when:** facets persist on the invocation; mechanical facets are stamped by ingest;
`mayClaim` (T2) reads them; a floor test proves a stamp cannot lower a binding's privacy
class; an unfaceted invocation behaves byte-identically to today.

### T7 — Jobs: the DAG · *tasks, sub-tasks, and the planner node*

**Files:** `packages/mailstore/sql/data-plane.sql` + `infra/migrations.mjs` (`job_id`,
`parent_id`, `needs` on `agent_invocations`; a `jobs` table for the underivable), the claim
query (claimability), `services/agent` (planner-node output → task creation).

Design is `jobs-and-facets.md` §3/§5. The load-bearing choices:

- **Nodes are ordinary invocations.** `job_id` (root, denormalized), `parent_id` (context +
  attenuation chain), `needs: [...]` (execution ordering — a DIFFERENT relation from
  parent). The `jobs` row stores only what cannot be derived: aggregate budget
  `{costMicros, maxNodes, maxDepth}`, originating binding, facets.
- **No new queues.** Claimability = `status='pending' AND NOT EXISTS (unmet needs)` computed
  in the claim query; Job status is a **view** derived from its tasks. Never store what can
  be derived — the membership-chain lesson, applied forward.
- **The planner node** emits tasks as output; the harness creates them (fan-out capped by
  the Job's `maxNodes`/`maxDepth`, spend capped by the aggregate budget). Progressive
  revelation: the plan is produced at runtime, not declared as front matter.
- **Attenuation is monotonic** (invariant): a sub-task's tools, credentials and budget are
  a subset of its parent's. Delegation attenuates, never amplifies. A test proves a planner
  cannot mint a child that exceeds its parent on any axis.
- **Composition:** a failed node blocks dependents (derived); `needsInfo` pauses only its
  subtree; join nodes receive their needs' results as context; side-effectful leaves still
  exit via `/approvals` — a Job reorganizes work, never its egress.

**Done when:** a planner's output becomes claimable sibling tasks that two different
runtimes process in parallel; a join node synthesizes; the aggregate budget stops a
runaway fan-out; the attenuation test refuses an amplifying child; Job progress renders
from the derived view.

### T8 — The fleet host · *one daemon, N agents, discovery from grants*

**Files:** `packages/cli/src/agent.ts` (multi-binding serve), `services/jmap` (claim-grant
resolution — the machinery exists: `authorizeAccount`), provisioning (the claim grant).

Design is `jobs-and-facets.md` §4. Today `agent serve` is one binding per process and five
agents means five logins — wrong shape.

- **Runtime-as-principal**: the daemon logs in once (e.g. `alpaca-daemon`); each agent
  account **grants** it claim authority via the existing cross-account grant machinery.
- **Discovery, not declaration**: on connect the daemon serves whatever granted it claim.
  Adding an agent = minting a grant; revoking one = revoking a grant, instantly, the other
  bindings untouched. The grants are visible in the console like every other grant.
- **The capability vector rides the connect** (T2's `fit`): the host declares what it can
  run (vision, context, tools); local backend config stays local — it describes the host's
  capability, never an agent's identity.

**Done when:** one daemon process serves two bindings on two accounts with one login; a
revoked claim grant stops claims for that binding without a restart; the declared
capability vector excludes the host from unfit work.

---

## Sequencing

```
T6 facets (boundary) ──┬──→ T2 eligibility (authority ∧ fit ∧ policy) ──→ T3 watchdog reconcile
T1 due_at (boundary) ──┘         │                                          (privacy pin exempt,
                                 │                                           decision 0)
                                 ├──→ T7 Jobs (DAG, planner, attenuation)
                                 └──→ T8 fleet host (grants + capability vector)
T4 defer writes due_at (human override) — anytime after T1
T5 $/work optimiser — deferred, needs cost history
s12 bouncer@ — stamps T6's judged facets; deterministic sieve is its own section
```

## Decisions needed

0. **Privacy is a pin, not a preference — and it collides with the watchdog.** Cost routing
   says *"prefer free"*; privacy routing says *"MUST run local"* — a hard constraint on the
   claimant set (e.g. a binding whose mail must never transit a paid cloud model). These are
   different axes: the scheduler may escalate a cost-preferred job past `due_at`, but a
   privacy-**pinned** invocation is exempt from T3's cloud-escalation backstop *by
   definition* — when the homelab is down and `due_at` passes, the system must choose between
   violating privacy and violating liveness. **Privacy wins: the work sits, and the human is
   alerted** (the invariant "no past-due invocation sits pending" gains the qualifier
   "…unclaimed *silently*"). Needs a `runtimePin: local | any` on the binding when built;
   named now so T2/T3 leave room for it.

1. **The escalation window — fixed, or cost-scaled?** A cheap job might escalate 10 min before
   due; an expensive one an hour, to leave retry room. *Recommendation: cost-scaled — the window
   is a function of the estimate and a retry budget, not a constant.*
2. **`due_at` extraction — RESOLVED (2026-08-13):** only deadline-shaped bodies, at the
   boundary, deterministic patterns first, NULL otherwise (never-urgent). A wrong `due_at`
   is worse than none. See T1 and jobs-and-facets §6.
3. **Does a homelab runtime advertise liveness, or is absence inferred?** Partially resolved
   by T8: the connect carries the capability vector (what it CAN do); liveness (is it here
   NOW) is still inferred from recent claims — a host that claimed in the last N minutes is
   "available". No heartbeat unless absence-inference proves too slow.

## Out of scope

- **A general job queue / cron.** This schedules agent invocations against inference budget and
  deadlines only.
- **The score UI.** s11 consumes T5's cost facts; rendering them is s07/s10.
- **Provisioning local runtimes.** `bullmoose agent serve` and the `@local` alias already exist
  (`~/.casa-studio/`); s11 assumes them.
