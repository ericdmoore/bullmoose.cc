# s44 — the tool loop · *agents that solve problems, and the envelope that approves them*

> **Status: DESIGN. Nothing built.** From the 2026-08-22 conversation — Eric:
> *"Multi turn helps get problem solving though… Cross referencing an email
> with contact info, etc is all lost with no multi-turn right?"* and, on
> governance: *"My fear is that scoping down to steps makes it too rigid —
> and approving principles seems too loosey-goosey."*
>
> Sequenced AFTER the s43 registry flip: the Go daemon is the runtime that
> gets the loop. The Node runtime is frozen and dying; teaching it tools
> would be work thrown away.

Today every model call on this platform — cloud and homelab — is **template
mode**: one call, no tools, harness does all I/O, pre-declared. That posture
is deliberate (an injected email has *nothing to call* — it fails at the
first hop, not at a permission check) and it is also a ceiling: an agent
that cannot ask a question mid-reasoning cannot solve a problem the harness
didn't anticipate. This plan is how the ceiling lifts without the wall
falling.

---

## Three machines, not one — where "multi-turn" actually lives

The conversation kept using one word for three different things. Naming them
prevents building the expensive one where a cheap one suffices:

| tier | machine | who drives | solves | example |
|---|---|---|---|---|
| 1 | **step** | harness, pre-written | anticipated joins | reconcile-before-offering: look up the event/contact the model already named (s36, SHIPPED) |
| 2 | **verified generation** | harness loop, model retries | "no guarantee on a one-shot" | sieve rule: schema → deterministic compile → engine verify → retry-with-transcript (s31 rung 2) |
| 3 | **tool loop** | model chooses the next question | unanticipated joins | "who is this sender? contacts: nothing → search past threads → it's the coach's spouse" |

Tier 1 can only answer questions written down in advance. Tier 2 can only
polish an artifact against a verifier that already exists. Tier 3 is the
genuinely new authority — the model decides *what to ask next* — and it is
the only tier this plan adds. The bouncer's sieve rule does NOT need tier 3
(the engine is a better verifier than a model turn); the unanticipated join
does. Reaching for tier 3 where tier 1/2 suffices is how the injection
surface grows without the product improving.

## The skeleton already exists — three parts, waiting

None of this starts from zero. The attenuated-authority plumbing was built
first, on purpose:

1. **The MCP server** (`services/agent/src/mcp.ts`, mounted at
   `mcp.bullmoose.cc/mcp`): stateless JSON-RPC, ten calendar/contact nouns
   (`mcpNouns.ts`) dispatching through `jmapBridge.ts` into REAL JMAP
   methods — every call passes the same `requireAccount(scope, domain)`
   gates as any client. There is no side door to grow; the tools the loop
   gets are tools that already answer to the capability wall.
2. **The per-invocation bearer.** The claim already mints a `bmi_` token,
   returned once in `updated[id].invocationToken`
   (`services/jmap/src/methods/agent.ts` claim path) — and the runtime
   currently IGNORES it. Agent-marked bearers must present it to reach
   `tools/list`/`tools/call` at all. This is the loop's credential: scoped
   to one invocation on one account, short-lived, useless to exfiltrate.
3. **The `tools` claim facet.** `HostCapabilities.tools` and `claimFitSql`'s
   `$.tools` term already gate which hosts may claim tool-requiring work.
   The facet finally gates something real.

## The loop's shape

- **Harness-owned turn budget.** N turns max (start: 4), each turn's cost
  stamped on the invocation like any other call — the binding's budget bounds
  the total, which is what keeps "on every email" meaningful when some
  invocations loop. The turn count rides the result JSON: a loop that used 4
  turns to say "no match" is signal, same as manual `+ Cal` is.
