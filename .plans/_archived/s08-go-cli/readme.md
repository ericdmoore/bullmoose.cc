# s08 — the Go CLI: one binary, no runtime

> **Status: COMPLETE — the Node CLI is GONE (2026-08-22).** T1–T7 shipped; the
> flip put every help-listed command native; Eric waived the soak ("literally
> the only user… ready to bury the CLI") and the removal PR deleted
> `packages/cli` and `internal/delegate` together. What survived the delegate:
> the front-door scanner, help routing and the flag guard, moved to
> `cli-go/internal/cmd/route.go` with unknown-flag refusals now native (exit 2,
> flag named). The help artifact is canonical (the generator died with Node);
> conformance/exit-codes.json is FROZEN as the exit-code contract, pinned by
> `internal/io/exit_test.go`. Releases: v0.1.0 (first binary), v0.2.0 (first
> all-native). The trace metric retired with the thing it measured.

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
