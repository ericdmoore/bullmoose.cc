# s17 — CJ, the chief of staff

> **Status: PARTIAL.** The spine SHIPPED: Jobs + attenuation (s11 T7) and per-invocation `bmi_` tokens, all four steps (#143, #146 — see `per-invocation-tokens.md`). Step 2 (`agents:invoke`) is still deferred at `attenuation.ts`, blocked on the identity-substitution question in `agents-invoke.md`. Step 3 (CJ herself) is not started.
> powerful as she can be."* Until now CJ has existed only as a character — she is named in
> `s10`, in `motivatingExamples.md`, and, tellingly, in `actionProposal.ts` **only as the
> thing a rule protects against**: the gate is literally called *CJ-cannot-self-approve*.
> We built her constraints before we built her.

## What makes her a chief of staff rather than another mailbox agent

**Delegation.** Every other agent acts in its own lane; CJ receives something vague, decides
*which colleague* should handle it, and hands off. That capability is
`agents:invoke` — and `agent-integration.md` §4 defers it with a precise condition:

> *"`agents:invoke` (agent→agent pipelines) is deferred: if ever allowed, it needs a
> **chain-depth cap** and a **shared budget**."*

## The unlock is already designed: s11 T7 (Jobs)

The Job DAG supplies exactly those two things, plus a third the sentence did not think to
ask for:

| §4's condition | Jobs provides |
|---|---|
| chain-depth cap | `maxDepth` on the Job |
| shared budget | the Job's aggregate budget (`costMicros`, `maxNodes`) |
| — | **monotonic attenuation**: a sub-task's tools, credentials and budget are a *subset* of its parent's |

So **Jobs is not merely the next big rock — it is CJ's spine**, and the architecture said so
before either was written. Build it framed as "CJ's delegation machinery" rather than "a
DAG", so the safety properties stay load-bearing instead of decorative.

## Sequence

1. **s11 T7 — Jobs.** Tasks/sub-tasks, planner nodes, `needs` edges, aggregate budget,
   attenuation with a test that refuses an amplifying child.
2. **Un-defer `agents:invoke`** — safe *because* of (1): a delegation is just a child node
   under a parent's ceiling.
3. **CJ herself** — a binding whose planner node routes work to the right colleague, plus
   her existing bounded authority over other agents' governing books (s10 T3).

## The one thing to be careful about

**CJ is the only agent whose failure mode is systemic.** Every other agent can damage its
own lane; a chief of staff with delegation authority is one prompt-injection away from being
a confused deputy *for the whole household*. Which is why the attenuation invariant and the
aggregate budget must be **real code with tests that bite** before she gets `agents:invoke`
— not documentation. The `CJ-cannot-self-approve` gate is the existing instance of this
discipline; it should not be the last.

## References

- `.plans/s11-scheduling/devPlan.md` T7 + `jobs-and-facets.md` §3/§5 — the DAG
- `docs/architecture/agent-integration.md` §4 — the deferral and its two conditions
- `.plans/s10-agents/devPlan.md` T3 — CJ's bounded authority over governing books
- `services/jmap/src/methods/actionProposal.ts` — the self-approve gate, already live
