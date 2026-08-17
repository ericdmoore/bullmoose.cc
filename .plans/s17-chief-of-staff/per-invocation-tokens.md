# Per-invocation tokens — design, and one decision for Eric

**Status: ALL FOUR STEPS SHIPPED — #143 (a,b) and #146 (c,d).**
Written 2026-08-15 after #132/#134/#138 closed the delegation-side half; Eric
approved all four decisions the same day and #143 built the first two steps.

| step | state |
|---|---|
| (a) `bmi_` grammar, mint-on-claim, resolver | **shipped** (#143) |
| (b) MCP `tools/list` + `tools/call` gated by `mayUse` | **shipped** (#143) — but see the correction below |
| (c) Bureau credential gate | **shipped** (#146) — correct but **inert**, see below |
| (d) the two mandatory rules | **shipped** (#146) — the mechanism is no longer voluntary at MCP or create |

> ### ⚠️ Correction: gap 1 closes for Job nodes only
>
> §Q6's table below says gap 1 (MCP visibility and dispatch) **closes**. That
> was wrong, and #143 proved it.
>
> For an invocation with **no `job_id`** the envelope is `{tools: null, …}` and
> every tool passes. `effectiveNodeAuthority` short-circuits before reading the
> binding — `job_id IS NULL` is the DefaultCase, and denying there would strand
> every ordinary agent. So for the common case, an ordinary mail-triggered
> invocation, a `bmi_` token narrows the **account**, the **realm**, the
> **verbs** and the **lifetime**, but **not the tool set**.
>
> Asserted as a test (`an ordinary non-Job invocation is NOT a delegation — the
> tool axis is unbounded`) so it stays a boundary rather than becoming an
> assumption.
>
> Closing it means intersecting with the binding's own ceiling — which
> **redefines `config_json.jobs.tools` as bounding every invocation of the
> binding, not only its Job nodes.** That is a second reading of a config key at
> a consumer, exactly the drift `bindingCeiling`'s docstring exists to prevent.
> It is a decision, not a patch, and it has not been taken.

> ### ⚠️ Two more corrections, from building (c) and (d) in #146
>
> **Rule 2 as specified below is an escalation at the root.** The spec says the
> created row inherits `job_id`/`parent_id`/`depth`/`authority_json` and stops.
> But `effectiveNodeAuthority` folds the acting node's OWN binding leniently and
> every ANCESTOR's fail-closed — so when the causing node is the **root**, where
> there are no ancestors, the fold collapses to `ceiling(new binding) ∩ envelope`.
> Copying a root's envelope onto a row on a *wider* second binding on the same
> account hands the copy **more than the node it came from had**. #146 adds a
> same-binding constraint, reusing `attenuateChild`'s identity rule. It also
> copies `privacy` — a fifth column this list omits but its own cited precedent
> (the needsInfo continuation) includes, so a pinned Job cannot spawn an
> unpinned sibling.
>
> **The claim below that (d) needs `packages/cli/src/agent.ts` changed is false.**
> All three of that file's `AgentInvocation/set` call sites are `update` — claim,
> done, failed; there is no `create:` key in it, and the CLI references MCP
> nowhere. The create path is `agentInvoke.ts`, the human on-demand trigger on an
> **unmarked** token, which rule 2 deliberately does not reach.
>
> ### (c) shipped but is INERT
>
> Nothing forces an agent to present a `bmi_` at `/bureau/use`: the two mandatory
> rules cover MCP and create only. An agent-marked device token still reaches the
> Bureau with full standing grants and no envelope — and `/bureau/use` has **no
> production caller at all** (`services/agent` calls only `/internal/bureau/seal`
> and `/internal/bureau/verify`). So the gate sits ahead of its first caller, and
> whoever writes that caller chooses which credential to present.
>
> A symmetric **third rule** — *an agent-marked bearer may not use `/bureau/use`
> except through an invocation token* — is what would make (c) enforcement rather
> than availability. **Not built:** it changes what the `agent` marker means,
> which is decision #3, ratified for two surfaces and not three. **Eric's call.**

Also worth recording from #143: `INVOCATION_STANDING_SCOPES` had to be invented,
because this document never said what standing scopes a `bmi_` token
authenticates with. An invocation has none of its own — scopes live on `tokens`
rows and the drain mints with no bearer in hand — so they are declared in code
as the union of `ToolDef.scope` over the live surface plus the `agent` marker,
explicitly excluding `vault`, `admin`, `send` and the `mail` bundle.

---

## Why this exists

Four gaps close with one mechanism. Three were found and documented in this
session's PRs and are recorded in code:

| | gap | why it is open |
|---|---|---|
| 1 | MCP tool visibility + dispatch | gates on the **bearer's principal**. `mcpNouns.ts:74`: *"MCP cannot map a bearer to one binding."* |
| 2 | Bureau credential use | `resolveBureauGrant(db, principalId, credRef, verb)` — `UseRequest` has no invocation, so the envelope's `credentials` axis has no consumer |
| 3 | `AgentInvocation/set` create | a `draft`-scoped token mints a `pending` invocation with **no envelope**; not fixable by propagation, since nothing on the request names a causing invocation |
| 4 | `agents:invoke` | deferred at `attenuation.ts`, partly on this |

`authorizeNodeUse` (`services/agent/src/useGate.ts`) already computes
`effective(node) = (⋂ bindings crossed) ∩ env(root) ∩ … ∩ env(node)`, is fully
tested, and **has no production caller**. The gate exists. The identity does not.

> Precise version of "no caller": `effectiveNodeAuthority` *does* run in
> production (`jobNode.ts:89`, `proposals.ts:252`) — but only as a fail-closed
> pre-flight asking *is the chain readable?* `mayUse`'s three axes have no
> consumer. The chain walk is exercised; the gate is not.

---

## The design

```
CLAIM (pending→running) ─mints─► bmi_<12hex>_<48hex>
                                       │
                    ┌──────────────────┴──────────────────┐
              MCP tools/call                   Bureau authorizeUse
      authorizeAccount(...) ∧ mayUse(tool)   resolveBureauGrant(...) ∧ mayUse(cred)
                                       │
                    effective(node) recomputed LIVE from rows
```

Row `agent_invocation_tokens`: `id, invocation_id, account_id, principal_id,
secret_hash, issued_at, expires_at`. **No envelope copy, no scope list.** It
carries an *identity* — "I am acting as invocation X". The *authority* is
computed from rows the holder cannot write.

**Who mints:** the claim, `pending → running`, which happens in exactly two
places (`agent.ts:318`, `index.ts:287`), both already atomic-on-race. The winner
is by construction the only party entitled to the token.

**Live, not frozen.** The resolver re-derives `effective(node)` per request, per
#132. Freezing would re-create the bug `useAuthority.ts` was written against — a
gate that trusts the column trusts whoever last wrote it — and would break
`admin agent` narrowing biting queued work.

**Lifetime is derived, not stored.** The resolver joins `agent_invocations` and
requires `status = 'running'`. `finish()` kills the token on the next check with
zero bookkeeping — the same "revocation works by making a token stop resolving"
property the whole s04 resolution rests on. `expires_at = issued_at + 15min` is a
belt against a row `failStaleRunning` never sweeps.

**Composition — the invariant that makes it safe:** the envelope is **ANDed after**
the standing check, never substituted for it. `mayUse` is a *denial* function;
`tools: null` means "no level declared this axis", never "granted". A consumer
that reads `effective` as a grant re-opens everything.

**Why it cannot be forged:** neither consumer can write the token row (the INSERT
is on the claim path only), and neither can write `agent_bindings.config_json`
(operator plane). The agent writes `authority_json` only through
`attenuateChild`/`attenuatePlan`. Control and controlled are different objects.

---

## THE DECISION

### What the ratified text says

`.plans/s04-AgentOS/arch.md:118` (**RESOLVED 2026-08-09**):

> Do **not** mint a new token type. […] It presents that token on every Bureau
> call; the Bureau verifies with **`verifyBearer`** — the same function every
> other surface uses.

### Why that shape leaks on day one

A credential `verifyBearer` accepts is, by construction, accepted by **every**
surface. The envelope's vocabulary — MCP tool names, `vault_credentials.name`
handles, micro-USD — is understood by **none** of them. So the token means
"narrow" to MCP and "an ordinary bearer" to everyone else.

Verified, not hypothetical:

- `services/agent/src/vault.ts:124` `authenticateVault` accepts any valid `bm_`
  bearer, gated on the `vault` scope alone (`:171`).
- `GET /vault/credentials` (`:288`) returns **every** credential row for that
  `principal_id`. No envelope.
- `DELETE /vault/credentials/{name}` (`:326`) removes any of them. No envelope.

An invocation token whose envelope reads `credentials: ["aws-mcp"]` would
enumerate and delete the principal's entire vault. Same class at
`services/anglebrackets/src/index.ts:52` (CalDAV/CardDAV, full calendar and
contacts at standing scope) and `services/jmap/src/index.ts:240`.

### The proposed fix, and why it is cheap

A distinct grammar: `bmi_<12hex>_<48hex>`.

`parseToken` (`packages/auth-core/src/index.ts:45`) is a strict anchored
`/^bm_([0-9a-f]{12})_([0-9a-f]{48})$/` and is the single chokepoint every reader
funnels through — including `authenticateVault`'s hand-rolled auth. So every
existing surface, **and every future surface written by anyone who reuses
`verifyBearer`/`parseToken`**, 401s on an invocation token without a line of code
being written. Fail-closed on unknown readers, for free, by construction.

### Why this is narrower than "overturning the decision"

The ratified passage's *argument* (`arch.md:123-133`) is entirely **JWT vs
opaque**, and it is about revocability: a JWT routes around both kill switches.

A `bmi_` token concedes that argument completely. It is opaque, DB-resolved, and
inherits `agent_bindings.enabled`, `grants.revoked_at`, `accounts.deleted_at` and
the new `status='running'` check identically.

What it declines is **universal acceptance** — which that sentence treats as a
benefit ("the same function every other surface uses") and which is, given that
no other surface understands the envelope, precisely the vulnerability.

So: the reasoning survives intact; one sentence's literal scope does not.

### Four things that need a yes

1. **Overturn `arch.md` OQ1's "do not mint a new token type"** (also asserted in
   `devPlan.md` T3 step 0 and `bureau.md` §13.1).
2. **A new externally-visible surface** — a bearer secret returned in an
   `AgentInvocation/set` response. Tokens have only ever come from `/auth/login`,
   `/auth/tokens`, and provision's `POST /tokens`.
3. **Change what the `agent` marker means** — from "narrows contact writes" to
   "may not use the tool surface except through an invocation token", and "may
   not create an `AgentInvocation` without presenting one". **Without this the
   mechanism is voluntary**: the harness holds both credentials and narrowing is
   opt-in. This is the one that makes it real rather than advisory.
4. **A second credential type**, in a system whose token model is deliberately
   one paragraph long.

Recommended order once decided: (a) grammar + mint-on-claim + resolver,
(b) MCP `tools/list`/`tools/call`, (c) Bureau, (d) the two mandatory rules last,
so each earlier step is independently green. (d) needs
`packages/cli/src/agent.ts` in the same commit.

---

## What self-assertion would and would not buy

Worth recording, because it is the cheap alternative and it *almost* works.

Because the envelope only ever **narrows** (it is ANDed after the standing
check), a *self-asserted* `invocationId` on the request cannot escalate at MCP or
Bureau — naming someone else's invocation only intersects you with their
envelope, and you already passed your own standing checks. That closes gaps 1 and
2 for ~150 lines and no new credential.

It does **not** close gap 3, because `create` **copies** the envelope onto a new
row rather than intersecting it. An agent could name the **root planner node**
instead of its own leaf and mint a child carrying the root's wide envelope. Same
for the budget axis, where there is no bearer-level "before" to narrow against.

That is exactly CJ's threat model: a root with broad authority delegating narrow
children, where the root's envelope is the prize. **Intra-Job envelope-hopping is
the one property self-assertion cannot provide and minting can.**

---

## Doc corrections this implies

- `docs/architecture/agent-integration.md` §4 promises scoping "to exactly the
  context ∪ the agent's standing grants" — that is **object-granular** (that
  draftId, that threadId). Our scope vocabulary has no object granularity and the
  envelope's axes are tools/credentials/budget. The delivered thing narrows a
  **different dimension** than §4 promises. Correct the doc rather than quietly
  under-deliver against it.
- `docs/architecture/mcp-auth.md` §15–16 gains: *"an invocation token is refused
  by every surface that does not understand invocations."*
- `agent-integration.md` §9's *"A fully compromised template-mode agent writes a
  weird draft. That's the bar."* will read, after this ships, as if the bar were
  met for agentic mode. **It is not.** A per-invocation token defends against a
  compromised *model*, by narrowing the trusted harness's own dispatch path. It
  does not defend against a compromised *runtime* — the fleet host holds a device
  token by architectural necessity (`packages/cli/src/agent.ts:36-44`). That
  sentence needs a qualifier in the same commit that ships this.
