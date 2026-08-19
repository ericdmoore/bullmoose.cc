---
plan: s03.A-foundations
status: closed
closed_at: 2026-08-19
closing_pr: none   # docs-only — .plans/ lands straight on main. Written during the
                   # 2026-08-19 archive sweep; the build is #37, its fallout fix is #48.
acceptance: partial
residues: 3
reversals: 0
---

# s03.A — closing notes

s03.A is the section that exists because two data-model changes are **cheap now and
impossible retroactively**: you cannot attribute a record written before it had a writer
column, and you cannot reconstruct an authorization that was deleted. It shipped both in
one PR (#37), touched every mutable table in every realm, and produced nothing a user can
see. That was the design.

What it actually became was a lesson in the difference between **a mechanism and its
coverage.** The mechanism is excellent: one `Mailstore` constructor argument, one
`provenanceValues()` that is the sole source of the trio, one `appendProvenance()` for
dynamic updates, and a source-grepping test that fails if a future `INSERT` omits the
columns. What the mechanism does not do — and could not, given where the guard was
pointed — is notice a *caller* that never supplies a writer. Two such callers existed on
the day it landed, both were reported honestly in `.feedback/…/common/033` **in the same
PR**, and both are still there. Acceptance #1 does not hold for DAV, and acceptance #2 does
not hold for the agent's own MCP write path, which is the case provenance was built for.

The tombstone half also shipped a P1 the same week. Making revocation an `UPDATE` rather
than a `DELETE` left the tombstoned row occupying `grants_tuple`, a plain unique index, so
re-granting a previously revoked pair was impossible — and `ON CONFLICT DO NOTHING`
swallowed the constraint failure, so the handler returned **200 with a freshly generated
grant id that no row carried**. `.feedback/fromClaude/agentic/✅037`, fixed in #48. That
one is closed; it belongs here because the *shape* of it recurs.

## Acceptance ledger

The five numbered clauses from `readme.md` plus the six per-task **Done when** bullets from
`devPlan.md`, verbatim.

| Done-when (verbatim) | verdict | evidence |
|---|---|---|
| 1. "Every `*/set` across mail, contacts, and calendar records a `lastWriter`" | ❌ **unmet for DAV** | true for JMAP: `storeFor(ctx)` supplies the writer (`services/jmap/src/methods/common.ts:126-132`) and every `*/set` calls it — `email.ts:80,196,272,727`, `mailbox.ts:36,82,178`, `calendars.ts:54,76,177,204,357,415`, `filenode.ts:74,125,189,335`, `identity.ts:142,193`. **Not true for CardDAV/CalDAV:** `services/anglebrackets/src/dav.ts:131` and `:163` construct `new Mailstore(env.DB, env.BLOBS)` bare, so the writer defaults to `null` (`packages/mailstore/src/index.ts:676-686`) and a contact edited from Apple Contacts or an event from Apple Calendar lands NULL provenance. Carried forward |
| 2. "An agent-authored write is attributable to its binding **and** invocation" | ❌ **unmet on the MCP path** | the mechanism works and is tested (`packages/mailstore/src/provenance.test.ts:178-289`, all seven realms × owner/agent/system), and the proposal executor really does supply it — `storeFor({ ...ctx, agent: { binding: row.binding_name, invocation: row.id } })` at `services/jmap/src/methods/actionProposal.ts:2035`. But the agent's **own tool surface** does not: `services/agent/src/jmapBridge.ts:157` builds `RequestContext` with `agent: {}`, so a noun write an agent makes over MCP stamps the principal and leaves binding and invocation NULL. The comment there says binding and invocation are "unknown at this layer" — true when it was written, less true since s17 (below). Carried forward |
| 3. "Revoking a grant removes access but preserves the row; a point-in-time query returns the historical authorization set" | ✅ met | soft delete at `services/provision/src/index.ts:1734` (`UPDATE grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`), lifecycle log at `:1596`, resolution filter at `packages/auth-core/src/principal.ts:183` and `:391`. The point-in-time consumer is real and shipped: `webmail/src/lib/console/perResource.ts:51` — `liveAt()`, tombstone first, then expiry, then birth |
| 4. "`authorizeAccount` behaviour is unchanged — the s01 test suite stays green" | ✅ met | `authorizeAccount` (`packages/auth-core/src/principal.ts:311-334`) contains no reference to `revoked_at`. The tombstone lives entirely in the resolution layer, exactly as the plan specified — the module comment at `:336-343` states the split so the next reader does not put it in the decision layer |
| 5. "`npm test` green, `npm run typecheck` clean" | ✅ met | 933 pass at landing (was 900), per `readme.md`'s status block, written by the author while the context was warm |
| T1 — "Every `*/set` writes provenance; a fake-DB unit test asserts an agent-authored write records both binding and invocation" | ✅ met as written | `provenance.test.ts:178-220`. Note this is the *mechanism* clause and it passes — which is precisely why clauses 1 and 2 could fail without anything going red |
| T1 — "'Who touched this card?' is answerable from the record alone, without joining `grant_audit`" | ⚠️ partial | answerable where the column is populated; hatched and labelled *not captured* where it is not, and rendered as a `not-captured` **finding** rather than a blank (`webmail/src/lib/console/perResource.ts:248`). Honest, but the answer for a DAV-written card is "nobody recorded it" |
| T1 — "A grep-assertable test proves no write path bypasses the provenance helper" | ⚠️ **met literally, and it is the wrong grep** | `provenance.test.ts:291-318` reads `packages/mailstore/src/index.ts` off disk and asserts every `INSERT INTO <table>` names `PROVENANCE_COLUMNS` or `last_writer_principal`, for all seven realms. That guards the *statement shape* inside one file. It cannot see `dav.ts` supplying no writer to the constructor, because that is not a bypass of the helper — it is a correct call with a null argument. This is why the hole survived its own guard |
| T2 — "Revoking removes access immediately (resolution excludes tombstoned rows)" | ✅ met | `packages/auth-core/src/principal.ts:183`, `:391`; `services/provision/src/adminLifecycle.test.ts` (+4 at landing) |
| T2 — "A point-in-time query … returns the historical set including since-revoked rows" | ✅ met | see clause 3 |
| T2 — "`authorizeAccount` is untouched and the s01 suite stays green" | ✅ met | see clause 4 |

Two clauses unmet, both known and both filed on the day — `common/033` is in #37's own
file list. Recording them here is bookkeeping, not discovery. What *is* new below is the
second half of `033`, which the archive index's audit row omitted.

## Carried forward

| what | why it did not ship | owner |
|---|---|---|
| **DAV writes land NULL provenance.** `services/anglebrackets/src/dav.ts:131` and `:163` build `new Mailstore(env.DB, env.BLOBS)` with no writer | anglebrackets replicates the write choreography rather than calling the JMAP method layer (it binds only `ACCOUNT_DO` cross-script), so it never passes through `storeFor`. The mechanism supports the fix — build a `WriteProvenance` from the DAV principal and hand it to the constructor — it was simply out of #37's blast radius | `.feedback/fromClaude/common/033 -P2-` (**open**, confirmed in `.feedback/_index.md`) |
| **Agent MCP writes stamp the principal but not the binding or invocation** — `services/agent/src/jmapBridge.ts:157` passes `agent: {}` | true when written: the bearer, not a job, was the identity at that layer. **s17 changed that** — a `bmi_` invocation token names exactly one invocation, and `handleToolCall` already resolves it into `envelope.invocationId` (`services/agent/src/mcp.ts:603`). It is not threaded to `runTool`/`callJmap`, so the fact is present and unused | `.feedback/fromClaude/common/033 -P2-` §2 (**open**). Flagged here because the index's audit row names only the DAV half, and this is the half `readme.md` calls "*the* motivating case" |
| **`webmail/src/lib/console/perResource.ts:171` joins a provenance writer to a grant by e-mail address**, because `last_writer_principal` is a login e-mail while grants key on `accountId` | s03.E built the consumer before the read interface existed and matched on the only field both sides carried. Correct today; wrong the first time two accounts share an address | `.plans/s22-operator-surface/control-plane-in-the-browser.md` §1 *"Where it lives"*, whose design is to extend `/console/*`, and whose rule 4 — *"Show provenance, not verdicts"* — is about this exact panel. The fix is server-side: `/console/*` should return the writer's account id (`services/jmap/src/console.ts`), which is why it is not s03.E's UI to repair |

## Reachability

- **Deployed?** The code rides `services/jmap`, `services/provision` and
  `packages/mailstore` (a workspace package, so it deploys inside whatever imports it),
  all via `.github/workflows/deploy-mail.yml` — **manual-only**, per its own header.
- **Migration applied?** Yes, and this is the section where that question has teeth: 21
  provenance columns plus `grants.revoked_at` plus `grant_lifecycle`, all nullable so they
  are safe on existing rows. They are `provenance-columns` (`infra/migrations.mjs:269`),
  `grants-revoked-at` (`:79`) and `grant-lifecycle-table` (`:90`), with the hand-run
  runbook still in `docs/DEPLOY.md §"Upgrading an EXISTING database — s03.A"` (from :117).
  Most recent `migrate.yml` run: **"Migrate — APPLY", success, 2026-08-19T02:58Z.**
  `docs/DEPLOY.md:38` names the failure mode if it is skipped — *"`grants.revoked_at`
  missing → every grant lookup breaks"* — because `verifyBearer` filters on the column
  unconditionally. This is a migration that takes authentication down if it is not run.
- **A fourth migration exists only because of this one.** `grants-tuple-partial`
  (`infra/migrations.mjs:223`) rebuilds the unique index as `WHERE revoked_at IS NULL`.
  That is #48's fix, and it is a schema change, not a code change — see the P1 above.
- **Switched on?** Yes, unconditionally. There is no flag; a nullable column is either
  written or it is not.
- **Verified live?** **Not verified live.** Everything above is code, tests and a green
  migration run. Nobody has read a `last_writer_principal` off the production database, and
  the natural way to do it — the console's forensic view — is authenticated, so this sweep
  could confirm only that `/console/*` answers (`401` from
  `https://app.bullmoose.cc/console/agents`, 2026-08-19, versus `200` HTML from the Pages
  fallback for an unrouted path). The columns being *present* in production is inferred
  from the migration run, not observed.

## Authority-surface delta

No new scopes, no new capabilities, no walls moved. Two changes to what the system can
*remember*, which is a different axis and arguably a larger one:

- **Attribution became a property of the record.** `grant_audit` only fires on *delegated*
  access, so an agent acting on its own account logged nothing — "Emily's agent scrambled
  Emily's VendorsBook" produced zero rows, exactly where you would look first. It produces
  a row now, on the record itself, for every realm.
- **Revocation stopped destroying evidence.** *"Who could have, last Tuesday?"* went from
  unanswerable to a query. `webmail/src/lib/console/perResource.ts:19-27` names s03.A T2 as
  the entire reason that view can be correct.
- **One refusal added, indirectly:** #48 made `createGrant` stop returning 200 for a write
  that did not happen. A false success is a worse authority bug than a refusal.

## Deviations from `devPlan.md` / `arch.md`

- **`file_nodes` was included immediately, not deferred.** T1 said "+ `file_nodes` when
  s03.B lands — its schema includes these from birth". It shipped with the other six and
  has its own migration entry (`infra/migrations.mjs:273`). Better: a table born with the
  columns never needs the ALTER.
- **The email flag/move path was added to the stamp** beyond the plan's "every insert +
  primary update" — `provenance.test.ts:271`, *"a flag/move (`replaceEmailSets`) stamps the
  email itself — triage is attributable"*. Triage is the highest-volume agent write there
  is; leaving it unstamped would have hollowed out the feature.
- **`appendProvenance` guards against provenance-only writes.** Not in the plan: it is
  called only when the update is real, so a no-op patch stays a no-op rather than becoming
  a write that changes nothing but the writer (`packages/mailstore/src/index.ts:699-709`).
- **No migration framework, as designed** — the plan's E3 said the exact ALTER list would
  be operator documentation. It was, and then #49 built the framework anyway a week later,
  and these three ALTERs are now entries in it. The plan was right for its moment and
  overtaken; both artifacts still exist and agree.

## Reversals

None. s03.A overturned no earlier decision, and nothing has overturned it — both halves
are still load-bearing, in `verifyBearer` and in the console's forensic view.

## Absorbed / donated

**Absorbed:** nothing. The plan's "Depends on: Nothing. Start here." held.

**Donated,** and this is a section that is almost entirely donation:

- To **s03.E**: the tombstone is what makes the per-resource view point-in-time correct at
  all (`perResource.ts:19-27`), and `last_writer_*` is the *who did* half of its central
  pair.
- To **s02 T4**: the tombstone contract was extended to `oauth_consents`, which carries its
  own `revoked_at` and is filtered the same way (`services/oauth/src/consentMirror.ts:89`).
- To **s04 / the Bureau**: `bureau_grants` adopted the same tombstone contract, and
  `packages/auth-core/src/principal.ts:336-343` says so explicitly — *"What they DO share
  is the tombstone contract, and this is the resolution layer that enforces it … exactly as
  `verifyBearer` does for `grants`."* Two grant vocabularies, one revocation semantics.
- To **s10 T2**: `grant_lifecycle` grew `via_proposal_id` (`infra/migrations.mjs:753`) and
  a single writer function (`services/provision/src/index.ts:1582`) — *"THE
  `grant_lifecycle` writer … every lifecycle row goes through here"*.
- **Received back from #48**: s03.A's own P1 fallout was fixed by a separate PR nine hours
  later, which also closed s03.E's reported `introspectTools` staleness in the same diff.
  Both were consequences of this section's tombstone; neither was in its plan.

## What grew stale during the build

- **`readme.md`'s status block is the honest one and should be read first** — it already
  says acceptance #1 does not hold for DAV. The section's own author wrote that, in the
  same PR that filed the issue. This closing note adds one thing: `033` has a **second**
  half, and it is the one `readme.md`'s "Why this exists" calls the motivating case.
- **`jmapBridge.ts:157`'s comment — "Binding/invocation are unknown at this layer" — was
  true and is now only half true.** s17's `bmi_` tokens name an invocation and `mcp.ts`
  already resolves one. The comment is not wrong about *bindings*; it is out of date about
  *invocations*.
- **"Tests — 933 pass (was 900)"** is a snapshot from 2026-08-09. The repo is well past
  that; the number is useful only as the delta it records.

## Traps for the next section

- **A guard that greps the helper cannot see a caller that supplies nothing.**
  `provenance.test.ts:291` proves no `INSERT` in `mailstore/index.ts` omits the columns —
  and `dav.ts` passes that test by construction while writing NULLs, because a bare
  constructor is a *legal* call. If a feature depends on every caller passing an optional
  argument, the assertion has to be over the call sites, not the callee.
- **An optional constructor argument defaulting to `null` "so every existing call site
  keeps compiling" is a decision to ship a coverage hole.** It was the right trade for #37
  — the alternative was editing two workers in one PR — but the debt is real, it is two
  weeks old, and the comment at `packages/mailstore/src/index.ts:676-686` documents the
  choice rather than a ticket to undo it.
- **Changing a `DELETE` to a soft delete is a schema change, not a code change.** Any
  unique index, partial index or `ON CONFLICT` clause over the affected table is now
  wrong. `grants_tuple` was a plain unique index and the tombstone occupied the tuple
  forever; `ON CONFLICT DO NOTHING` then turned a constraint failure into a 200 with a
  fabricated id. Grep for every index and conflict clause on the table *before* the ALTER.
- **`ON CONFLICT DO NOTHING` plus an unconditional success response is a false-success
  generator.** The author of #37 already knew the no-op case — `grant_lifecycle` was
  guarded on `res.meta.changes > 0` with a comment explaining exactly this — and applied
  the guard to the audit log and not to the reply. The system's own record stayed honest
  while the answer to the caller did not. If you guard one, guard the other.
- **A migration that a hot path depends on unconditionally is an availability event.**
  `verifyBearer` filters `revoked_at IS NULL` with no fallback, so shipping the code
  before the ALTER breaks every grant lookup. `docs/DEPLOY.md:38` names it. Deploy order,
  not deploy content.
