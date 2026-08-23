# s08 — the Go CLI: one binary, no runtime

> **Status: T1–T7 SHIPPED; the SOAK begins.** Every help-listed command is native
> (s42 + s43; `agent` flipped 2026-08-22). Contract suite 75/75; trace over it:
> 131 native, 1 delegated — the 1 is the UNKNOWN-FLAG refusal (`log
> --no-such-flag`), which the delegate routes to Node BY DESIGN so parse-error
> bytes stay Node's; it is delegate-package policy, not a port gap. v0.1.0 is
> released and installed as `~/bin/bullmoose`. Remaining: cut v0.2.0 (first
> all-native release), soak ONE release at zero delegated commands, then the
> removal PR — Node CLI + `internal/delegate` in one PR, at which point
> unknown-flag refusals go native and the trace metric retires with the thing
> it measured.

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
