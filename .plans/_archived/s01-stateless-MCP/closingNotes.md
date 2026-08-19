---
plan: s01-stateless-MCP
status: closed
closed_at: 2026-08-19
closing_pr: none   # docs-only — .plans/ lands straight on main. Written during the
                   # 2026-08-19 archive sweep, two weeks after the build, so this is
                   # an auditor's note: every row below is a citation, not a memory.
acceptance: partial
residues: 1
reversals: 3
---

# s01 — closing notes

s01 asked a research question — *is the 2026-07-28 stateless spec real enough to build
on?* — and answered it by porting the internal `mailstore-analytics` MCP server to it in
two commits. What it actually became was the **auth pass wearing a transport pass's
name.** The transport port is a couple of hundred lines of header and `_meta` validation;
the durable output is `verifyBearer` and `authorizeAccount` in `@bullmoose/auth-core`,
which every credential system since — OAuth access tokens (s02 T4), `bmi_` invocation
tokens (s17) — has landed on rather than beside. The plan predicted this in one line
("the auth gap is the real work and we were going to do it anyway") and was right for a
reason it could not have known: making the authorization decision a *pure function* is
what let two later credential types reuse it without touching it.

The other thing s01 became is a **worked example of a section being correct and
superseded at the same time.** Its headline decision — no `initialize`, ever — was the
right call for a surface bullmoose owned both ends of, and the wrong call within nine
days, when the client stopped being ours. `acceptance: partial` above is not a failure
grade. It is the honest statement that two of the five clauses no longer describe the
system, on purpose.

## Acceptance ledger

Both the per-task **Done when** clauses and the five-item **Acceptance criteria** from
`devPlan.md`, verbatim.

