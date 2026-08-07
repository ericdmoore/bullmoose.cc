# 021 -P2- The feedback indexer doesn't match this repo's folder taxonomy

**Subsystem:** common (tooling) · **Severity:** MEDIUM · **Fix class:** CHANGE-CODE

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
