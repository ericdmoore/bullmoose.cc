# s43 — the agent port · *the last delegation, and it's a daemon*

> **Status: DESIGN, written 2026-08-22.** `agent` is the ONLY command still
> delegating to Node (verified: everything else help-listed traces `native`,
> v0.1.0 is released and installed). s42 said this one "may deserve its own
> section when reached" — it is reached, and it does. Nothing built yet.

## Why a section and not another s42 row

Every s42 port so far was request-response: validate, make the pinned calls,
render, exit. `agent serve` is a PROCESS — it claims work other actors are
also watching, holds authority that can be revoked out from under it while it
runs, spends (or deliberately does not spend) money per invocation, and
writes drafts into real mailboxes. A subtle divergence in `share` prints the
wrong line; a subtle divergence here is an agent that double-claims, silently
stops serving an account, mislabels paid work as free, or un-pulls a kill
switch. The failure modes are behavioural, not textual — which is exactly the
half of the s42 contract ("the server sees the same thing") that matters, and
why this write-up pins loops and state machines rather than output bytes.

Also: "agent" is not one surface. It is THREE, in three modules, speaking to
three different doors — and the port must keep them separate because their
auth models differ, not because Node's file layout did.

## The map (what Node actually has)

| module | lines | surface | door |
|---|---|---|---|
| `agent.ts` | 691 | `serve --config\|--fleet [--once]` — the fleet-host daemon | JMAP (AgentInvocation, Email, Mailbox) + WS push + model providers |
| `agentInvoke.ts` | 151 | `invoke` / `invocations` / `rm` — drive the queue from outside | JMAP `AgentInvocation/set·query·get`, own mail token |
| `agentDossier.ts` | 1219 | `show` / `budget` / `model` / `backfill` / `enable` / `disable` — read and tune ONE binding | THREE doors: console projection (read), `AgentBinding/set` (kill switch), provision worker (money/menu) |
| `extract.ts` | 342 | the extraction pipeline `serve` dispatches to | `Annotation/set` over JMAP; constants MIRRORED from the cloud pass |

What is already native and gets reused, not rebuilt: `internal/ws` (the RFC
6455 client `watch` runs on), the StateChange plumbing in `internal/mirror`,
`internal/jmap`, `internal/provision` (the admin port's client — the dossier's
operator door), `internal/store`. The daemon's skeleton exists; the port is
the loops and the judgment calls.

## The invariants that survive EXACTLY (the NOT-idioms list)

1. **L0 is a wire format.** The platform preamble — the injection pin telling
   the model email content is untrusted data — reaches the model byte-exact.
   Prompts the server/model sees are choreography, not chrome; same rule as
   `encodeURIComponent` in s42. Same for `EXTRACT_SYSTEM` and the extract
   constants: the CUE regexes, `CLASS_TYPES`, `MAX_PER_MESSAGE`, `SCAN` are
   mirrored from `services/agent/src/extract.ts`, and Node's drift test
   (extract.test.ts reads the cloud source and fails on divergence) must be
   REBUILT in Go, not dropped — a Go test reading the same TS file, the
   artifact-hash pattern `internal/help` already uses.
2. **Claim before work, and a lost race is a clean no-op.** The optimistic
   `AgentInvocation/set {status: "running"}`, checked via `updated`, is the
   concurrency contract with every other claimant (cloud cron included).
   No work happens before the claim confirms; an unclaimed invocation is
   left untouched, not retried in a loop.
3. **The claim DECLARES the claimant** — `isFree: true` plus the fleet's
   capability vector when declared. That declaration feeds the server's
   liveness inference (a free claim in the last 15 min = NULL-due work waits
   for the homelab instead of going to the paid cloud) and the audit trail.
   Shape and placement are pinned.
4. **Authority is discovered, revocable, and revocation is LIVE.** Fleet
   accounts come from grants resolved on a fresh session, never from config.
   An authz refusal (`accountNotFound` | `forbidden` — names pinned
   server-side) mid-drain drops that account and closes its channel without
   touching the rest; the periodic re-discovery tick is the only way back in.
5. **Cost honesty: NULL ≠ 0.** Missing provider usage stays absent and lands
   as NULL ("undetermined"), never 0 ("free"). 0 is EARNED: mock, keyless
   openai-compatible, or a route declaring `free: true`.
6. **Keys are env references, never values.** `apiKeyEnv` names a variable; a
   named-but-unset variable is an error; NO `apiKeyEnv` on openai-compatible
   is the keyless @local shape, not an error. (The admin/creds rule, again.)
7. **Failure writes `failed`, best-effort, and the loop survives.** A pipeline
   error completes the invocation as failed with the error in `result`; the
   completion write itself is allowed to fail silently; the daemon never
   crashes out of the drain over one bad invocation.
8. **The kill switch stays un-softened.** `enable`/`disable` go through
   `AgentBinding/set` on the session (the ONE mutation a session can make);
   and the re-provision hazard is refused, not papered over: `budget --set` /
   `model --set` on a DISABLED binding would silently re-enable it, so that
   is exit 5 without `--yes`. Both directions of s42's admin rule: the
   dangerous-off direction frictionless, the sneaky-on direction gated.
9. **Doors are reported, never guessed at.** A verb whose door the configured
   credentials cannot reach says UNREACHABLE plus the exact call that would
   work (`--json` carries the same as a `doors` block). And `budget`/`model`
   are read-modify-writes against `POST /extractor` — every field read back
   and re-sent — because that endpoint rewrites the WHOLE config and every
   field not re-sent is lost.
