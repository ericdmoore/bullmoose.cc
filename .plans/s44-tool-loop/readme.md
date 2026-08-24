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

## Venue indifference (Eric, 2026-08-24) — one harness, two homes

*"For the end-user I would like to design the system to the point where they
are indifferent to where the job was invoked."* Named as an invariant,
because most of it already holds and the loop is where it would quietly
break:

- **The tool vocabulary lives server-side, ONLY.** `tools/list` is the
  platform's answer for both venues — cloud in-process, CLI over HTTPS with
  the `bmi_` token — and neither runtime defines a tool locally. The moment
  the CLI grows a local tool (a filesystem read, a shell), the venues fork
  capability and indifference is dead. This is also the deep reason
  venue-local-tool frameworks (sausheong/harness, reviewed 2026-08-24) were
  declined.
- **The loop spec is a CONFORMANCE ARTIFACT**, the pattern the repo already
  trusts twice (scopes.json, the help artifact): golden transcripts — given
  this model output, the harness parses/refuses/retries/stops THIS way —
  generated once, replayed against both implementations. Two harnesses, one
  oracle; drift is a red build, not a bug report.
- **What may differ is measured, never semantic**: latency, cost, declared
  capability facets (no vision → the claim gate routes elsewhere). The user
  sees identical proposals, rationale and refusal sentences; the venue
  appears only in the dossier's receipt — which cashier rang you up.

The prior art: s43's eleven invariants were this contract for template mode
(L0 as a wire format, byte-pinned by a Go test that reads the cloud source),
and s45 slice 3 finished the receipt half — a homelab run lands in the same
columns a cloud run does.

## Cloud-defined sandboxes (Eric, 2026-08-24) — compute as a server-side tool

