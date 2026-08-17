# 015 -E2-I1- Self-introspection over MCP (`help@`)

|                |                                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Kind**       | projection                                                                                                         |
| **Effort**     | **E2** — `services/agent`, plus one widening in `auth-core`; no schema change, no migration                        |
| **Impact**     | **I1** — human-verifiable, unlocks nothing named                                                                   |
| **Owner**      | `sVOL`                                                                                                             |
| **Depends on** | `001` (ToolDef scope+domain)                                                                                       |
| **Status**     | **done** — `services/agent/src/introspectTools.ts` + `introspect.test.ts` (38 tests). See _Shipped_ at the bottom. |

## Cells covered

`Agents × Read × MCP` — bindings and invocation history.
`SystemAdmin × Read × MCP` — grants and the `grant_audit` trail, **narrowed to the caller's
own accounts** (see _What to build_; the noun is `SystemAdmin` but the tool is emphatically
not an admin tool).

`Secrets × Read` is **not** covered and never will be: `bureau.md` invariant 1 — there is no
"reveal password" button (`_index.md` §4). Credential _names and metadata_ are a different
thing and are discussed below.

## Why these grades

**E2, but on the E1 line.** The tool definitions themselves are a handful of bounded queries
in `mcp.ts` — that reads like E1. Three things push it over:

1. `handleToolCall` **requires** a self-asserted `accountId` on every call
   (`services/agent/src/mcp.ts:250-253`) and authorizes exactly that one account at `:257`.
   Introspection's most natural question — _"what can I reach?"_ — is inherently
   cross-account, and cannot be expressed under the current dispatcher. That gate has to
   grow a path for account-less tools, which is a change to shared dispatch, not a new row
   in `TOOLS`.
2. `MethodDomain` is a closed union — `"mail" | "contacts" | "calendar"`
   (`packages/auth-core/src/principal.ts:207`). An honest domain for this surface is none of
   those, so either the union widens (a change in another package, with
   `grantCoversDomain` `:209-214` to keep consistent) or the tools ride on `mail`, which is
   a lie the audit log then records. Either way it is not one file.
3. It needs its own tests, and the disclosure boundary below is the entire substance of the
   unit — untested it is worse than absent.

**I1 — human-verifiable, unlocks nothing.**

- _Human-verifiable_: you ask _"which agents can read my contacts?"_ and read the answer.
  That is the literal acceptance test, and it is the literal example in the source document
  (`docs/agents/motivatingExamples.md:218`).
- _Unlocks nothing_: no unit in `_index.md` and no `sNN` section names this as a blocker.
  `s03.E` renders the same data but is gated on `s03.A`, `s03.C`, and an `s04` spec — not on
  this. See open question 1; this is the grade I am least sure of.

**Sequencing.** `_index.md` §3 puts it in wave 4 ("cheap cleanup, any time"), which is right
— it is the only wave-4 unit that produces something a person can _ask a question of_, so it
is a good one to do when you want a visible win cheaply.

## What exists today

**This is `help@`.** From `docs/agents/motivatingExamples.md:215-221`, under _Meta_:

> - _help@_ (answers questions about _your own_ bullmoose)
>   - "Which agents can read my contacts?" · "Why did editor@ skip that email?"
>   - Requires
>     - ReadAccess: agent bindings, grants, invocation history
>   - Self-documenting, and it's the natural conversational face of the s03.E console

Two things in that entry are load-bearing and easy to skim past. **"_your own_"** is the
whole security design, italicised in the source. And `:230` classifies `help@` as
**on-demand (ask)** rather than on-delivery — which is why MCP is the right surface for it:
the mail-delivery trigger (`services/ingest/src/index.ts:178`) is the only trigger that
exists (`_context.md` §2 fn 14), and an ask-shaped agent needs a request/response surface,
not a queue.

**The data all exists, in the same database the MCP worker already binds.**

| Data        | Read path today                                                                                        | Schema                      |
| ----------- | ------------------------------------------------------------------------------------------------------ | --------------------------- |
| Invocations | `AgentInvocation/query` (`services/jmap/src/methods/agent.ts:20`), `/get` (`:38`), `/changes` (`:137`) | `data-plane.sql:113-129`    |
| Bindings    | `GET /agent-bindings` (`services/provision/src/index.ts:100` → `listAgentBindings:665`)                | `data-plane.sql:98-109`     |
| Grants      | `GET /grants` (`provision/src/index.ts:117` → `listGrants:581`)                                        | `control-plane.sql:84-99`   |
| Audit trail | written, never read back by anything                                                                   | `control-plane.sql:103-111` |

