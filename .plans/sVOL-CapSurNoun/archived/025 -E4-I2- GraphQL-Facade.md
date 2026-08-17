> **ARCHIVED 2026-08-14 — wontfix.** Kept for the reasoning, not as pending work.
> JMAP already provides the three things GraphQL is adopted for: batched multi-call
> requests, `#ref` back-references chaining one call's output into the next, and
> `/changes` as a real incremental-sync cursor. A facade would be a second vocabulary
> over identical data, with its own schema to keep in sync and its own auth surface to
> get wrong. **`.plans/s19-transports/readme.md` is the live document** — it records why
> a `graphql` *scope* would be a category error, and why a facade (if one is ever
> genuinely needed for a client that cannot speak JMAP) is resolvers over the existing
> method registry rather than any new authorization.
>
> Revisit only on an external client that cannot speak JMAP — not on the merits of the
> idea, which were settled.

# 025 -E4-I2- GraphQL facade

| | |
|---|---|
| **Kind** | projection |
| **Effort** | **E4** — a new protocol surface |
| **Impact** | **I2** per the ledger — unlocks, not human-verifiable. The *unlocks* leg is thin; see *Open questions*. |
| **Owner** | **`.feedback/fromClaude/common/022`** (P2, INVESTIGATE) + `docs/architecture/mcp-auth.md` §14 |
| **Depends on** | **the spike returning a number.** Nothing else. |
| **Status** | **wontfix — archived** (Eric, 2026-08-13). The `common/022` spike was never needed: JMAP already has all three properties GraphQL would be adopted for — batching (a request is an array of method calls), cross-call references (`#ref`), and incremental sync (`/changes`). A facade would be a second vocabulary over the same data with its own auth surface to get wrong. See `_index.md` §2 fn 11. |

## Cells covered

Potentially **every noun × GraphQL** — the whole empty column in `_index.md:13-28`.

Realistically the first scope is three entities read-only: `Email`, `ContactCard`,
`CalendarEvent` — the traversal the spike itself measures
(`common/022.fix.md:10-11`). Writes are a separate question governed by
`mcp-auth.md:748-751`: *writes go through shared `Mailstore` methods, never
per-projection SQL* — the same rule `_context.md` §3 states for every new write surface.

## The gate is a measurement, not an opinion

`mcp-auth.md` §14 (`:681`) is explicit that this is *"a live decision gated on one
measurement — not a settled 'no'"* (`:686`). §14.1 (`:695-701`) retires the old security
arguments; §14.6 (`:788-799`) states what is left:

> **Measure where the ceiling is, not what the average costs.** … Workers' CPU limit is a
> **cliff, not a gradient** — an over-budget request is killed, not slowed. So the
> question is: *how deep a traversal, over how many rows, before a request dies?*
> — `mcp-auth.md:790-794`

The deliverable is a number and a recommendation, explicitly **not** a service
(`022.fix.md:5-6`). The risk is not slowness: it is a traversal that works on a small
inbox and hard-fails on a 50k-message one with no warning between (`022.md:17-21`).

## The nuance that must not be lost: this gates agents, not webmail

§14.5 (`:753-786`) splits the audiences and reaches **different verdicts**:

| Surface | Verdict | `mcp-auth.md` |
|---|---|---|
| JMAP → standard clients | keep | `:757` |
| DAV → Apple Contacts/Calendar | keep | `:758` |
| **GraphQL → agents** | **strong case** | `:759,762-764` |
| **GraphQL → webmail** | **weak case — a toss-up** | `:760,766-779` |

The webmail case is weak for two concrete reasons, both verified:

1. **JMAP already does batched traversal and we support it.** Back-reference resolution
   (`#key` / `resultOf`, RFC 8620 §3.7) is implemented in
   **`packages/jmap-core/src/dispatch.ts`** — the resolver is `:63-89`, called from the
   dispatch loop at `:47`. Webmail can already chain *"query the thread's emails, then get
   the senders of those results"* in one POST. GraphQL's round-trip win is largely
   already available.
   > Ref correction: this unit's brief cited `services/jmap/src/dispatch.ts:63-83`. There
   > is no `dispatch.ts` under `services/jmap`. `mcp-auth.md:769` has the correct path.
2. **Webmail's hardest problem is sync, and sync is JMAP's best feature**
   (`mcp-auth.md:773-776`). `Foo/changes` + `state` + AccountDO push exist across every
   realm. GraphQL subscriptions are live event push, not *"give me the delta since state
   X"*; adopting GraphQL for webmail would mean reimplementing `/changes` on top of it.

**Therefore this unit does not block `021` / `s03.C`.** `common/022.md:68-77` carries an
explicit ⚠️ *Sequencing correction* saying so: *"this spike does not block s03.C. Webmail
proceeds on JMAP either way. The spike gates only the agent-facing surface, which is
s04/harness territory."*

## What `sVOL` adds

1. **The two feedback files contradict each other on exactly this point.** The main issue's
   correction (`022.md:68-77`) supersedes an earlier draft — but the `.fix.md` was not
   updated: its final bread-crumb (`022.fix.md:62-63`) still reads *"Sequencing: do this
   before `.plans/s03.C-webmail-floor` T1, since that task builds the webmail's one JMAP
   client module and a GraphQL decision would change its shape."* Anyone who reads the
   fix file and stops there will block the largest slice in the arc on a spike that no
   longer gates it. **`022.fix.md:62-63` should be deleted or rewritten to match.**
2. **The facade-vs-parallel-stack line is already decided and is not the spike's to
   reopen.** Facade only (`mcp-auth.md:727-737`): same `Mailstore`, auth by directives
   calling the same `authorizeAccount`. A parallel data/auth path is refused regardless of
   the number (`022.md:63-64`). `anglebrackets` projecting CardDAV off `Mailstore`
   (`dav.ts:106`) is the precedent.
3. **`common/001` weakens the field-level auth story here too.** `hasScope` treats `mail`
   as universal (`_context.md` §4), so `@requiresScope`/`@grantScoped` would inherit the
   same hole `anglebrackets` did (`mcp-auth.md:743-747`). The spike must include
   field-level authz for at least one field (`022.fix.md:53-56`) or it measures the wrong
   thing.

## Open questions / where this could be wrong

1. **Does this actually *unlock* anything?** `I2` requires a **named** dependency removed
   (`readme.md:89-90`). The beneficiary is the agent-facing surface, which lives in `s04`
   — and `s04` has **zero tasks** (`_context.md` §6). No named blocker to remove means a
   strict reading grades this **`I0`**. I left `I2` because the measurement is a named
   input to a decision `mcp-auth.md` §14.5 commits to recording, and the grade becomes
   correct the moment `s04` acquires tasks. Weaker than the `023` disagreement, but worth
   a reviewer's eye.
2. **`E4` may overstate a facade.** The anchor says "new protocol surface"
   (`readme.md:73`), which this is — but a facade over an existing store with auth already
   centralized is closer in cost to `013`'s MCP tool layer than to building webmail. The
   rubric cannot distinguish them.
3. **A negative spike result is a good outcome** (`022.fix.md:47-49`) and would *close*
   this unit rather than complete it. The ledger has no status for "resolved: won't
   build"; `deferred` is the nearest fit and reads wrong.
