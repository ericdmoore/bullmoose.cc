# s08 — the Go CLI: one binary, no runtime

> **Status: T1–T6 SHIPPED; T7 not started.** 112 of 113 invocations are native, and the
> 61-case contract suite runs against BOTH binaries in `verify` so a port that changes
> behaviour fails the build. Seven commands still delegate to the Node CLI. T7 — the
> release pipeline and the Node-CLI retirement — has not begun; there is no
> `release-cli.yml`.

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
