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

## Cursor Cloud specific instructions

Standard commands live in the root `package.json` scripts — use those directly:
`npm run lint` (oxlint), `npm run fmt:check` (oxfmt), `npm run typecheck`
(tsc + webmail + cli), `npm test` (vitest), `npm run build:cli`,
`npm run -w webmail build`, and the `dev:*` service scripts. The pre-commit hook
(`.githooks/pre-commit`, wired by the `prepare` script on install) runs
oxfmt + oxlint on staged files. The update script keeps `node_modules` fresh
with `npm ci`.

Non-obvious gotchas discovered during setup:

- **Node / FTS5 (test suite):** the sandbox's default `node` (`/exec-daemon/node`,
  v22.14.0) has a `node:sqlite` build WITHOUT FTS5, so `npm test` fails ~1784
  tests with `no such module: fts5` (the test D1 fake loads `emails_fts`, a
  `fts5` virtual table). This VM uses an nvm-installed Node 22 (FTS5-enabled) put
  ahead of `/exec-daemon/node` via a `~/.bashrc` `PATH` prepend, so fresh shells
  already resolve the right `node` (`node --version` → `v22.2x`). If you ever see
  the `fts5` error, you are on the wrong `node`; open a fresh shell / re-source
  `~/.bashrc`. CI uses `node-version: 22` (latest), which also has FTS5.
- **Go components not runnable here:** `cli-go/` and `packages/popcorn` need
  Go 1.26 (CI); this VM has Go 1.22.2, so those `go test`/`go build` checks and
  the CLI parity smoke won't run. The Node product is unaffected.

Running the mail stack locally (see `tools/README.md` for the seed/run recipe —
`.dev.vars` + local D1 seed + `wrangler dev --persist-to <shared dir>`), plus
these caveats that are easy to trip over:

- **`wrangler dev` pins `url.origin` to the production route host.** Because
  `services/jmap/wrangler.jsonc` declares `routes` for `app.bullmoose.cc`, the
  worker sees `url.origin === http://app.bullmoose.cc` regardless of the request
  Host, so the RFC 8620 session doc advertises `apiUrl`/`uploadUrl`/`…` at
  `app.bullmoose.cc`. The `tools/e2e-*.mjs` suites work because they POST
  directly to `${BASE}/api/jmap` and never follow `session.apiUrl`. The
  `@bullmoose/cli` client and the webmail DO follow `session.apiUrl`, so they
  cannot reach a purely local server without help (see next two points).
- **The jmap worker is same-origin only (no CORS).** It sends no CORS headers
  and 401s `OPTIONS` by design; in prod the webmail and the worker share one
  origin (`app.bullmoose.cc`). To exercise the webmail GUI locally, front
  `astro dev` (`npm run dev -w webmail`, :4321) and the jmap worker (:8787) with
  a single same-origin reverse proxy: route `/api/*`, `/.well-known/jmap`,
  `/auth/*`, `/console/*`, `/share/*` to the worker and everything else to astro,
  and rewrite the `app.bullmoose.cc` host in the `/.well-known/jmap` body to the
  proxy origin (request it with `accept-encoding: identity` so you can string-
  replace it).
- **`DEV_BEARER_TOKEN` is matched verbatim** (`packages/auth-core/src/principal.ts`,
  before token parsing), so setting it to a `bm_<12hex>_<48hex>`-shaped value
  lets the same string pass the webmail door's client-side token-shape check AND
  authenticate as the dev single-account principal. The webmail "Advanced: use a
  device token" panel is the dev/homelab login path (hosted OAuth sign-in only
  works from `app.bullmoose.cc`).
- **Sending mail locally** needs the `submit` worker with `RELAY=mock` (SES has no
  local emulator) sharing the same `--persist-to` state dir as `jmap`.