| Done-when (verbatim) | verdict | evidence |
|---|---|---|
| T1 — "jmap typechecks + existing jmap auth tests pass against the lifted functions (pure refactor, no behavior change)" | ✅ met | `authorizeAccount` is pure and I/O-free at `packages/auth-core/src/principal.ts:311`; jmap's `requireAccount` delegates to it at `services/jmap/src/methods/common.ts:96` and keeps the audit write in the shell. `c1cdc83` |
| T2 — "conformance client (T4) passes transport cases; no `initialize` path remains" | ✅ met at landing, ↩ reversed | met by `b8f1133`; `initialize` was restored nine days later by s02 T2 — see Reversals |
| T3 — "a token scoped to `a_eric` reads `a_eric`; the same token reading `a_stranger` is `forbidden` and returns zero data; a granted token reads the granted account **and** writes one `grant_audit` row" | ✅ met | `services/agent/src/mcp.ts:746` (the gate) and `:759` (the audit INSERT); cases 8, 9 and 10 in `services/agent/src/mcp.test.ts:269,288,354` |
| T4 — "green in CI; runbook curl script reproduces 1–10 against `wrangler dev`" | ⚠️ partial | the ten cases are green and still numbered 1–10 in `services/agent/src/mcp.test.ts:148-404`. **No curl script exists in this folder** — the folder holds `readme.md`, `devPlan.md`, `arch.md` and nothing else. The equivalent landed later and elsewhere as `tools/e2e-mcp-public.mjs` (s02 T7), which drives the real host rather than `wrangler dev`; nothing was lost, but the clause as written was never satisfied |
| 1. "`/mcp/analytics` speaks **only** MCP.2; `initialize`/`ping` return method-not-found" | ✅ met at landing, ↩ **deliberately reversed** | reversed by s02 T2 (#108). Both now answer: `services/agent/src/mcp.ts:482-490`, `services/agent/src/mcpLegacy.ts`. The test that proved this clause is now titled *"6. initialize is ALIVE and legacy (s02 T2 — this test inverted on purpose)"* — `services/agent/src/mcp.test.ts:239` |
| 2. "Every `tools/call` is bearer-authenticated and `requireAccount`-authorized, with `grant_audit` on delegated reads — `mcp-auth §16.4` holds" | ✅ met, and still holds | `mcp.ts:441` (resolve), `:452` (401), `:746` (authorize), `:759` (audit). Holds for all three credential types that now reach this handler, because they all arrive as a `Principal` and nothing downstream knows which |
| 3. "No self-asserted `accountId` trust remains" | ✅ met, strengthened | the id is still an argument but is authorized, never trusted (`mcp.ts:746`). s02 T5 went further and resolves it server-side when omitted (`mcp.ts:729-742`), pinned by test 24, *"a supplied accountId is STILL never trusted — the gate is unchanged"* (`mcp.test.ts:489`) |
| 4a. "No new runtime dependency" | ✅ met | `services/agent/package.json` gained nothing in either s01 commit; the `package-lock.json` churn in `c1cdc83` is vitest, a dev dependency |
| 4b. "`mcp.ts` still a bounded, read-only, parameterized-query surface" | ❌ **no longer true** | overturned by sVOL `013`/`014` (#23, #26), which added Calendar/Contacts/Email **writes** through `jmapBridge.ts`. The file says so itself at `services/agent/src/mcp.ts:39-45`: *"This surface was read-only until `013`; it is not any more."* Not a regression — a deliberate scope change made by a later section. See Reversals |
| 5. "`npm run typecheck` clean; T4 suite green" | ✅ met | green at landing per `b8f1133`; the suite has since grown to 45 cases in the same file and is gated by `verify` |

## Carried forward

| what | why it did not ship | owner |
|---|---|---|
| `services/agent/src/vault.ts:124-149` still hand-rolls the `tokens ⋈ principals` join that T1 existed to delete. It has drifted: the copy skips `verifyBearer`'s `last_used_at` liveness write (`packages/auth-core/src/principal.ts:127-128`), so a token used only against the vault reads as never used | T1's bullet said *"Repoint jmap + vault at the shared functions; delete the duplicates."* jmap was repointed; the vault was not, and the Done-when only asked about jmap, so nothing went red. Named again by sVOL `023` and by s03.E's devPlan delta 3, both of which are now archived — this is the last live record | `.plans/s17-chief-of-staff/per-invocation-tokens.md:165` — the only **live** plan that names this line, under §"Why that shape leaks on day one", as a *verified, not hypothetical* finding. It owns the observation; nobody owns the deletion. **Not** s04 T3a: that split shipped and deliberately left the `creds` HTTP surface, and therefore `authenticateVault`, on the agent worker (`.plans/s04-AgentOS/devPlan.md:112-137`) |

## Reachability

s01 is section one, so it is the only entry here with no PR and no deploy step of its own
— it rode whatever shipped `services/agent` next.

- **Deployed?** Yes, `services/agent` (the `bullmoose-agent` worker), deployed by
  `.github/workflows/deploy-mail.yml:87`. That workflow is **manual-only** (its own
  header: *"Manual-only until the first hand deploy proves the config"*), so "merged"
  and "deployed" are genuinely different events in this repo.
- **Migration applied?** None needed. s01 added no columns and no tables; `grant_audit`
  already existed.
- **Switched on?** Yes, and with no flag. There is no s01 feature gate — the transport
  and the auth gate replaced their predecessors in place.
- **Verified live?** Yes, but by s02, not by s01: the surface s01 built answers
  `https://mcp.bullmoose.cc/mcp` today. Probed 2026-08-19 during this sweep — an
  unauthenticated POST returns `401` with `{"jsonrpc":"2.0","id":null,"error":{"code":-32001,"message":"unauthorized"}}`,
  which is `mcp.ts:452` speaking. At the time s01 landed, the endpoint was
  `workers.dev`-only behind `x-internal-token` and nobody probed it from outside.

## Authority-surface delta

The largest single tightening in the repo's history to that point, and it was a
*narrowing*:

- **Removed** the ability of any holder of the platform's shared `x-internal-token` to
  read any account's analytics by asserting an `accountId`. That was the whole
  authorization model before this section.
- **Added** per-request principal resolution (`verifyBearer`) and a per-call
  token ∩ grant intersection (`authorizeAccount`) on the MCP surface, with a
  `grant_audit` row on every grant-reached read — `mcp-auth §16` invariant 4 became true.
- **Added no scopes.** s01 reused `read` and leaned on the existing (and separately
  criticised) rule that `mail` is a superset of everything but `admin`.
- **Refusals added:** `401` with no bearer; `-32004`/403 for an account the token cannot
  reach, returning **zero rows** rather than an empty result that might be mistaken for
  "nothing there".

## Deviations from `devPlan.md` / `arch.md`

- **D3 was decided as proposed but the module was not.** The plan offered
  `auth-core` vs a new `@bullmoose/authz`; `auth-core` won, but the code did not land as
  the "new `authz` module" the task described — `authorizeAccount` sits directly in
  `packages/auth-core/src/principal.ts` beside `verifyBearer`. Right call, and the reason
  is visible in the file today: `BUREAU_VERBS` and `resolveBureauGrant` were later added
  to the same module precisely because it had become "the repo's authorization module"
  (`principal.ts:336-343`).
- **`authorizeAccount` came out purer than specified.** `arch.md` §3 describes it as
  re-homed `requireAccount`, audit write included. What shipped splits the decision from
  the effect: the function returns the grant to audit and writes nothing, and each of the
  two shells does its own INSERT under its own `method` label. That is `devPrinciples.md`
  applied, and it is why the same function survived two later credential types unchanged.
- **T4's curl runbook was never written** — see the ledger. This is the one place the
  plan's own bookkeeping over-reports.

## Reversals

s01 is section one and overturned nothing. The traffic is entirely in the other
direction, and this is the file to read before "restoring" any of it as a bug fix:

1. **s02 T2 reversed s01 acceptance #1 and its D1 posture.** `initialize` and `ping` were
   restored (`services/agent/src/mcpLegacy.ts`; dispatch at `services/agent/src/mcp.ts:482`).
   The reason is in s02's devPlan and it is not "we changed our mind": Anthropic's clients
   speak the 2025 revisions and open with `initialize`, so a pure-MCP.2 server is a server
   claude.ai cannot handshake with at all. s01 was right about the surface it scoped
   (internal, both ends ours) and s02 changed the surface.
2. **s02 T1 reversed decision D2.** s01 proposed keeping `x-internal-token` as a
   defence-in-depth network ACL on `/mcp/analytics`. It came off, because a third-party
   client cannot hold a secret only we hold. `/drain` and `/internal/*` keep it —
   `services/agent/src/index.ts:112-124, 169`.
3. **sVOL `013`/`014` reversed acceptance #4's read-only invariant.** The MCP surface
   writes now. The file's module docstring (`mcp.ts:26-45`) is the corrective, and it
   draws the line that matters: analytics tools may hit `env.DB` directly; noun tools
   must dispatch through `jmapBridge.ts` so the ctag/changelog choreography happens.

## Absorbed / donated

**Donated** — s01's output is load-bearing in four later sections, which is unusual for a
section that shipped in two commits:

- `verifyBearer` → s02 T4's principal bridge (`services/agent/src/index.ts:150-160`) and
  s03.A T2's tombstone filter, which was added *inside* it
  (`packages/auth-core/src/principal.ts:183`).
- `authorizeAccount` → s17's invocation envelope, which is ANDed strictly *after* it and
  says so at `services/agent/src/mcp.ts:751-757`.
- The MCP.2 transport → s02 T2's modern lane, kept byte-identical apart from three
  corrected error codes.

**Absorbed** — nothing. s01 had no predecessors.

## What grew stale during the build

Nothing went stale *during* the build; it was two commits sixteen minutes apart. Plenty
went stale within the fortnight after, and the folder was updated honestly at the time —
`readme.md`'s status block already carries the "superseded on one point" note and names
the inverted test. Two things it does **not** say:

- **`readme.md` §3's table is now a period piece.** Every row in "Where bullmoose already
  is" describes the pre-s01 file. Read it as the diff s01 closed, not as a description of
  `mcp.ts`, which is 850 lines and has three credential systems in it.
- **The `initialize` shim is not permanent, and its delete condition is written down.**
  `services/agent/src/mcpLegacy.ts:31-36`: delete the file and its one dispatch branch
  when a Claude client completes `server/discover` without first sending `initialize`.
  Anyone reading s01 and concluding "the legacy lane is the settled state" has read one
  section too few.

## Traps for the next section

- **A "Done when" that names one of two call sites will close with one of two call sites
  done.** T1's bullet said *jmap and vault*; its Done-when said *jmap typechecks*. The
  vault copy is still there two weeks later and nothing ever went red. If a task removes
  a duplicate, the acceptance clause has to be `grep`-shaped, not test-shaped.
- **A protocol decision has a client population attached to it, and the population is not
  in the spec.** "The spec is `Final`" was true and told us nothing about whether any
  shipped client spoke it. `readme.md` §5 flagged exactly this risk and then scoped it
  away as s02's problem, which was defensible — but the lesson is that *spec support* and
  *client support* need separate evidence, and only one of them is a document you can read.
- **Purity buys reuse you cannot foresee.** `authorizeAccount` was made I/O-free for
  testability. What that actually bought was two later credential systems adopting it
  without a line of change. When a decision is between "pure core, effects in the shell"
  and "one function that does both", the tiebreak is who else might want the decision.
