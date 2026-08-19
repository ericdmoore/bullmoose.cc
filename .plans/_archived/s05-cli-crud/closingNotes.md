---
plan: s05-cli-crud
status: closed
closed_at: 2026-08-19
closing_pr: none          # docs-only; .plans/*.md lands straight on main
acceptance: partial       # T3's write-side recurrence clause is unmet
residues: 2
reversals: 0
---

# s05 — closing notes

s05 was written as the cheapest work in the backlog: the JMAP server already
implemented contacts and calendar CRUD, and the CLI simply never called it.
Class (b), catch-up, no new protocol. That framing held — but the section did
not ship as "s05". Every one of its tasks was executed under a **sVOL unit
number** by the capability-surface sweep running in parallel (016 → T1, 017 →
T2, 018 → T3, 020 → T4), which is why `git log --grep s05` finds three commits
and the archive's own audit found the work by grepping the code instead. The
plan turned out to be a *specification* that another section built. That is a
fine outcome, but it means the landing notes in `readme.md` were written by
someone reconciling after the fact, and one of them softened a clause that
should have stayed sharp — see the ledger.

The genuinely interesting thing s05 produced was not CRUD. It was T1: the I/O
contract, and the discovery that **a process cannot observe its own EPIPE**.
That forced the acceptance signal out of unit tests and into a real subshell
with real pipes (`smoke/contract.mjs`), which is now the pattern the Go CLI's
conformance suite inherited.

## Acceptance ledger

Clauses quoted from `devPlan.md`'s **Done when** lines, split where one line
carried several independent claims.

| Done-when (verbatim) | verdict | evidence |
|---|---|---|
| T1 "`bullmoose log \| head -3` exits 0 silently" | ✅ met | `packages/cli/src/io.ts:286-318` (`installEpipeGuard` / `isBrokenPipe`), driven under a real pipe by `packages/cli/smoke/contract.mjs` via `packages/cli/src/contract.test.ts:27-46`; #27 |
| T1 "`contacts list --json \| jq -r .name` streams" | ✅ met | NDJSON emitter `packages/cli/src/io.ts` (`emitNdjson`), asserted in the piped smoke run — the test refuses to pass with fewer than 30 clause checks (`contract.test.ts:46`), so it cannot go green vacuously; #27 |
| T1 "`contacts list > /dev/null` shows chrome but no records; `2>/dev/null` the inverse" | ✅ met | the split is enforced **at the source**, not by convention: `packages/cli/src/io.test.ts:175-203` greps every command module for stray `console.log`; #27 |
| T1 "a table-driven test asserts the exit code for each failure class" | ✅ met | `packages/cli/src/io.test.ts:29-112` — including `io.test.ts:82`, "never maps anything to 0", which is the clause that matters; #27 |
| T2 "a book round-trips `import` → `export` → `import` with no drift" | ✅ met | `packages/cli/src/contacts.test.ts:62-86` (round-trip **and** export stability); #33 |
| T2 "create/edit/rm work from both flags and stdin; `--dry-run` mutates nothing" | ✅ met | `packages/cli/src/contacts.ts`; stdin sniffing per RFC 6350 at `io.test.ts:127-174`; `dryRun` gate `io.ts:39`; #33 |
| T3 "an event round-trips iCal → JMAP → iCal" | ✅ met | `packages/cli/src/calendar.test.ts:80-127` — timed-UTC and all-day, TZID preserved; #33 |
| T3 "editing one occurrence leaves the other occurrences untouched (asserted in a test, not assumed)" | ❌ **unmet** | nothing writes `recurrenceOverrides` from either CLI. `packages/cli/src/calendar.ts:293-299` and `cli-go/internal/cmd/calendar.go:452-462` both refuse `--occurrence` outright. Carried forward below |
| T3 "a bare edit against an occurrence id refuses rather than guessing" | ⚠️ moot | there is no occurrence id to refuse. The server keys occurrences by `eventId+recurrenceId` and exposes no standalone handle, so `--ids` emits the **event** id (`packages/cli/src/calendar.ts:123`, `cli-go/internal/cmd/calendar.go:214-219`) and a bare edit correctly hits the master. The clause described a hazard that the read model had already made unreachable |
| T3 "`agenda` reflects writes immediately" | ✅ met | `agenda` reads `CalendarEvent/getOccurrences` server-side on every call — there is no client cache to invalidate (`cli-go/internal/cmd/calendar.go:197`) |
| T4 "a credential minted without `--allow` cannot be used (fail closed)" | ✅ met | refused at mint (`packages/cli/src/creds.ts:101-105`) **and** at use (`services/bureau/src/fetchVerb.ts:120-127`, invariant 5); #36, #43 |
| T4 "`--kind` is persisted and readable by the Bureau" | ✅ met | `services/bureau/src/index.ts:120-121` stores it, `index.ts:165` gates the verb on it — an unimplemented verb on the wrong kind is a 403, not a 501 (`index.ts:147-148`); #36, #43 |
| T4 "`--scope global` refuses with a message pointing at the pending AAD work" | ✅ met | `services/agent/src/vault.ts:201-214`. Refused **server-side**, not in the CLI — so the refusal holds for every caller of the vault API, not just this one; #36 |
| T4 "`show` returns kind/meta/timestamps and provably no secret material" | ✅ met | `packages/cli/src/creds.ts:140-166`; the vault's list projection (`services/agent/src/vault.ts:375`) has no secret field to leak |
| T4 "a rotated credential still opens under the vault's verify endpoint" | ✅ met | `packages/cli/src/creds.ts:167-183` → `POST /vault/credentials/{name}/rotate`; #36 |
| T4 "entropy never arrives via argv" | ✅ met | stdin / hidden prompt / `--secret-env` only (`packages/cli/src/creds.ts:16-18`, `promptHidden` from `tokens.ts`) |
| T5 "`bullmoose help --json` includes every new command and flag" | ✅ met | `packages/cli/src/help.test.ts:26-33` asserts the registry and the runtime dispatcher agree **in both directions** — a command with no help entry fails the build |
| T5 "`--man` renders; no command exists without a help entry" | ✅ met | `packages/cli/src/help.test.ts:92-105`, which also pins `docs/cli.md` and `man/bullmoose.1` against the spec so regenerated docs cannot drift |

