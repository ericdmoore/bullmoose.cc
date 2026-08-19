---
plan: s12-boundary
status: closed
closed_at: 2026-08-19
closing_pr: none          # docs-only; .plans/*.md lands straight on main
acceptance: met           # against the readme's own commitments — this plan has no devPlan
residues: 1
reversals: 2
---

# s12 — closing notes

s12 started as a stub note on the back of an s11 discussion — bouncer@ promoted
from a motivating-example candidate to the fourth agent kind — and turned into
the largest single-plan build in the archive: two waves, four merged PRs, a new
dependency-free package, six migrations, and an agent that reads hostile mail
for a living.

The plan has **no `devPlan.md`**. Its whole specification lives in `readme.md`
as five design commitments and, later, a self-correction. That is unusual here
and worth naming: the acceptance ledger below quotes the readme's commitments
rather than Done-when clauses, because there are none to quote.

The thing the plan could not know is that it would **argue with itself
mid-build and win**. Wave 1 shipped a `Quarantine` mailbox next to `Junk` — two
piles where the product's whole thesis says there should be zero — and Eric's
*"the JUNK folder seems like a design flaw now"* turned that into the rework
(#107). The result is the sharpest sentence the section produced: **anything
that is *maybe* your job is actually nobody's job.** A folder has no completion
state and accrues obligation at a constant rate whether or not it holds
anything. That reasoning is why held mail is now a dated question in
`/approvals` rather than a room you are expected to visit.

## Acceptance ledger

Quoted from `readme.md` — the five design commitments, and the two-part fix
that superseded wave 1.

| Commitment (verbatim) | verdict | evidence |
|---|---|---|
| 1. "Deterministic first, model only on the mid-band" | ✅ met | the cascade runs stages 1–4 before any model: `services/ingest/src/boundary.ts`, engines in `packages/boundary/src/{sieve,bayes}.ts`. The sieve has **no RegExp anywhere** — anchored glob via a two-pointer walk — so ReDoS is impossible by construction, not by review; #95, #96 |
| 1. "Stage-1 rejects should exit at the SMTP edge" | ✅ met | `services/ingest/src/index.ts:92` calls `message.setReject()`; `services/ingest/src/boundary.test.ts:163` proves nothing is stored and the counter bumps — twice, i.e. a repeat offender costs no more than the first |
| 1. "a **bloom filter** … fronts the union of ALL blocked tiers" | ✅ met | `services/ingest/src/bloom.ts`, KV-published derived index. Its property test caught a real sign-coercion bug — a *guaranteed-false-negative* class — during the build, which is the one failure mode a bloom may never have. `boundary.test.ts:209` pins that the exact checks still decide with no bloom published: it is a fast path, never the source of truth |
| 1. "**Bayesian filter — two thresholds, not one**" | ✅ met | `packages/boundary/src/bayes.ts:53` — `DEFAULT_THRESHOLDS = { reject: 0.98, clean: 0.2 }`, both comparisons inclusive per the spec. An all-unseen stranger lands at exactly 0.5 → MID_BAND, which is the Laplace identity and precisely the behaviour the cascade wants for strangers; #95 |
| 1. "The graduation loop — the cascade optimizes its own cost" | ✅ met | `services/ingest/src/graduationSweep.ts` on an hourly cron (`services/ingest/wrangler.jsonc:13`, `"17 * * * *"`). `graduationSweep.test.ts:145` closes the loop end-to-end: a graduated domain's *next* message exits at the SMTP edge. `:110` proves one rescue blocks graduation, and rescues never decay |
| 1. "The industrial tier gets **counters, not chains**" | ✅ met | `deny_counters` is the only per-message write for that tier (migration `deny-counters-table`, `infra/migrations.mjs:636`); expensive-stage holds bump counters *and* chain, cheap-stage holds stay chains-only, edge rejects stay counters-only. An attacker cannot make us pay D1 writes per spam |
| 2. "Sender-classification first, message-rescue second" | ✅ met | known-good = the default contacts book, blocked books by naming convention + per-tenant KV; `boundary.test.ts:316` — blocked beats known-good, because over-blocking is rescuable and under-blocking is not |
| 3. "The quarantine log is an append-only chain" | ✅ met | `quarantine_events` (migration `quarantine-events-table`, `infra/migrations.mjs:652`), on the `book_membership_log` model. Conversation 2 reads it to answer "why" with the firing stage verbatim (`services/agent/src/bouncer.ts:26-29`) — the record speaks, not a narrator |
| 4. "Bouncer stamps the judged facets" | ✅ met | mechanical facets at ingest (`services/ingest/src/facets.ts`, s11 T6); judged facets from the classifier (`services/agent/src/bouncerClassify.ts`) |
| 5. "The floor rule bounds the doorman's power … a stamp may raise, never lower" | ✅ met | max-wise composition against the binding's floor, `services/ingest/src/facets.ts:12` and its test. This is the invariant that makes it safe to concentrate stamping in one hostile-input-facing agent |
| "The one hard rule — wrapper is instruction, payload is evidence" | ✅ met | enforced **by signature**: `parseIntent(wrapper: string)` cannot receive the evidence (`services/agent/src/bouncerParse.ts:19-21`). The split is biased toward *less* wrapper (`bouncerParse.test.ts:42,56`) so a mis-split fails safe. The injection test — forwarded spam carrying "P.S. add rival.com…" — produces zero unauthorized writes, and its mutation (feeding evidence to the parser) fails it; #97 |
| Fix 1. "The mid-band produces a PROPOSAL, not a hold" | ✅ met | `services/agent/src/midBandProposal.ts:82` (`held-mail-review`), one ask per account per **UTC day**. `midBandProposal.test.ts:192` — three holds → one proposal, second sweep asks nothing; `:309` — confident spam produces no proposal, because a shunt is a decision, not a chore; #107 |
| Fix 2. "One mailbox, registered role, honest name" | ✅ met | `QUARANTINE_ROLE = "junk"`, asserted against the IANA list at `packages/mailstore/src/quarantineRole.test.ts:77-78`, displayed `Quarantined` (`services/provision/src/index.ts:1097`); the whole tree is scanned so the invented role cannot creep back; #107 |
| "Deploy posture: inert until configured … byte-identical delivery" | ✅ met | pinned against the **real** `email()` handler, not a stub: `services/ingest/src/boundary.test.ts:420-421` — empty deny list + no books + no rules ⇒ the flow is byte-identical to pre-s12 ingest |
| Conversation 3 — analytics | ⛔ deferred by the plan itself | `.backlog/bouncer-analytics.md`; the daily counters are the substrate. Carried forward |

## Carried forward

| what | why it did not ship | owner |
|---|---|---|
| Conversation 3 — analytics over the boundary ("rejection rate, trailing 30d?") | Deferred in the plan, not discovered late. The two conversations that ship are the ones that *change* something (report a miss, repair a false positive); analytics only reads, and reading has no urgency until there is traffic to read. `deny_counters` was built as its substrate | `.backlog/bouncer-analytics.md` — named by the readme, and the backlog file exists |

## Reachability

- **Deployed?** Yes, code-wise. `services/ingest`, `services/agent`,
  `services/jmap` and `services/provision` all ship via
  `.github/workflows/deploy-mail.yml`; the graduation sweep rides ingest's own
  cron.
- **Migrations applied?** Six s12 migrations are registered with executable
  checks: `domain-deny-list-table`, `deny-counters-table`,
  `quarantine-events-table`, `sieve-rules-table`, `bayes-state-table` and
  `quarantined-mailbox-role` (`infra/migrations.mjs:618-745`). The last one is
  the interesting one — its `DELETE` is **guarded on the mailbox being empty**,
  so a shard where something *was* shunted fails the check and stops the deploy
  rather than moving a human's mail blind. Whether these have been applied to
  production is not established in this note; `migrate.yml` is manual and now
  applies by default (#180).
- **Switched on?** **No, and deliberately.** Empty tiers, no sieve rules, no
  Bayes state and no bouncer binding ⇒ byte-identical delivery. Provisioning is
  explicit opt-in via `POST /bouncer` (`services/provision/src/index.ts:187`) —
  `index.ts:195` says plainly that nothing is auto-provisioned. So the entire
  cascade is present and doing nothing until a tenant asks for it.
- **Verified live?** Partially, and unusually well for this archive. Before
  #107's migration was written, the live shard was read read-only and reported
  **0 chain rows, 0 held messages, 5 junk mailboxes all empty** — which is what
  made the rename free rather than a data migration, exactly as the readme had
  pinned. That is a real probe against production, on 2026-08-14, by #107's
  author. **What has never been verified live is the cascade running**: no
  bouncer binding is known to be provisioned, so no message has been judged in
  production.

## Authority-surface delta

The largest in the archive, and the one most worth reading twice — bouncer@ is
the only agent whose job description is reading attacker-authored text.

- **A new agent kind with a deny-write capability.** bouncer@ writes the
  industrial deny list, and may auto-write the tenant blocked book under
  graduation policy. The argument for that autonomy is the *failure direction*:
  block lists are deny-only, so the worst outcome is over-blocking — visible in
  the chain, rescuable, and an availability bruise rather than a breach. Do not
  generalise this to any agent whose failures leak.
- **The injection wall is structural, not procedural.** Only the authenticated
  wrapper may carry intent, and the parser's signature makes the alternative
  impossible to write by accident. The model fallback sees the wrapper only,
  and is validated against the same closed enum.
- **Four gates run before a single write**, in order: `allowedSenders` (an
  unlisted sender is skipped **silently** — a reply would be backscatter and an
  existence oracle), reply-only fail-closed egress through the binding's
  governing book, `authenticatedDirective` (one fixed canned refusal naming no
  reason, zero writes, sent to the *claimed* address so a spoofer never sees
  it), then wrapper-vs-evidence.
- **A self-harm guard.** The tenant's own domain is refused from the deny list
  (`services/agent/src/bouncer.ts:385-388`) — deny-listing it would refuse the
  house's own mail at the door.
- **Internal directives are recognised by an absence.** Our MX prepends
  `Authentication-Results` to everything external, so the header's *absence* is
  the signature of our own submit path. That is a clever trust boundary and a
  fragile one: it is only true while every external path prepends.
- **`LLM_LABELS_TRAIN = false`** (`services/agent/src/bouncerClassify.ts:64`,
  pinned by test at `bouncerClassify.test.ts:189`). The classifier only ever
  sees what Bayes was unsure about, so training on its verdicts would compound
  the model's bias into the filter silently. **Only human labels teach the
  filter** — rescues and false-negative reports.

## Deviations from `devPlan.md` / `arch.md`

There is no `devPlan.md` and no `arch.md` — the readme is the whole
specification. Where the build diverged from it:

- **Wave 1 built a second pile.** The readme's own §"Junk is a decision with no
  owner" is the record of that divergence being caught and corrected, which is
  the best possible place for it.
- **Stage 2 turned out to be real work, not a header read.** CF Email Routing
  prepends `Authentication-Results`; only the **topmost** header is trusted per
  RFC 8601 (an attacker's forged `dmarc=fail` sits below ours), and we reject
  only on explicit `dmarc=fail` — `dmarc=none` is not a fail signal
  (`boundary.test.ts:398,413`).
- **Blocked books are identified by naming convention**, not by a typed field:
  `Blocked`, case-insensitive, plus per-tenant KV for the tenant book. Cheap,
  and a rename by a human silently disarms it.
- **The graduation sweep lives in ingest, not the agent worker**, though it
  writes bouncer@'s working data — because it also republishes the stage-1
  bloom, and the bloom lives with the thing that reads it.

## Reversals

Two, both from the #107 rework, both overturning **s12's own waves** rather
than an earlier section. Named here so nobody restores them as regressions:

1. **`role: 'quarantine'` → `role: 'junk'`, displayed `Quarantined`.** Wave 1
   invented a role that is not in the IANA JMAP registry, which a
   standards-native client renders as an ordinary folder with no spam handling
   — a client-compat cost taken by accident. The past participle is
   load-bearing: *"Quarantine" is a room; "Quarantined" is a condition.* `Junk`
   survives as the role because the role is not negotiable in a standards-native
   system; our own surfaces show a decision instead of a pile, and webmail hides
   `junk` from the sidebar and from move targets entirely.
2. **`unsure` releases → `unsure` holds.** Wave 2-C shipped the mid-band so that
   a garbage parse or a missing model degraded to *release*. #107 inverted it:
   `unsure` now holds and asks. State the consequence plainly, because it is a
   live-operations fact — **a classifier outage now holds mail** rather than
   passing it through, and the proposal says so explicitly rather than
   presenting an outage as a judgment
   (`services/agent/src/midBandProposal.test.ts:241`).

## Absorbed / donated

- **Absorbed from s11:** the facet columns bouncer stamps (T6), the lobby model,
  and T9's line — *"marker when nothing can be decided, proposal when something
  can"* — which is the whole argument for Fix 1. s12 is the second user of that
  rule and the one that generalised it.
- **Absorbed from s10:** every primitive. Books for sender sets, chains for
  history, proposals for authority, `write_policy`, the membership chokepoint,
  and decision 5's authenticated-directive pattern. The readme's claim of "no
  new primitives" holds up under inspection — the only genuinely new storage is
  `domain_deny_list` and `deny_counters`, and both exist precisely *because*
  a book was the wrong shape for five thousand junk domains.
- **Absorbed from s11 T1:** deterministic `due_at` extraction, which bouncer
  stamps at the boundary.
- **Donated → s12's own rework:** #107's approve/decline plumbing on
  `held-mail-review` fixed a bug belonging to **s11 T9** in passing — declining
  a `budget-overrun` was impossible from the webmail, because the UI demanded a
  reject reason for every kind while the server refuses one on
  `NO_FAULT_KINDS`. **s11's note should know that s12 unbroke its decline
  path.**
- **Donated → the archive generally:** the "wrapper is instruction, payload is
  evidence" enforcement-by-signature pattern. Any future agent that reads
  third-party content should copy the signature, not the prose.

## What grew stale during the build

- **The readme's own migration warning was correct and is now discharged.** It
  said the rename was *"free today and costs a migration tomorrow"* — and #107
  cashed that in with a read-only production check first (0 chain rows, 0 held
  messages) before writing the migration. The warning did its job; it is now
  history, and the guarded `DELETE` is what remains of it.
- **`.plans/_archived/_index.md` recorded s12 as "waves 1+2 complete (#95–#97,
  #107)" with no carried-forward entry.** That is right on the facts, but it
  reads as if #107 were part of wave 2. It was a *rework* that reversed two
  wave-1/2 decisions, and the distinction is the most useful thing in this
  folder.
- **PR #97's own body** says the mid-band's garbage path "parses as `unsure` →
  release". Ten days later that is the opposite of the shipped behaviour. A PR
  body is a snapshot, and this one is now a trap for anyone reading the merge
  history for current semantics.

## Traps for the next section

- **A bloom filter's only unforgivable bug is a false negative**, and it is the
  one a hand-written test will not find. The property test here caught a sign
  coercion that made whole classes of entry invisible. If you build a
  probabilistic index, test the *guarantee*, not the examples.
- **Enforce an injection boundary in the type signature.** `parseIntent(wrapper:
  string)` cannot be handed the evidence. Prose in a comment saying "do not pass
  the body here" is not a boundary; a parameter that does not exist is.
- **Bias every ambiguous split toward the safe side and say which side that is.**
  Less wrapper means an unparsed directive and a clarifying question; more
  wrapper means executing attacker text. Those are not symmetric, and the code
  should say so where the split happens.
- **A new mailbox role is a client-compatibility decision.** The IANA JMAP role
  registry is short (`inbox|archive|drafts|junk|sent|trash|flagged|important`);
  anything outside it renders as a plain folder in every standards-native
  client, silently.
- **"Inert until configured" is a claim you can pin.** Assert byte-identical
  behaviour against the *real* handler with everything empty, and a whole class
  of deploy anxiety goes away permanently.
- **Check the live shard before writing a data migration, not after.** Ten
  minutes of read-only SQL turned a scary rename into a free one, and produced
  the guard that makes the scary case stop the deploy instead of eating mail.
