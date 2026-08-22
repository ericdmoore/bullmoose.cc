# s08 — the Go CLI: one binary, no runtime

> **Status: T1–T6 SHIPPED; T7 pipeline LANDED, retirement pending.** After the s42
> wave (share → admin), exactly ONE command still delegates to Node: `agent`.
> `release-cli.yml` cross-compiles darwin/linux × arm64/amd64 (+ windows/amd64) on a
> `cli-go/v*` tag, checksums, and attaches a GitHub release; `bullmoose version`
> (Go-native-only) names the build. Remaining under T7: cut the first tag, flip
> `~/bin/bullmoose` off the Node wrapper, and — only after `BULLMOOSE_TRACE` reports
> zero delegated for a full release — delete the Node CLI.

**This section had no readme until 2026-08-17** — the only numbered section that
lacked one, which is part of why its `devPlan.md` under-reported itself by roughly ten
commits. The devPlan is the authority here; this file exists so the section has a front
door and a current status line.

## What it is

A single Go binary (`cli-go/`) that replaces the Node CLI command by command, in waves,
without a flag day. `internal/delegate` decides per-invocation whether this binary can
answer or must shell out to `bullmoose.mjs` — so every command is either ported or
transparently forwarded, and the user never sees a gap.

The safety property is the **contract suite**: one set of cases, run against both
implementations in CI (`.github/workflows/mail-typecheck.yml`). A port that drifts from
the Node behaviour fails, rather than being discovered later by a person.

## Where the detail lives

- `devPlan.md` — the wave-by-wave task list and its status block, kept current during the
  build. **Read this rather than this file** for what is done.
- `arch.md` — the delegation seam, the flag-ownership model, and why `help` is a
  compiled-in artifact rather than a renderer.
