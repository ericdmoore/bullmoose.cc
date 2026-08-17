# 016 -E2-I3- CLI I/O contract

|                |                                                                           |
| -------------- | ------------------------------------------------------------------------- |
| **Kind**       | projection (prerequisite in practice — it is the shape of every CLI cell) |
| **Effort**     | **E2** — `packages/cli` only; no schema, no new JMAP method, no migration |
| **Impact**     | **I3** — unlocks _and_ human-verifiable                                   |
| **Owner**      | **`s05-cli-crud`** T1                                                     |
| **Depends on** | —                                                                         |
| **Blocks**     | `017` · `018` · `019`                                                     |
| **Status**     | **✅ done**                                                               |

## Cells covered

**None directly.** It has no noun. It conditions the entire CLI column: every cell that
`017`, `018` and `019` deliver is written to this contract or written twice.

## Why these grades

**E2.** Several files inside one package, no new method over existing tables — but it touches
101 `console.log` sites (`s05/readme.md:52`, `devPlan.md:16`) and the entry point. Not E1;
not E3 either, because nothing outside `packages/cli` has to respect it.

**I3, both factors.** _Unlocks_ — `s05/devPlan.md:110-111` states it as hard ordering ("T1
first, strictly … building T2–T4 before it means writing every command twice"), and this
ledger hangs three units off it. _Human-verifiable_ — `bullmoose log | head` currently
produces a Node stack trace (`s05/readme.md:51`); after T1 it exits 0 silently. Anyone with a
terminal can see the difference.

## Owned by

**`s05` T1** (`s05/devPlan.md:8-26`). The contract itself is `s05/arch.md` §1, lines **9-90**,
in eight sub-clauses: §1.1 stdout/stderr split · §1.2 EPIPE · §1.3 NDJSON · §1.4 stdin and
explicit `-` · §1.5 exit codes · §1.6 no TTY assumptions · §1.7 `--if-state` / `--dry-run` ·
§1.8 `--ids`. The seven invariants are `arch.md:195-201`.

## What sVOL adds

**Two gaps between the contract and the task that owns it.**

**1. No task owns invariant 6.** `--if-state` appears exactly twice in the whole of s05 — at
`arch.md:81-83` (§1.7) and as invariant 6 at `arch.md:200` ("An `--if-state` mismatch fails
with exit 5 and changes nothing"). It appears **zero times in `devPlan.md`**. T1's bullet list
(`devPlan.md:14-21` — the ref circulating as `:13-21` is off by one; 13 is blank) covers
EPIPE, the stdout/stderr audit, NDJSON, the exit-code table, TTY/`NO_COLOR`, and `--ids`.
No `--if-state`, no `ifInState`, no exit-5 path. Invariant 4 (`--dry-run`, `arch.md:198`)
fares slightly better — it survives only in T2's done-when (`devPlan.md:39`) and is absent
from T3 and T4. So the two concurrency/safety invariants are the two with no owner, which is
the wrong two to lose. Whoever picks up T1 should add both to its bullet list; `--if-state`
is the one that cannot be retrofitted cheaply, since it changes every write command's
signature.

**2. The exit-code table has no JMAP mapping.** `arch.md:62-72` gives six codes by English
meaning; `devPlan.md:19` says "via a small typed error → code mapping" and stops. Nothing
states which JMAP error produces which code — `stateMismatch` → 5, `notFound` → 3,
`forbidden` → 4, `invalidProperties` → 2, and then the ones with no obvious home
(`overQuota`, `tooLarge`, `singleton`), plus the method-level errors (`accountNotFound`,
`unknownMethod`) which are a different class from `setError` entirely. Without that table
each command module invents its own, and T1's done-when ("a table-driven test asserts the
exit code for each failure class", `devPlan.md:25-26`) has no agreed list of classes to
enumerate.

## What shipped

`packages/cli/src/io.ts` is the contract's runtime — dependency-free, so the exit-code
table is unit-testable without a database or a process. Every command module writes through
it; `io.test.ts` greps the package and fails if any module other than `io.ts` calls
`console.log`, which is the only mechanism that survives the next fifty commands.

| clause                          | where                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------ |
| §1.1 stdout = data              | `out` / `note` / `warn`; all 116 `console.*` sites audited and moved                 |
| §1.2 EPIPE                      | `installEpipeGuard()`, first statement of `main.ts`                                  |
| §1.3 NDJSON                     | `emitJson` / `emitNdjson`; under `--json` every stdout line is a complete JSON value |
| §1.4 stdin, `-`, `--as`         | `readInput` / `inferType`; `send` and `contacts import` use it                       |
| §1.5 exit codes                 | `EXIT` + `JMAP_EXIT` + `exitCodeFor`; one `die(err)` at the entry point              |
| §1.6 no TTY assumptions         | `colorEnabled` (NO_COLOR, `TERM=dumb`, `isTTY`); no pager anywhere, asserted         |
| §1.7 `--if-state` / `--dry-run` | `ifInState` on `Mailbox/set`; `--dry-run` on every destructive verb                  |
| §1.8 `--ids`                    | `emitIds`; honoured by every list command                                            |

**Both gaps this file flagged are closed.**

**Gap 1 — invariant 6 had no owner.** `--if-state` is built. It threads to JMAP's
`ifInState` on `Mailbox/set` (the CLI's only `/set` write surface today besides `send`
and the chunked `contacts import`, where per-chunk state would be wrong), and a mismatch
exits 5 with nothing written. The other half was missing too: a write now REPORTS the state
it landed on, in `--json` as `state` and on stderr otherwise — without that, a
read-modify-write loop has nothing to pass to the next call. `--dry-run` covers
`mailbox rm`, `blobs rm`, `share revoke`, `token revoke`, `creds rm`,
`contacts import`, `vacation on|off`, and the `admin` revoke verbs; it resolves the
target for real first, so an unknown folder still exits 3 — a dry run that did not resolve
would be evidence of nothing.

**Gap 2 — the exit-code table had no mapping rule.** `JMAP_EXIT` in `io.ts` is that
table, covering RFC 8620 §3.6.2 method errors, §5.3 SetErrors and the RFC 8621 mail
SetErrors, with the rule that decides the hard cases written down:

> 2 = retyping could fix it · 3 = the named thing is absent · 4 = not permitted, and no
> retype changes that · 5 = well-formed and permitted, but the server's state refused it ·
> 1 = the caller can do nothing about it.

So `overQuota` is **1**, not 2 (no phrasing fits under the quota) while `tooLarge` is
**2** (a smaller input does); `mailboxHasEmail` is **5** rather than 2, because the
command was right and the folder's contents refused it — the same shape as
`stateMismatch`, with `--force` as the resolution. HTTP status maps the same way for
the endpoints outside the JMAP envelope.

**Finding 3 verified.** `JmapClient.one` does return the whole result record and does
attach `jmapType` to thrown method errors, so `--if-state` needed no new plumbing. Two
things were still missing: unmapped types short-circuited to 1 and threw away a perfectly
good HTTP status beside them (a 409 saying `blobInUse` read as "generic failure"), and the
non-JMAP endpoints attached no status at all. Both fixed in `jmap.ts` / `exitCodeFor`.
The composition smoke script is what caught it.

**The smoke script is the acceptance signal**, as `devPlan.md` says it must be.
`smoke/contract.mjs` builds the CLI, starts a loopback stub server, and drives the real
binary through a real `sh`: `| head -3` and `| head -c1` really close the read end,
`| xargs -n1` really fans ids back in, `awk '{print $NF}'` really reads the last column.
38 checks, one per clause obligation. A process cannot observe its own EPIPE, exit code or
pipeline composition, which is exactly why unit tests could not have held this.

**Also folded in** (their `.fix.md` files said to): `.feedback/fromClaude/cli/008`
(`--json` a silent no-op on eight commands — implemented everywhere, and `login`'s dead
`json` plumbing now reads), `009` (`pickAccount` in `db.ts` refuses an ambiguous
selector instead of silently taking `[0]` on the _send_ path; `show` resolves like
`read` and distinguishes "no such id" from "not in the account you selected"), `010`
(unknown flags exit 2 instead of printing a Node stack; `help` has a registry entry;
`admin`'s usage text is derived from `IMPLEMENTED`; Markdown table cells escape `|`;
the four doc drifts).

## Open questions / where this could be wrong

1. **Calling this a projection is a stretch.** It projects nothing; it is a prerequisite in
   everything but the ledger's label. I left the kind as `_index.md` has it rather than edit
   the ledger from a pointer file, but the classification is wrong and worth arguing.
2. **The two gaps may be deliberate.** It is possible s05 dropped `--if-state` from T1 on
   purpose, intending it per-command in T2/T3 — but then it should not be an invariant, and
   no task mentions it either. I read the omission as an oversight; I could be wrong.
3. ~~**I did not check whether `packages/cli` actually threads state through today.**~~
   **Checked, and it does.** `JmapClient.one` returns `resp[1]` whole, so `oldState` /
   `newState` were always there for the taking; nothing discarded them. E2 holds.
