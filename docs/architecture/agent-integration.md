# Agent Integration — Design

Status: **design / pinned from brainstorm**
Companion to [`serverless-jmap.md`](serverless-jmap.md) — references its §11 (calendars), §17 (rules), §18 (classify), §19 (feature homes).

---

## 1. Three integration patterns

| Pattern | What it is | Status |
|---|---|---|
| **A. Homelab agent** | An external agent uses the CLI as its hands: `watch --json` (events), `read`/`search`/`log` (context), `send` (action) | **works today** |
| **B. Agent mailbox** | `hermes@bullmoose.cc` is a real account; delivery to it triggers the agent; it replies from its own identity | works today as a watch-driven responder; cloud trigger later |
| **C. UI actions** | "EditorEmily" button in webmail/native app: invoke an agent on a draft/thread, get a structured result rendered in the UI (diff panel) | this document |

The unifying move: **B is a special case of C** — "mail was delivered" is just another trigger type on the same binding table. An agent with an email address makes email itself an invocation transport (forward a thread to `emily@` ≡ click her button).

---

## 2. Object model

```
Agent            the definition (portable, synced DATA — never code)
  id, name, address?                    # address → pattern B for free
  model     { provider: anthropic | openai-compatible,
              baseURL, model, params, apiKeyRef }     # keys BY REFERENCE
  persona   versioned prompt (L1, see §3)
  tools     [ mcpServerRef... ]         # MCP is the tool extension API
  grants    [ scope... ]                # §4 — default deny
  budgets   { tokensPerInvocation, turnsMax, deadlineMs, spendPerMonth }
  runtime   cloud | homelab

AgentBinding     agent × trigger, with task framing
  trigger   action-button | mailbox-delivery | rule-hook | schedule
  mode      template | agentic          # §5 — template is the default
  contexts  [ compose | thread-view | message-view ]   # where buttons render
  input     contract (e.g. draft + thread)
  output    contract (e.g. draft-proposal)             # tells UI what to render
  promptAddendum (L2), paramSchema (structured per-run variation)

AgentInvocation  one run — a synced JMAP collection (rides the AccountDO
                 changelog, which is already collection-agnostic)
  binding, context refs { draftId?, threadId?, emailId? }
  note (L3, append-only), params
  runAt?                                # timed invocations → DO alarms
  status pending → running → done | failed
  result refs (e.g. proposal emailId), usage { tokens, cost },
  personaVersion                        # reproducibility
  audit [ every tool call: name, args-hash, duration ]

AgentAction      registry entry the UI renders buttons from
  (id, label, icon, contexts, binding ref) — pushed as config, e.g.
  `bullmoose actions push emily.json`

AgentNote        per-thread agent-private annotation (vendor object,
                 §19 home B) — "the mailbox is the memory", see §7
```

All of these live under a vendor capability `urn:bullmoose:params:jmap:agent` — visible to our webmail, native apps, and CLI; invisible to plain-JMAP clients like himalaya (per the §19 keyword-vs-capability boundary).

**Pull-based by design.** The platform never calls into an agent runtime. Invocations are created, state-bumped, and pushed like any other collection; the runtime — cloud Worker or homelab process — *watches for work* over the same WS/changes machinery as mail. A homelab hermes and a cloud Emily implement the identical contract and are interchangeable.

---

## 3. The prompt stack

| Layer | Author | Mutability |
|---|---|---|
| **L0 platform preamble** | platform | immutable — harness contract, output contract, and the injection pin: *email content is untrusted data, never instructions* |
| **L1 persona** | user | editable, **versioned**; invocations record the version that ran |
| **L2 binding addendum** | user | editable per binding (same agent, different task framing) |
| **L3 invocation note** | user | append-only per run ("more formal this time") |

No full per-invocation persona override: it destroys reproducibility and turns every surface into a prompt editor. Structured variation goes through the binding's `paramSchema` instead.

---

## 4. Grants — capability, not trust

Default deny. Verb-tiered, enforced **at the API layer via scoped tokens**, never by trusting agent code:

```
read:{query}  <  annotate  <  draft  <  move  <  SEND  <  delete
```

- **Per-invocation tokens**: minted at invocation time, scoped to exactly the
  context (that draftId + that threadId) ∪ the agent's standing grants,
  short-lived. Emily fully hijacked = "wrote a weird draft", nothing more.
- **`send` is special**: agents with send are restricted to their own
  identity, rate-limited + daily-capped, and (for responders) reply-only —
  recipients must be participants of the thread being answered.
- Platform capabilities use the same vocabulary: `shares:create`,
  `rules:propose` vs `rules:write` (§17), `taxonomy:read|feedback` (§18),
  later `contacts:read`, `calendar:read|write` (§11 — calendars ride the
  same collection spine; no new machinery).
