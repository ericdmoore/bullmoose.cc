# 008 -E3-I3- Admin lifecycle — update + delete

| | |
|---|---|
| **Kind** | capability |
| **Effort** | **E3** — regraded on delivery. The tombstone design was adopted, so this crossed the migration cliff: one hand-run `ALTER TABLE`. See *Status* |
| **Impact** | **I3** — regraded on delivery. Footnote 5's own argument: the binding-disable route is a named de-risking dependency of `007`, and it shipped here rather than being split out |
| **Owner** | `sVOL` |
| **Depends on** | — |
| **Status** | **✅ done** — shipped with `.feedback/fromClaude/agentic/023` (P1). See below |

---

## Status — what shipped, and the four calls that were open

Shipped as one commit with `agentic/023`, because the kill switch and the rest
of this unit are the same two files (`services/provision/src/index.ts`,
`packages/cli/src/admin.ts`) and splitting them meant two agents in one file.

**Both grades moved, and both were flagged in advance by this file.**

- **`E2` → `E3`** (Open Question #2 resolved *for* tombstones). `accounts`
  gains `deleted_at`. Operators run, by hand, before deploying:
  `ALTER TABLE accounts ADD COLUMN deleted_at INTEGER;` — documented in
  `control-plane.sql` beside the column (the `contact_cards.dav_name`
  precedent) and in `docs/DEPLOY.md` §1 with the ordering constraint spelled
  out, because `deleted_at IS NULL` is now in the auth path and a worker
  deployed ahead of the column authenticates nobody.
- **`I1` → `I3`** (Open Question #1 resolved by *shipping*, not splitting).
  The ledger's footnote 5 is right that binding-disable is `I3`; the answer was
  to land it here in wave 3 rather than to file a second unit for one `UPDATE`.

**Scope actually built** — tier 1 whole, tier 2 for accounts only, tier 3
narrowly, tier 4 whole:

| | route | note |
|---|---|---|
| **U** | `POST /agent-bindings/{id}/disable` · `/enable` | the kill switch; `?email=` narrows an ambiguous id |
| | `PATCH /tenants/{id} {name}` · `PATCH /accounts/{id} {displayName}` | rename |
| | `PATCH /domains/{domain} {status}` | `active` \| `suspended`, allow-listed |
| **D** | `DELETE /accounts/{id}` | **soft** — tombstone + route/KV teardown |
| | `DELETE /domains/{domain}` | hard; 409 while any route/identity is on it |
| | `DELETE /tenants/{id}` | hard; 409 while anything references it |
| | `DELETE /agent-bindings/{id}` | hard; 409 while invocations are queued |

CLI: `admin tenant rename|delete` · `domain suspend|resume|delete` ·
`account rename|delete` · `agent disable|enable|unbind` ·
`account list --include-deleted`.

### The five judgement calls, stated

1. **Soft delete for accounts, hard for domains and tenants.** Not a
   compromise — they are different situations. An account's mail, calendars,
   contacts and blobs live on `accounts.shard`, a database this worker cannot
   reach, so dropping the row strands all of it addressed by an id that
   resolves to nothing: the evidence is destroyed and the storage is not freed.
   A tenant or domain that nothing references **never carried mail**, so there
   is no history a tombstone would preserve — and that empty case is exactly
   the mistyped-domain complaint this unit exists for. Tombstoning it would
   also mean a legitimate later re-add of the same name hits a corpse.

2. **`tokens` and `grants` keep their hard `DELETE`.** Done-when #4 asked for
   `revoked_at` on them. Declined, and this is the one done-when not met:
   `s03.A` T2 owns grant tombstones *and* a `grant_lifecycle` log, and doing
   the column half here buys the repo the two hand-run schema events this
   file's own tier-2 warning says to avoid. Deferred deliberately, not missed.

3. **Suspend had to be made real.** Tier 1 proposed `PATCH /domains {status}`
   as "the safe 90% of delete". **Nothing in the tree reads `domains.status`** —
   ingest resolves through KV with no D1 fallback — so as specified it was
   cosmetic, and a suspend that does not stop mail is worse than no suspend.
   It now moves the KV keys aside (mail bounces `550` immediately) and
   `resume` puts them back. They are *parked*, not deleted, because `forwardTo`
   is a KV-only field D1 cannot rebuild; resume restores the parked copy
   verbatim and falls back to `routes` only for keys with no parked copy.

4. **`--yes`, not a prompt.** Tier 4 said "prompt unless `--yes`". Prompting
   breaks `ssh host 'bullmoose …'` and CI, no other destructive verb on this
   surface prompts, and the I/O contract has no interactive posture. So:
   irreversible verbs (`tenant|domain|account delete`, `agent unbind`) refuse
   without `--yes`; `--dry-run` previews; the **reversible** verbs — including
   `agent disable` — need nothing. Making the kill switch harder to pull than
   it has to be defeats the point of having one.

5. **Bare `bind_xxxxxxxx` in the route, not `/accounts/{id}/…`.** The fix note
   proposed the account-scoped path. `agent_bindings` is `PRIMARY KEY
   (account_id, id)` so an id alone is not formally a key — but every other
   route here speaks in email addresses, `agent bind` hands the operator a bare
   binding id, and requiring `t_home__a_3f2a1b9c` at 3am is the friction the
   kill switch exists to remove. The route resolves the id to its account and
   **409s** if one id sits on two accounts (`?email=` narrows it). Silently
   picking a row would have been the bug.

### Six things review caught that the design as written got wrong

Recorded because each was a *design* hole, not a typo, and the corrected rule
is the interesting part. All six are pinned by tests.

1. **Soft delete made hard delete unreachable.** `DELETE /domains` refused
   while any identity sat on the domain, and `DELETE /tenants` counted
   tombstoned accounts and principals — but `deleteAccount` deliberately
   *retains* `identities`, and nothing in the tree deletes an `identities` or
   `principals` row. So a domain or tenant that ever held one account was
   permanently undeletable, with a 409 whose own advice could never be
   satisfied. **This defeated the unit's headline use case.**
   *Rule now:* blockers count **live** accounts only, and
   **`DELETE /tenants` is the terminal purge** — it drops the tenant's
   tombstones and their principals/identities/tokens/credentials in
   foreign-key order. Delete has to have a bottom.

2. **Deleting an account did not revoke its credentials.**
   `principals.login_email` is `UNIQUE` and `createAccount` reuses a principal
   by that email, so re-creating a deleted address **re-attaches the old
   principal** — every token and the password that could read the old mailbox
   silently become live credentials for whoever gets the address next. Exactly
   backwards for the delete-a-compromised-mailbox case.
   *Rule now:* if the tombstone leaves the principal owning no live account,
   its tokens and password go with it. If it still owns one, they stay — a
   principal legitimately owns `eric@a.com` and `eric@b.com`, and deleting one
   must not log the other out.

3. **Disable holds the queue; delete cancels it.** The `023` decision (hold
   `pending` rows) was right for disable and wrong for delete: the drain skips
   tombstoned accounts, so a row left `pending` there could never reach a
   terminal status — it blocked `agent unbind` forever and permanently
   inflated the drain's held-backlog log. `deleteAccount` now fails them.
   That is the general rule: **a pause holds, a terminal verb terminates.**

4. **Suspend was leaky in two directions.** `POST /accounts` on a suspended
   domain wrote a live route key (a partial suspension with no read path that
   showed it), and `GET /domains/{d}` — a *read* that happens to write
   `status='active'` — silently un-suspended the domain while its keys stayed
   parked. Both now refuse. Also: `parkDomainRoutes` enumerated keys with
   `KV.list`, which lags writes by up to a minute, so an account provisioned
   moments earlier was missed while the step still reported success; it now
   unions D1's authoritative `routes` rows with the KV listing.

5. **Account teardown only handled `kind = 'mailbox'` routes.** An alias, a
   forward, or the catch-all `localpart = '*'` — which `resolveRoute` falls
   back to — survived in both D1 and KV, kept delivering into the tombstone,
   and blocked the domain delete. Now every route naming the account goes.

6. **Public share links outlived the account.** They resolve from KV on no
   credential at all, so tombstoning changed nothing: anyone holding a minted
   URL kept pulling R2 blobs for up to 90 days. `deleteAccount` now revokes
   them (absence denies, so deleting the key *is* the revocation).

The through-line: **a soft delete is only as good as the set of things that
check the tombstone**, and the first draft checked resolution paths while
missing every path that grants access without one.

### Done-when, measured

1. ✅ mistyped domain — `admin domain delete <typo>` unwinds the Cloudflare
   catch-all and the SES identity, and reports DNS records and Email Routing
   itself as *not* unwound, in `addDomain`'s own `steps[]` shape.
2. ✅ `admin agent disable <bindingId>` — proved with ingest's enqueue query,
   copied verbatim, returning zero rows.
3. ✅ deleting an account drops the KV key *and* the `routes` row, KV first
   (the mirror of create's D1-first order, so a crash between them bounces mail
   for a live account rather than delivering into a tombstone).
4. ⚠️ **not met, deliberately** — see call #2. Revoked tokens still hard-delete.
5. ✅ `DELETE /domains/{d}` with a live account 409s with a readable message
   naming the counts, rather than a 500 carrying an FK error.
6. ✅ — and it was already fixed: the `IMPLEMENTED`/`DESIGNED` arrays landed
   with `common/025`. Only the new verbs needed adding.

### Deltas the ledger should absorb

- **`_verify.sh` has no `SystemAdmin` assertion at all** — it asserts JMAP
  methods, and `services/provision` is not JMAP. Every cell in the
  `SystemAdmin` row is therefore invisible to the volume's executable grid,
  in both directions. Not fixed here (`_verify.sh` is off-limits to this unit);
  worth a decision about whether the grid's one non-JMAP row gets a harness.
- **`services/provision` had `createAccount.test.ts` and `mintScopes.test.ts`
  when this unit was written**, not "no test file" as Bread-crumbs claims.
  `_context.md` §5's "two test files in the whole repo" is long stale.
- **Citation drift confirmed**: the admin gate is `:52` in the working tree,
  not `:46` or `:47`.
- `admin.ts` referenced an `admin.test.ts` in its header that does not exist —
  the assertions it describes actually live in `packages/cli/src/help.test.ts`.

---

## Cells covered

`SystemAdmin × Update × JMAP` · `SystemAdmin × Delete × JMAP` ·
`SystemAdmin × Update × CLI` · `SystemAdmin × Delete × CLI`

Four cells — the `~~` half of the `CR~~` that the `SystemAdmin` row carries on both surfaces.

Plus, by my call rather than the ledger's: **agent-binding update and delete**. `config.yml`
files `AgentBinding` under the `Agents` noun, and `_index.md` §4 maps `Agents × C/D` to `007`
— but bindings live in this worker, behind this auth model, with this fan-out. `007` states
the same split from its side. See Open Questions #1; this is the sharpest disagreement between
these two units and the ledger.

⚠️ **The grid column is a misnomer here.** `SystemAdmin`'s "JMAP" column is not JMAP —
`services/provision` is a plain REST worker with its own bearer scheme, sharing nothing with
`services/jmap` except D1. The grid reads as though these are JMAP methods. They are not.

## Why these grades

**E2.** Every route is a sibling of routes that already exist, in one 744-line file, over
tables that already exist. The CLI mirror is a `switch` case per verb in one 311-line file.
No new service, no new dependency.

It is **not E1** because doing it *correctly* is not a SQL statement. `POST /accounts` writes
five places including a **KV** hot copy (`:409`), and `POST /domains` mutates **two external
systems** — Cloudflare and AWS SES. Delete is not the mirror image of create here; it is a
teardown across three systems, only one of which is transactional. Full inventory below.

**I1, and I want to be blunt about it:**

- *Human-verifiable* — yes, straightforwardly. An operator runs `bullmoose admin domain delete
  <typo>`, `admin domain list` no longer shows it, and mail to it bounces. That is CLI output
  a person reads.
- *Unlocks nothing* — no unit in `_index.md` and no `sNN` section names admin delete as a
  blocker. I checked. **This unit exists because provisioning is one-way and a mistyped domain
  is permanent via the API**, which is a real operational complaint (the repo's own recent
  history is demo/deploy iteration — `demo-keys: … deploy runbook`) and not a feature.

The one place that grade is arguably wrong is the binding-disable route. See Open Questions #1.

## What exists today

**One gate for everything.** `services/provision/src/index.ts:47`:

```ts
if (request.headers.get("Authorization") !== `Bearer ${env.ADMIN_TOKEN}`) …
```

A single shared string. No per-operator identity — which is why `createGrant` records
`created_by` as the literal `'admin'` (`:556`). Whatever this unit tombstones, it cannot
record *who*.

**The route table, verbatim** (`:55-120`):

| | route | handler |
|---|---|---|
| **C** | `POST /tenants` `:55` | `createTenant` `:131` |
| | `POST /domains` `:61` | `addDomain` `:170` |
| | `POST /accounts` `:67` | `createAccount` `:324` |
| | `POST /tokens` `:82` | `mintPrincipalToken` `:459` |
| | `POST /agent-bindings` `:94` | `createAgentBinding` `:627` |
| | `POST /grants` `:104` | `createGrant` `:519` |
| **R** | `GET /tenants` `:58` · `GET /domains` `:59` · `GET /accounts` `:60` · `GET /domains/{d}` `:64` · `GET /tokens` `:93` · `GET /agent-bindings` `:100` · `GET /grants` `:117` | |
| **U** | `POST /principals/password` `:79` | `setPassword` `:425` — **the only update in the API** |
| **D** | `DELETE /tokens/{id}` `:101` · `DELETE /grants/{id}` `:118` | `revokeToken` `:498` · `revokeGrant` `:602` — **the only deletes** |

Both deletes are hard: `DELETE FROM tokens` (`:499`), `DELETE FROM grants` (`:603`). Nothing
exists for tenant, domain, account, or agent-binding.

**The CLI mirror** (`packages/cli/src/admin.ts`, 311 lines, dispatch `switch` at `:71`):
`init` `:53` · `tenant create` `:72` / `list` `:78` · `domain add` `:86` / `status` `:100` /
`list` `:110` · `account create` `:118` / `list` `:134` · `agent bind` `:147` / `list` `:174` ·
`grant create` `:185` / `list` `:210` / `revoke` `:224` · `token create` `:230` / `list` `:244`
/ `revoke` `:256` · `password <email>` `:264`.

⚠️ **The CLI's own help is wrong today.** The error text at `:278-280` tells the user that
`token` and `agent` are *"designed (not yet built)"* while both are implemented directly above
it, and the module taxonomy at `:11-21` marks them `○`. Fix that in this unit — it is one edit
and it is actively misleading operators.

### Why delete is not the inverse of create

**`createAccount` writes five places** (`:375-412`): `accounts` `:378`, `identities` `:383`,
`routes` `:387`, six role `mailboxes` `:401`, and — outside the D1 batch — the **KV hot copy**
`env.ROUTES.put(...)` `:409`. Ingest resolves recipients from KV, not from D1
(`services/ingest/src/index.ts:285-296`). Delete the account row without the KV key and mail
keeps being accepted into an account id that no longer exists.

**`addDomain` mutates Cloudflare and SES**, not just D1: email-routing enable `:182`,
catch-all rule → ingest worker `:186`, DKIM CNAMEs `:219`, custom MAIL FROM + its MX/SPF
`:229,:239,:246`, DMARC `:254`, `_jmap._tcp` SRV `:264`, SES identity `:199`. A domain delete
that drops only the D1 row leaves a live catch-all pointing at the ingest worker for a domain
the platform no longer knows about.

**`createAgentBinding` also arms a responder.** When `slaSeconds` is set it inserts
`watchdog_{id}` into `responders` (`:646-660`). Deleting the binding without that row leaves
an armed auto-responder telling senders an agent is *"temporarily unavailable"* forever.

**The data plane is a different database.** `accounts.shard` (`control-plane.sql:36`, default
`'shard0'`) selects it, and this worker's `DB` binding is the control plane. Emails, calendars,
contacts and R2 blobs are unreachable from here. Account deletion is inherently cross-plane.

### Integrity footguns that argue for *update* before *delete*

- `createTenant` is `INSERT OR IGNORE` (`:133`). Re-POSTing with a corrected name **silently
  no-ops** and returns `ok: true`. There is no rename.
- `identities` is `UNIQUE (account_id, email)` (`control-plane.sql:46`) — **not** unique per
  email. So `POST /accounts` twice for the same address creates a *second* account, repoints
  `routes` (`INSERT OR REPLACE` `:387`) and the KV key (`:409`), and orphans the first
  account's mail. No error, no warning.
- `agent_bindings.enabled` (`data-plane.sql:104`) is written `1` at creation (`:638`) and never
  written again. Both drain paths filter on it (`services/agent/src/index.ts:110`,
  `services/ingest/src/index.ts:169`), so it *is* a kill switch — with no route to reach it.
- No `revoked_at` on `tokens` (`control-plane.sql:62-72`) or `grants` (`:84-95`). Revocation
  destroys the evidence along with the access.
- Everything throws into one `catch` that returns `{ error: String(err) }` with **500**
  (`:121-123`). An FK violation from a premature delete reads as an opaque server error.

## What to build

Tier by risk, not by noun. Ship tier 1 alone if that is all there is appetite for — it is most
of the value.

### Tier 1 — reversible state (do this first, regardless of the rest)

- **`POST /agent-bindings/{id}/enabled {enabled}`.** One `UPDATE`, and it is a real kill switch
  because both drain paths already honour the column. ⚠️ **Land this before `007`** — see Open
  Questions #1.
- **`PATCH /tenants/{id} {name}`** and **`PATCH /accounts/{id} {displayName}`** — rename, which
  is what an operator actually wants after a typo, and which the `INSERT OR IGNORE` at `:133`
  currently makes impossible.
- **`PATCH /domains/{domain} {status}`** restricted to `active | suspended`. Suspension is the
  safe 90% of "delete this domain" and touches nothing outside D1. `checkDomain` already writes
  `status` (`:309`), so the column is live.

### Tier 2 — soft delete, following `s03.A` T2 rather than inventing a second pattern

`s03.A-foundations/devPlan.md:42-50` specifies the shape: a `revoked_at` tombstone plus a
lifecycle log, with resolution filtering `revoked_at IS NULL` **in addition to** the existing
`expires_at` check *"so live behaviour is identical while history survives."*

Apply the same to `accounts` and `domains` (`deleted_at`), and **retrofit `tokens` and
`grants`**, which hard-delete today (`:499`, `:603`). A compromised token's usage history
should outlive its revocation.

Consequences to wire, not skip:
- `listAccounts` `:154` / `listDomains` `:147` filter the tombstone.
- Auth resolution filters it — otherwise a "deleted" account still authenticates.
- The KV route key must go at tombstone time, not at hard-delete time, or a soft-deleted
  account keeps receiving mail.

⚠️ **This is the migration cliff.** New columns, no migration framework — schema is applied by
re-running `CREATE TABLE IF NOT EXISTS` (`tools/README.md:10-11`, `readme.md:75-78`).
**Coordinate with `s03.A` T2 and add every column in one pass**, or this repo gets two
hand-run schema events instead of one.

### Tier 3 — hard delete, narrowly and last

- **`DELETE /accounts/{id}`** — KV route key, `routes` row, `identities`, `mailboxes`,
  `accounts`, and any `grants` naming it as grantee or target. Recommend it explicitly *not*
  touch the data-plane shard or R2, and **say so in the response body**, so the caller knows
  what remains.
- **`DELETE /domains/{domain}`** — refuse with **409** while any account exists on it. Unwind
  the Cloudflare catch-all and the SES identity, or report that it did not, using the same
  `steps[]` ok/detail shape `addDomain` already returns (`:294`). Symmetry with create is the
  point: create tells you which of eight steps failed; delete must too.
- **`DELETE /agent-bindings/{id}`** — must also drop `watchdog_{id}` from `responders`
  (`:646-660`), and should refuse (or cascade) while `pending`/`running` invocations name it,
  because `drain`'s `JOIN agent_bindings` (`services/agent/src/index.ts:108`) makes orphaned
  invocations permanently invisible.

### Tier 4 — the CLI mirror

`admin tenant rename` · `admin domain suspend | delete` · `admin account rename | delete` ·
`admin agent enable | disable | unbind`. Destructive verbs prompt unless `--yes`;
`promptHidden` already exists in the module's imports (`admin.ts:4`) as prior art for
interactive prompting. **Fix the stale help text at `:278-280` and the `○` markers at `:11-21`
in the same commit.**

## Done when

1. An operator mistypes a domain, runs `bullmoose admin domain delete <typo>`, and
   `admin domain list` no longer shows it — with the Cloudflare catch-all and SES identity
   either unwound or listed as not-unwound in the step output. A person reads that output and
   knows what is left.
2. `bullmoose admin agent disable <bindingId>` stops new invocations: a message delivered
   afterwards creates **no** `agent_invocations` row (`services/ingest/src/index.ts:169`
   filters `enabled = 1`).
3. Deleting an account stops mail — a message to the address bounces
   `550 5.1.1 recipient unknown` (`services/ingest/src/index.ts:117`). **This is the assertion
   that catches forgetting the KV key**; a D1-only check passes while mail still lands.
4. A revoked token stops authenticating **and** is still returned by a forensic query with its
   `revoked_at` set.
5. `DELETE /domains/{d}` with a live account on it returns **409 with a readable message**, not
   a 500 carrying `String(err)` from the FK.
6. `bullmoose admin <garbage>` no longer claims `token` and `agent` are unbuilt.

## Bread-crumbs

- The dispatch block is `:51-120` — a flat `if` chain over `` `${method} ${pathname}` `` with
  two regex specials for `/tokens/{id}` `:101` and `/grants/{id}` `:118`. New parameterised
  routes follow that regex pattern; there is no router to learn.
- `revokeToken` `:498-501` and `revokeGrant` `:602-605` are the shape to copy — three lines
  each, returning `{ revoked: (res.meta.changes ?? 0) > 0 }`. Keep that response shape; the CLI
  already renders it (`admin.ts:227,259`).
- `accountByAddress` `:618` and `accountWithTenant` `:607` already resolve email → account;
  every new delete route wants one of them.
- `GRANTABLE_SCOPES` `:505-515` is the only allow-list in the file. If tier-1 `PATCH` routes
  take a field name, mirror that pattern rather than trusting the body.
- The `catch` at `:121-123` swallows everything into a 500. Any new route that wants a 409 must
  return it, not throw.
- Config: `ADMIN_TOKEN` is a plain `Env` field (`:33`) alongside `CF_API_TOKEN` `:34` and the
  SES keys `:35-36`. Nothing about adding routes changes the deployment surface.
- The CLI reads `adminUrl`/`adminToken` from its local SQLite config (`admin.ts:286-291`),
  deliberately separate from the mail account's `base`/`token` (`:7-9`). Destructive verbs
  inherit that separation for free.
- Tests: `services/provision` has **no test file** (`_context.md` §5 — two test files exist in
  the whole repo, neither here), and `vitest.config.ts:24` excludes `packages/cli/**` from
  coverage. Both halves of this unit ship with zero automated verification unless someone
  builds it. Done-when #3 is the real test.

## Open questions / where this could be wrong

1. **One slice of this unit is not `I1`, and the ledger's wave-4 placement is wrong for it.**
   `agent_bindings.enabled` is the only off switch for an agent, and `007` gives a human a way
   to fire agents on demand. Shipping `007` first means a runaway binding can only be stopped
   from a D1 console. By `config.yml`'s own definition — *"removes a STATED blocker from at
   least one other unit"* — binding-disable is a named de-risking dependency of `007`, which
   makes it `I3`, not `I1`, and puts it in wave 3. The honest fix is to split one route out of
   this unit. I did not split it because the split is a single `UPDATE` statement and a
   two-unit ledger entry for one SQL line is its own kind of dishonesty. **A reviewer should
   decide this; it changes the build order.**

2. **`E2` holds only for hard delete.** The tombstone design I recommend in tier 2 adds columns
   to four tables, which is `E3` by `config.yml`'s own anchor (*"New table or column +
   migration"*) and by `readme.md:75-78`'s migration-cliff argument. I left the filename at
   `E2` to match the ledger, but I believe **the ledger is wrong if the recommendation is
   accepted**, and I would rather flag the contradiction than quietly pick the cheaper design
   to protect a grade. Decide the design first, then regrade.

3. **Hard delete may not be worth building at all.** Cloudflare and SES state lives outside D1
   and drifts; a `DELETE /domains` that half-unwinds is arguably worse than none, because it
   leaves an operator believing the domain is gone. A defensible alternative: ship tier 1 only
   (rename + suspend + disable), and do real deletion by hand against a runbook. That version
   is `E1`/`I1` and nearly free. I did not choose it because *"a mistyped domain is permanent"*
   is the actual complaint — but it is close, and a reviewer who values the blast radius over
   the ergonomics should win this argument.

4. **Account teardown is genuinely unowned, and this unit does not fix that.** The control
   plane and data plane are separate D1 databases (`accounts.shard`, `control-plane.sql:36`),
   and R2 blobs have **no GC path at all** — `packages/mailstore/src/index.ts:644` says so in
   a source comment: *"Blob is retained in R2 for now… garbage collection is a separate sweep
   (TODO)."* `s03.B` T1 owns blob pinning; `010` owns explicit blob delete; **nobody owns
   deleting an account's data**. Whatever ships here, "delete account" will leave rows and
   objects behind. That gap probably deserves its own unit and does not have one.

5. **Adding destructive verbs behind one shared bearer increases blast radius with no
   attribution.** `ADMIN_TOKEN` (`:47`) is a single string; `created_by` is the literal
   `'admin'` (`:556`). Tombstones that cannot name an actor record half a fact. A reasonable
   position is that this unit should not ship before admin auth is more than one string. I did
   not make that a dependency edge because nothing in the ledger owns admin auth — which is
   itself worth noticing.

6. **Nothing was run.** No provision request was issued, no Cloudflare or SES call observed.
   The claim that deleting the KV key is what stops mail is read from
   `services/ingest/src/index.ts:116-117,285-296`, not tested.

7. **Citation drift.** `_context.md` footnote 20 (`:139-142`) cites the admin gate at `:46`; in
   the working tree it is `:47` (`:46` is the `fetch` signature). Every other line number in
   that footnote — `:79`, `:101`, `:118` — matches exactly.
