# Agents & automation

bullmoose is built to be driven by agents (and humans who like a good CLI).
Start here.

## The `bullmoose` CLI — the primary programmatic surface

It is **self-documenting**, from one source of truth
(`packages/cli/src/help.ts`):

```sh
bullmoose help                 # overview of every command + global options
bullmoose help <command>       # verbose: synopsis, flags, examples, see-also
bullmoose <command> --help     # (same)
bullmoose help --json          # the full command spec, machine-readable
```

- **Reference:** [`docs/cli.md`](docs/cli.md) (generated) · **man page:**
  `packages/cli/man/bullmoose.1` (`man packages/cli/man/bullmoose.1`).
- The `--json` dump is the fastest way for an agent to enumerate commands,
  flags, and examples without scraping text.

## Email-native agents (mailboxes with a runtime)

- Design: [`docs/architecture/agent-integration.md`](docs/architecture/agent-integration.md)
  and the composition model in
  [`docs/architecture/capability-roadmap.md`](docs/architecture/capability-roadmap.md).
- Runnable examples: [`docs/examples/`](docs/examples/README.md) — cloud
  binding configs (`editor-emily`, `analyst-allen`) and the homelab
  `hermes-bridge`.
- Bind one: `bullmoose admin agent bind <email> --name <binding> --config …`
  (see `bullmoose help admin`).
- A **read-only analytics MCP** over the message log lives in the `agent`
  worker (`services/agent/src/mcp.ts`) — safe tools, zero external creds.

## Where things live

- **Architecture & capacity:** [`docs/architecture/`](docs/architecture/README.md)
- **Packages / services (indexed):** [`packages/`](packages/README.md) ·
  [`services/`](services/README.md)
- **Deploy:** [`docs/DEPLOY.md`](docs/DEPLOY.md) · one command:
  `node infra/bootstrap.mjs`
- **Client setup playbooks:** [`docs/playbooks/`](docs/playbooks/README.md)

## Convention

The CLI help is generated from `packages/cli/src/help.ts` → `--help`,
`--json`, `man/bullmoose.1`, and `docs/cli.md`. Edit the spec, then
`npm run -w @bullmoose/cli gen:docs`; never hand-edit the generated files.
