# s08 — the Go CLI: structure

> Why a second language is affordable here, what the seams are, and which
> couplings become explicit contracts. Build order lives in
> [`devPlan.md`](./devPlan.md).

## 1. The argument is the static binary

Everything else is secondary and should be treated that way when trading off.

Today `bullmoose` is `~/bin/bullmoose` → `~/bullmoose-cli/bin/bullmoose.mjs`, which
needs Node on the host. A Go binary is `scp` and run — on a server, a NAS, a colleague's
laptop, a container with no package manager. For **cross-host tooling that is the whole
feature**, and no amount of Node packaging (pkg, SEA, bun build) gets there as cleanly.

Secondary, real, but not load-bearing:

- **Cross-compilation.** `GOOS`/`GOARCH` from one machine; no per-platform CI matrix.
- **Startup.** ~5 ms versus Node's 50–100 ms. Matters when `watch` or `xargs` invokes it
  in a loop, which the I/O contract explicitly supports.
- **SQLite.** The CLI keeps a local mirror on `node:sqlite`, which is still experimental.
  `modernc.org/sqlite` is pure Go and cross-compiles without cgo.
- **Precedent.** `popcorn` is already Go, so the stack is not monolingual and the language
  is not new to this operator.

## 2. Why a second language is affordable — the duplication is already paid

The usual objection to porting a CLI is that it forks everything the platform shares with
it. Measured:

```
imports of @bullmoose/* in packages/cli/src …… ZERO
npm dependencies ……………………………………………………… marked
```

`scopes.ts`, `calendar.ts`, `contacts.ts` and `mime.ts` are each a **vendored mirror**,
and each carries a comment saying why: the CLI compiles to plain Node and cannot import
workspace TypeScript at runtime.

So Go does not create a second implementation. It changes the language of one that is
**already second**. That single fact is what moves this from romantic to feasible, and it
also _resolves_ `.feedback` `cli/032` — the vendoring stops being an awkward Node
limitation and becomes deliberate architecture.

## 3. The acceptance gate already exists, and it is black-box

`packages/cli/smoke/contract.mjs` (602 lines, 61 cases) drives **the built binary**
through a real `sh`, with real pipes, a reader that closes early, and real `xargs`. The
binary under test is one constant:

```js
const CLI = join(HERE, "..", "bin", "bullmoose.mjs");
```

Point that at a Go binary and the conformance suite exists on day one. The part it covers
is exactly the part that is hardest to get right and easiest to regress invisibly —
SIGPIPE, exit codes, TTY detection, colour, framing under pipes.

**The property to preserve:** with delegation (§4) the Go binary passes **61/61 from the
first commit**, because every command delegates. It then holds 61/61 as commands migrate.
The suite never goes red; it quietly changes which implementation it is exercising. That
makes "how far along is the port" a measured number rather than a feeling — but only if
§4's seam is observable, or a green suite tells you nothing about what ran.

## 4. The strangler seam

The Go binary is the front door. Anything not yet implemented natively `exec`s the Node
CLI with the same argv. Three details decide whether that is transparent:

- **Inherit file descriptors; do not copy streams.** `cmd.Stdin = os.Stdin` and the same
  for stdout/stderr. Wrap them in pipes Go pumps and Node's `isatty` flips.
  ⚠️ **Corrected by T2's measurement:** this does NOT break the contract suite —
  `spawnSync` gives every case a closed stdin and a non-TTY stdout, so `isatty` is false
  either way and the suite is blind to fd identity. The real breakage is only visible under
  a **real pty**: the pumped build reports `isTTY=false` where Node reports `true`, then
  **hangs forever**, because `os/exec` waits on a stdin copier that never ends on a
  terminal. `cli-go`'s `TestDelegateInheritsFileDescriptors` is the only thing that catches
  this — the contract suite cannot. This is the single easiest way to get a shim that looks
  fine interactively (and in CI) and is subtly wrong.
- **Propagate the exit code exactly.** `packages/cli/src/io.ts` maps every JMAP
  `setError` to a specific code (`JMAP_EXIT`). The shim passes it through untouched;
  it must not normalise, clamp, or substitute.
