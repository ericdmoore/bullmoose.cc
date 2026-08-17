Code Hygiene Efforts
=======================

> **Status: the CI spine landed; none of the four named tools did.** `verify` is a required check running typecheck, the full suite, `gofmt -l` and `go vet`. Still missing: any TypeScript linter or formatter (Go has two gates, TS has none), a coverage RATCHET (`coverage.yml` is `workflow_dispatch`-only and self-documents as non-gating), and perf/bench.

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