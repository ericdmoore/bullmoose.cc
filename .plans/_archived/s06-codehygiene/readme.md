Code Hygiene Efforts
=======================

> **Status (corrected 2026-08-19): three of the four landed; only perf/bench is missing.** `verify` is the one
> required check (`.github/rulesets/main-tests-must-pass.json`) and runs typecheck, the full suite, `gofmt -l`,
> `go vet`, **and both `oxfmt --check` and `oxlint`** (`mail-typecheck.yml:34-35`) — so TypeScript now has the two
> gates this file said it lacked, plus a `.githooks/pre-commit` that formats before a commit is recorded. The
> **coverage ratchet is real and triggers on `pull_request`**, exiting non-zero on a regression
> (`coverage-ratchet.mjs:307`); its job id is `coverage`, so it shows a red X without blocking the merge — a
> deliberate soft gate, not the `workflow_dispatch`-only stub described below. **Perf/bench never landed.**
>
> The original status line is preserved below for the record; it was wrong in the direction that matters —
> it understated shipped work, which is how tooling gets built twice.
>
> ~~**Status: the CI spine landed; none of the four named tools did.** `verify` is a required check running typecheck, the full suite, `gofmt -l` and `go vet`. Still missing: any TypeScript linter or formatter (Go has two gates, TS has none), a coverage RATCHET (`coverage.yml` is `workflow_dispatch`-only and self-documents as non-gating), and perf/bench.~~

Need to add
[oxc / rome / eslint / ??]
- Fmt
- Lint
- Code coverage CI codecov must go up
- Perf/bench Testing

Ideally we also make GH CI run it all too
- and add to ruleset for PR submissions



Deployer Worker?
- Is it a crazy idea that we might offer a UI and some mini-app `deploy.bullmoose.cc`
- that offers a UI for config
- and then lets a human hand us minted CF keys 
- and lets us deploy their system to CF?

is this an unreasonable presumption