## Carried forward

| what | why it did not ship | owner |
|---|---|---|
| `--occurrence <recurrenceId>` writing a `recurrenceOverrides` entry, in **both** CLIs | The devPlan's Risk section pre-authorised deferring *single-occurrence editing* if it got hard, and it did. But the pre-authorisation covered refusing a **bare** edit aimed at an occurrence id — it never covered dropping the `--occurrence` write path itself, which was T3's actual deliverable. `readme.md` calls the refusal "the devPlan's pre-authorised v1"; that reading is too generous and this note supersedes it | `#222` (filed 2026-08-19, label `residue`, unassigned — alongside #220 and #221 for the equivalent s03.E and s07 gaps) |
| The TypeScript `--occurrence` refusal has no test | The Go port got one (`cli-go/internal/cmd/calendar_test.go:314-319`); the TypeScript original never did. Delete `calendar.ts:293-299` today and the suite stays green, which means the refusal is convention rather than contract — exactly the condition T1 spent its whole budget eliminating for stdout | `#222` (same issue; it is the same line of code) |

## Reachability

- **Deployed?** Nothing to deploy — s05 is client-side only, calling methods
  that were already live. No worker changed.
- **Migration applied?** None needed. Every method this section calls predates it.
- **Switched on?** `@bullmoose/cli` is `private: true` at `0.0.1`
  (`packages/cli/package.json:2-4`) with no publish step, and the Go binary has
  no release workflow — **s08 T7 has not begun**. So every command here is
  reachable only from a repo checkout via `npm run -w @bullmoose/cli build`.
  The `~/bin/bullmoose` wrapper on the homelab box is a hand-installed shim
  over `dist/`, and it is stale the moment main moves.
- **Verified live?** The piped contract runs in CI against a loopback stub
  server (`smoke/server.mjs`), not against production. The CRUD verbs were
  exercised against a live server during #33's smoke script (its PR body names
  a delegated-access exit-4 path), but **nothing here has been re-verified
  against production since 2026-08-09.**

## Authority-surface delta

One, and it is the section's most consequential output: **s05 made the CLI the
sole ingestion path for secrets.** `creds set` carries the mint-time contract —
`--kind` (which Bureau verbs may ever touch this credential), `--allow` (the
destination binding, required, fail-closed), `--header` (the injection recipe).
Three walls that did not exist before:

