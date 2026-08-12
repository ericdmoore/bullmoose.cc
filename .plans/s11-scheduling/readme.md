# s11 — the optimistic work scheduler: sit free, escalate near-due

> **Status: design.** The invocation queue exists and is claim-**first-available**. This
> section makes it claim-**smart**: let work sit hoping a *free* runtime picks it up, and spend
> paid cloud budget only as a deadline approaches. The `feed.works` pattern, applied to agent
> inference.
>
> **Sits on `s07` T5** (just merged): you cannot preserve budget for near-due work without
> knowing what work *costs*. This is the second consumer of the cost facts, after the score.

---

## What already exists — do not rebuild it

`docs/architecture/agent-integration.md` already specifies the runtime model, and most of it is
built:

- **Pull-based queue** (§2): the platform never calls a runtime; runtimes *watch for work* over
  the same WS/changes machinery as mail. `agent_invocations.claimed_at` is the optimistic claim.
- **`runtime: cloud | homelab`** — a first-class field on the binding.
- **`bullmoose agent serve`** — the homelab daemon (Node, sibling of `watch`); `agent.ts`
  already claims and runs work.
- **Inference is an independent axis** (§6): *"any `baseURL` — Ollama on LAN, or cloud APIs."*
  A homelab runtime firing at LiteLLM/Ollama on alpaca, with the binding's model = `@local/…`,
  is the intended shape — and free.
- **The cloud is the watchdog** (§8): if no runtime claims within the pickup SLA, the cloud
  takes it, so a mailbox never goes dark because the homelab is down.
- **Budgets exist** on the binding: `{ tokensPerInvocation, turnsMax, deadlineMs, spendPerMonth }`.

So "a daemon pops jobs and fires them at local inference" is not new — it is assembling three
things that ship today.

## What does NOT exist — the two gaps this section fills

The queue is **claim-when-seen**. Nothing schedules. Two specific holes:

### 1. No *business* due-date on the invocation
`budgets.deadlineMs` is a **loop** deadline — kill a runaway turn. It is not *"this reply is due
Friday."* The scheduling this section needs is driven by a **`due_at`** the agent infers from the
work itself (the *implied-due-date-from-the-email-body*): "can you review this by EOD Thursday"
→ `due_at = Thu 17:00`. That field does not exist; T1 adds it.

### 2. No deadline-and-budget-aware policy
Today the first runtime to see a `pending` invocation claims it. This section adds a scheduling
function over `(due_at, cost estimate, remaining budget, which runtimes are free)` that decides
**whether a given runtime may claim it *yet*.** The policy:

- **Far from due → free runtimes only.** A `@local` homelab daemon may claim; the paid cloud
  runtime holds off. The work sits *optimistically*, hoping alpaca picks it up for $0.
- **Near due → escalate.** As `due_at` approaches and no free runtime has claimed, the paid
  cloud runtime becomes eligible — spend now, because the deadline is real.
- **Out of budget → assigned, but free-claimable only.** `spendPerMonth` exhausted does not fail
  the invocation; it *narrows who may claim it* to free runtimes until budget resets or a
  `@local` runtime grabs it. The pull model already supports "assigned but unrun"; this is the
  policy that says *why* it sits.

This is the `feed.works` insight exactly: cheap/free capacity is best-effort and patient; paid
capacity is reserved for what is actually due. The scheduler spends the *last* dollar on the
*next* deadline, not the first job it sees.

## The `defer` connection — human and machine, one signal

The decline taxonomy (`decline-taxonomy.md`) retires `notNow` into a **`defer`** action. `defer`
and this scheduler are the same instruction from two directions:

- **Human `defer`**: "correct proposal, not due yet — re-surface later." Sets/extends `due_at`.
- **Scheduler `defer`**: "not due yet, wait for a free runtime." Reads `due_at`.

So a human deferring a proposal and the scheduler letting an invocation sit are the *same*
policy over the *same* field. `defer` is the manual override of the automatic optimism, and it
is why the taxonomy split matters here.

## Why T5 is load-bearing, not incidental

The escalation decision — "is it worth spending paid budget now, or wait for free?" — is a
**cost** decision, and it is impossible without a cost estimate. `s07` T5 gave the queue:

- `cost_micros` per past invocation of this `kind` → an **estimate** for the next one.
- `provider` → which runtimes are *free* (`@local`/`workers-ai` → 0) vs paid.
- the token facts → the `$/work` optimisation that decides *which* model a deadline-pressed run
  should escalate to (cheapest that meets the quality bar).

The scheduler is where the `$/work` job (flagged in T5) actually lives: **tokens/work × $/token,
spent against a deadline.** T5 recorded the facts; s11 spends them.

## Non-goals / cautions

- **Not a general job queue.** This schedules *agent invocations* against *inference budget and
  deadlines*. It is not a cron, not a task runner.
- **The watchdog still wins on liveness.** §8's cloud-watchdog guarantee is about *"did anyone
  claim it"*; s11's optimism must never let a `due_at`-passed invocation sit unclaimed — near-due
  escalation and the watchdog are complementary, and the watchdog is the backstop.
- **Do not infer `due_at` silently and wrongly.** A mis-extracted deadline that reads *"due in an
  hour"* would burn budget on non-urgent work. `due_at` extraction is a proposal the human can
  see and correct, not a hidden field — surface it on the approval row next to the two clocks.

## References

- `docs/architecture/agent-integration.md` §2 (pull queue), §6 (runtimes), §8 (watchdog)
- `packages/mailstore/sql/data-plane.sql` — `agent_invocations` (`claimed_at`, and s07 T5's cost columns)
- `.plans/s07-app-surface/devPlan.md` T5 — the cost facts this spends, and the `$/work` forward-reference
- `.plans/s03.D-coexistence/decline-taxonomy.md` — the `defer` action, the human side of this
- `~/.casa-studio/` — LiteLLM (:4000) and Ollama on alpaca, the free `@local` inference this optimises toward
