# s03.E — Agent console: "can Allen do that?" / "who could have?"

> **Status: SHIPPED and live.** Two of this plan's own caveats are now closed: the read interface IS served (`services/jmap/src/console.ts`), and the `introspectTools` tombstone delta is fixed.

> **Slice of the s03 web-access arc.** Shared context:
> [`../s03-webAccess/readme.md`](../s03-webAccess/readme.md) ·
> [`../s03-webAccess/arch.md`](../s03-webAccess/arch.md) §6.
>
> ⚠️ **This is the only s03 slice gated on another plan.** See "The s04 line" below.

## Why this exists

Granting an agent a capability is only safe if you can answer two questions, and they are
**different questions in different directions**:

| Question                                  | View             | Mode                                             |
| ----------------------------------------- | ---------------- | ------------------------------------------------ |
| _"Can Allen even do that?"_               | **per-agent**    | authorization — forward-looking, before the fact |
| _"Who could have messed up VendorsBook?"_ | **per-resource** | forensic — backward-looking, after the fact      |

Support tools organize per-person; security tools organize per-resource. Both are
needed, and neither substitutes for the other.

## The split inside the forensic view

"Who could have possibly done this" is really two queries against two sources:

- **who _could_** → the authorization set (grants covering the resource, **at the time**)
- **who _did_** → `grant_audit` + the s03.A provenance column

Show them **side by side** — the gap between them is itself the finding. A wide _could_
with a narrow _did_ means over-permissioning; a _did_ with no matching _could_ means
something is broken.

## What it ships

- **Per-agent:** bindings, MCP credential _references_, A2A grants, spend, recent actions.
- **Per-resource:** the could/did pair, point-in-time correct.
- Credential lifecycle (attach, rotate, revoke) and OAuth initiation.

## Non-obvious requirements

1. **Render _effective_ permissions, not raw scopes.** `hasScope` treats `mail` as a
   superset of everything except `admin` (`auth-core:50-53`). A chip labeled "mail" reads
   as innocuous while granting `send` and `delete`. Show what it _allows_.
2. **Surface dangerous combinations.** `send` + external MCP + WebFetch is an
   exfiltration path (`mcp-auth.md` §8) even though each part looks fine alone.
3. **No secret transits the site backend.** Credential entry POSTs **directly** to the
   agent worker's `/vault/credentials` — the CLI is good today precisely because
   `creds set` does that (`mcp-auth.md` §9). OAuth flows are the WebUI's _best_ case
   (nothing sensitive is typed); raw API keys are the one flow that bounces to the CLI.

## The s04 line

`s04-AgentOS` already lists _Gatekeeper · Budget Constraints · ACLs (People Accessing
Agents, Agents Accessing Tools/Data)_ — which **is** this console's subject matter.

**The line: s03.E renders and requests; s04 decides and enforces.** If this slice starts
inventing budget semantics or gatekeeper policy, it has crossed into s04 and should stop.

**Consequence:** this slice should not start until s04's model is at least _specified_
(it need not be built). Everything else in s03 can proceed without it.

## Depends on

**s03.A** (tombstones + provenance — without them the forensic view cannot be
point-in-time correct) · **s03.C** (the shell) · **s04** (the governance model, specified)

## Acceptance

1. Both questions are answerable in one screen each.
2. The forensic view is **point-in-time correct** — a since-revoked grant still appears
   for the window it was live.
3. Effective permissions are shown; no raw scope string is presented as if it were the
   whole truth.
4. No secret ever transits the site backend.
5. The views read an s04-defined model rather than re-deriving policy.

## Out of scope

Budget _enforcement_ · gatekeeper implementation · the policy engine (**all s04**) ·
named-principal file sharing (ACL epic).