10. **Capability narrowing is preference client-side, eligibility
    server-side.** `fitsRequirements` semantics exactly: null/absent requires
    → claim; no declared vector → claim; booleans default to "cannot";
    `contextTokens` unstated = no known limit. A generous self-filter never
    widens anything — the server enforces the same predicate in the guarded
    UPDATE.
11. **`invoke` refuses a disabled binding server-side** and each distinct
    SetError arrives as a distinct exit code. Refusals cost the requests the
    server charges, none extra.

## The licence (what Go idioms replace)

- **The event loop.** `setInterval` + un-awaited promises + a never-resolving
  promise become a context, a `time.Ticker`, and goroutines per channel —
  with ONE new behaviour Node never had: **graceful shutdown**. Node dies
  mid-invocation and strands the claim as `running`. Go gets
  `signal.NotifyContext`: finish (or fail-complete) the in-flight invocation,
  close channels, exit. This is a deliberate, named divergence — the server
  sees a *completed* invocation instead of a stranded one, which is the
  direction the contract exists to protect.
- **The WS channel.** Node's per-account browser-API `WebSocket` with
  hand-rolled jittered backoff becomes `internal/ws` + the reconnect pattern
  `watch`/`mirror` already carry. Jitter/backoff stays (1s→60s cap, ×2 per
  retry, each wait jittered to 50–100% of the step), injected for tests.
- **Provider adapters.** `callModel` (mock | anthropic | openai-compatible)
  ports as an interface with the three implementations; the mock stays
  deterministic and pipeline-aware (it answers in the extract contract's
  shape under `EXTRACT_SYSTEM`) so every loop is testable key-free.
- **Config loading.** Same validation set, same refusals (`RUNNABLE_PIPELINES`
  checked at LOAD — a config naming an unrunnable pipeline is refused before
  any claim is burned), Go error values instead of `process.exit` mid-loader.
- **Dossier rendering.** Column padding and layout may go Go-native; the
  `_self`/doors JSON shape stays (it is HAL, and it is consumed).

## Order of work

1. **`invoke` / `invocations` / `rm`** — request-response, ordinary s42 port.
   Lands the AgentInvocation choreography + the mailFake extensions
   everything else here tests against.
2. **Dossier reads** (`show`, and the doors model) — console projection GET,
   `findBinding`, ledger/budget math, µUSD rendering (six places sub-cent).
3. **Dossier writes** — `enable`/`disable` over `AgentBinding/set`; then
   `budget`/`model`/`backfill` over `internal/provision` with the RMW and the
   `--yes` re-enable gate. The gate tests come first, both directions, zero
   requests on refusal.
4. **`serve --config --once`** — single binding, reply pipeline, mock
   provider, fake server: the whole template loop (claim → Email/get →
   model → draft with `$agent` keyword → done) as a choreography table.
   `--once` is the test seam Node already built; keep it.
5. **The extract mirror** — port `extract.ts` gates in order (List-Unsubscribe
   → cues → idempotence → menu+arm → parse → Annotation/set), plus the Go
   drift test pinning the mirrored constants to the cloud source.
6. **Fleet mode** — grant discovery, channel lifecycle following the served
   set, live revocation, capability narrowing, the 5-minute tick. Then real
   providers (anthropic, openai-compatible) against httptest servers.
7. **Flip the registry** — `agent` registered native; `BULLMOOSE_TRACE`
   should then report **zero delegated** across the full help-listed set.

Each step lands separately mergeable; the registry flip is LAST and alone, so
every loop is in the tree and tested before the delegation ends.

## What this unlocks (the s08 endgame)

When step 7 lands, the trace metric reads zero. Then, per s08 T7 and s42:
one release soaks at zero delegated → the Node CLI and `internal/delegate`
are removed in the SAME PR → `contract.mjs` retires (its assertions live on
as cli-go's own choreography tests, #19). `~/bin/bullmoose-node` on alpaca
outlives the repo copy only as long as Eric wants a museum piece.

## Risks, named

- **The daemon is where "equivalence not imitation" is most tempting to
  abuse.** The rewrite budget is the loops above, not a redesign of claim
  semantics or a new health endpoint. Anything the server would see
  differently needs its own line in this file first. (Current count of named
  divergences: ONE — graceful shutdown.)
- **Timers and jitter make tests flaky by default.** Everything time-shaped
  is injected (`--once` for the drain, a clock/rand seam for backoff), the
  `local_test.go` way. No test sleeps its way to a claim.
- **The extract constants can drift three ways now** (cloud, Node, Go) until
  Node is deleted. The Go drift test reads the CLOUD source — the same
  source-of-truth Node pins — so all three stay chained to one file.

## Related

- [[s42-go-native]] — the contract this finishes; the "agent may deserve its
  own section" note this honours
- [[s08-go-cli]] — T6's last wave and T7's retirement criterion
- `packages/cli/src/agent.ts` header — the fleet/claim design (s11
  jobs-and-facets §4/§6), quoted throughout above
- [[s26-agent-config]] (T5a/T6) — frontier assignment and the extraction mirror
- [[s10-agents]] — the two-surface framing (configuration vs activity) the
  dossier verbs inherit
- sVOL 007/008 — invoke and the kill switch