`grant_audit` is written from **both** surfaces, with the same statement shape but different
`method` strings: JMAP writes `"${domain}:${scope}"` (`services/jmap/src/methods/common.ts:41-53`,
literal at `:50`), and MCP writes `` `mcp:${tool.name}` `` (`services/agent/src/mcp.ts:262-269`,
literal at `:267`). So the log already distinguishes "reached over JMAP" from "reached over
MCP", for free — and **nothing in the repo has ever read a row out of it**. This unit is the
first reader.

**The MCP worker binds the same D1** — `bullmoose-mail-shard0`
(`services/agent/wrangler.jsonc`, `d1_databases`), and both `data-plane.sql` and
`control-plane.sql` are applied to that one database (`tools/README.md:10-11`). So
`grants`, `grant_audit`, `agent_bindings`, and `agent_invocations` are all reachable from
`env.DB` in `mcp.ts` with no new binding and no service hop.

**Nothing is exposed on MCP.** `TOOLS` (`mcp.ts:55`) is four spend/volume aggregates.

**⚠️ The two provision routes are the wrong plumbing, and it matters.** `GET /grants` and
`GET /agent-bindings` are gated by a single shared `ADMIN_TOKEN`
(`provision/src/index.ts:47`) and are **not filtered by caller** — `listGrants` (`:581-600`)
narrows only by an _optional_ `?email=` query parameter that the caller supplies. Anyone
holding the admin token reads every grant in the deployment. Proxying those routes from an
MCP tool would hand an agent admin-plane reach through a `read`-shaped door. **Do not proxy
provision. Query D1 directly, filtered by the principal.** This is the single most important
implementation note in the unit.

## What to build

### The disclosure boundary is the feature — build it first

This tool reads **authorization state**. Every other tool in `TOOLS` reads user data, where
the gate answers "may you see this account?" once and the rest follows. Here the gate has to
answer a second question the existing dispatcher never asks: _may you see this **fact about
who else** can see this account?_

Make it a first-class constraint, not a filter bolted on at the end:

**Rule 1 — every returned row is justified by an account the caller _owns_.**
Not "can reach". `AccountAccess.granted` is present **iff** access came through a grant
rather than ownership (`packages/auth-core/src/principal.ts:24-26`), so
`decision.access.granted === undefined` is an exact, already-available ownership test. Use
it. It costs one line and is the difference between the two designs.

Why ownership and not the usual gate: `authorizeAccount(principal, accountId, "read", …)`
returns `ok` for a **grant-reached** account (`principal.ts:253-259`). So under the normal
MCP gate, `analyst@` — holding a read grant on Eric's account for one job — could ask
_"who can read Eric's account?"_ and enumerate Eric's entire grant table, learning every
other agent's binding and every other grantee's login email. Each of those rows is about a
**third party who never granted anything to `analyst@`**. The delegation Eric authorised was
"read my mail", not "read my org chart". Refuse it.

**Rule 2 — "what can _I_ do" is always answerable; "what can _others_ do" only about
accounts I own.** Two different questions, and the split is clean:

| Question                                            | Row source                                               | Allowed                                   |
| --------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------- |
| _What can I reach?_                                 | `grants WHERE grantee_account_id ∈ my accounts`          | always — this is self-description         |
| _Who can reach me?_                                 | `grants WHERE target_account_id ∈ my **owned** accounts` | owner only                                |
| _Who can reach account X?_ where X is grant-reached | —                                                        | **refused**, with a message that says why |

Note the asymmetry that falls out and should be stated rather than discovered: answering
_"who can reach me"_ necessarily discloses **other principals' login emails**
(`listGrants:591-592` resolves both sides to an identity). That is correct — you are
entitled to know who can read your mail — but it is a disclosure, and it is the reason
Rule 1 says _own_.

**Rule 3 — never `SELECT *` from a control-plane table.** Enumerate columns. `tokens`
carries `secret_hash` (`control-plane.sql:66`); `agent_bindings` carries `config_json`
(`data-plane.sql:107`), which holds personas and model routing and is not obviously free of
sensitive strings. Note that `AgentInvocation/get` already does
`SELECT * FROM agent_invocations` (`agent.ts:54`) and then hand-projects the row at
`:62-72` — copy the projection discipline, not the `SELECT *`.

