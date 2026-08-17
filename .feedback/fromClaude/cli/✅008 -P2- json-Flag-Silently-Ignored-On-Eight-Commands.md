# 008 -P2- `--json` is documented as global but is a silent no-op on eight commands

**Subsystem:** cli · **Severity:** MEDIUM-HIGH · **Fix class:** CHANGE-CODE

## The drift

`docs/cli.md:41` lists `--json` under global options: "machine-readable output where supported."
Nothing says _which_ commands support it — and the entire stated purpose of the help spec
(`packages/cli/src/help.ts:9-12`) is agent consumption.

## Where it is ignored

`init` (`main.ts:237-292`) · `discover` (`:595-612`) · `sync` (`:294-315`) · `accounts` (`:317-334`) ·
`send` (`:338-515`) · `vacation` (`:540-574`) · `token create` (`tokens.ts:100-113`) ·
`token revoke` (`tokens.ts:133-140`)

**Worst case is `login`:** `main.ts:131` threads `json: opts.json` into `LoginOpts` (`tokens.ts:15`)
and `cmdLogin` never reads it — dead plumbing that looks implemented.

**Inconsistent within one noun:** `token list` (`tokens.ts:121`) _does_ honour `--json`, while
`token create` and `token revoke` do not.

## Why it matters

The commands that emit a value you'd most want to capture programmatically — `login` and
`token create`, both of which print a **secret shown once** — are precisely the ones with no
machine-readable output. Scripting them means screen-scraping a human-formatted line.

For an agent-first CLI (`.plans/s03-webAccess` §2 makes the CLI the agent surface), a flag that
silently does nothing is worse than one that errors: the agent gets human text where it expected
JSON and has no signal that it asked for something unsupported.

## Related but distinct

`.plans/s05-cli-crud` already covers `--json` emitting **arrays instead of NDJSON**. This issue is
about the flag being _absent_ on commands that advertise it. Both should be fixed in the same pass.