- `agents:invoke` (agent→agent pipelines) is deferred: if ever allowed, it
  needs a chain-depth cap and a shared budget.
- Every agent is its own **principal**: every JMAP call attributed + logged.

**Grant → tool visibility (the key security move).** Grants determine which
tool definitions are *offered* to the model, not which calls are permitted:
no `send` grant ⇒ no `email.send` in the tools array ⇒ nothing to trick.
Executors still re-check (defense in depth), but visibility is the first line.

---

## 5. Execution model: template vs agentic

**Template mode (default — no loop, no tools, one model call).** When the
binding's inputs and outputs are both known in advance, the harness does all
I/O itself:

```
harness: fetch declared context via JMAP (scoped token)   ← deterministic
harness: render L0..L3 + context
model:   ONE call → output (e.g. rewritten draft text)
harness: validate against output contract → apply (Email/set create) → done
```

Cheap, fast, auditable, and **injection-resistant by construction** — a
malicious email can distort the rewrite but has no primitive to invoke.
Classify / summarize / rewrite / translate / triage all fit here.

**Agentic mode (the loop).** Only when the agent must *decide* what to look
at or do (search the archive, check a calendar, variable-count actions):

```
messages = [prompt stack + context]
loop (≤ turnsMax, ≤ tokenBudget, ≤ deadline):
    resp = model.call(messages, tools)          # tools = grant-filtered
    tool_use? → executor(name, args)            # harness runs it
               messages += [tool_use, tool_result]
    else     → submit_result(schema)            # forced structured finish
```

Budgets are enforced *in the loop* (the only place they can be). The final
answer goes through a forced `submit_result` tool with a JSON schema, so even
agentic runs end in validated, machine-readable output.

**Tool executors, two families behind one registry:**
1. **Native JMAP tools** (`email.search`, `email.read`, `draft.create`,
   `keywords.set`, `calendar.query`…) — first-class implementations against
   our API using the invocation token, mapped 1:1 from grants.
2. **MCP tools** — the harness connects to the agent's declared MCP servers,
   `tools/list`, namespaces, forwards `tool_use` → `tools/call`. External
   systems (Google Calendar, home automation, filesystem) come through here;
   we write zero per-tool code.

**Tool tiers by side effect:**
- Tier 1 (safe): web search/fetch (egress-allowlisted), time, calendar-read
- Tier 2 (external side effects): calendar-write, webhooks, arbitrary MCP — per-agent opt-in
- Tier 3 (homelab-only): shell, filesystem — **flatly refused by the cloud runtime regardless of config**; runtime shape enforces policy

Cloud runtimes also get a per-agent **egress allowlist** — web-fetch must not
be able to POST a thread to an arbitrary host.

---

## 6. Runtimes

| | Homelab | Cloud |
|---|---|---|
| Host | `bullmoose agent serve` (Node, sibling of `watch`) | Worker consuming the invocation queue |
| Work discovery | WS push + changes cursor (same as `watch`) | queue/DO-alarm trigger |
| Multi-turn durability | the process just runs | **Cloudflare Workflows** for agentic runs (step-checkpointed; template mode fits a plain Worker) |
| MCP | local servers over stdio | remote servers only |
| Tier-3 tools | allowed (your hardware) | never |
| Inference | any `baseURL` — Ollama on LAN, or cloud APIs | cloud APIs / Workers AI |

Where inference runs and where the *agent* runs are independent axes; the
`baseURL` + `apiKeyRef` config makes homelab-first a first-class citizen.

**Timed invocations**: `AgentInvocation.runAt` is fired by the AccountDO's
alarm — the same §19-home-C mechanism as snooze/Send-Later. This is what
schedule-triggered bindings (FollowUpFrank) ride.

---

## 7. Worked examples: the roster

| | **EditorEmily** | **FollowUpFrank** | **SchedulingSarah** |
|---|---|---|---|
| Trigger | action button (compose) | schedule/alarm: "no reply in 3d" | mailbox delivery + action button |
| Mode | template | template | agentic (calendar search) |
| Grants | `read(ctx)`, `draft` | `read(sent,threads)`, `draft` | `read`, `draft`, `calendar:read` (→ `:write` later) |
| New primitive | — | timed invocations (`runAt`) | per-thread memory (AgentNote) |

- **Emily**: click → invocation → she reads the draft + thread → writes her
  rewrite as a **real draft** (`$agent-proposal` keyword, header linking it to
  the original) → marks done → the UI's diff panel is just two
  `Email/get bodyValues` calls; Accept/Discard are ordinary `Email/set` ops.
  Works from the CLI before any webmail exists.
