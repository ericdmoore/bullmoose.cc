# FIX — 008 -P2- `--json` silently ignored on eight commands

## Proposal

Fold this into the **s05 I/O contract** (`.plans/s05-cli-crud/devPlan.md` T1) rather than fixing it
standalone — T1 already rewrites every command's output path for NDJSON, stdout/stderr discipline,
and exit codes. Adding "and `--json` actually works everywhere" costs little on top of that and
avoids touching the same 20 files twice.

## Two acceptable end states — pick one and make it uniform

1. **Implement `--json` everywhere.** Every command emits a JSON object (or NDJSON stream) when
   asked. Most useful for the agent audience, and the natural reading of a *global* flag.
2. **Mark support per command in the spec.** `help.ts`'s `COMMANDS` entries gain a `json: true|false`
   field, surfaced in `help --json` and rendered in `docs/cli.md`. Then an agent can *discover* what
   is supported instead of guessing.

**(1) is the right target; (2) is the honest interim** and is worth doing regardless, because the
spec is what agents read.

## Priority order within (1)

`login` and `token create` first — they emit once-only secrets and are the ones people actually want
to script. `{ "tokenId": "...", "token": "bm_...", "scopes": [...] }` on stdout, human text to stderr.

Then `accounts`, `discover`, `sync` (progress/summary), then the rest.

## Bread-crumbs

- **Delete the dead plumbing at `tokens.ts:15` / `main.ts:131`** if `login` isn't implemented in the
  same commit — a threaded-but-unread option is worse than an absent one, because it reads as done.
- Use `token list` (`tokens.ts:121`) as the reference implementation — it is the one that already
  behaves.
- **Guard rail:** a test that iterates `COMMANDS` and asserts every command claiming `--json` support
  emits parseable JSON. Cheap, and it prevents the next divergence.
- Watch the interaction with `watch --json` (already NDJSON) — it is the precedent to generalize
  from, not an exception.
