# Jobs, facets, and the switchboard — replacing the race without breaking the pull

> Design note from the 2026-08-13 discussion (Eric's InvocationSwitchBoard sketch). Extends
> [`readme.md`](./readme.md)/[`devPlan.md`](./devPlan.md); nothing here contradicts them —
> this names the _shape_ the eligibility policy grows into, and adds two pieces the plan
> did not have: **Jobs (the DAG)** and **the fleet host**.

## 1. The core swap: gate the claim, don't dispatch the work

The sketch's `ROUTING(InvocationSwitchBoard, with DefaultCase)` reads like a dispatcher —
something that _sends_ each invocation to a backend. Do not build a dispatcher. The pull
model is load-bearing for security: the platform never calls into a runtime; claimants
authenticate in. A switchboard that pushes inverts that and reopens the door the Bureau
closed.

The swap that keeps the property: **unconditional claim → policy-gated claim.**

- **Facets** are computed where the sketch says (at enqueue, by ingest/creator) and stored
  on the invocation.
- **Eligibility** is evaluated at _claim time_ — `mayClaim(facets, runtime, budgetState,
now)` (devPlan T2, unchanged) — because it is time-dependent: the same invocation that
  only a free runtime may claim at 9am is claimable by paid cloud at 4pm.
- The claim's guarded UPDATE gains the eligibility predicate. The race does not disappear;
  it shrinks to a race _within the eligible set_ — and a race among equals is just load
  balancing. The problem today is not that claiming races; it is that the set is "everyone,
  and the cloud gets poked first."
- **DefaultCase** = an invocation with no facets behaves exactly like today (anyone may
  claim; watchdog SLA applies). The switchboard must be a total function, and its default
  is the current behavior — new facets tighten, never strand.

## 2. Facets — constraints, not prescriptions

The sketch's facet list, adjudicated:

| sketch                         | verdict                      | landing shape                                                                                                                                                                                                                              |
| ------------------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `initiated_kind: human\|agent` | ✅ exists in spirit          | the trigger + `last_writer` provenance already carry it; surface, don't duplicate                                                                                                                                                          |
| `from`                         | ✅ exists                    | the invocation's context refs                                                                                                                                                                                                              |
| `dueDate`                      | ✅ already T1                | `due_at`, inferred-and-correctable                                                                                                                                                                                                         |
| `requiredPrivacyScore: 0–10`   | ⚠️ **class, not score**      | see below                                                                                                                                                                                                                                  |
| `effort_hint: low…max`         | ✅ as a _prior_              | seeds the cost estimate until per-kind history exists; history beats hints, facts beat vibes                                                                                                                                               |
| `model_req: <modelID>`         | ⚠️ **capability, not model** | `requires: {tools?, contextTokens?, vision?}` + a quality floor. Prescribing the model is front-matter in a new hat; requirements constrain, the optimizer chooses. (A literal pin stays possible as a debug flag that _smells_ like one.) |
| `has_sub_steps`                | ✅ but bigger                | not a facet — a **Job** (§3)                                                                                                                                                                                                               |

**Privacy is a class, not a score.** A 7-vs-6 privacy score enforces nothing — no gate can
act on it, and scores invite arithmetic ("average privacy") that is meaningless. Use a small
enum with checkable meanings, e.g. `open | internal | pinned` where each level answers real
boundary questions: may it leave the LAN? may it transit a paid API? may the prompt be
logged? Same argument as micro-USD over floats: pick a representation where invalid
reasoning is unrepresentable. `pinned` is the s11 devPlan decision 0 pin.

**The verifiability axis is real, and it lands as DAG nodes, not a facet-flag.** A
`verify: none | second-model | human` requirement appends _verifier nodes_ after the work
node (§3) — verification becomes ordinary scheduled work with its own cost, runtime and
audit, instead of a boolean nobody enforces.

## 3. Jobs — the DAG, and progressive revelation without front matter

Today an invocation is atomic and trigger-born. The Job generalizes it **without new
machinery for the nodes**:

```
Job:   job_id, aggregate budget {costMicros, maxNodes, maxDepth}, originating binding
Node:  an ordinary agent_invocation + job_id + needs: [node ids]
Rule:  a node is claimable when status=pending AND all needs are done
       (the migrations runner's `needs` pattern, applied to work)
```

- **Parallel subagents fall out for free.** Every unblocked node is simultaneously
  claimable — by _different_ runtimes. Alpaca takes three cheap summarize nodes while the
  cloud takes the near-due synthesis node. That is "subagents in a connected push" with
  zero new execution machinery: the DAG is data, the claim loop is unchanged.
- **The planner node is the progressive revelation.** A Job starts as ONE node carrying
  goal + facets. Its first node may be a decomposition ("plan") whose _output is the rest
  of the DAG_. The plan is not front matter — it is produced at runtime, inside the work,
  by a model. `has_sub_steps` is not declared; it _happens_.
- **Decomposition cannot mint authority.** Child nodes inherit the originating binding's
  identity, grants, governing book, and tier gates — expansion decides _structure_, never
  _permission_. The Job's aggregate budget caps the fan-out (N nodes cannot each spend the
  per-invocation cap), and `maxNodes`/`maxDepth` are the runaway-planner backstop.
