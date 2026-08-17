# 010 -P3- CLI doc + help-registry drift (bundle)

**Subsystem:** cli · **Severity:** LOW (individually) · **Fix class:** mostly UPDATE-DOC

Small confirmed items, bundled because each is a few lines. **Note first the good news:**
`docs/cli.md` was regenerated (`node bin/bullmoose.mjs help --markdown`) and diffed **byte-identical**
to the checked-in file, and every command in `help.ts`'s registry has a matching `case` in
`main.ts`'s switch and vice versa. There is no phantom-command drift. What follows is spec-vs-runtime.

1. **`admin`'s own error message calls implemented features unimplemented.**
   `admin.ts:276-281` prints "designed (not yet built): route, identity, policy, share, suppression,
   **agent**" — but `agent bind`/`agent list` are live at `:147-184` and `grant create/list/revoke`
   at `:185-229` (and documented working at `docs/cli.md:462-467`). A user who typos
   `admin grnat create` is told grants don't exist. The header taxonomy at `:11-22` is stale the same
   way. → **CHANGE-CODE**: derive the string from the switch.

2. **Unknown flags produce a raw Node stack trace.** `parseArgs` runs at module scope
   (`main.ts:30`), _outside_ the try/catch that formats every other error (`:121, 230-233`).
   `bullmoose log --dry-run` prints `TypeError [ERR_PARSE_ARGS_UNKNOWN_OPTION]` + a ten-line internal
   stack. Given `--dry-run` doesn't exist yet, this is the first thing a cautious user types before a
   `send`. → **CHANGE-CODE**.

3. **`help` is a real command with no spec entry.** Handled at `main.ts:90-117`, absent from
   `COMMANDS` — so it's missing from the overview table and from `help --json`, which is what agents
   parse. `bullmoose help help` prints "unknown command: help" and exits 1. `--man`/`--markdown`
   (`main.ts:84-85`) are likewise absent from `GLOBAL_OPTIONS`. → **CHANGE-CODE**.

4. **`creds oauth --port` undocumented** — parsed at `main.ts:70`, defaulted 8976 at `creds.ts:127`,
   printed in the command's _own_ usage string at `creds.ts:118`, but absent from `help.ts:251` /
   `docs/cli.md:373`. `--meta` on `oauth` (`creds.ts:134`) likewise. → **UPDATE-DOC**.

5. **`packages/cli/README.md:31` says `init --url`; the flag is `--base`.** `cmdInit` reads only
   `opts.base` (`main.ts:239-247`); `--url` parses fine (`:35`) and is silently discarded, so
   `init --url file:///…` fails with "init requires --base and --token". → **UPDATE-DOC**.

6. **`docs/README.md:45` is not runnable as sequenced.** `bullmoose token create …` follows only
   `admin init`/`account create`/`password`, but `cmdToken` calls `requireSettings(db)`
   (`main.ts:138` → `db.ts:147-154`) which needs a prior `login`. As written it exits "Not
   configured. Run: bullmoose login". → **UPDATE-DOC**.

7. **`docs/agents/README.md:90,95` reference `emily-config.json` / `allen-config.json`** — the files
   are `editor-emily.config.json` / `analyst-allen.config.json`. (`docs/cli.md:476` is correct.)
   → **UPDATE-DOC**.

8. **`docs/cli.md:195` renders as a broken table row** — `renderMarkdown` (`help.ts:530`) doesn't
   escape `|`, and the flag text is `--expandMD html|no`, making four cells in a two-column table.
   Only flag affected. → **CHANGE-CODE** (escape pipes in the generator).