**Rule 4 — no token enumeration.** "Which tokens exist and what are they scoped to" is a
credential-inventory question. It belongs to the console (`s03.E`) behind a human session,
not to an agent's tool loop. `listTokens` (`provision/src/index.ts:486-496`) exists; do not
project it here.

**Rule 5 — reading the audit log is itself auditable.** The tools go through
`handleToolCall`'s existing `grant_audit` write (`mcp.ts:262-269`) unchanged. A tool that
reads who-accessed-what must appear in who-accessed-what.

### Tool set

Small, and each one maps to a question a person actually asks.

```
whoami                     principal, scopes, owned accounts, grant-reached accounts
                           — the only account-less tool; see the dispatcher note
my_access                  grants where I am the GRANTEE — "what can I reach, and until when"
who_can_access             grants where I am the TARGET  — owner-only; "which agents can
                           read my contacts?" answered by filtering collection/scope
my_agents                  agent_bindings for an owned account — name, trigger_on,
                           sla_seconds, enabled (NOT config_json verbatim)
invocation_history         AgentInvocation/query + /get — "why did editor@ skip that email?"
access_log                 grant_audit for an owned account, windowed — "who reached this
                           account, under what scope, when"
```

`who_can_access` is the tool that answers the document's headline question. _"Which agents
can read my contacts?"_ is `grants WHERE target_account_id = mine AND (collection IS NULL OR
collection = 'AddressBook') AND scopes ⊇ read` — `grantCoversDomain` (`principal.ts:209-214`)
already encodes exactly that mapping, so reuse it rather than re-deriving the SQL.

**Render effective permissions, not raw scopes.** This is `s03.E`'s non-obvious requirement
1 (`s03.E/readme.md:41-43`) and it applies identically to a conversational answer:

> "`hasScope` treats `mail` as a superset of everything except `admin` (`auth-core:50-53`).
> A chip labeled 'mail' reads as innocuous while granting `send` and `delete`. Show what it
> _allows_."

Verified at `packages/auth-core/src/index.ts:50-53`. So a grant whose `scopes` column reads
`["mail"]` must be reported as _"read, annotate, draft, move, send, delete"_ — expand it
through `MAIL_SCOPES` (`index.ts:46`). Reporting the literal string is the failure mode: the
one tool whose job is to explain authorization would be the tool that misrepresents it.
Carry `fromClaude/common/001` (P1, open) as a note in the tool description too — until it
lands, `mail` really does satisfy `contacts`, `calendar`, and `vault`.

Second `s03.E` requirement worth importing (`readme.md:44-45`): **surface dangerous
combinations**. `send` + external MCP + WebFetch is an exfiltration path even though each
part looks fine alone. A conversational surface is arguably _better_ at this than a UI,
because it can say so in a sentence.

### The dispatcher change

`whoami` has no `accountId` and cannot get one — it is the tool you call to _find out_ your
account ids. `handleToolCall` rejects it at `:250-253` before dispatch. Options:

- add `requiresAccount?: boolean` to `ToolDef` alongside `001`'s scope/domain fields, and
  skip the account gate (and the `grant_audit` write, which has nothing to audit) when
  false — the token itself is the authorization, and `verifyBearer` (`mcp.ts:170`) already
  resolved the principal's whole account list;
- or make `whoami` take an `accountId` and answer only about that one, which is circular and
  worse.

Take the first. Keep the change to `ToolDef` in `001` so there is one shape, not two.

### Relationship to `s03.E` — same data, different face

`.plans/s03.E-console` owns this data on the WebUI and states the two views precisely
(`s03.E/readme.md:16-17`): _"can Allen even do that?"_ (per-agent, forward-looking) versus
_"who could have messed up VendorsBook?"_ (per-resource, forensic). The forensic view splits
again (`:24-31`) into **who could** (grants at the time) and **who did** (`grant_audit` plus
`s03.A` provenance), shown side by side, because _"the gap between them is itself the
finding"_ (`:29`).

**This unit is the conversational face of the same questions**, exactly as
`motivatingExamples.md:221` says. Two honest consequences:

1. **It is not blocked by `s03.E`, and does not unblock it.** `s03.E` is blocked on `s03.A`
   (tombstones + provenance), `s03.C` (the shell), and an `s04` spec
   (`s03.E/readme.md:64-65`), and it "should not start until s04's model is at least
   _specified_" (`:59-60`). None of that gates a read-only MCP tool. This unit can ship years
   earlier.
2. **It cannot be point-in-time correct, and must not pretend to be.** `s03.E`'s acceptance
   criterion 2 requires that "a since-revoked grant still appears for the window it was
   live" (`:70-71`). Impossible today: `revokeGrant` is a hard `DELETE FROM grants`
   (`provision/src/index.ts:603`), there are no tombstones (`s03.A` unstarted,
   `_context.md` §6), and `grant_audit` rows survive with a `grant_id` that no longer
   resolves. So `access_log` will show audit rows referencing vanished grants. **Say so in
   the answer** — "this grant has been revoked or deleted; the access below happened while
   it was live" — rather than dropping the row or rendering a dangling id. The gap is the
   finding, per `s03.E/readme.md:29-31`.

When `s03.E` is built it should read the same query layer this unit writes. Putting those
queries in a small shared module rather than inline in `mcp.ts` costs nothing now.

## Done when

1. A person asks Claude _"which agents can read my contacts?"_ and gets a correct,
   readable answer naming the agents and the scope each holds. That is the acceptance test
   from `motivatingExamples.md:218`, verbatim, and it needs no engineer to judge.
2. **The disclosure assertion.** A principal holding a _grant_ on another account calls
   `who_can_access` and `access_log` against that account and is **refused** — while the
   same token still succeeds on `email_query`-class tools for the same account. This is the
   test that catches the shortcut of reusing `authorizeAccount`'s `ok` as the gate; the
   refusal must key on `access.granted` being present (`principal.ts:24-26`), not on the
   authorize result.
3. A grant stored as `["mail"]` is reported as the six mail verbs it actually confers, not
   as the string `mail` (`auth-core/src/index.ts:46,50-53`). Asserted in a test, because
   this is the claim the whole tool exists to make.
4. No tool response anywhere contains `secret_hash`, a token secret, a vault value, or a
   raw `config_json`. Assert by inspecting the projected column list, not by grepping
   output — an absent value in one fixture proves nothing.
5. `access_log` on an account with a revoked grant renders the audit rows **with an explicit
   "grant no longer exists" annotation**, not a dangling `grant_id` and not a silent drop.
6. Every introspection tool call itself appears in `grant_audit` when it is grant-reached
   (`mcp.ts:262-269`), including the calls that were refused at rule 1 — a refused
   enumeration attempt is exactly the event an operator wants to see.
7. `whoami` works with no `accountId` argument and lists both owned and grant-reached
   accounts, distinguishing them.

## Bread-crumbs

- `verifyBearer` (`mcp.ts:170` → `packages/auth-core/src/principal.ts:100`) already returns
  the principal's owned accounts (`:123-141`) **and** the grant-reached ones with their
  `GrantRef`s attached (`:145-187`). `whoami` and `my_access` are almost pure projections of
  that object — no new query at all.
- `matchingGrants` (`principal.ts:217-224`) and `grantCoversDomain` (`:209-214`) are the
  scope∩domain logic. `allowedBookIds` (`:266-277`) is the collection narrowing. Reuse; do
  not re-derive in SQL.
- `grant_audit.method` is `"${domain}:${scope}"` from JMAP (`methods/common.ts:50`) and
  `"mcp:${toolName}"` from MCP (`mcp.ts:267`). Parse both when rendering `access_log`, and
  note the index is `(account_id, at)` (`control-plane.sql:111`) — window queries on
  `account_id` are cheap, anything else is a scan.
- `agent_invocations` carries `status`, `email_id`, `context_json`, `result_json`, `note`,
  `created_at`, `claimed_at`, `done_at` (`data-plane.sql:113-127`). _"Why did editor@ skip
  that email?"_ is answerable only to the extent that `note`/`result_json` were populated —
  the failure path writes `{error: …}` (`packages/cli/src/agent.ts:224`), and there is **no
  row at all** for an email that never matched a binding (`ingest/src/index.ts:175-190`
  inserts only for matching bindings). "Skipped" is often the absence of evidence; the tool
  should say "no invocation was created for that message" rather than "unknown".
- `AgentInvocation/query` hard-caps at `LIMIT 64` and filters to one status
  (`agent.ts:22-28`, default `"pending"`). For history you want `status: "done"` and
  `"failed"` as separate calls, or a direct query — the method will not give you "all".
- `AgentInvocation/set` is update-only; `created: {}` and `destroyed: []` are hardcoded
  (`agent.ts:128-132`). Do not offer a create/cancel tool here — that is `007`.
- `mcp.test.ts` (`:93-255`) has the auth-gate test shape with real `mintToken()` crypto
  (`:50`) and a grant-reached case (`:221`). The grant fixture there is the one to extend
  for _Done when_ #2.
- `002` (fake-D1 `.batch()`) is **not** a dependency — everything here is a read. That is
  why this unit can be picked up when `013`/`014` are blocked.

## Open questions / where this could be wrong

1. **`I1` versus `I2`, and whether "unlocks" is being read too strictly.** This unit
   produces the principal-filtered authorization queries, the effective-permission
   expansion, and the revoked-grant rendering that `s03.E` needs — arguably it _does_ unlock
   work. I graded `I1` because `readme.md` requires a **stated, named** dependency and no
   section names this one. If a reviewer thinks "s03.E will reuse this query layer" is
   enough, the grade is `I3` (both factors), not `I2`, since human-verifiability is not in
   doubt. That is a two-step swing on a single judgement call, and it is the most likely
   thing in this file to be wrong.
2. **Ownership-only may be too strict for the delegation case that motivates the system.**
   The `mcp-auth.md` §12 worked example has `analyst@` legitimately operating inside Eric's
   account under a grant. There is a defensible reading where `analyst@` should be able to
   ask "what am I allowed to do here?" — which `my_access` covers — but also "is anyone
   else writing to this mailbox concurrently?", which Rule 1 refuses. I think refusing is
   right (it is other principals' data, and the grantee can always ask its owner), but I
   have not thought through a multi-agent workflow where the refusal is actively harmful.
3. **`MethodDomain` widening is the ugliest part and I ducked it.** Adding a fourth domain
   means touching `auth-core`, deciding what `grantCoversDomain` returns for it
   (`principal.ts:209-214`), and answering whether a whole-account grant should confer
   introspection at all — which Rule 1 says it should not, meaning the domain would exist
   solely to label audit rows. That is a weak reason to change a shared type. The
   alternative — a `requiresAccount: false` tool that never calls `authorizeAccount` and
   therefore has no domain — may be the honest answer for all six tools, not just `whoami`.
   Unresolved.
4. **`config_json` is an information-disclosure question I punted on.** `my_agents` returning
   an agent's persona is _useful_ ("why did editor@ reply like that?") and is arguably the
   most valuable field on the row. I excluded it because `BindingConfig`
   (`services/agent/src/models.ts:29-49`) also carries `modelAliases`, `digestTargets`, and
   `allowedSenders`, and I would rather under-disclose by default. A field-level allowlist is
   the right answer and I did not specify one.
5. **"Why did editor@ skip that email?" may not be answerable at all**, which would undercut
   half the motivating entry. Bindings fire on `trigger_on = 'mailbox-delivery'`
   (`data-plane.sql:102`) and the ingest handler inserts one invocation per matching binding
   (`ingest/src/index.ts:175-190`). `allowedSenders` filtering lives in the runtime's binding
   config (`models.ts:34`), not in a logged decision — so a sender-filtered skip leaves **no
   trace anywhere**. Answering "why" properly may require a decision-log the system does not
   have, which would make part of this unit a capability, not a projection. **This is the
   claim most likely to break the unit's classification under the law in `readme.md`, and a
   reviewer should check it before this is picked up.**
6. **Nothing here was run.** Every claim is read from source. I have not confirmed that
   `grant_audit` actually accumulates rows in a live deployment — it is written on every
   grant-reached call in both surfaces, but if grants are rarely used in practice the table
   may be empty, and `access_log` would be a tool that always returns nothing.

---

## Shipped

`services/agent/src/introspectTools.ts` (new module; `mcp.ts` touched only for the import and
the `TOOLS` spread, one line each, to stay out of `014`'s way) and
`services/agent/src/introspect.test.ts` (38 tests). Seven tools, all `scope: "read"`,
`domain: "mail"`:

```
whoami  my_access  who_can_access  my_agents  invocation_history  explain_skip  access_log
```

`explain_skip` is not in the tool list above — it was added because open question 5 turned out
to be **wrong**, see below.

### Open questions, resolved

**5 — "Why did editor@ skip that email?" IS answerable, and the unit stays a projection.**
This was filed as the claim most likely to break the unit's classification. It does not. The
_cloud_ runtime already writes a decision log: `runInvocation` finishes a filtered message with
`done("done", { note: \`skipped: ${sender} not in allowedSenders\` })`
(`services/agent/src/index.ts:172`, and `:167`for the RFC 3834 auto-sender case), and`finish()`copies that string into`agent_invocations.note` (`:330-335`). The fact *and* the
reason are on a row. The unit's premise — "`allowedSenders`filtering lives in the runtime's
binding config, not in a logged decision" — was read from`packages/cli/src/agent.ts`(the
homelab runtime) and generalised to both;`services/agent/src/index.ts` was not checked. No
capability is needed and nothing new is written.

Where it is genuinely unanswerable, `explain_skip` says so instead of guessing, and returns a
`limitations` array with every answer:

| Case                                                 | Verdict         | Evidence                                                                                                         |
| ---------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------- |
| sender/auto-submitted filtered, cloud runtime        | `skipped`       | the runtime's own `note`                                                                                         |
| binding disabled, or `trigger_on ≠ mailbox-delivery` | `never-ran`     | ingest filters on exactly those two columns (`ingest/src/index.ts:167-172`), so no row provably means not queued |
| still queued                                         | `not-skipped`   | status                                                                                                           |
| homelab runtime name-mismatch                        | **no evidence** | `packages/cli/src/agent.ts:156` is a bare `return false` — no note, row left `pending`                           |
| never delivered / predates the binding               | **no evidence** | nothing records a delivery that matched no binding                                                               |

**3 — `MethodDomain` was NOT widened, and the stated reason for widening it does not hold.**
The unit argued that riding on `mail` is "a lie the audit log then records". It is not: MCP
writes `mcp:${tool.name}` as the audit `method` (`mcp.ts:350`), never the domain. `domain` is
consumed only by `grantCoversDomain`, i.e. which grants could unlock the tool for a
_grant-reached_ caller — and Rule 1 refuses every one of those. Widening a shared type for a
label nothing records would be a change with no behaviour. Also decisive: `mcpTools.test.ts:19`
pins `VALID_DOMAINS` to the closed union, so widening is a two-package change, not a one-line one.

**4 — the `config_json` field-level allowlist is specified and frozen by a test.**
`describeBinding()` returns derived facts only: `pipeline`, `replyMode` (re-narrowed to the
enum this module owns), `hasPersona`, `senderAllowlist: {active, count}`, `modelAliasCount`.
Never the persona text, the allowlisted addresses, the model routing or the digest targets.
Test 22 asserts the projected key set exactly, so a new `BindingConfig` field cannot arrive by
passthrough.

**6 — `grant_audit` was in fact never read, and its columns only partly support the questions.**
This unit is its first reader. What it supports: _who_ (acting login email), _which account_,
_what method label_, _when_, _under which grant_. What it does not, all now returned as an
explicit `limitations` array on every `access_log` answer rather than left to be misread:

- **only DELEGATED access is recorded.** The write is conditional on `decision.auditGrant`, which
  is `null` for an owned account (`principal.ts:259`). An owner's own reads are never logged, so
  an empty `access_log` means "nobody reached this through a grant", not "nothing happened".
  This is the single most misreadable thing about the table.
- **rows are attempts, not outcomes.** The insert happens _before_ the tool or method runs
  (`mcp.ts:345-352`) and there is no status column, so a refused call is indistinguishable from
  a successful one. (This is also what makes _Done when_ #6 work for free.)
- **no row says what was read** — no object id, count or collection.
- **a revoked grant's scopes are unrecoverable.** `revokeGrant` is a hard `DELETE`
  (`provision/src/index.ts:603`) and `s03.A`'s tombstones do not exist, so the `grant_id`
  dangles. Rendered as `grantStatus: "revoked-or-deleted"` with the explaining sentence, per
  _Done when_ #5.

One shape the bread-crumbs missed: `method` has **three** forms, not two.
`requireAccountScopes` writes `${domain}:${scopes.join("+")}` (`methods/common.ts:76`), e.g.
`mail:draft+delete`, alongside `requireAccount`'s `${domain}:${scope}` (`:108`) and MCP's
`mcp:${tool}`. Parsed naively that is a scope named `draft+delete`. All three are covered.

### Not done

**`whoami` still takes an `accountId`** and therefore does not satisfy _Done when_ #7's
account-less form — only its substance (owned and grant-reached accounts, listed separately and
distinguished). Skipping the account gate needs `requiresAccount?: boolean` on `ToolDef` plus a
branch in `handleToolCall`, which is a change to shared dispatch. This unit's brief was to touch
`mcp.ts` in one line while `014` was in flight, and the unit itself says the `ToolDef` change
belongs in `001` "so there is one shape, not two". Filed there, not done here. Everything else
in _Done when_ is covered by `introspect.test.ts`.