- **Failure and questions compose.** A failed node blocks its dependents (Job status is
  derived, not stored); a `needsInfo` on one node pauses that subtree only. Side-effectful
  leaves still land in `/approvals` — the Job changes how work is _organized_, never how it
  _egresses_.
- **Join nodes** (multiple `needs`) receive their dependencies' results as context — the
  synthesis step.

## 4. The fleet host — one daemon, N agents, zero per-agent logins

Today `bullmoose agent serve` is one binding per process (`cfg.binding`, singular), and
agent mailboxes are separate accounts — so five agents on alpaca means five processes and
five tokens. Wrong shape. Two changes:

1. **One process, many bindings.** The daemon becomes a fleet host: one WS connection, one
   claim loop, a table of binding → backend configs.
2. **Runtime-as-principal, discovery from grants.** The daemon logs in ONCE as a runtime
   principal (`alpaca-daemon`). Each agent account **grants** that principal claim
   authority — the existing cross-account grant machinery (`grantee_account_id`,
   `authorizeAccount`) already expresses this. On connect the daemon asks "which bindings
   have granted me claim?" and serves that set. Adding a sixth agent to alpaca = minting
   one grant, no daemon restart, no new login. Revoking one agent's homelab claim =
   revoking one grant, instantly, without touching the other five. The local backend
   config (which Ollama, which keys) stays local — it describes alpaca's _capability_,
   not any agent's _identity_.

