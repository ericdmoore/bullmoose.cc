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
- The agent **infers** `due_at` from the work — the implied-due-date-from-the-email-body. This
  is a *proposal*, not a hidden field: it surfaces on the approval row beside the two clocks so
  a human can see and correct a mis-read deadline (readme caution 3).
- ⚠️ Distinct from `budgets.deadlineMs` (a loop kill-switch) and from `ActionProposal.expiresAt`
  (the *human's* decide-by). `due_at` is the *work's* business deadline. Three clocks now; keep
  them apart, same discipline as `expiresAt` vs `holdUntil`.

**Done when:** an invocation carries an inferred `due_at`; it renders on the approval row and is
correctable; NULL means never-urgent.

### T2 — The eligibility policy · *sit free, escalate near-due*

**Files:** `services/agent` (the claim gate), `packages/auth-core` or a new `scheduling` module
(pure policy).

A pure function `mayClaim(invocation, runtime, budgetState, now) → bool`, over `(due_at, cost
estimate, remaining spendPerMonth, runtime.isFree)`:

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

---

## Sequencing

```
T1 due_at ──→ T2 eligibility policy ──→ T3 watchdog reconcile
     │              (spends s07 T5's cost facts)
     └──→ T4 defer writes due_at (human override)
                    T5 $/work optimiser — deferred, needs cost history
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
2. **`due_at` extraction — always, or only for deadline-shaped work?** Inferring a deadline for
   every email invites false urgency. *Recommendation: only when the body is deadline-shaped
   (explicit date/"by"/"EOD"), else NULL (never-urgent). A wrong `due_at` is worse than none.*
3. **Does a homelab runtime advertise liveness, or is absence inferred?** The scheduler needs to
   know a free runtime *could* claim. *Recommendation: infer from recent claims — a homelab that
   claimed in the last N minutes is "available"; do not add a heartbeat unless absence-inference
   proves too slow.*

## Out of scope

- **A general job queue / cron.** This schedules agent invocations against inference budget and
  deadlines only.
- **The score UI.** s11 consumes T5's cost facts; rendering them is s07/s10.
- **Provisioning local runtimes.** `bullmoose agent serve` and the `@local` alias already exist
  (`~/.casa-studio/`); s11 assumes them.
