# FIX — 010 -P3- CLI doc + help-registry drift bundle

## The structural fix that prevents recurrence

Items 1, 3, and 8 share a root cause: **`help.ts` is the single source of truth for docs, but nothing
checks it against the runtime.** `docs/cli.md` is generated and therefore always consistent _with the
spec_ — and silently wrong wherever the spec is.

**Add one test** that closes items 1 and 3 permanently:

```ts
// packages/cli/src/help.test.ts
const switchCases = extractCases(readFileSync("src/main.ts")); // regex the `case "x":` list
const specNames = COMMANDS.map((c) => c.name);
expect(new Set(switchCases)).toEqual(new Set(specNames)); // neither side may drift
```

Then `admin`'s error string (item 1) should be _derived_ from its subcommand switch rather than
hand-written, and `help` (item 3) gets a real `COMMANDS` entry.

## Per-item notes

- **(2) parseArgs stack trace** — wrap the call:
  ```ts
  let opts, positionals;
  try { ({ values: opts, positionals } = parseArgs({...})); }
  catch (e) { console.error(`unknown option: ${extractFlag(e)}`); console.log(renderOverview()); process.exit(2); }
  ```
  Exit 2 = usage error, matching the s05 exit-code table
  (`.plans/s05-cli-crud/arch.md` §1.5). Do this **before** adding `--dry-run`, so the first thing a
  cautious user types gives a sane message.
- **(8) pipe escaping** — `help.ts:530`, escape `|` as `\|` inside table cells. One-line fix; verify by
  regenerating `docs/cli.md` and diffing (the regen is already byte-stable, so any other change is a
  real difference).
- **(4)(5)(6)(7)** — pure doc edits. (5) is in `packages/cli/README.md`, the others in `docs/`.
  Consider also _accepting_ `--url` as an alias for `--base` since it parses and is documented
  somewhere — silently discarding a valid-looking flag is worse than rejecting it.

## Regeneration reminder

After any `help.ts` change, regenerate rather than hand-editing:

```sh
node packages/cli/bin/bullmoose.mjs help --markdown > docs/cli.md
```

Worth adding as an `npm run docs:cli` script so nobody edits the generated file by hand.
