# FIX — 021 -P2- Feedback indexer doesn't match this repo's taxonomy

## Proposal: make it config-driven, per the readme's own claim

Since a copy of the indexer now lives **inside each provider folder**, `ROOT` is the provider dir and
the subsystem folders are its immediate children. Replace the hardcoded convention with the
authoritative list:

```js
// read ../config.yml relative to the script, tolerate being run from the repo root
const cfg = parseConfig(path.join(SCRIPT_DIR, "..", "config.yml"));
const CATEGORIES = cfg.components.map((c) => (c.label ?? c.name).trim()); // trailing-space safe
const isCategoryDir = (name) => CATEGORIES.includes(name);
```

A five-line hand-rolled YAML reader is enough for this shape (`components:` → list of
`name:`/`label:`) and keeps the script's zero-dependency property, which is worth preserving.

`.trim()` handles `config.yml:5`'s trailing space without needing to edit the YAML — though fixing
the YAML too is free.

## Decide: does the `refactors/` sub-track survive?

In the original it was `forX/refactors/` with its own `_refactors.md`. Here the nesting slot is
occupied by subsystems. Options:

- **Drop it** — simplest; `_refactors.md` and the `REFACTORS_DIR` machinery come out.
- **Keep it one level deeper** — `fromClaude/cli/refactors/`. Costs a nested walk.

I'd **drop it** unless you're actively using the distinction; the issue/fix pairing already carries
the "what kind of work is this" signal.

## Verify

```sh
node .feedback/fromClaude/reindex.mjs --dry-run   # should now report 21 open items across 5 folders
```

The ✅-prepend → `📦completed/` archive flow is good and needs no change — it works, it's idempotent,
and marking done is trivially agent-friendly. Only discovery is broken.

## Also finish the readme

- Complete the truncated Clean Up sentence (`"A reinde file will"`).
- Fix `{Issue Nuumnber}` → `{Issue Number}`.
- **Define `-P{num}-`.** I assumed priority (P1 = highest) for this pass; if it means phase, pass, or
  something else, the files filed here need renaming.
- Consider stating that the issue number is **globally unique across providers**, or scoped per
  provider — right now two agents would both start at `001` and collide in conversation, if not on
  disk.