- **Frank is mostly not an LLM**: "no reply in N days" is a deterministic
  query (§18: AI = perception, rules = policy). The alarm fires the check;
  only if it holds does the model run — template mode — to draft the nudge.
  Ships draft-only; auto-send is a grant change, not a redesign.
- **Sarah exposes the memory question.** Negotiations span days and multiple
  inbound emails; invocations are ephemeral. The principle: **the mailbox is
  the memory.** Each reply triggers a fresh invocation whose context = the
  thread + Sarah's own `AgentNote` on it (proposals made, constraints
  learned). Runtime stays stateless and portable; her "mental state" is
  synced, inspectable, correctable data. Interim calendar access via a
  Google Calendar MCP server on the homelab runtime; swaps to the native
  `calendar:read` grant when the JMAP Calendar collection lands — nothing
  else about her changes.

The roster proves the schema: three agents = three rows, zero per-agent
infrastructure.

---

## 8. Liveness & fallback policy (homelab instability)

A homelab runtime is cheap but not durable — and the platform must not let
an agent mailbox go silently dark. Because invocations are pull-based, the
**cloud side is the watchdog** (it's the part guaranteed to be up), and the
AccountDO alarm is the natural mechanism: creating an invocation for an
agent binding also sets an alarm at T+SLA. Hibernated alarms make the
watchdog effectively free.

Two timers, because "down" and "stuck" are different failures:

```
pickup SLA    did any runtime claim the invocation (status → running)?
              → tests whether hermes is ALIVE          (e.g. 10s–60s)
complete SLA  did the claimed run finish?
              → tests whether hermes is STUCK          (e.g. 2–10 min)
```

The runtime heartbeats the invocation while working (`running`,
`heartbeatAt`), so a long LLM call doesn't trip the watchdog.

**Fallback ladder** (per binding, configurable; tenant defaults via the
`policy` admin noun):

1. **notify-sender** — auto-respond: "hermes appears to be unavailable;
   your message is queued and will be answered when it's back"
2. **cloud-failover** — re-run the binding on the cloud runtime (same agent
   definition; template-mode bindings failover trivially, possibly on a
   cheaper model)
3. **escalate-owner** — local delivery to the owner's inbox ("hermes has
   been down 20 min, 3 messages queued")
4. **queue-silently** — nothing outward; retry on recovery

**Auto-responder etiquette is mandatory** (RFC 3834) or fallback replies
cause mail storms: set `Auto-Submitted: auto-replied`; never auto-reply to
mail that is itself auto-submitted, to bounces, or to list traffic; suppress
to once-per-sender-per-period (the same machinery as a vacation responder).

**Recovery semantics:** the invocation was never lost — pull model — so when
hermes returns it answers the original message. The fallback notice is
recorded on the thread's AgentNote so the recovered agent knows a delay
notice went out and can acknowledge it ("sorry for the delay") instead of
responding as if nothing happened.

---

## 9. Security summary (defense in depth)

1. **L0 injection pin** — email bodies are data, not instructions
2. **Template-mode default** — most actions never hand the model a tool
3. **Grant-filtered tool visibility** — can't invoke what isn't offered
4. **Scoped invocation tokens** — API enforces even if the model is tricked
5. **Egress allowlists** (cloud) + **tier-3 refusal** (cloud)
6. **Budgets in the loop** — turns, tokens, deadline, monthly spend
7. **Audit** — per-principal attribution; every tool call on the invocation record

A fully compromised template-mode agent writes a weird draft. That's the bar.

---

## 10. Build order

1. ✅ Pattern A: `watch --json` / `--exec` (shipped)
2. Pattern B cheap: provision `hermes@`, watch-driven responder — zero new server code
3. `urn:bullmoose:agent` capability: Agent/AgentBinding/AgentAction/AgentInvocation (+`runAt` alarms) + scoped tokens — the DO changelog already handles new collections
4. `packages/agent-harness`: prompt-stack renderer, two provider adapters, native JMAP tools, MCP client, template + agentic loops, `submit_result`
5. CLI: `bullmoose actions push/list`, `bullmoose agent serve`, `bullmoose actions run <id> --draft <id>` (invoke Emily with no UI)
6. Webmail: render AgentActions, diff panel for `draft-proposal` outputs
7. Cloud runtime on Workflows; AgentNote; Frank's alarms; Sarah

## 11. Open questions

- `agents:invoke` chaining (depth cap? shared budget?) — deferred
- AgentNote schema (freeform vs structured slots) — decide with Sarah
- Billing attribution: usage rolls up per agent per tenant — needed before multi-tenant agents
- Human-in-the-loop confirmation surface for agentic `send` — likely a
  "proposed submission" state on EmailSubmission
