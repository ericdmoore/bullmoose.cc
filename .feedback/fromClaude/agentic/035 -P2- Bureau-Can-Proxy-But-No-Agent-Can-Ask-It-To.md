# 035 -P2- The Bureau can proxy, but no agent has any way to ask it to

**Subsystem:** agentic-components · **Severity:** MEDIUM (capability stranded) · **Fix class:** ADD-CODE

## The claim

`.plans/s04-AgentOS/devPlan.md` marks **T3 (proxy runtime) done**, and it is: 90 tests in
`services/bureau`, destination binding enforced, redirects refused across origins, invariant 1
asserted on nine paths.

## The gap

`services/agent` holds the `BUREAU` service binding, but **nothing in it ever calls
`/bureau/use` with `verb: "fetch"`**. The proxy is reachable only from a test.

T3's "done when" is written at the Bureau boundary, so this is not a missed requirement — it
is the seam _between_ two done tasks that no task owns.

## What is actually unclaimed

The hard part is not the call. It is the **tool schema**, and it is a design question the
Bureau docs do not answer:

- How does a tool name a `credRef` **without naming a secret**? The whole point of the
  coat-tag is that the agent holds an opaque handle — so the MCP tool's parameter must be a
  handle the model can legitimately see and reason about, which means it must be
  human-meaningful (`"stripe-prod"`) while remaining non-sensitive.
- Does the model **choose** the credRef, or does the operator bind it to the tool at grant
  time? These are very different security postures. If the model chooses, prompt injection
  selects the credential. If the operator binds, one tool per credential.

That second question is the same shape as the one settled for Class B verbs — _who chooses
the scope_ — and it should be settled the same way, deliberately, before a tool ships.

## Consequence

Until this lands, every downstream Bureau task (T4 egress redaction, T5 Class B verbs) is
building on a runtime that has no production caller — so none of it is exercised end-to-end,
and the invariants are only ever tested against fakes.