- **Forward signals.** SIGINT/SIGTERM reach the child, and the parent reports the child's
  disposition rather than its own. Note (T2): a Go process **cannot re-raise SIGPIPE on
  itself** — the runtime's handler swallows it, so a child killed by SIGPIPE surfaces as
  exit 141 rather than a re-raised signal. `$?` is identical under `sh`, and `io.ts:287`'s
  EPIPE guard means the CLI never dies that way regardless.

**The seam must be observable.** `BULLMOOSE_TRACE=1` on stderr, printing `native` or
`delegated` per invocation. Without it a passing contract run cannot distinguish "the Go
implementation is correct" from "the Go implementation does not exist yet", which is the
one question the suite is being used to answer.

Discovery of the Node CLI is explicit — `BULLMOOSE_NODE_CLI`, else a sibling path, else a
clear error naming both. Never a silent fallback to "command not found".

## 5. Three couplings become explicit contracts

An import is a coupling the compiler checks. Across languages nothing checks it, so each
must become a file that both sides read and a test on each side that reads it.

Worth noting the scope coupling is **already** not an import. `packages/cli/src/scopes.test.ts`
reads `auth-core/src/index.ts` as a **string** and regex-parses four declarations out of
it, following spreads by hand — because the CLI's tsconfig is Node-typed and cannot even
`import type` from a workers-typed package. Its own comment calls this "crude, but the only
check that actually fails when someone adds a scope on one side."

So the cross-language contract below is not a downgrade from a type-checked import. It
replaces a regex over another package's source with a generated artifact — which is
strictly better, and would be worth doing even if the CLI stayed in TypeScript.

| coupling                                | today                                                                           | as a contract                                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `deriveLoginKey`                        | CLI imports nothing; mirrors the algorithm                                      | ✅ `conformance/login-key.json` (T1)                                                                        |
| scope vocabulary                        | `scopes.test.ts` **reads `auth-core/src/index.ts` as text** and regex-parses it | ✅ `conformance/scopes.json` exists (T1); ⏳ `scopes.test.ts` still regex-parses — swap to the vector in T5 |
| `JMAP_EXIT`                             | `io.ts` constant                                                                | ✅ `conformance/exit-codes.json` (T1)                                                                       |
| **argv flag spec** _(4th, found in T2)_ | `main.ts` flag table                                                            | mirrored in `cli-go/internal/delegate/argv.go` with a drift test; candidate for T1's generator              |

⚠️ **T1 also captured a Go-specific divergence worth reading before T6:** `strings.ToLower`
vs JS full case mapping. `strings.ToLower("İ")` yields a bare `i`; JS yields `i` + U+0307.
The login salt lower-cases the email, so a naive Go port derives a **different key** for such
an address and login fails looking exactly like a wrong password. The vector's
`unicode-email-turkish-dotted-i` case is red until the port matches; do not "fix" it by
changing the vector.

⚠️ **Not in the T1 vector, flagged for T5:** `exitCodeForHttpStatus` (`io.ts:144`) is the
same taxonomy for the CLI's non-JMAP endpoints. Either extend the vector or record why the
Go port re-derives it.

### 5.1 `deriveLoginKey` — do not change the algorithm

Nobody uses bullmoose yet, so PBKDF2-SHA256/600k is free to replace. **It should not be.**

⚠️ **Correction — this section originally cited the weaker of two reasons.** It said login
is client-stretched to fit the Workers **free-plan 10 ms CPU cap**. That is true and, on a
paid plan, **no longer binding**. It should not have been the argument.

The reason that survives has nothing to do with billing: **the server never sees the
password.** A compromised server, a malicious operator, or an accidental log line never
observes plaintext, because plaintext never leaves the client. That property is worth the
same on any plan.

And the argon2 obstacle is unchanged, because it was never the Worker: `auth-core` records
that argon2 is better but "neither Workers **nor browsers** ship it natively". Paid compute
does not give a browser argon2.

So the derivation is a **cross-client contract, not a per-client choice.** A Go CLI can do
argon2id natively; a browser cannot without shipping WASM. Ship both and one password
yields two different keys depending on which client was used — login succeeds in one and
silently fails in the other. `LOGIN_KEY_ALGO` is versioned, so the algorithm _could_ be
recorded per credential, but that makes the split explicit rather than removing it.

Only the CLI derives a key today (the webmail door takes a pasted token), so the
constraint is not binding _right now_. It binds the moment webmail grows a password login
— which is `s02` T7's business, and a decision to make there rather than here.

