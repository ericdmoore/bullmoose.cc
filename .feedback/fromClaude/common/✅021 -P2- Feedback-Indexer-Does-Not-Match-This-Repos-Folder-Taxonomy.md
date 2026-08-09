# 021 -P2- The feedback indexer doesn't match this repo's folder taxonomy

**Subsystem:** common (tooling) · **Severity:** MEDIUM · **Fix class:** CHANGE-CODE

> ## ✅ CLOSED
>
> **Shipped**, together with `common/026` item 1 — they were not separable, exactly as
> both issues predicted. Five identical copies of `reindex.mjs` became **one root
> dispatcher** at `.feedback/reindex.mjs`, which is the path `readme.md` already
> documented. It walks every `from*/` provider folder and writes one `.feedback/_index.md`.
>
> Both defects named here are fixed: categories come from `config.yml` (`label ?? name`,
> trimmed, so `cloud-infra` → `infra` and the trailing space on `agentic-components` is
> absorbed — the YAML is tidied too), and the file that claimed to be authoritative now
> governs. A folder present on disk but absent from `config.yml` is reported as
> `⚠️ undeclared` instead of being silently skipped, which is how the original hid itself.
>
> **Two further dead paths this issue didn't catch**, both from the same tensr port:
>
> 1. Done-detection read the ✅ off the first *line* of the file. This repo puts it on the
>    *filename*, so it matched **1 file out of 13**. Both are accepted now, filename
>    canonical, and only *leading* glyphs count (`title.includes("✅")` would close an
>    issue whose title merely quoted a checkmark).
> 2. `numberOf`/`priorityOf` matched `001-P1-slug.md`. Every filename here is
>    `001 -P1- slug.md`, **with spaces** — so both returned `null` for every file in the
>    repo, and the priority ordering plus the `next:` bookkeeping were dead code producing
>    nothing. Fixed; the index is now priority-ordered and `next.<provider>` is real.
>
> **Decisions taken**, both recorded in `readme.md`:
> - The `refactors/` sub-track is **dropped** (no such folder exists here), as proposed.
> - The `📦completed/` archive is **dropped**, against the proposal. It never existed in
>   this repo — 13 issues were closed in place — and issues cross-reference each other by
>   path (`common/021`, `cli/010`), which relocating them would break. Closed items fold
>   away under `<details>` instead. The script's only write is `_index.md`.
> - Issue numbers are **one sequence per provider**, shared across its subsystem folders
>   (`fromClaude` 001–027, `fromCodex` 001–007). The original's severity *bands* keyed off
>   the number were a tensr convention this repo never adopted, and the data contradicts
>   them (`024 -P1-` is a P1 in what they called the "medium" band) — so they are gone,
>   replaced by a single `next.<provider>`.
> - `-P{num}-` is confirmed as **priority**, P1 highest; the readme says so now.
>
> Verified against real data: **21 open, 13 closed across 5 folders** — the 13 being every
> ✅-prefixed file in the tree. The readme's truncated "A reinde file will" sentence and
> the `{Issue Nuumnber}` typo are fixed as well.

Found while running the `.feedback` process itself — the janitor/indexer is currently a **no-op**.

## The defect

`reindex.mjs` was ported from tensr.fitness, where categories were **one level** of `for*`-prefixed
folders (`forIOS/`, plus an optional `refactors/` sub-track). It discovers them with:

```js
const isCategoryDir = (name) => name.startsWith("for");   // reindex.mjs:59
```

This repo's taxonomy is `from<Provider>/<subsystem>/`, and the subsystem folders come from
`config.yml`: `common`, `cli`, `infra`, `agentic`, `webUI`. **None starts with `"for"`** — verified:

```
common  → false     agentic → false
cli     → false     webUI   → false
infra   → false
```

(`"from"` vs `"for"` is a near-miss that reads as though it should match.)

Result, even with the indexer now copied *into* each provider folder:

```
$ node .feedback/fromClaude/reindex.mjs --dry-run
  indexed 0 open item(s) across 0 folder(s) → _index.md
```

## Second defect: `config.yml` is declared authoritative but never read

`.feedback/readme.md:4` — "use the [config.yml] for the **authoritative** list of the TLCs".

A grep of `reindex.mjs` for `config|yml|yaml` returns **nothing**. The component list exists only as
folder names on disk, so the file that claims to be authoritative governs nothing.

The mapping is otherwise consistent — folder name = `label ?? name`:

| config entry | folder |
|---|---|
| `common`, `cli`, `webUI` | same |
| `cloud-infra` (label `infra`) | `infra` |
| `agentic-components` (label `agentic`) | `agentic` |

## Minor

- `config.yml:5` — `agentic-components ` has a trailing space in the YAML value.
- `.feedback/readme.md`'s Clean Up section is truncated mid-sentence: *"A reinde file will"*.
- The naming template says `{Issue Nuumnber}` (typo) and `-P{num}-` is undefined — I have assumed
  **P = priority** (P1 highest) for the files filed in this pass.
