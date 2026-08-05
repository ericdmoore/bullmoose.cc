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

## Commands (high points)

- `login` / `discover` / `init --url` (accepts `file://` bootstrap
  bundles) / `token` (mint app-passwords) / `accounts`
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