- **`--allow` is mandatory** for the capability kinds. A credential with no
  destination is unusable by construction, not by policy (`creds.ts:101-105`).
- **`--scope` non-`actor` is refused server-side** pending the AAD re-seal
  (`services/agent/src/vault.ts:204-213`). The flag shipped anyway so the
  surface would not have to change twice — a deliberate bet that the refusal is
  cheaper than the migration.
- **No read path returns plaintext.** `list` and `show` project metadata only;
  the vault has no reveal endpoint to call.

Everything else in s05 is projection over authority that already existed.

## Deviations from `devPlan.md` / `arch.md`

- **T3's write table was not implemented as specified.** `arch.md` §3's
  three-row table (master edit / `--occurrence` override / refuse) shipped as
  one row. See the ledger and the residue.
- **T4 was built by s04, not s05.** The mint-time fields, `show` and `rotate`
  all arrived in `eb5a1e5` under the banner "s04-AgentOS: decompose the Bureau
  + build sVOL 020" (#36). s05 specified the surface; s04 built it while
  extracting the Bureau worker.
- **Mail triage verbs were explicitly out of scope, and shipped anyway.**
  `flag/move/archive/trash/label/delete` landed as sVOL 019 in the same PR as
  T2 and T3 (#33), because `--ids` made `bullmoose search --ids | xargs
  bullmoose archive` the obvious demonstration of T1 and nobody wanted to write
  it twice. The out-of-scope line in `readme.md` §5 is therefore wrong as
  written.
- **Codec vendoring.** `arch.md` claims the CLI imports `calendar-core` and
  `contacts-core`. It does not — it ships unbundled `dist/*.js` and vendors
  compact codecs, so there are now three copies of the iCal/vCard logic. Filed
  during the build as `cli/032`; mitigated only by the server revalidating
  every write.

## Reversals

None. s05 overturned no earlier section's decision.

## Absorbed / donated

- **Absorbed:** the entire build. T1 ← sVOL 016 (#27), T2 ← sVOL 017 (#33),
  T3 ← sVOL 018 (#33), T4 ← sVOL 020 via s04-AgentOS (#36). sVOL's own closing
  note should read s05 as one of the places its units landed.
- **Absorbed:** enforcement for T4's mint-time contract. s05 could only
  *record* `--kind` and `--allow`; the Bureau's destination-bound fetch proxy
  (#43, Bureau T3) is what made them bite.
- **Donated:** T1's I/O contract became **s08 T5**, ported to Go and
  oracle-checked against T1's own vectors (#80). The exit-code table, the
  NDJSON rule and the EPIPE guard are now enforced against two binaries by the
  CI ratchet (#78).
- **Donated:** sVOL 019's triage verbs, built here, off-plan (see Deviations).

## What grew stale during the build

- **`creds.ts`'s own header comment.** Lines 29-32 still say *"NOTHING enforces
  the allowlist, verb set or redaction yet; the Bureau proxy is a later task."*
  The Bureau proxy landed on 2026-08-10 (#43) and enforces all three
  (`services/bureau/src/fetchVerb.ts:120-127`, `services/bureau/src/index.ts:165`).
  A reader following that comment would conclude the fail-closed guarantee is
  aspirational. It is not.
- **`readme.md`'s status line** on T3 — "`--occurrence` refuses with a clear
  message — the devPlan's pre-authorised v1". Half true, and the wrong half is
  load-bearing. See the ledger.
- **`arch.md` §3's import claim** — superseded by the vendored codecs
  (`cli/032`).

## Traps for the next section

- **A process cannot observe its own EPIPE, exit code, or `| xargs` behaviour.**
  Those are properties of the process boundary. If your acceptance clause is
  about composition, your test has to spawn a real shell — a unit test asserting
  it will pass while the binary is broken.
- **A smoke script that runs and asserts nothing exits 0.** `contract.test.ts:46`
  counts the clause checks and fails below 30, because the first version of that
  wrapper went green on an empty report.
- **Refuse in one place, and prefer the server.** T4's `--scope` refusal lives in
  the vault, not the CLI, so it holds for the Go CLI, MCP and curl alike. The
  `--occurrence` refusal lives in *both* clients and is tested in *one* — which
  is how you end up with two implementations and one contract.
- **Check who actually built the task before writing the landing note.** Four of
  five tasks here shipped under another section's unit numbers. The note written
  from the plan folder alone would have named the wrong PRs for all of them.