This also kills the last front matter Eric objected to: the daemon no longer declares which
agents it serves; the grants _are_ the declaration, made by the accountable party (each
agent's owner), revocable per-agent, and visible in the console like every other grant.

## 5. Second-pass resolutions (2026-08-13, cont.)

**The WHERE-clause formulation is blessed — with one security note.** Eric's framing:
claimants see the invocation table through a WHERE clause and sort by their own strengths.
Exactly right, with the enforcement point pinned: **the server derives the WHERE from
facets + the claimant's grants/capabilities; the claimant may narrow it further
(preference, ORDER BY), never widen it.** Eligibility is enforced in the guarded UPDATE
server-side — a hostile claimant that self-filters generously still cannot claim outside
its set. Preference is client-side; eligibility is not.

**Effort/budget facets are derived, never asked.** Nobody hand-writes `effort_hint` per
message. Sources, in precedence order: (1) mechanical derivation at enqueue — message
length, attachment MIME types, kind; (2) history — median cost of this kind/binding (T2's
estimate, already specced); (3) the binding's standing defaults. Humans only _correct_,
exceptionally, the same way due_at is inferred-surfaced-correctable. If a facet requires
routine human data entry, it is designed wrong.

**Capabilities are also derived.** "Message is LONG" → context-length requirement;
"attachment is an image" → vision requirement. Computed at ingest from the work itself, no
model call needed.

**The verification ladder** (facets.verify → appended verifier nodes, cost rising with
level; the default level should follow the _tier_ of the proposed action):

| level                 | check                                                                                                              | cost                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------- |
| **L0 mechanical**     | output parses against the contract (JSON schema — the forced `submit_result` already does this)                    | free, harness-level, exists |
| **L1 evidence**       | output must cite sources; a cheap verifier node confirms the citations resolve and the quoted text appears in them | cheap node                  |
| **L2 second opinion** | independent verifier node, _different_ provider/model, refute-framed prompt                                        | real node                   |
| **L3 human**          | the `/approvals` tier gate — already the ultimate verifier                                                         | human attention             |

**Attenuation is monotonic down the tree.** Eric's rule, promoted to invariant: a
sub-task's tools, credentials, and budget are always a **subset of its parent's**.
Delegation attenuates, never amplifies — the object-capability discipline, applied to
decomposition. Combined with §3's "decomposition cannot mint authority," the tree is safe
at every depth by construction: the Job's ceiling is the binding, and every level below
only lowers it.

**Vocabulary settled:** Job → **tasks** → **sub-tasks** (level 3+ are all just
"sub-task"). Two distinct relations, both needed, never conflated:

- `parent_id` — context + authority inheritance (the attenuation chain);
- `needs: [...]` — execution ordering (usually siblings). A task's _parent_ gives it its
  ceiling and its context; its _needs_ give it its start time.
  Plus `job_id` denormalized onto every row for cheap whole-Job queries.

**No new queues — states and views over ONE table.** The direct answer to
"pending_task_queue vs pending_job_queue vs Inprogress_job_queue": none of them exist as
tables. There is one physical queue (`agent_invocations`, extended); every "queue" is a
WHERE clause — the same §1 insight applied to storage:

- _pending task queue_ = `status='pending' AND needs satisfied` — claimability is
  **computed in the claim query** (a NOT EXISTS over unmet needs), not stored. A stored
  `blocked` flag is derived state that can drift; the membership-chain lesson
  (fold-vs-book) applies verbatim: never store what you can derive, or you own a
  reconciliation problem forever.
- _in-progress job queue_ = a **view**: Job status is derived from its tasks (all pending
  → pending; any done/running → in progress; all done → done; failure among blockers →
  stalled). The Looking-Ahead / approvals surfaces render Jobs with progress from the same
  rows.
- The Job row itself stores only what cannot be derived: the aggregate budget, the caps,
  the originating binding, the facets.

At bullmoose scale the derived-state queries are noise; if a hot path ever hurts,
materialize _then_, with the reconcile test that materialization owes.

## 6. Facet authorship, claimant capabilities, and the boundary (third pass)

### Who/what/how sets a facet — nobody hand-authors, and each facet has ONE author class

| facet                               | author                                                                                                      | when                                     |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| size / MIME / thread refs / `from`  | **ingest** (mechanical)                                                                                     | enqueue                                  |
| sender class (ham / spam / unknown) | **the boundary agent** (§bouncer)                                                                           | enqueue                                  |
| privacy class                       | **binding floor ∨ boundary stamp** — see the floor rule                                                     | config-time ∨ enqueue                    |
| `due_at`                            | **boundary extraction** (deterministic patterns; model only where the binding opts in); NULL = never-urgent | enqueue, correctable on the approval row |
| effort prior                        | boundary (length/attachments) → replaced by **history** as it accrues                                       | enqueue → claim                          |
| verify level                        | **policy from the action tier**, not per-message                                                            | claim/plan                               |
| corrections                         | **human**, on the approval row                                                                              | any time                                 |

Note the move this forces on the devPlan: T1 had the _claiming agent_ infer `due_at` — but
eligibility needs `due_at` **before any claim exists** (sit-free vs escalate is a pre-claim
decision). Extraction moves to the boundary; the claim gate reads it, the approval row
corrects it.

**The floor rule (the one real danger of boundary stamping).** A mis-stamped privacy facet
is not a cosmetic bug: `open` stamped on what should be `pinned` routes private mail to a
paid cloud model. So privacy composes **max-wise against a binding-level floor**: a binding
declares "my work is never below `internal`," and a facet stamp can _raise_ the class,
never lower it below any implicated floor. Boundary stamps tighten; floors are config,
written once, enforced structurally. A compromised boundary can then delay or over-tighten
work — annoying, visible — but cannot leak it downward.

### The claimant's side: authority vs fit — two vectors, never confused

Eric's question: the authN'd actor stipulates hard filters — but don't we also need the
host's _capabilities_ (can it even run vision)? Yes, and they are different kinds of bound:

```
eligible(task, claimant) =
      authority(claimant.grants)          -- MAY it act        (server-verified, hard)
    ∧ fit(claimant.capabilities, facets)  -- CAN it succeed    (self-declared at connect)
    ∧ policy(facets, budgetState, now)    -- SHOULD it, yet    (mayClaim, time-varying)
-- claimant preference = ORDER BY within the eligible set, never a widener
```

Capabilities (vision, context length, tools, GPU) are **self-declared** at connect — and
that is safe _because they gate fit, not authority_. Lying about authority would be a
security hole; lying about capability just means claiming work you will fail, which the
stale-claim sweeper reaps and **history punishes**: per-runtime failure rates feed the same
score machinery as everything else, so a chronically over-claiming host loses eligibility
the honest way. Never let a capability claim widen authority: declaring "vision" earns
vision _tasks_, not vision _permissions_.

### bouncer@ — the boundary is an agent, and it stamps the lobby

The boundary layer is itself an agent **kind** (a fourth, joining analyst/photos/
newsletters): uniquely shaped, because it sees ~every inbound message and sits on the hot
path.

- **Deterministic first, model only on the mid-band.** Sieve / nested rejection rules run
  as fast-path deterministic compute — cheap, auditable, and **immune to prompt injection
  by construction** (rules cannot be talked out of). Only mid-range scores reach a model,
  and its output is a classification enum, never a free action. Latency: the deterministic
  path keeps p50 flat; mid-band screening may briefly hold mail in a screening state.
- **Sender-classification first** (Eric's instinct, adopted as the starting point): spam is
  a _sender_ problem before it is a message problem. And sender classes land on machinery
  that already exists — **address books**: bouncer's known-good and blocked sets are books,
  so classification changes get CRUD on every protocol, CardDAV inspectability, a
  `write_policy`, and the membership **chain** — a sender reclassification is a logged,
  attributed membership event. Message-by-message rescue ("show me, let me pick the one
  that is NOT spam") stays available as the quarantine-view escape hatch, deliberately
  secondary.
- **The quarantine log is another append-only chain.** "Did I get mail from X in the last
  N days? Did you shunt it?" is an audit query over shunt events (event, sender, reason,
  at). "Pass that sender through" is a **human-originated directive** → the s10 decision-5
  pattern verbatim: authenticated owner directive, applied with provenance, auto-approved;
  the reclassification lands in the book with the chain row citing the directive.
- **And because bouncer already reads everything: it stamps the facets.** Ingest stays
  mechanical (parse, dedup, store); bouncer is the _named identity_ for enqueue-time
  judgment — sender class, privacy stamp (floor-bounded), due extraction, effort prior —
  before the invocation enters the **lobby** (the pending pool eligible claimants see).
  Facet-stamping is exactly admission work, and admission is what a doorman is for. The
  floor rule above is what makes concentrating this power at the boundary safe: the
  doorman decides who gets in and how urgently — never what anyone inside is allowed to do.

The recurring pattern is worth noticing: books for sets, chains for history, proposals for
authority. bouncer@ introduces no new primitive — it is the fourth kind assembled from the
same three.

## 7. Names (proposed)

| concept                                | name             | why                                                                        |
| -------------------------------------- | ---------------- | -------------------------------------------------------------------------- |
| the constraint bundle on an invocation | **facets**       | Eric's word; they are read-many, written-once-ish, and non-prescriptive    |
| the claim gate                         | **`mayClaim`**   | already in devPlan T2; "switchboard" implies dispatch, which §1 rejects    |
| the DAG                                | **Job**          | plain; a Job _has_ invocations, an invocation _belongs to_ at most one Job |
| a Job's decomposition step             | **planner node** | its output is DAG, not prose                                               |
| the homelab process                    | **fleet host**   | it hosts claims for a fleet of bindings it does not own                    |

## 8. What stays sacred, whatever the scheduler becomes

1. **Pull, never push** — the platform never calls a runtime; gating happens at claim.
2. **Authority rides the binding** — no facet, plan, runtime or backend choice can widen
   what an identity may do; the governing book and tier gates do not know the scheduler
   exists, and must not need to.
3. **Egress is `/approvals`** — Jobs reorganize work; proposals remain the only door out.
4. **Default = today** — an unfaceted invocation behaves exactly as before; the scheduler
   tightens claims, it never strands work (and the watchdog + privacy-pin precedence of
   devPlan decision 0 still wins at the boundary).
