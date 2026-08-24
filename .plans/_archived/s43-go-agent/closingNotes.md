---
plan: s43-go-agent
status: closed
closed_at: 2026-08-24
closing_pr: none        # docs-only archive move; the seven steps were
                        # #307 #308 #310 #311 #312 #314 #315 + the flip
acceptance: met
residues: 0
reversals: 0
---

# s43 — closing notes

Set out to port the one command that is a PROCESS rather than a
request-response: `agent serve`, the daemon that claims work other actors are
also watching. Became a seven-step arc whose discipline was the claim
contract — claim-before-work, lost race is a clean no-op, capabilities ride
verbatim, failure writes `failed` best-effort — ending with THE FLIP as a
one-entry registry PR, deliberately alone so the diff that changes who
answers contains nothing else.

## Acceptance ledger

| Done-when (status claims, verbatim) | verdict | evidence |
|---|---|---|
| "All seven steps landed" | ✅ met | #307 invoke, #308 dossier reads, #310 dossier writes, #311 serve --once, #312 extract mirror, #314 fleet + persistent loop, then the flip |
| "Contract suite 75/75" | ✅ met | recorded at flip time; suite since retired with the delegate (s08/s42) |
| "trace: 131 native, 1 delegated — and the 1 is delegate-package policy" | ✅ met | `log --no-such-flag`, the unknown-flag class that BY DESIGN stayed Node's until the burial made refusals native |
| "Every help-listed COMMAND is native" | ✅ met | registry.go; route.go refusals exit 2 naming the flag |

## Carried forward

| what | why it did not ship | owner |
|---|---|---|

None. The s08 soak clock this status mentions was waived by Eric before it
started.

## Reachability

- **Deployed?** in the released binary (v0.2.0 onward); the persistent daemon
  runs wherever an operator starts it — s37's DeviceReport is how the app
  sees one.
- **Migration applied?** none needed.
- **Verified live?** fleet reconnect and claim races under `-race` (30 clean
  runs after the KeepAlive fix); live invocations against production during
  the arc.

## Authority-surface delta

None new: the daemon authenticates with the same token vocabulary; graceful
shutdown via `context.WithoutCancel` is the ONE named divergence from Node's
behaviour (Node dropped in-flight work on SIGTERM; Go finishes the claimed
invocation).

## Deviations from `devPlan.md`

`context.WithoutCancel` on shutdown, named above and in the code — an
improvement recorded as a divergence, not smuggled in as a port.

## Reversals

None.

## Absorbed / donated

Received the whole `agent` surface from [[s42-go-native]]'s scope. The
daemon's device reporting was built later by s37 T1b (which also fixed a
`runLocal` dispatch bug this arc's tests never drove — verb read at at(0)).

## What grew stale during the build

The trace numbers, every step — by design.

## Traps for the next section

- A daemon port's tests need the fixture's connections kept ALIVE
  (`runtime.KeepAlive`) — the GC closing a fake server's fd reproduces as a
  phantom reconnect that looks like daemon flakiness.
- WebSocket auth rides `access_token` in the query BEFORE any Bearer check;
  a fake that gates WS behind the header check hangs the dial loop forever.
