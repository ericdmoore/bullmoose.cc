# 022 -P2- Spike: measure GraphQL resolver cost on D1 + Workers

**Subsystem:** common · **Severity:** MEDIUM (decision-blocking) · **Fix class:** INVESTIGATE

## Why this exists

`docs/architecture/mcp-auth.md` §14 was revised: the security arguments against a
model-facing GraphQL surface don't hold up (they conflate a public-anonymous threat model
with an authenticated agent under budget, and JMAP has the same unenforced exposure —
see `common/005`).

What's left is **one operational unknown**, and it is the actual gate on the decision:

> Can a GraphQL resolver graph traverse mail → contacts → calendar on **D1 inside a
> Worker's CPU budget**, with batching?

If yes, the split in §14.5 (JMAP for standard clients, GraphQL for agents + our own
webmail) becomes attractive. If no, that is the honest reason to decline.

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
- `.plans/s03.C-webmail-floor` — if GraphQL wins, its JMAP client module changes shape.
  Worth deciding **before** that slice starts.
