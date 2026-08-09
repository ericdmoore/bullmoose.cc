# Feedback

The following are folders organized by the (agent-provider)
- then organized into main top-level-sub-systems represented as nested folders.
- use the [config.yml](config.yml) for the authoritative list of the TLCs
- within each of those subfolders make a "pile of files".
- Where each file represents an issue to investigate / something to consider fixing.

So the shape on disk is `.feedback/from<Provider>/<subsystem>/<issue>.md`, e.g.
`.feedback/fromClaude/common/026 -P3- Doc-And-Tooling-Drift-Bundle-Two.md`. Create the
provider folder if yours doesn't exist yet — the indexer picks up any `from*/` folder.

### PreProcessing
First, if there are files in `~raw-input` /  `<name>.txt` then please read it,
and break it down into file-issues using this naming template:

  `{Issue Number} -P{priority} - {Issue-Name-with-dashes}.md`

written with the spaces exactly as shown:

  `026 -P3- Doc-And-Tooling-Drift-Bundle-Two.md`

- **`-P{num}-` is PRIORITY**, P1 highest. P1 = drop what you're doing, P2 = should be
  fixed, P3 = worth doing / cleanup. It is not a phase or a pass number.
- **The issue number is one sequence per provider**, shared across that provider's
  subsystem folders — `fromClaude` runs 001–027 across `common`/`cli`/`infra`/`agentic`/
  `webUI`, and `fromCodex` keeps its own independent 001–007. Two providers both having
  an `001` is expected; always say which provider you mean (`fromCodex/common/001`).
  Before filing, read `next.<provider>` from the front matter of [_index.md](_index.md)
  and use that number.

## Main Process
Then the task/process for each file is:

- Create a proposal for how to fix it, and write the proposal in a `<total issue name >.fix.md` file
  - Perform Web research if deemed useful
- Usually a human or different agent will cross reference your proposals.
- it is highly recommended to leave implementation `detail-bread-crumbs` for yourself in that file before you move on,
- FYI - sometimes you will be called back to implement your own proposals, other times it will be a different agent.
- When an implementation is commited to git, mark the issue closed — see below — and then
  run the indexer.

### Marking an issue ✅ closed

Prepend `✅` to the **filename** of **both** the `.md` and its `.fix.md`:

```
026 -P3- Doc-And-Tooling-Drift-Bundle-Two.md       →  ✅026 -P3- Doc-And-Tooling-Drift-Bundle-Two.md
026 -P3- Doc-And-Tooling-Drift-Bundle-Two.fix.md   →  ✅026 -P3- Doc-And-Tooling-Drift-Bundle-Two.fix.md
```

**No space after the ✅.** `✅026 -P1- …`, never `✅ 026 -P1- …` — one agent used the
spaced form and it had to be normalised by hand. The filename is what counts; you may
also mark the title line, but you don't have to.

Closed issues **stay where they are**. Nothing is moved to an archive folder: issues
cross-reference each other by path (`common/021`), and relocating them breaks those
references. They just fold away under a `<details>` block in the index.

If an issue bundles several items, only mark it ✅ once **every** item is closed. Note
the shipped ones in-file in the meantime, so the next agent doesn't redo them.

## Clean Up Process
Regenerate the index so the closed item drops off the open list:

```bash
node .feedback/reindex.mjs
```

That is one script for the whole tree — it walks every `from*/` provider folder, reads
the authoritative subsystem list out of `config.yml`, and rewrites
[_index.md](_index.md) with the open items (priority-ordered, with links to their
proposals) and a folded list of the closed ones. Commit the regenerated `_index.md`
along with your change.

It writes nothing else and moves nothing, so it is safe to run at any time:

```bash
node .feedback/reindex.mjs --dry-run   # print the counts, write nothing
node .feedback/reindex.mjs fromClaude  # limit it to one provider
```
