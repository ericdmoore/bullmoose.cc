# 019 -E2-I3- Email triage verbs over CLI

| | |
|---|---|
| **Kind** | projection |
| **Effort** | **E2** — `packages/cli` only; no schema, no new JMAP method, no migration |
| **Impact** | **I3** — human-verifiable; *unlocks* is contested, see below |
| **Owner** | `sVOL` |
| **Depends on** | `016` (CLI I/O contract, `s05` T1) |
| **Status** | done |

## Cells covered

`Email × Update × CLI` · `Email × Delete × CLI` — the two `-` cells in the CLI's Email row
(`_index.md` §1: `Email | CLI | -R~-`).

`Mailbox × Read × CLI` is already built (`bullmoose mailboxes`, `main.ts:879`) and is
consumed here as the move-target resolver, not re-delivered.

## Why these grades

**E2.** `packages/cli` only. New commands over live methods, written to a contract `016`
already establishes. Not E1 — it is several commands plus a mirror-reconciliation path plus
the `--dry-run`/`--if-state` handling, across at least `main.ts` and a new triage module.
Not E3 — no table, no column, no new semantics anyone outside `packages/cli` must respect.

**I3 — and the *unlocks* half is the weakest claim in this file.**

- *Human-verifiable*: unambiguous. `bullmoose archive <id>` then look at any mail client, or
  `bullmoose sync && bullmoose mailboxes`. A non-engineer confirms it in one line.
