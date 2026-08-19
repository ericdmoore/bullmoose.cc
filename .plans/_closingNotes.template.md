---
plan: sNN-short-name
status: closed            # closed | reopened
closed_at: YYYY-MM-DD
closing_pr: 123           # the PR that carried this file. Write it while the
                          # context is warm — a closing note written later is
                          # written by an auditor, and auditors guess.
acceptance: met           # met | partial — `partial` is legal, dishonesty is not
residues: 2               # count of "Carried forward" rows; 0 is a fine answer
reversals: 0
---

# sNN — closing notes

One paragraph: what this section set out to do, and what it actually became.
Not a summary of the devPlan — the devPlan is right there. This is the part
the devPlan could not know in advance.

## Acceptance ledger

The plan's own **Done-when** clauses, quoted verbatim, each with evidence.
Evidence is a `file:line`, a PR number, or a live probe — never "yes".

| Done-when (verbatim) | verdict | evidence |
|---|---|---|
| "…" | ✅ met | `services/x/src/y.ts:120`, #178 |
| "…" | ❌ unmet | nothing implements it; carried forward below |

An unmet clause does not block closing. **Hiding one does.**

## Carried forward

Every loose end, each with an owner. **The rule: no residue closes a folder
without a home.** A row whose owner is "—" is not done being argued about.

| what | why it did not ship | owner |
|---|---|---|
| … | … | `#456` (label `residue:sNN`) or `.plans/sMM-…/devPlan.md` T3 |

## Reachability

Merged is not reachable. State the truth for each shipped capability:

- **Deployed?** which worker/plane, and when
- **Migration applied?** name it, or "none needed"
- **Switched on?** routes, secrets, flags — s21 shipped complete and stayed
  dark behind a commented route and an unset secret
- **Verified live?** by whom, how, against what host — or plainly "not verified"

## Authority-surface delta

New scopes, capabilities, walls moved, refusals added. In this codebase this is
the highest-consequence diff a section can produce, and it must not live only
in a PR body. "None" is a perfectly good answer.

## Deviations from `devPlan.md` / `arch.md`

Where the build diverged from the design, and **why**. A deviation is not a
failure — an unrecorded one is, because the next reader treats the plan as
current.

## Reversals

Decisions from earlier sections this one deliberately overturned, so nobody
"restores" them as a bug. Name the section and the decision id.

## Absorbed / donated

Work this section received from elsewhere, and work of its own that another
section finished. **Record it in both files.** s24's T6 was closed by s25's
#189; without a note in both, s24 reads incomplete forever and s25 gets no
credit.

## What grew stale during the build

Claims inside this folder that stopped being true while it was being built,
and what they say now. This is where the honesty is cheapest and most useful.

## Traps for the next section

Transferable lessons only — not plan-specific trivia. The ones that cost real
time here: a schema change needs `go test` from `cli-go/` (the Go CLI embeds a
mirrored copy of the SQL); `migrate.yml` once defaulted to dry-run and went
green while doing nothing; a screenshot harness will happily hand you a
convincing fake browser.
