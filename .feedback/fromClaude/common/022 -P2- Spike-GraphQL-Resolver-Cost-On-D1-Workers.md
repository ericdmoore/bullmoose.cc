# 022 -P2- Spike: measure GraphQL resolver cost on D1 + Workers

**Subsystem:** common · **Severity:** MEDIUM (decision-blocking) · **Fix class:** INVESTIGATE

## Why this exists

`docs/architecture/mcp-auth.md` §14 was revised: the security arguments against a
model-facing GraphQL surface don't hold up (they conflate a public-anonymous threat model
with an authenticated agent under budget, and JMAP has the same unenforced exposure —
see `common/005`).

What's left is **one operational unknown**, and it is the actual gate on the decision:

> **Where is the ceiling?** How deep a traversal, over how many rows, before a resolver
> graph on D1 exceeds a Worker's CPU budget?

**Framing matters here.** Resolver overhead at personal-mailbox scale is a *utility tax* —
a fine price for better-shaped data, and not worth optimizing. The reason to measure at
all is that **Workers' CPU limit is a cliff, not a gradient**: an over-budget request is
**killed**, not slowed. So the risk isn't slowness — it's a traversal that works on a
small inbox and hard-fails on a 50k-message one, with no warning in between.

If the ceiling is comfortably far away, the case in §14.5 (GraphQL for **agents**) is
attractive. If it's close, that's the honest reason to decline — not §14.1's arguments.

## What makes this non-obvious

- **N+1 is the default failure mode.** A naive resolver turns one query into dozens of D1
  round trips. DataLoader-style batching fixes it, but on Workers the batching window is
  bounded by the event loop within a single request — it is not the long-lived process
  DataLoader was designed for.
- **Workers CPU budget is small.** `packages/auth-core/src/index.ts:60-66` already records
  that a 10ms CPU cap drove the client-side-PBKDF2 design — so CPU, not wall-clock, is the
  binding constraint here too.
- **D1 round trips are the cost**, not query complexity per se.

## What would make the answer clear

A throwaway Worker (not merged) implementing **one** realistic agent traversal:

```graphql
{ email(id: $id) {
    subject
    from { contactCard { name, emails } }        # → contacts
    from { upcomingEvents(limit: 3) { start } }  # → calendar
} }
```

Measure, batched and unbatched:
- **D1 statements executed** (the number that actually matters)
- **CPU ms** against the Workers limit
- **wall-clock** vs the equivalent 3–4 JMAP calls it replaces

## The comparison that decides it

Not "is GraphQL fast" — but **is one GraphQL query cheaper than the 3–4 JMAP method calls
an agent would otherwise make**, given that in an agent loop each tool call is also a
**model round trip** (§14.3). The bar is not "as fast as one JMAP call"; it is "cheaper
than the sequence it replaces."

## Related

- `mcp-auth.md` §14.4 — facade vs parallel stack. This spike only informs the **facade**
  option; a parallel stack is refused regardless.
- `services/anglebrackets/src/dav.ts:106` — the existing proof that multi-projection over
  `Mailstore` works.

## ⚠️ Sequencing correction

An earlier draft of this issue said the spike should land **before**
`.plans/s03.C-webmail-floor` T1, because a GraphQL decision would change webmail's client
shape. **That is no longer true** — §14.5 now concludes the webmail case is weak
(JMAP back-references already batch, `dispatch.ts:63-83`; and sync, webmail's hardest
problem, is JMAP's best feature with no GraphQL equivalent).

**So: this spike does not block s03.C.** Webmail proceeds on JMAP either way. The spike
gates only the **agent-facing** surface, which is s04/harness territory.