Cloudflare Sandbox (containers driven from a Worker: exec/runCode/files,
configurable egress, per-container isolation) resolves a tension this plan
had merely suppressed. "No bash tool, ever" was two objections fused: the
VENUE FORK (a CLI-local shell makes capability differ by where you run) and
the BLAST RADIUS (code amid the user's real files and credentials). A
sandbox defined in OUR Worker un-fuses them — the definition lives
server-side like every other tool, both venues reach it through the same
tools/call door, and what executes is disposable. Eric's framing is the
architecture: an RPi invokes elephant-sized sandboxes and looks mousey in
the mirror — compute asymmetry between venues DELETED, capability facets
left to what genuinely differs (models).

Admissible under this plan's posture on four containment rules:

1. **No credentials inside, ever.** The sandbox receives data the harness
   wrote in — never tokens; its user-scope is the invocation id, not the
   human. Compute is "act on this data", never "act as this person".
2. **Egress OFF by default.** Outbound is configurable, and that is where
   the new hole lives: attacker-steered code exfiltrating what the harness
   fed it. v1 allowlist: empty.
3. **Harness-mediated I/O, size-bounded both ways** — and stdout gets the
   L0 treatment on return, because sandbox output is attacker-INFLUENCEABLE
   content re-entering the context window. Data to read, framed as such.
4. **Metered and stamped.** Sandbox minutes are real money; they land in
   the s45 cost columns, budget-bounded like tokens.

What it unlocks: **the attachment family** — the ladder's missing row.
Bullmoose cannot open a spreadsheet today. "What did we spend, per the
attached CSVs"; the .ics parse s36's UID-merge wanted; format conversion;
ledger crunching. Tier-two problems where the unknown is the COMPUTATION,
which no read-only noun serves and no model should eyeball.

**The image is the provisioning layer (Eric's npx question, 2026-08-24).**
`npx <pkg>` at run time is egress plus unpinned third-party code — refused
by rule 2, and rightly. The capability moves one layer down: the sandbox
IMAGE (node with vendored parsers, sqlite, python+pandas) is part of the
server-side tool definition — baked, pinned, reviewed once like any tool
admission. The model steers WHAT code runs against the data, never WHICH
software exists. And the sqlite-over-CSV shape is the pattern at its
purest: the model writes the query, the ENGINE computes the answer, and
the SQL rides back as the citation — the sieve-rule instinct (generation
is fallible; verification is deterministic; the artifact is reviewable)
applied to data instead of filters.

**The image request — grant-request, image edition (Eric, 2026-08-24).**
An agent that hits a missing capability completes honestly as
blocked-on-capability and emits a PROPOSAL: "I'd benefit from <lib>
because <reason>". A research invocation may investigate the liability
(maintenance, CVEs, native bindings, install scripts, transitive deps) and
its output rides the proposal as EVIDENCE — the ask arrives carrying its
dossier. The human decides (beneficiary-cannot-self-approve, s10,
unchanged), and because approval widens the image FOR EVERYONE it is an
operator-level admission reviewed once — which buys software provenance by
the rulebook's own mechanism: every binary in the image traceable to the
ledger row that admitted it. Approval enqueues a SUCCESSOR invocation (the
sieve-retry mechanics verbatim); whether the re-run even uses the lib is a
MEASUREMENT, not a guarantee — the request recorded a real miss, and
approved-but-never-used libs are a dossier stat and their own finding.

**Lifecycle — the box is INVOCATION-SCOPED, and every timer agrees with
the ledger.** Born at the invocation's first sandbox call; kept warm
across THAT invocation's turns (exec → inspect → exec needs its
intermediate files); killed at completion — graceful shutdown already
guarantees the kill fires on a runtime restart. Backstops: a wall-clock
cap derived from the binding's budget, and a TTL reaper for orphans (the
stale-running reaper's sibling). NEVER a standing box: a warm home
directory across invocations is where a poisoned file waits for the next
job — the security argument and the billing argument reach the same
verdict. Sandbox-seconds land in the s45 cost columns per invocation.

**The free lane keeps its zeros (Eric's pricing question, 2026-08-24).**
The sandbox's DEFINITION being server-side never required its EXECUTION to
be: a capable homelab may satisfy the same tool contract LOCALLY — the
same pinned image in a container on the box, identical interface, held to
the identical conformance transcripts. The host declares `sandbox: true`
as a capability FACT; the claim gate routes on it; an RPi declares false
and its sandbox calls run cloud-side, metered and stamped. Knowability of
need comes in three tiers: the attachment family is knowable AT ENQUEUE
(MIME types set `requires.sandbox` deterministically, no prediction);
mid-loop needs are unknowable by definition (that is what the loop is),
but the harness sees the call before money moves; and the ledger ITEMIZES
after — "model: $0 · sandbox: $0.00x" — because free was always measured
zero, never an identity.

Sequencing: after the first tool family — it is tool N+1 through the same
door, with the same per-tool injection review, not a new architecture.

## The ladder of problems — what each tier buys (Eric's question, 2026-08-24)

What separates the tiers is WHAT IS UNKNOWN in advance:

| tier | unknown | examples |
|---|---|---|
| **now** (template) | nothing — question known, evidence pre-fetchable | extract, reply draft, hold, sieve rule, classify, thread summary, anticipated reconcile joins |
| **loop** (tier 3 machine) | WHERE the evidence is — the model picks the next look | "who is this sender?" enrichment; mailbox-grounded Q&A with citations ("did we settle the venue?" — also s33's hr@ story); reply drafts that VERIFY claims against history; extraction back-filled from prior threads (s36's own wish); "prep me for Dana" briefs (s16/s34 composites) |
| **beyond** (loop + envelope + time) | the STEPS themselves — they will surprise | multi-week errands ("family reunion weekend": calendars → outreach proposals → watches → reconcile → holds); "renew the insurance" (Files + a thread over weeks; goal milestones become investigations); backlog negotiation with per-item evidence; the CRM as a STANDING process |

Tier two keeps the shape "one final artifact, writes still proposals." Tier
three has egress INSIDE it, which is why it requires the envelope section
above and not merely the plumbing: checkpoints stay non-negotiable, payment
still ends at a prepared handoff. The progression is the chief-of-staff
framing arriving on schedule: clerk, then researcher, then staff work.

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
