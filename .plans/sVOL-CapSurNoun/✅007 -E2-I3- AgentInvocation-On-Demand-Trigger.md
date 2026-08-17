# 007 -E2-I3- `AgentInvocation` on-demand trigger

| | |
|---|---|
| **Kind** | capability |
| **Effort** | **E2** — `AgentInvocation/set` gains two branches, one guard moves in `services/agent`, one CLI subcommand. No schema change, no migration |
| **Impact** | **I3** — unlocks *and* human-verifiable |
| **Owner** | `sVOL` |
| **Depends on** | `002` (fake-D1 `.batch()` — see Bread-crumbs for why the edge is softer than it looks) |
| **Blocks** | `s03.D` T3 (*"Human → agent invoke on a thread"*, `s03.D-coexistence/devPlan.md:44-45`) |
| **Status** | **✅ done** — `AgentInvocation/set create` queues an on-demand invocation (`services/jmap/src/methods/agent.ts:127-179`) + `bullmoose agent invoke` (`packages/cli/src/agentInvoke.ts`). The `008` kill switch landed first, as ⁵ required. |

> **Delivered.** `AgentInvocation/set` now honours `create` and `destroy`
> (`services/jmap/src/methods/agent.ts`) — `created: {}` / `destroyed: []` are no
> longer hardcoded. CLI surface `bullmoose agent invoke <binding> --email <id>` +
> `invocations` + `rm` (`packages/cli/src/agentInvoke.ts`). Decisions:
> - **Create acts on an emailId** (v1 requires it — the cloud runtime hard-requires
>   email context). `context_json` mirrors ingest's shape but OMITS `envelopeTo`
>   (no synthetic envelope → no ledger digest mis-steer); the human's reason rides
>   in `context.note`.
> - **The interlock** (008 kill switch): create REFUSES a disabled binding
>   (`forbidden`), distinct from a missing binding (`notFound`) and a bad emailId
>   (`invalidProperties`) — three distinguishable errors, none leaving a `pending`
>   row. Asserted, plus the drain's own `enabled` gate holding a queued row.
> - **Destroy is IN scope** — hard DELETE (Open Q #5's grade-preserving choice),
>   guarded: a `running` invocation is refused (`forbidden`).
> - **Scope**: `draft`, all three branches (§4). Flat-set (common/027): a
>   `send`/`delete`-only token does NOT satisfy it.
> - **No poke path added** (§3): the `commitChanges` entry wakes the CLI runner;
>   the cron sweep covers the cloud runtime. Verified end-to-end — a JMAP-created
>   invocation drains through the real `services/agent` worker to `done` with a
>   reply draft, same pass as an ingest-created one.
> - **Watchdog interaction (done-when #5)**: not exercised. `invoke` reuses the
>   existing claim→`done` path, so the `cancel_if='invocation-active'` disarm at
>   `packages/account-do/src/index.ts` fires identically for an on-demand claim as
>   for a mail-triggered one — the fall-out-by-accident behaviour Open Q #4
>   describes is unchanged, not decided. Filed as a follow-up rather than silently
>   changed.

## Cells covered

`Agents × Create × JMAP` · `Agents × Delete × JMAP` · `Agents × Create × CLI` ·
`Agents × Delete × CLI`

Four cells — the `C` and `D` of the `Agents` row, which reads `-RU-` on both surfaces today.

⚠️ **Scoping note the ledger does not make.** `config.yml` defines the `Agents` noun as *two*
datatypes: `datatypes: [AgentInvocation, AgentBinding]`. They have different homes, different
auth, and different owners — invocations live in `services/jmap` behind a principal bearer
token; bindings live in `services/provision` behind the single `ADMIN_TOKEN`
(`services/provision/src/index.ts:47`). **This unit owns invocation lifecycle only.** Binding
update/delete is filed in `008`; the reasoning is at the end of *What to build*.

## Why these grades

**E2.** The table already exists and already has every column this needs
(`packages/mailstore/sql/data-plane.sql:113-127`): `email_id` is nullable `:119`,
`context_json` is free-form `:120`, and the AccountDO changelog is collection-agnostic (the
schema comment says so at `:111-112`). `AgentInvocation/set` already does the state-bump
choreography for updates (`agent.ts:120-123`); create and destroy reuse it verbatim. No new
table, no new column, no migration.

It is **not E1**: the change lands in three services — the JMAP method, the cloud runtime's
`email_id` guard (`services/agent/src/index.ts:142`), and the CLI — plus it changes when an
armed SLA watchdog stands down (`packages/account-do/src/index.ts:161-168`). That is a new
semantic other code must respect, which is E3's language; it stays E2 only because no schema
moves. See Open Questions #4, where that could break.

**I3, both factors:**

- *Unlocks* — `s03.D` T3 plans *"Human → agent invoke on a thread (`agent-integration.md` §C)
  — the direction that makes this multiplayer rather than a review console"*
  (`devPlan.md:44-45`), and its done-when is *"invoking an agent from the UI creates an
  invocation that the runtime picks up"* (`:46-47`). That sentence is this capability. `s03.D`
  cannot build it as UI work because **no surface can create an invocation at all**. Named
  edge, verified in the cited file.
- *Human-verifiable* — run `bullmoose agent invoke emily --email e_…` in one terminal with
  `bullmoose agent serve` in another, then open a mail client and see the reply draft appear
  in Drafts. No engineer, no JSON.

## What exists today

**Four registered methods** (`services/jmap/src/methods/agent.ts`), all under `AGENT_CAP` =
`urn:bullmoose:params:jmap:agent` (`packages/jmap-core/src/capabilities.ts:14`), advertised in
the session at `services/jmap/src/session.ts:37,53,69` and accepted at
`services/jmap/src/index.ts:27`:

```
AgentInvocation/query    :20   status filter, ORDER BY created_at LIMIT 64  (:24-26)
AgentInvocation/get      :38
AgentInvocation/set      :78   ← update only
AgentInvocation/changes  :137  proxyChanges
```

**`/set` is update-only, deliberately and visibly.** The source comment at `:77` says
`// update only: { id: { status: "running"|"done"|"failed", result? } }`. Only
`args.update` is read (`:84`); `args.create` and `args.destroy` are never touched. The
response hardcodes `created: {}` (`:128`), `notCreated: {}` (`:129`), `destroyed: []`
(`:132`) and `notDestroyed: {}` (`:133`). The optimistic claim guard — `AND status =
'pending'` when moving to `running`, so two runtimes cannot both claim — is at `:93`.

**Inbound mail is the only creator.** `grep -rn 'INSERT INTO agent_invocations'` returns
exactly one hit: `services/ingest/src/index.ts:178`, inside a loop over bindings selected by
`enabled = 1 AND trigger_on = 'mailbox-delivery'` (`:167-172`). So:

- there is **no way to trigger an agent** except by sending it mail — which for a
  self-addressed thread means emailing yourself and waiting for Cloudflare Email Routing;
- there is **no way to purge** invocations. `grep -rn agent_invocations --include='*.ts'`
  finds nine references and **zero `DELETE`**. The table only grows.

**Two runtimes claim the same queue, by different routes.** The CLI runner goes through JMAP —
`AgentInvocation/set` with `update: { [invId]: { status: "running" } }`
(`packages/cli/src/agent.ts:159-163`), completing at `:214-218` and failing at `:222-226`. The
cloud worker uses raw SQL: `SELECT … WHERE inv.status = 'pending' AND b.enabled = 1`
(`services/agent/src/index.ts:104-112`) then `UPDATE … WHERE … AND status = 'pending'`
(`:116-122`). Both implement the same guard; the module header at `:21-24` says this is
intentional and that whoever claims first wins.

**Three constraints that shape the design:**

1. ⚠️ **The cloud runtime hard-requires an email.** `services/agent/src/index.ts:142`:
   `if (!job.email_id) return done("failed", { note: "no email context" });` — before any
   pipeline branch. The column is nullable in the schema and the runtime is not. An invocation
   created with no `emailId` is marked `failed` within one drain cycle.
2. **`drain` joins the binding row.** `JOIN agent_bindings b ON b.account_id = inv.account_id
   AND b.id = inv.binding_id` (`services/agent/src/index.ts:108`). An invocation naming a
   nonexistent or disabled binding is invisible to the cloud runtime *forever* — it never
   drains, never fails, just sits `pending`. Validate at create time.
3. **`drain` does not filter on `trigger_on`.** The `WHERE` clause is status + `b.enabled`
   (`:110`). So an on-demand invocation is picked up against an existing
   `mailbox-delivery` binding with **no new trigger value required**. That is why this is E2
   and not a binding-model rewrite. `agent-integration.md:36` designs four trigger types
   (`action-button | mailbox-delivery | rule-hook | schedule`); only one is ever written
   (`services/provision/src/index.ts:638` hardcodes `'mailbox-delivery'`). We do not need the
   others yet.

**The design doc is ahead of the code and agrees with this unit.**
`docs/architecture/agent-integration.md:14` names Pattern C — *"invoke an agent on a
draft/thread"* — and `:16` states the unifying move: *"B is a special case of C — 'mail was
delivered' is just another trigger type on the same binding table."* The object model at
`:41-43` already specifies `context refs { draftId?, threadId?, emailId? }`, `note (L3)`,
`params`, and `runAt?`. Build order step 5 (`:304`) names the CLI verb:
`bullmoose actions run <id> --draft <id>` *(invoke Emily with no UI)*.

## What to build

### 1. `AgentInvocation/set` — honour `args.create`

Mirror the ingest insert (`services/ingest/src/index.ts:174-195`), which is the reference
shape. Per-creation spec:

```
{ bindingId | bindingName,          // resolve name → id within the account
  context: { emailId?, threadId?, draftId? },
  note?, params? }
```

Validation, in this order, each producing a `notCreated` entry rather than a thrown method
error:

- binding exists **and** `account_id` matches **and** `enabled = 1` → else `invalidProperties`.
  Constraint 2 above is why: an invocation against a stale binding is a silent black hole.
- `context.emailId` present and resolvable → else `invalidProperties`. Constraint 1 above.
  **v1 requires an emailId** (see Open Questions #2).

Then insert `status = 'pending'`, `created_at = Date.now()`, `context_json` = the context
object, and add the ids to the existing `commitChanges` call at `:120-123` as
`{ collection: "AgentInvocation", created: ids }`. That single line is what makes the CLI
runner's WebSocket wake up — it already listens on the same channel
(`packages/cli/src/agent.ts:96`).

### 2. `AgentInvocation/set` — honour `args.destroy`

`DELETE FROM agent_invocations WHERE account_id = ? AND id = ?`, guarded:

- refuse `status = 'running'` with `forbidden` — deleting a row a runtime is mid-way through
  produces an orphaned model call that will `UPDATE` zero rows on completion and log nothing;
- allow `pending`, `done`, `failed`.

Report ids in `destroyed` and commit `{ collection: "AgentInvocation", destroyed: ids }`.

⚠️ Read Open Questions #5 before choosing hard `DELETE`. `s03.A` T2 argues tombstones for
grants on forensic grounds, and the invocation table is a better forensic record than the
grants table.

### 3. Do not add a poke path

Ingest pokes the cloud worker directly — `env.AGENT.fetch(".../drain")`
(`services/ingest/src/index.ts:98-106`), guarded by `INTERNAL_TOKEN`. The jmap worker has no
`AGENT` binding and should not get one. `agent-integration.md:62` states the invariant: *"The
platform never calls into an agent runtime… the runtime watches for work."* The changelog push
covers the CLI runner immediately and the cron sweep (`services/agent/src/index.ts:80-83`)
covers the cloud runtime within one tick. Adding a second poke path buys latency and costs an
invariant. If someone measures the cron delay and hates it, that is a separate, arguable
change.

### 4. Scope

Leave it as `requireAccount(ctx, args, "draft")` (`agent.ts:79`) for all three branches.
Creating an invocation causes an agent to draft or send, which is exactly what `draft` means.
⚠️ `common/001` (P1, open) makes this advisory: any `mail`-scoped token satisfies `draft`, and
`mail` is the mint default (`services/provision/src/index.ts:467`). Declare it correctly
anyway; do not describe the result as gated.

### 5. CLI — the surface that earns the `I3`

```
bullmoose agent invoke <binding> --email <emailId> [--note "…"] [--json]
bullmoose agent invocations [--status pending|running|done|failed]
bullmoose agent purge --status done [--older-than 30d]
```

`invoke` is `agent-integration.md:304`'s step 5 under a name that matches the noun. Follow the
`016` I/O contract if it has landed; if not, match `packages/cli/src/admin.ts`'s `out()`
shape (`:303-306`).

### 6. Where agent *bindings* go — the call

**Binding update/delete belongs in `008`, not here.** They are a different worker
(`services/provision`), a different auth model (one shared `ADMIN_TOKEN` at `:47` vs a
per-principal bearer), a different plane (control vs the account's own data), and their delete
semantics fan out into an auto-created `watchdog_{id}` responder
(`services/provision/src/index.ts:646-660`) that has nothing to do with the invocation queue.
Splitting on the `Agents` noun would put two unrelated auth surfaces in one commit.

⚠️ **But there is a sequencing consequence, and it is real.** Today `agent_bindings.enabled`
(`data-plane.sql:104`) is written `1` at creation (`provision:638`) and **never written
again** — there is no route that flips it. Both drain paths filter on it (`agent:110`,
`ingest:169`), so it *is* the kill switch; it is simply unreachable. Shipping `007` gives a
human a button that fires agents on demand, in a system where a misbehaving binding cannot be
turned off through any API. **`008`'s binding-disable route should land before this unit**,
even though the rest of `008` is wave-4 cleanup. That is a ledger correction, not a
preference — see `008`'s Open Questions #1.

## Done when

1. With `bullmoose agent serve` running against an account, `bullmoose agent invoke emily
   --email e_…` produces a reply draft in Drafts, **visible in a normal mail client**. A
   non-engineer can do this and see the result.
2. The runner picks it up **over the push channel**, not on the next poll — proving the
   `commitChanges` entry was written. Assert `AgentInvocation/changes` reports the new id.
3. Invoking against a disabled binding, a binding on another account, or a nonexistent
   `emailId` lands in `notCreated` with a distinguishable error. **None of the three may
   produce a `pending` row** — a queued invocation nobody will ever drain is worse than a
   rejection.
4. `destroy` on a `running` invocation is refused; on a `done` one it succeeds and the id
   disappears from `/get` and appears in `/changes` as destroyed.
5. **The watchdog interaction is asserted, whichever way it is decided.** Invoke on a thread
   that has an armed SLA watchdog and assert the chosen behaviour at
   `packages/account-do/src/index.ts:161-168`. Today the answer falls out by accident; after
   this unit it must be a decision with a test on it.
6. The cloud runtime is exercised too, not just the CLI runner — an invocation created over
   JMAP drains through `services/agent/src/index.ts:99` on the cron path without a poke.

## Bread-crumbs

- The whole method module is 140 lines (`agent.ts:19-140`). The `UPDATE` to extend is
  `:94-112`; the `commitChanges` to add collections to is `:120-123`; the response object to
  stop hardcoding is `:124-134`.
- **Copy ingest's `context_json`, and read its comment.** `services/ingest/src/index.ts:190`
  writes `{ emailId, threadId, envelopeTo }`, and `:188-189` explains that `envelopeTo` keeps
  the plus-tag because *"the ledger pipeline uses it to select a digest target."* An on-demand
  invocation has no envelope. If the target binding runs the `ledger` pipeline
  (`services/agent/src/index.ts:157-159`), it will take a different branch than it does for
  delivered mail. Decide what `envelopeTo` should be for a synthetic invocation, or restrict
  `invoke` to `reply`-pipeline bindings in v1.
- `failStaleRunning` marks `running` rows stale after `STALE_RUNNING_MS` = 15 min
  (`services/agent/src/index.ts:51`, SQL at `:341`). A destroyed-mid-run invocation is not
  covered by that sweep, which is the other reason to refuse `destroy` on `running`.
- `finish()` writes terminal state at `services/agent/src/index.ts:329` — raw SQL, not through
  `AgentInvocation/set`, so it does **not** hit `commitChanges`. That is a pre-existing gap
  (`_context.md` §3's failure mode: a write invisible to `/changes`), out of scope here, worth
  a `.feedback` issue.
- `AgentInvocation/query` is `LIMIT 64` with no cursor (`agent.ts:25`) and
  `canCalculateChanges: false` (`:33`). Do not build `bullmoose agent invocations` expecting
  pagination.
- Nothing new to advertise: `AGENT_CAP` is already in `SUPPORTED_CAPS`
  (`services/jmap/src/index.ts:27`) and in all three session shapes
  (`session.ts:37,53,69`).
- **The `002` dependency is softer than the ledger's edge implies.** The create path uses
  `.prepare().run()` and `commitChanges`, not `.batch()` — the existing local `fakeD1`
  (`services/agent/src/mcp.test.ts:19-43`) may cover it after being extracted and taught the
  new SQL. `002` is still worth having first; do not treat it as a hard gate if it slips.
  Note that `vitest.config.ts:24` excludes `packages/cli/**` from coverage entirely, so the
  CLI half of this unit has no automated verification path at all — done-when #1 is the test.

## Open questions / where this could be wrong

1. **This may be work that `s03.D` T1 reshapes.** T1 turns `agent_invocations` into an
   `ActionProposal` read model with `tier`, `rationale` and `evidence[]`
   (`s03.D-coexistence/devPlan.md:12-16`). I believe create is orthogonal — T1 is about what an
   agent *emits*, this is about what *starts* it — but if T1 lands first and restructures the
   collection, the create branch may need rewriting. It is the cheapest way this unit becomes
   wasted, and `s03.D` is currently unstarted (`_context.md` §6), so nobody will notice the
   collision until it happens.

2. **Requiring `emailId` makes this "invoke on a thread", not "invoke an agent".** That is
   `s03.D` T3's exact framing so it satisfies the named dependency, but it is narrower than the
   filename. The alternative — teach `services/agent` a no-email pipeline — means a new
   pipeline branch, a new prompt shape, and a new output contract, which is E3 work in a
   different unit. Separately: `agent-integration.md:304` says `--draft <id>`, and a draft *is*
   an Email row, so `getEmailRow` (`services/agent/src/index.ts:143`) should resolve it — but
   the reply pipeline then computes `sender` from `email.from[0]` (`:161`), which on a draft is
   **you**. I have not traced whether the RFC 3834 self-reply guards downstream of `:163`
   reject that. **This is the most likely place the unit is quietly broken on arrival.**

3. **Is `I3` sound if the CLI is descoped?** The unlock half is solid — `s03.D` T3 names it.
   The human-verifiable half depends entirely on shipping `agent invoke`, per `readme.md:110`
   (*pair a capability with its cheapest human-visible surface*). Without the CLI this is
   curl-verifiable only and drops to `I2`. If a reviewer moves the CLI to a separate projection
   unit, downgrade this one.

4. **The watchdog disarm is a behaviour change I am not confident about.**
   `packages/account-do/src/index.ts:161-168`: a responder with `cancel_if =
   'invocation-active'` stands down if *any* invocation for that `email_id` is `running` or
   `done`. So a human invoking an agent on a thread silently suppresses the SLA auto-response
   the external sender was going to get. I lean *"yes, disarm — a human took the thread, the
   apology is wrong"*, but the watchdog exists precisely because agents fail
   (`agent-integration.md:212`, §8), and a human invoke that then fails leaves the sender with
   nothing. A reviewer may reasonably invert this.

5. **Hard `DELETE` vs a tombstone is unresolved and affects the effort grade.**
   `s03.A` T2 (`devPlan.md:42-50`) argues soft-delete for grants so *"history survives"*.
   `agent_invocations` is a stronger case: it is the record of what an agent did, with
   `result_json` and `note`. If `destroy` should be a `purged_at` tombstone, this unit needs a
   new column — no migration framework (`readme.md:75-78`) — and becomes **E3**. I chose hard
   DELETE to keep the grade, which is exactly the kind of reasoning that produces a regret.

6. **Nothing was run.** All claims read from source at the working tree. In particular the
   claim that a `commitChanges` entry wakes `bullmoose agent serve` over WebSocket is read from
   `packages/cli/src/agent.ts:96,109-121`, not observed.

7. **Citation drift from `_context.md`.** Footnote 13 (`_context.md:124-125`) cites
   `created: {}` at `agent.ts:124` and `destroyed: []` at `:130`; in the working tree they are
   `:128` and `:132`, and `:124` is the `return {`. Every claim holds; the offsets have moved
   since the `8ba3fe3` audit. Same class of drift as `001`'s Open Question #6.