- *Unlocks*: **no unit in `_index.md` lists `019` in its `depends on` column, and no `sNN`
  section names it as a blocker.** By the strict reading in `readme.md:89-90` — *"Not 'would
  be nice to have first'; a named dependency"* — that is `I1`, not `I3`. The nearest thing to
  a named dependency is `s05/readme.md:115-116` (*"a complete CLI is a behavioural reference
  to build the UI against"*), which is explicitly a convenience. I have kept the ledger's
  `I3` because the filename is identity (`readme.md:26-27`) and renumbering grades mid-pile
  is worse than a documented disagreement — but see open question 1, and **a reviewer should
  probably move this to `I1`.**

There is one substantive *unlocks* argument and it is worth stating so it can be judged
rather than assumed: `014` gives an **agent** the ability to move and destroy mail. Today a
human has no bulk undo for that on any surface — there is no `Email/set` caller in the CLI
outside the agent worker loop. Shipping agent-side triage without human-side triage means the
only actor who can reorganise a mailbox at scale is the one that reads untrusted email. That
is an operational dependency, not a build dependency, and the rubric measures build
dependencies.

## What exists today

### This is the slice `s05` punted, by name

`s05` scoped itself deliberately and said so twice. `.plans/s05-cli-crud/readme.md:95-96`:

> **Out:** mail triage verbs (`move`/`label`/`flag`/`archive` — same class-(b) gap, worth
> its own slice) · Files (s03.B) · …

and again in `.plans/s05-cli-crud/devPlan.md:138-139`:

> Mail triage verbs (`move`/`label`/`flag`/`archive` — same class-(b) gap, deserves its own
> slice) · Files CLI surface (arrives with **s03.B**) · …

**This unit is that slice, and `sVOL` owns it** (`_context.md` §6: *"Gaps owned by nobody …
Email triage verbs × CLI (s05 punted them: 'worth its own slice')"*).

Note what "same class-(b) gap" asserts. `s05/readme.md:16-19` defines class (a) as *"the
server can't do it either"* and class (b) as *"the server can, the CLI doesn't expose it"*.
Putting triage in class (b) is a claim about the server — and it is correct, verified below.
That claim is exactly what `readme.md`'s capability/projection law requires before a unit may
be filed as a projection.

### The CLI's mail surface, and the capability beneath it

**The CLI reads mail well and mutates nothing.** Verified command surface:

| Command | Where | Source of truth |
|---|---|---|
| `read` | `main.ts:681` | live JMAP `Email/get` (`:728`) |
| `show` | `main.ts:837` | local mirror row, then body |
| `search` | `main.ts:810` | **local** `cli_fts` (`:828`) |
| `log` | `main.ts:775` | local mirror |
| `mailboxes` | `main.ts:879` | local mirror |
| `sync` | `main.ts:294` → `sync.ts:138` | `Email/changes` (`:225`) or full resync (`:250`) |
| `send` | `main.ts:338` | `Email/import` (`:432`) |

**There is no flag, move, label, archive, or delete command.** The only `Email/set` call in
the entire package is inside the agent worker loop (`packages/cli/src/agent.ts:196`), where
it creates a reply draft. Even `bullmoose read` does not set `$seen` — it fetches the body
and prints it (`main.ts:728-754`), leaving the message unread forever.

**The server capability is complete.** `Email/set` (`services/jmap/src/methods/email.ts:226`,
registered `:50`) covers all three write classes this unit needs:

- **update — flags and moves**, `:263-277` → `applyEmailPatch` (`:332`), which accepts
  RFC 8620 patch paths under `keywords` and `mailboxIds` (`:351-359`), full-replace or
  per-key (`applySetPatch:380-397`);
- **destroy**, `:280-291` → `store.destroyEmail`;
- optimistic concurrency, `ifInState` checked at `:234-236`, throwing `stateMismatch`.

So this is pure projection and qualifies under `readme.md:42`.

**The move targets exist.** Account creation seeds six role mailboxes in one batch —
`inbox`, `sent`, `drafts`, `trash`, `junk`, `archive`
(`services/provision/src/index.ts:391-397`) — and `Mailbox/query` filters on `role`
(`mailbox.ts:54`, condition `:119`). ⚠️ `004` (`Mailbox/set + CLI`) states at its `:49-51`
that this unit is blocked on it because *"there are no folders to move to beyond the six
seeded roles."* **I disagree, and the disagreement is recorded rather than resolved.**
`archive` is the single most-used triage verb in any mail client and it is one of the six.
`004` unlocks *custom* folders — `bullmoose move --mailbox Receipts` — which is real value
and not a precondition. Filing an `E2` behind the volume's only `E3` on that basis would be
a mis-sequencing, so `_index.md`'s edge (`019` depends on `016` only) is right as it stands.

**What `016` has not settled that this unit needs.** `016`'s own §"What sVOL adds" records
that `--if-state` appears in `s05/arch.md` §1.7 and invariant 6 but **zero times in
`s05/devPlan.md`**, so no task owns it; and that the exit-code table has no JMAP mapping.
Both land squarely on this unit — a triage verb is the first command where a state mismatch
is a realistic outcome. If `016` ships without them, this unit implements them and `016`'s
contract should be amended rather than quietly diverged from.

## What to build

### The verbs

Keep them thin, and let the JMAP set semantics show through rather than inventing a
vocabulary the server does not have.

```
bullmoose flag    <id…> --add $flagged --remove $seen     Email/set update  keywords/*
bullmoose seen    <id…> [--unset]                          sugar over flag
bullmoose move    <id…> --role archive | --mailbox <id>    Email/set update  mailboxIds (replace)
bullmoose label   <id…> --add <mb> [--remove <mb>]         Email/set update  mailboxIds (add/remove)
bullmoose archive <id…>                                    sugar: move --role archive
bullmoose junk    <id…>                                    sugar: move --role junk
bullmoose trash   <id…>                                    sugar: move --role trash
bullmoose rm      <id…> --force                            Email/set destroy
```

**`move` and `label` are genuinely different operations and both are needed.** JMAP's
`mailboxIds` is a *set*, not a pointer — a message can be in several mailboxes at once
(`email.ts:109` maps the row's list into the JMAP object; `applySetPatch:380-397` handles
both full replace and per-key add/remove). So `move` replaces the set and `label` adds to it,
and the second is what `s05`'s word "label" was reaching for. Getting this wrong in either
direction is the classic mail-CLI bug: a `label` that silently unfiles the message, or a
`move` that leaves it in Inbox too.

⚠️ `applyEmailPatch` refuses to leave a message in zero mailboxes (`email.ts:362-364`:
*"an email must belong to at least one mailbox"*). So `label --remove` on the message's only
mailbox is an error, not an archive. Catch it client-side with a message naming `move`,
rather than letting it come back as a bare `invalidProperties`.

**`rm` requires `--force`, and its help text must not say "delete".** `store.destroyEmail`
(`packages/mailstore/src/index.ts:643-655`) deletes the `email_mailboxes`, `email_keywords`,
and `emails` rows; the R2 blob is orphaned, not reclaimed (comment at `:644-645`); there are
no tombstones (`s03.A` unstarted, `_context.md` §6). Nothing is recoverable. The gesture a
human means by "delete this message" is `bullmoose trash`.

### The I/O contract, clause by clause

`016` conditions all of this (`s05/arch.md` §1, `:9-90`). The sub-clauses that are
load-bearing *here*, as opposed to generally:

- **§1.8 `--ids`** (`arch.md:85-90`) — *"`--ids` prints one identifier per line and nothing
  else — the `xargs` shape."* This is the clause that makes the whole unit compose. It has to
  land on `search` and `log`, which today go through `printRows` (`main.ts:909`) with no such
  mode; `--json` there emits a **whole pretty-printed array** (`:913-921`), which
  `arch.md:46-47` correctly calls out as defeating every line-oriented tool.
- **§1.7 `--if-state` and `--dry-run`** (`arch.md:79-83`) — `--if-state <state>` maps to
  `ifInState` and returns **exit 5** on mismatch; `--dry-run` on destructive commands.
  `Email/set` already honours `ifInState` (`email.ts:234-236`), and `JmapClient.one` already
  surfaces the method error type: it attaches `jmapType` to the thrown `Error`
  (`packages/cli/src/jmap.ts:59-61`). So the exit-5 path is a two-line mapping, not a design.
  *(This also answers `016`'s open question 3: `one()` returns the whole result record
  (`jmap.ts:63`), so `newState` is available to thread — `--if-state` does not need new
  plumbing.)*
- **§1.5 exit codes** (`arch.md:62-72`). The mapping this unit needs, which `016` notes is
  missing: `stateMismatch` → **5**; `notFound` (a `setError` in `notUpdated`/`notDestroyed`,
  `email.ts:273-274`, `:284`) → **3**; `forbidden` → **4**; `invalidProperties` → **2**.
  ⚠️ Partial failure is the interesting case: `Email/set` returns per-id results, so
  `bullmoose archive` over 40 ids can half-succeed. Report per-id outcomes on stderr, exit
  non-zero if *any* id failed, and do not swallow the successes.
- **§1.2 EPIPE** (`arch.md:23-33`) — without it `bullmoose search --ids | head` throws.
- **§1.1 stdout is data** (`arch.md:14-21`) — a triage verb's stdout should be the ids it
  acted on, so verbs chain: `bullmoose archive $(…) | xargs bullmoose flag --add $seen`.

### Reconcile the local mirror, or the second stage of every pipeline is stale

This is the failure mode specific to the CLI, and it is the counterpart of `_context.md` §3's
warning for server-side surfaces.

`search`, `log`, and `mailboxes` all read the **local SQLite mirror**, not the server —
`cli_fts` joined to `emails` (`main.ts:828`), written only by `sync` (`sync.ts:352`). A
triage verb that writes over JMAP and returns leaves the mirror describing the old world. So:

```sh
bullmoose search "from:amazon" --ids | xargs bullmoose archive
bullmoose search "from:amazon" --ids     # ← still lists them as Inbox, until you sync
```

Two options, and take the second:

1. Tell the user to run `bullmoose sync`. Wrong — it makes every pipeline two-phase and every
   composed command a lie.
2. **Reconcile the touched ids in-process after a successful write.** `sync.ts` already has
   the pieces: `upsertEmails` (`:282`) re-fetches by id and rewrites the mirror rows including
   `email_mailboxes`, `email_keywords`, and `cli_fts` (`:330-360`); `deleteEmail` (`:364`)
   removes them. A triage verb calls the appropriate one for the ids it changed. Provide
   `--no-sync` for the case where the caller is batching and will sync once at the end.

Note the ordering constraint: reconcile **only after** the server write returns, and only for
the ids the server reported in `updated`/`destroyed` (`email.ts:299-304`). Reconciling
optimistically re-introduces exactly the divergence this is meant to prevent.

### Unix composition — the stated goal, with real pipelines

`s05/readme.md:25-27` is explicit that this is a posture problem, not polish: *"The
agent-first audience drives the CLI … and agents compose tools with pipes. A CLI that can't
be piped is a CLI agents use badly."* Concretely, after this unit:

```sh
# file a sender's mail
bullmoose search "from:amazon" --ids | xargs bullmoose archive

# rehearse a destructive sweep, then run it
bullmoose search "unsubscribe" --ids | xargs bullmoose trash --dry-run
bullmoose search "unsubscribe" --ids | xargs bullmoose trash

# mark everything older than the last 20 as read
bullmoose log -n 200 --json | jq -r 'select(.seen==0) | .id' | xargs bullmoose seen

# concurrency-safe scripted read-modify-write
state=$(bullmoose log -n 1 --json | jq -r .state)
bullmoose move ID --role archive --if-state "$state" || test $? -eq 5 && echo "raced; retry"

# chain two verbs on the same ids
bullmoose search "receipt" --ids | xargs bullmoose label --add mb_receipts | xargs bullmoose seen
```

Those belong in `help.ts`'s registry entries — `s05/devPlan.md:92-95` requires every new
command to carry *"examples that demonstrate composition"*, and `help --json` is described
there as *"the machine-readable spec agents read."*

## Done when

1. `bullmoose archive <id>` moves the message, and it shows up in Archive in a normal mail
   client. A person confirms it without reading JSON.
2. **The choreography assertion.** After `bullmoose archive <id>` on one machine, a *second*
   client sees the move: either `bullmoose read <id> --json` (which goes live to JMAP,
   `main.ts:727`) or an **incremental** `bullmoose sync` on a different machine reports the
   id in its updated set (`sync.ts:225-236`). This is what catches the shortcut of writing to
   the local mirror and skipping `Email/set` entirely — the tempting version, because the
   mirror is right there and `search`/`log`/`mailboxes` would all immediately agree with it.
   A local-only write passes every same-machine check and is invisible to the server forever.
3. **The mirror assertion, which is the same bug from the other side.** Immediately after
   `bullmoose archive <id>` — with no explicit `sync` — `bullmoose search` and
   `bullmoose mailboxes` report the new mailbox. A verb that writes to the server and skips
   reconciliation fails this while passing #2.
4. `--dry-run` on `trash` and `rm` performs **zero** mutations — asserted by comparing the
   JMAP state string before and after, not by eyeballing output (`s05/arch.md:198`,
   invariant 4).
5. `--if-state` with a stale state exits **5** and changes nothing (`arch.md:200`,
   invariant 6). Assert the "changes nothing" half: `Email/set` throws before touching
   anything (`email.ts:234-236`), so this should hold, and it is the half people forget.
6. `bullmoose search "…" --ids | xargs bullmoose archive` works end-to-end, and
   `bullmoose search "…" --ids | head -1` exits 0 with no stack trace (`arch.md:23-33`).
7. Partial failure is honest: archiving 3 ids where 1 does not exist reports the failure on
   stderr, still archives the other 2, prints the 2 succeeded ids on stdout, and exits
   non-zero.
8. `label --remove` on a message's only mailbox refuses client-side with a message naming
   `move`, rather than surfacing `invalidProperties` from `email.ts:363`.
9. `rm --force` destroys, and `bullmoose help rm` states that it is permanent, not Trash,
   and not recoverable.
10. Every new command has a `help.ts` registry entry with a composition example, and
    `bullmoose help --json` includes it (`s05/devPlan.md:97-98`).

## Bread-crumbs

- `parseArgs` options live at `main.ts:31-85`. There is **no** `--ids`, `--dry-run`,
  `--if-state`, `--add`, `--remove`, or `--role` today; `--json` exists as a global boolean
  (`:79`) and `--mailbox` as a string (`:45`).
- `printRows` (`main.ts:909`) is the shared list renderer for `log` and `search` and is where
  `--ids` and NDJSON have to land. Its `--json` branch (`:913-921`) is the whole-array form
  `016` replaces.
- `applyEmailPatch` (`email.ts:332`) is **exported** and also called by `EmailSubmission/set`
  (`submission.ts:73`). It is the single choke point for flags and moves; nothing in the CLI
  should reimplement patch construction.
- ⚠️ `Email/set` gates the entire method on the `draft` scope (`email.ts:230`) — flags, moves
  and destroys included. That is
  [`fromCodex/common/003`](../../.feedback/fromCodex/common/003%20-P1-%20Email-set-Draft-Scope-Can-Move-And-Destroy-Mail.md)
  (P1, open). Practical consequence for this unit: a token scoped `move` or `delete` but not
  `draft` will be **refused** by the server on every verb here. Until `003` lands, document
  that triage needs `draft` (or `mail`), and do not paper over it by telling users to mint
  broader tokens.
- `bullmoose read` does not mark `$seen` (`main.ts:727-754`). Whether it should start doing so
  is a behaviour change, not a bug fix — see open question 4.
- Resolve `--role archive` to a mailbox id from the **local mirror** first
  (`mailboxes` table, `main.ts:886-889`), falling back to `Mailbox/query` with
  `filter: {role}` (`mailbox.ts:54`, `:119`) when the mirror is empty. The agent loop does
  exactly the latter for drafts (`agent.ts:188-193`).
- `sync.ts` reconciliation entry points: `upsertEmails:282`, `deleteEmail:364`,
  `incrementalSync:215`, `fullResync:250`. `fullResync` deletes and repages, so never use it
  to "fix" a mirror after a write — it will mask a missing server write.
- The CLI's `cli_fts` is real and written (`sync.ts:352`). ⚠️ **The server's `emails_fts` is
  now real too** — `common/004` is closed
  ([`fromClaude/common/✅004`](../../.feedback/fromClaude/common/%E2%9C%85004%20-P2-%20FTS5-Documented-As-Load-Bearing-But-Unwired.md)):
  `Mailstore.insertEmail` writes it and `Email/query`'s `text` condition matches it, bodies
  included. `bullmoose search` is still local-only, but that is now a CHOICE (offline, no
  round trip) rather than a necessity, and the pipelines above still depend on a synced
  mirror. Worth one line in the help text — and worth revisiting whether `search` should
  grow a `--server` mode.
- No tests exist for `packages/cli` and coverage excludes it (`vitest.config.ts:24`,
  `_context.md` §5). `s05/devPlan.md:115-125` specifies the shape: unit tests with an injected
  fake JMAP client, **plus** a composition smoke script that actually pipes. Done-when #6 and
  #7 are the smoke-script half and cannot be covered by unit tests.

## Open questions / where this could be wrong

1. **The `I3` is probably wrong; `I1` is the defensible grade.** Nothing in `_index.md`
   depends on `019`. I kept `I3` to match the ledger and the filename, and argued the
   operational case above, but by `readme.md:89-90`'s own words that case is "would be nice
   to have first" dressed up. **If a reviewer changes one grade in this pile, make it this
   one** — and note that changing it changes the wave-3 sequencing rationale in
   `_index.md` §3, not just a letter.
2. **I contradict `004` on the dependency edge, in writing.** `004:49-51` claims this unit is
   blocked because there are no folders to move to. I claim `archive`/`junk`/`trash` are
   folders and are seeded (`provision/src/index.ts:391-397`). One of us is wrong about what
   "most-used verb" means, and the ledger edge follows whoever is right. My position: `004`
   unlocks *custom* folders and is a strict improvement, not a precondition.
3. **`move` versus `label` may be over-designed for a first cut.** Every real mail client
   exposes both, and JMAP's set semantics make both nearly free — but three of the eight
   commands above are sugar over `move`, and a reviewer could reasonably say ship
   `flag`/`move`/`rm` and let `archive`/`junk`/`trash` be shell aliases. I think the sugar
   earns its keep in `xargs` lines; I would not fight hard for `label`.
4. **Should `bullmoose read` start setting `$seen`?** It is what every mail client does and
   what a user expects, and this is the unit where the capability arrives. It is also a
   silent behaviour change to an existing read-only command, and it would make `read` fail
   for a token that lacks write scope. I left it out and flagged it; deciding it belongs here
   is reasonable.
5. **Partial-failure exit semantics are not in `s05`'s contract at all.** `arch.md:62-72`
   gives one code per invocation, and `Email/set` is inherently per-id. My "non-zero if any
   failed" is an invention. The alternative — exit 0 when anything succeeded, with failures
   only on stderr — is what some tools do and is friendlier in pipelines. Genuinely unsettled,
   and it should be settled in `016`, not here, so every multi-id command agrees.
6. **`--if-state` may be unusable in practice for triage.** The state string is
   account-global (`accountState`, `methods/common.ts:62`), so *any* concurrent change to the
   account — an inbound message arriving — invalidates it. On a live mailbox a scripted
   read-modify-write may lose the race almost every time, making exit 5 the normal outcome
   rather than the exceptional one. I have not measured this. If it is true, `--if-state` is
   a footgun for mail specifically and the answer is per-message concurrency, which JMAP does
   not offer here.
7. **Nothing was run.** All claims read from source. Specifically unverified: that
   `upsertEmails` (`sync.ts:282`) is safe to call outside a sync pass, and that an
   incremental `Email/changes` pass reports a CLI-originated `Email/set` update — done-when
   #2 and #3 both assume the changelog wiring (`email.ts:308-322`) works end-to-end.
