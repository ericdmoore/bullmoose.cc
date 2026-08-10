# 023 -E4-I1- Agents + Secrets over WebUI

| | |
|---|---|
| **Kind** | projection |
| **Effort** | **E4** — screens on the `s03.C` stack, which does not exist |
| **Impact** | **I1** — human-verifiable (revoke a grant, reload, watch the answer change), unlocks nothing. Regraded from `I2` at review; `s03.E` is the terminal leaf of the arc — `s03.C` blocks it, `s04` gates it, nothing follows. The argument is in *Open questions*; the ledger now agrees |
| **Owner** | **`s03.E`** — `.plans/s03.E-console/{readme,devPlan}.md` |
| **Depends on** | **`s04` governance model, specified** · `021` (the shell) · `s03.A` (provenance) |
| **Status** | todo — **pointer only**, and gated. `s03.E` owns the work. |

## Cells covered

`Agents × Read × WebUI` · `Secrets × C/U/D × WebUI`

**`Secrets × Read` is not in this unit and never will be.** Vault reads return
names/kind/meta, never plaintext, by design (`bureau.md` invariant 1; the CLI already
behaves this way at `creds.ts:73,93,106,114`). The console shows credential *references* —
`devPlan.md:16-17` says so explicitly. The grid marks this `n/a`, not `todo`
(`_index.md:152-153`).

## Owner — read there, not here

| Task | Where | Cells |
|---|---|---|
| **T1** per-agent — *"can Allen even do that?"* | `devPlan.md:11` | `Agents × Read` |
| **T2** credential lifecycle, OAuth | `devPlan.md:28` | `Secrets × C/U/D` |
| **T3** per-resource — *"who could have?"* | `devPlan.md:43` | `Agents × Read` (forensic) |

## The gate — the only s03 slice blocked on another plan

`s03.E/readme.md:7` — *"⚠️ This is the only s03 slice gated on another plan."*
`s03.E/devPlan.md:6` — *"⚠️ Do not start until s04's governance model is specified. The
other s03 slices have no such gate."*

The line is `readme.md:55-56`: **s03.E renders and requests; s04 decides and enforces.**
`s04` is docs-only — `bureau.md` is a 429-line design with **zero tasks**, `readme.md` a
23-line napkin (`_context.md` §6). The gate is not near lifting; this sits last in wave 5
(`_index.md:114`).

## Why these grades

**E4** — same inheritance as `021`/`022`: no `webmail/` workspace (`tsconfig.json:33`
excludes a path that has never existed). Once the shell exists, T1 is a read-only screen
over the vault API and the ledger; the credential form is the only novel piece, and novel
for a *security* reason rather than a size one — it must POST **directly** to the agent
worker, never through the site backend (`devPlan.md:33-35`).

**I2 is the ledger's grade and I think it is wrong. See below.**

## What `sVOL` adds

1. **`s03.E` never mentions contacts, calendar, or settings** — `grep -rni
   "contact\|calendar\|settings" .plans/s03.E-console/` returns nothing. A pure
   agent-governance surface, which is what leaves `022` and `024` unowned.
2. **`services/agent/src/vault.ts:41-66` still hand-rolls its own bearer verification**,
   duplicating the `tokens ⋈ principals` join — the unfinished half of `s01` T1. A browser
   POSTing directly to `/vault/credentials` (which `devPlan.md:33-35` requires) makes that
   duplicate path a second front door, not just untidy. Fix it before this ships.
3. **`common/001` turns a rendering nicety into a correctness requirement.** `hasScope`
   treats `mail` as universal (`_context.md` §4), which `s03.E/readme.md:41-43` already
   flags: a chip labelled `mail` reads as innocuous while granting `send` and `delete`.

## Open questions / where this could be wrong

1. **⚠️ I believe the ledger's `I2` is wrong and the correct grade is `I1`.** Apply the
   rubric's two factors (`readme.md:84-94`) directly:

   - *Human can verify?* **Yes.** The rubric names "a browser" as a normal interface. A
     non-engineer revokes a grant, reloads the console, and watches the answer to "can
     Allen send?" change. That is exactly the standard the rubric sets — and it is a far
     easier verification than most units in this volume.
   - *Unlocks other work?* **No.** Nothing in `_index.md` depends on `023`. Nothing in the
     s03 arc depends on `s03.E`: `s03.C/readme.md:35` lists what it blocks (`s03.D`,
     `s03.E`) and `s03.E` blocks nothing in return. `s04` **gates** it, not the reverse
     (`s03.E/readme.md:59-60`). It is the terminal leaf of the arc.

   human-verifiable + unlocks nothing = **`I1`**. `I2` needs it to be *not*
   human-verifiable while unlocking something; neither leg holds.

   The likeliest reasoning behind `I2` is that confirming the console is **correct** —
   point-in-time forensics, effective-permission expansion — needs someone who understands
   the grant model. That has force but proves too much: by it, no security surface is ever
   human-verifiable, and the same objection would demote `022`'s cross-surface checks. The
   rubric asks whether a human can confirm it *works*, not whether they can audit it.

   **If accepted:** rename to `023 -E4-I1- …` and update `_index.md:74` plus the totals at
   `:171-172` (I2 → 6, I1 → 8). Left as filed pending review, per `readme.md:148-150`.

2. **The `021` edge is real but the `s04` one dominates.** Even with a finished shell this
   cannot start. Sequencing it behind `021` (`_index.md:114`) is accurate but misleading
   about *why* it is last.
