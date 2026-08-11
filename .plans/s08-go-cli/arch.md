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
also *resolves* `.feedback` `cli/032` — the vendoring stops being an awkward Node
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
  for stdout/stderr. Wrap them in pipes Go pumps and Node's `isatty` flips — colour and
  framing change under delegation, and the early-close/SIGPIPE cases in the contract suite
  fail. This is the single easiest way to get a subtly wrong shim that still looks fine
  interactively.
- **Propagate the exit code exactly.** `packages/cli/src/io.ts` maps every JMAP
  `setError` to a specific code (`JMAP_EXIT`). The shim passes it through untouched;
  it must not normalise, clamp, or substitute.
- **Forward signals.** SIGINT/SIGTERM reach the child, and the parent reports the child's
  disposition rather than its own.

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

| coupling | today | as a contract |
|---|---|---|
| `deriveLoginKey` | CLI imports nothing; mirrors the algorithm | golden vectors: (email, password) → key |
| scope vocabulary | `scopes.test.ts` **reads `auth-core/src/index.ts` as text** and regex-parses it | JSON emitted from `auth-core`, asserted by both suites |
| `JMAP_EXIT` | `io.ts` constant | JSON table, asserted by both |

### 5.1 `deriveLoginKey` — do not change the algorithm

Nobody uses bullmoose yet, so PBKDF2-SHA256/600k is free to replace. **It should not be.**

The constraint that chose it is still in force and has nothing to do with existing users:
`auth-core` records that argon2 is the better algorithm but "neither Workers nor browsers
ship it natively", and login is client-stretched specifically so it fits the Workers
free-plan 10 ms CPU cap — the server must never do the expensive part.

So the derivation is a **cross-client contract, not a per-client choice.** A Go CLI can do
argon2id natively; a browser cannot without shipping WASM. Ship both and one password
yields two different keys depending on which client was used — login succeeds in one and
silently fails in the other. `LOGIN_KEY_ALGO` is versioned, so the algorithm *could* be
recorded per credential, but that makes the split explicit rather than removing it.

Only the CLI derives a key today (the webmail door takes a pasted token), so the
constraint is not binding *right now*. It binds the moment webmail grows a password login
— which is `s02` T7's business, and a decision to make there rather than here.

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

The open ones split cleanly: **`038`** (`vacation --if-state` ignored) is a *server* bug
and unaffected by the language; **`032`** is resolved by §2.

## 7. What stays in TypeScript, permanently

Nothing about this section proposes a second platform. Workers, JMAP methods, the
mailstore, the webmail and every shared package stay exactly as they are. The CLI is the
one component with a distribution problem that Go solves, and it is also — not
coincidentally — the one component that already shares no code.

If a future component wants the same treatment, the test is the same two questions: does
it have a distribution problem Go fixes, and does it already stand alone?