- **Wire shape:** the OpenAI `tools` array on the chat-completion request;
  `tool_calls` in the reply; harness executes; result appended as a `tool`
  message. Local-model reality check: small models emit tool calls as prose
  (the Hermes `ollama_chat/` lesson) — so tool-call parsing is fail-closed
  (unparseable → the turn ends, never "best-effort execute what the prose
  seems to want"), and the `tools` capability facet keeps tool-requiring
  work off hosts whose models can't.
- **Read-only nouns first, writes NEVER.** The loop may look things up
  (mailbox search, contact/calendar reads — the narrow reconcile-shaped
  lookups before the general ones). Anything that changes the world still
  lands as a proposal a human decides. This is not a phase-1 restriction to
  relax later; it is the design: the loop widens what the agent can KNOW,
  not what it can DO.
- **Per-tool injection review, written down.** Every noun exposed to the
  loop answers, in this plan, before it ships: *what can an injected email
  make this do? what does it enumerate? what crosses back into the context
  window?* A search tool that returns full bodies hands the injector a
  second document to speak through; returning ids + tight snippets is the
  same attenuation instinct as `summary_text_NN`'s clamp.

## The envelope — what a human actually approves

The plan/steps/principles question, resolved (2026-08-22):

- **Steps are predictions** — they die on first tool result. Approving them
  means re-approval fatigue or an approval pinned to fiction.
- **Principles are interpretations** — the model grades its own compliance,
  and untrusted text is very good at supplying reinterpretations. Eric's
  instinct ("loosey-goosey") is correct: principles do not bind, because
  nothing checks them mechanically.
- **The envelope binds**: which tools, which realms, how much budget, which
  recipients, how long. Mechanically checkable at every hop — and already
  enforced in the job graph (ceilings recomputed at every depth, never
  believed; cross-binding hops forced through handoffs that intersect both
  ceilings). An injected email can rewrite steps and reinterpret principles;
  it cannot widen an envelope, because widening is a `grant-request` that
  routes to a human, and the beneficiary structurally cannot approve its own
  ask (s10 T3).

So: **plan for judgment, envelope as contract, checkpoints regardless.**

1. The agent writes the plan (narrative + proposed steps). The human reads
   it to judge whether the ASKED envelope is proportionate. Steps revise
   freely afterward — inside the envelope, revision is autonomy.
2. Needing more mid-flight — a new tool, more budget, a new recipient
   class — is a grant-request. Existing kind, existing wall.
3. Irreversible edges stay proposals REGARDLESS of plan approval. A plan
   approval is never blanket pre-approval of egress; tier walls do not know
   or care that a plan exists. Wherever a deterministic verifier exists, the
   checkpoint carries a blast-radius line (s31's precedent).
4. Principles get their seat as PRECEDENT, not contract: every
   approve/decline with its reason is the corpus the agent (and the learning
   pipeline) reads back. Principles accumulate as measured decisions — the
   only form untrusted text cannot argue with.

The goals plane already prototypes this shape (`goal-plan` proposals,
approve/needs-info/reject, milestones as decidable rows). What it lacks is
the envelope as the EXPLICIT object of approval — today the envelope is
implicit in the binding's grants. The first tool-looping binding makes that
explicit or it ships without a contract.

## Explicitly not

- **No workflow engine.** One level of delegation stays one level; the job
  graph's attenuation is the ceiling system, not a plan DAG.
- **No write tools, ever, in this plan.** If a future case wants one, it is
  its own plan with its own fight.
- **No tool loop for pipelines a cheaper tier serves.** The reviewer's
  question for any new consumer: which tier is this, really?

## Order of work

1. The envelope surface: make a binding's grant set renderable and
   approvable as the object it already is (webmail + `agents` CLI).
2. `bmi_` round-trip: the Go daemon presents the claim's invocation token to
   `mcp.bullmoose.cc`; server-side scoping of `tools/list` to the
   invocation's account + read-only set.
3. The loop itself in the Go runtime: turns, budget, fail-closed parsing,
   per-turn cost stamps.
4. First consumer: the unanticipated-join enrichment ("who is this
   sender?"), because its failure mode is a missing note, not a wrong
   artifact.

Related: s31 (verified generation, tier 2), s36 (steps, tier 1), s43 (the
runtime this lands in), s33 (identity assurance — orthogonal wall, same
spirit), s15 (local MCP).