**What paid Workers buys here, honestly: very little.** A database leak already costs an
attacker 600k PBKDF2 iterations per password guess, because the client-side stretch is in
the chain — adding a server-side stretch does not change the dominant term. The design is
already the right one; the plan change removes a _justification_ without changing the
_conclusion_.

Where paid compute genuinely changes assumptions is elsewhere, and those are worth
revisiting deliberately rather than inheriting: `s07`'s attachment-search tiering assumes
extraction cannot happen in a Worker, and `capacity-and-scaling.md` budgets against the
free plan. Eight files across `docs/` and `.plans/` assert free-tier constraints.

**What being pre-users actually buys is cheapness of error:** a mismatch during the port
is re-minted, not migrated. That lowers the risk of the port, not the quality of the
design. The vector is still required, because a silent mismatch presents as "wrong
password" and sends you to fix something that is not broken.

## 6. The regression surface a rewrite re-opens

The CLI's closed `.feedback` items are the record of what was learned the hard way. They
are fixed **in TypeScript**, which the Go port will not read, so a fresh implementation
reintroduces them by default. Each becomes a Go test case up front, not a follow-up:

- `✅cli/006` — `watch --exec` shell injection via a blocklist. The lesson is that a
  blocklist was the wrong shape; the port must not re-derive a blocklist.
- `✅cli/007` — `token create` defaulted to the widest scope.
- `✅cli/008` — `--json` silently ignored on eight commands.
- `✅cli/009` — account resolution inconsistent across commands.

The open ones split cleanly: **`038`** (`vacation --if-state` ignored) is a _server_ bug
and unaffected by the language; **`032`** is resolved by §2.

## 6a. Measured: Go-WASM cannot be the shared codec core (for the browser)

The appealing version of this section is bigger than a CLI: extract the codecs
(`contacts-core`, `calendar-core`, `mime`, the scope lattice) into a **pure-data core**,
compile it to WASM, and let the CLI, the browser and Workers all consume one
implementation — with effects staying in each shell. The duplication is real: the scope
vocabulary alone exists in `auth-core`, the CLI mirror, and the webmail mirror, and
`GRANTABLE_SCOPES` has already drifted (it silently omits `vault` and `files`).

Go does have a WASM target, so this looked available. **Measured, it is not** — for the
browser:

|                                                          | gzipped    |
| -------------------------------------------------------- | ---------- |
| entire webmail: 7 pages, every island, Preact, all of it | **83 KB**  |
| one Go-WASM module — a _toy_ vCard parser                | **844 KB** |

Ten times the whole application, for a fraction of one codec. The bytes are Go's runtime —
GC, scheduler, reflection — not the parser. `GOOS=js GOARCH=wasm`, `-ldflags="-s -w"`, plus
20 KB of `wasm_exec.js` glue. Reproduce with the toy in this section's history; the number
moves with the Go version but not by an order of magnitude.

Consequences, in order:

- **The browser is out.** A mail client cannot pay 10× its own weight for a parser.
- **Workers might tolerate it** (paid script limits are generous), but at a cold-start cost
  and for one of three consumers.
- So Go-as-shared-core yields **Go native + Go WASM for Workers + TS for the browser** —
  still two implementations, just differently arranged. That is not an improvement over
  today, and it is the reason this section stays scoped to the CLI.

⚠️ **Not measured, and it is the deciding number if this is ever revisited:** Rust has no
runtime and no GC, so the same toy should be far smaller — plausibly under 150 KB gzipped.
That is an _estimate from general knowledge, not a measurement_, and this whole section
exists because an estimate was wrong by an order of magnitude once already. TinyGo is the
other unmeasured option; its weak spot is `encoding/json` and reflection, which is exactly
what a codec needs.

**If the codec-deduplication goal ever outranks the static-binary goal, measure Rust
first.** The CLI port does not depend on that answer.

## 7. What stays in TypeScript, permanently

Nothing about this section proposes a second platform. Workers, JMAP methods, the
mailstore, the webmail and every shared package stay exactly as they are. The CLI is the
one component with a distribution problem that Go solves, and it is also — not
coincidentally — the one component that already shares no code.

If a future component wants the same treatment, the test is the same two questions: does
it have a distribution problem Go fixes, and does it already stand alone?
