# @bullmoose/cli — `bullmoose`

The command-line client: a JMAP sync client whose data container is a
**local SQLite message log** (`~/.bullmoose/mail.db`, 0600 perms, same
data-plane schema as the server — the local copy is designed to be
authoritative enough to migrate providers from).

```sh
npm ci && npm run build:cli && npm install -g ./packages/cli
bullmoose login eric@bullmoose.cc     # SRV autodiscovery — no URL needed
```

## Help & discovery

Every command is self-documenting from one source of truth
([`src/help.ts`](src/help.ts)):

```sh
bullmoose help                 # overview: every command + global options
bullmoose help <command>       # verbose: synopsis, flags, examples, see-also
bullmoose <command> --help     # (same)
bullmoose help --json          # the whole command spec, machine-readable (for agents)
man packages/cli/man/bullmoose.1   # the generated man page
```

Full reference: [`docs/cli.md`](../../docs/cli.md) (generated). After editing
the spec, regenerate the man page + markdown: `npm run -w @bullmoose/cli gen:docs`.

## The I/O contract

Every command obeys `.plans/s05-cli-crud/arch.md` §1, implemented in
[`src/io.ts`](src/io.ts) (sVOL `016`):

- **stdout carries records; stderr carries everything else** — progress,
  prompts, warnings, counts, tree decoration, "(none)" notices, hints.
- **A closed pipe is not an error.** `bullmoose log | head -3` exits 0 silently.
- **`--json` is NDJSON** — one complete JSON value per line, never a wrapping
  array. **`--ids`** prints bare identifiers for `| xargs`.
- **Exit codes:** 0 ok · 1 generic · 2 usage · 3 not found · 4 auth · 5 conflict.
  `io.ts`'s `JMAP_EXIT` is the JMAP-error-type → code mapping, and the reason
  each hard case lands where it does.
- **`--if-state`** maps to JMAP `ifInState` (exit 5 on a mismatch, nothing
  written); **`--dry-run`** resolves the target and reports without writing.
- A file argument may be `-` for stdin, or omitted to read piped stdin;
  `--as` forces the content type. Explicit flags always beat implicit stdin.

The parts that only exist across a process boundary — EPIPE, exit codes,
`| xargs` — are held by [`smoke/contract.mjs`](smoke/contract.mjs), which
drives the built binary through a real shell against a loopback stub server.
Run it alone with `npm run -w @bullmoose/cli smoke`; `npm test` runs it too.

## Commands (high points)

- `login` / `discover` / `init --base` (`--url` is accepted as an alias;
  both take `file://` bootstrap bundles) / `token` (mint app-passwords) /
  `accounts`
- `sync` — batched `Email/changes` across all accounts; clean probes
  chunked at 16
- `send` — stdin/`--file`/`--body`; `--expandMD html` renders Markdown,
  CID-inlines local images, attaches small files, and turns big ones
  into expiring HMAC-signed R2 share links (`--linkMax`, `--linkTTL`)
- `read [id]` — newest message when no id; `--raw` for RFC 5322
- `watch` — push-triggered live sync over WebSocket; `--json`,
  `--exec`, `--daemon/--status/--stop` (pidfile)
- `search` / `show` / `mailboxes` / `log`
- `vacation` — the VacationResponse facade
- `agent serve` — the homelab agent runtime (template mode; shares the
  invocation queue with the cloud `services/agent` worker — whoever
  claims first wins)
- `admin <noun> <verb>` — operator surface over the provision worker:
  tenant/domain/account/password/token/agent (see `docs/agents/README.md`
  for agent binding flags)

Multi-account: one login can attach many inboxes; selectors accept
account id, address, `@suffix`, or substring. Requires Node ≥ 22.5
(`node:sqlite`); the bin shim re-execs with the flag on older 22.x.
