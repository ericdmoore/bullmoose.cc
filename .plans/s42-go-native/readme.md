# s42 — Go native · *finish the port, and stop imitating Node while doing it*

> **Status: COMPLETE, 2026-08-22.** Every remaining command ported under this
> section's rule (share → admin here; agent under [[s43-go-agent]]), the
> registry flipped, and the Node CLI + `internal/delegate` were REMOVED in one
> PR the same day — the soak waived by the only user. The contract suite
> retired with the delegation it measured; its job lives on as cli-go's own
> choreography tests.

## The decision

Eric, verbatim intent: migrate as many of the remaining Node commands to Go as
reasonable — and, since the CLI has little usage beyond test suites, **stop
preserving Node idioms**. Where a Node-shaped behaviour survives only because
`main.ts` did it that way, replace it with the Go-idiomatic form.

This RETIRES the byte-identity contract as the port's organising rule. That
contract earned its keep — it caught five real bugs in the `models` port alone,
and the parser-grammar drift test it motivated found a silently-dropped commit
(#294). Retiring it is safe now for one reason: **the sole consumer is Eric
plus the test suites.** There is no scripted fleet parsing this CLI's stderr,
so "identical to Node" protects nobody; it only taxes every port with the
obligation to reproduce accidents.

## What replaces byte-identity

Not nothing. The replacement bar, per command:

1. **The server sees the same thing.** JMAP calls, their order, and their
   arguments stay pinned — that is what the choreography tests assert and it
   is the half with consequences. A different stderr sentence is cosmetic; a
   different `Email/set` is a different action.
2. **Refusals stay free.** A bad invocation costs zero requests (main.ts:589's
   rule — which was always a good rule, not a Node idiom).
3. **Exit codes keep their MEANING** (0 ok, 2 usage, 4 auth/refused, 5
   conflict…), because scripts branch on codes even when nobody parses text.
4. **Parse-back over byte-diff** wherever output has structure — the mime.ts
   precedent: assert the thing a consumer would do, not the bytes.

## What "Go idioms" means concretely (and what it does not)

The codebase currently carries **203 `file:line` references into the
TypeScript source** (`main.ts:596`, `io.ts:260`, …). Under the old rule those
were load-bearing citations; under the new one they decay into archaeology.

In favour:

- **`flag`-style or subcommand-per-file structure** where the hand-rolled argv
  walker forces Node's shapes; the parser-grammar drift test survives either
  way, and it is the thing that matters.
- **Errors as `error` values** flowing up, not `die()` mid-function — the
  current shape is process.exit's ghost.
- **Contexts with timeouts** on every network call as the default, not the
  exception.
- **Go's own naming** (`ExpandMD string` pretending to be an enum → a typed
  const set).
- Dropping compatibility shims that exist only to mirror Node quirks — the
  `encodeURIComponent` reimplementation stays (it is wire-format, rule 1), but
  chrome-formatting helpers that pad columns to match `padEnd(40)` do not need
  to survive if a Go-native table reads better.

NOT in favour, and worth saying so nobody "idiomatizes" them away:

- The **security guards** (stripCtl, the no-credential-in-argv rule, consent
  failing closed, refusals-cost-zero). These predate Node and outlive it.
- The **scope discipline** (single-operation patches so a narrow token gets a
  clean exit 4) — that is a JMAP-server contract, not a CLI style.
- The **stdout/stderr split** (records vs chrome). `models | sort` must keep
  working; that is Unix, not Node.

## The contract suite: repoint it, do not delete it

`packages/cli/smoke/contract.mjs` (726 lines) drives both binaries and
compares. Under the new rule its byte-comparisons will fail as ports diverge,
and the WRONG response is deleting cases.

Right response: the suite's assertions migrate to the Go side as
choreography + parse-back tests (the send/mime pattern), and contract.mjs
shrinks as commands stop delegating — because once Node is not invoked for a
command, there is nothing left to compare. The suite's real job was always
"the port did not change what the server sees", and that job moves into
`cli-go`'s own tests, which survive Node's deletion.

## The remaining eight, in proposed order

| command | help lines | note |
|---|---|---|
| `share` | 33 | client method already exists (#289); closes the blobs/share story |
| `discover` | 14 | smallest; pure read |
| `vacation` | 15 | one RFC 8621 object |
| `identity` | 50 | send already reads identities; this is the write side |
| `repoint` | 26 | touches routing — read the #150 installer lesson first |
| `creds` | 49 | the vault; port EXACTLY, the guards here are the product |
| `admin` | 85 | operator plane; ADMIN_TOKEN handling |
| `agent` | 140 | the daemon. LAST, deliberately — serve/--fleet/pipelines is
|         |    | where a subtle divergence is an agent misbehaving, not a
|         |    | command erroring |

`agent` may deserve its own slice (or its own section) when reached: it is a
long-running process with claim semantics, not a request-response command.

## Done-when (s08 T7 unchanged)

This section FEEDS s08 T7; it does not replace it. The trace metric still
gates: **delete the Node CLI only when the delegation count has been zero for
a release.** What changes is the path there — equivalence instead of
imitation — not the bar.

One more marker: when `agent` goes native, `BULLMOOSE_TRACE` should report
zero `delegated` across the full help-listed command set, and the
`delegate/` package itself becomes dead code to remove in the same PR that
removes the Node CLI.

## Risks, named

- **Diverging stderr breaks a script nobody remembered.** Accepted explicitly:
  the stated premise is that no such script exists. If one surfaces, it reads
  exit codes (rule 3) or it was already fragile.
- **"Idiomatic" as a licence to rewrite.** The rewrite budget is the COMMAND
  BEING PORTED, not its neighbours. A port PR that refactors `bmio` wholesale
  is out of scope by definition.
- **The 203 TS citations rot.** As each command ports under the new rule,
  its citations should be either kept (where the cited REASONING still holds)
  or replaced with the reasoning itself, inline. A citation into a deleted
  file is worse than none.

## Related

- [[s08-go-cli]] — T6/T7, the strangler this finishes
- `.plans/devPrinciples.md` — the Node feature-freeze this extends
- #294 — the dropped-commit incident; the drift tests that must survive the
  idiom shift are the ones that caught it
