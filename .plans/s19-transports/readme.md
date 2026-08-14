# s19 — resources, not transports: what a token means

> **Status: principle, already realized** (2026-08-14). Eric: *"ideally tokens carry access
> to **resources** independent of transport. A resource could be accessed over MCP, GraphQL,
> JSON-RPC — they all have their own idioms, but fundamentally you get access to the same
> resources."*
>
> That is not a change request. **It is a description of what bullmoose already does**, and
> writing it down turns an accident into an invariant.

## The principle

> **A scope names a RESOURCE and a VERB. It never names a door.**
> `contacts` means "the contacts realm", not "contacts over JMAP".

Verified 2026-08-14 across the live transports:

| transport | gates on |
|---|---|
| JMAP (`requireAccount(ctx, args, …)`) | `read`, `contacts`, `calendar`, `draft`, `send`, … |
| MCP (`mcpNouns.ts` `scope:`) | the **same words** |
| CardDAV / CalDAV (`anglebrackets`) | the same words |
| blob upload (`/api/upload`) | `draft` |

One vocabulary, four doors. A token minted for a phone works in the CLI; a token minted for
an agent works over CardDAV; nothing about the credential knows which door it will be
carried through.

## Therefore: a `graphql` scope would be a category error

Adding one would make a token's meaning depend on **which door you knock on** — the exact
confusion the flat scope set exists to prevent (`common/027`: scopes are a flat set, not an
ordered lattice). By that logic CardDAV and MCP would each need their own scope too, and
"what may this token do?" would stop having a single answer.

**The right test of the principle: adding a transport must require NO new authorization
vocabulary.** GraphQL is a good thought experiment even if it is never built — if it would
need a new scope, the scopes were transport-shaped all along.

## And yes: GraphQL would ride the same rails as MCP — because of one rule

`jmapBridge.ts` does not reach into the store. It **registers the JMAP methods and calls
them** (`registerContactsMethods`, `registerEmailMethods`, …). That is the rail:

```
        MCP tools ─┐
   GraphQL resolvers┼─→  the JMAP METHOD LAYER  ─→  mailstore
        JSON-RPC ──┘      (scope + account gate)
```

> **The rule that makes shared rails safe: a facade calls the METHODS, never the store.**
> A facade that reaches past JMAP into `mailstore` bypasses the authorization the methods
> enforce — and *that* is how a transport-specific hole appears. The scope check lives at
> the method layer precisely so no door can skip it.

So a GraphQL facade would be resolvers over the existing registry: no new scopes, no new
gate, no new auth surface. Cheap *because* the principle holds.

## Still wontfix, and for a different reason than the scope question

`sVOL 025` stays **wontfix** — not because it is architecturally hard, but because
**JMAP already provides the three things GraphQL is adopted for**: batched multi-call
requests, `#ref` back-references chaining one call's output into the next, and `/changes`
as a real incremental-sync cursor. A facade would be a second vocabulary over identical
data, with its own schema to keep in sync and its own bugs to find. *"It would be cheap"* is
not a reason to build it.

Revisit only if an external client genuinely cannot speak JMAP — at which point this
document says the work is resolvers, not authorization.

## The one thing that is NOT a scope, and might be wanted

Restricting a token **to** a transport ("this app-password may only be used over CardDAV")
is a legitimate wish and a **different axis**: a property of the credential, not of the
resource. It would be a field on `tokens` (an allowed-transport list), enforced at each
door, orthogonal to scopes — narrowing *where* a token works without changing *what* it
means. Not built; named so it is not mistaken for a scope when someone wants it.

## References

- `packages/auth-core/src/index.ts` — the flat scope set (`common/027`)
- `services/agent/src/jmapBridge.ts` — the rail: MCP over the JMAP method registry
- `services/jmap/src/methods/common.ts` — `requireAccount`, where the gate actually lives
- `.plans/s15-local-mcp/readme.md` — the same argument for the local MCP door
- `.plans/sVOL-CapSurNoun/_index.md` unit 025 — the wontfix, with the JMAP reasoning
