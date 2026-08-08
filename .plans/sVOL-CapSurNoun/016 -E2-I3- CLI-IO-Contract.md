# 016 -E2-I3- CLI I/O contract

| | |
|---|---|
| **Kind** | projection (prerequisite in practice — it is the shape of every CLI cell) |
| **Effort** | **E2** — `packages/cli` only; no schema, no new JMAP method, no migration |
| **Impact** | **I3** — unlocks *and* human-verifiable |
| **Owner** | **`s05-cli-crud`** T1 |
| **Depends on** | — |
| **Blocks** | `017` · `018` · `019` |
| **Status** | todo |

## Cells covered

**None directly.** It has no noun. It conditions the entire CLI column: every cell that
`017`, `018` and `019` deliver is written to this contract or written twice.

## Why these grades

**E2.** Several files inside one package, no new method over existing tables — but it touches
101 `console.log` sites (`s05/readme.md:52`, `devPlan.md:16`) and the entry point. Not E1;
not E3 either, because nothing outside `packages/cli` has to respect it.

**I3, both factors.** *Unlocks* — `s05/devPlan.md:110-111` states it as hard ordering ("T1
first, strictly … building T2–T4 before it means writing every command twice"), and this
ledger hangs three units off it. *Human-verifiable* — `bullmoose log | head` currently
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

## Open questions / where this could be wrong

1. **Calling this a projection is a stretch.** It projects nothing; it is a prerequisite in
   everything but the ledger's label. I left the kind as `_index.md` has it rather than edit
   the ledger from a pointer file, but the classification is wrong and worth arguing.
2. **The two gaps may be deliberate.** It is possible s05 dropped `--if-state` from T1 on
   purpose, intending it per-command in T2/T3 — but then it should not be an invariant, and
   no task mentions it either. I read the omission as an oversight; I could be wrong.
3. **I did not check whether `packages/cli` actually threads state through today.** If the
   JMAP client wrapper discards `newState` from `/set` responses, `--if-state` is more than a
   flag and T1's E2 grade weakens. Unverified.
