package delegate

import "strings"

// Subcommand identification.
//
// The front door parses argv only far enough to learn which command was named.
// Everything else is opaque and forwarded verbatim — `arch.md` §4: the Go binary
// must not normalise, reorder or "helpfully" interpret flags it does not own.
// Nothing here rewrites argv; Command only *reads* it.
//
// "Far enough" still has to honour one rule from the other side. The Node CLI
// reads the command as `positionals[0]` (`packages/cli/src/main.ts:183`) after
// `parseArgs` has consumed the token following each value-taking option
// (`packages/cli/src/main.ts:64-163`). So in
//
//	bullmoose --db /tmp/x log
//
// the command is `log`, not `/tmp/x`. A scanner that skipped only `-`-prefixed
// tokens would answer `/tmp/x`, mislabel the trace, and — once T6 starts
// flipping commands to native — route to the wrong implementation.

// valueFlags mirrors the `type: "string"` entries of the `parseArgs` spec at
// `packages/cli/src/main.ts:64-163`. It is a hand-kept copy of another
// language's declaration, so `argv_test.go` re-derives it from that file and
// fails on drift — the same crude-but-effective cross-language check
// `packages/cli/src/scopes.test.ts` already runs against `auth-core`, and for
// the same reason: nothing else notices when one side grows a flag.
var valueFlags = map[string]bool{
	// ---- connection / identity ----
	"db": true, "base": true, "url": true, "token": true, "tenant": true,
	"name": true, "password": true, "scopes": true, "account": true,
	"from": true, "principal": true, "blobs": true, "mailbox": true,
	"parent": true, "sort": true, "book": true,
	// ---- compose ----
	"to": true, "cc": true, "bcc": true, "subject": true, "file": true,
	"body": true, "expandMD": true, "linkMax": true, "linkTTL": true,
	// ---- identity (sVOL 006) ----
	"text": true, "html": true, "reply-to": true, "identity": true,
	"config": true,
	// ---- fleet host (s11 T8) ----
	"fleet": true,
	// ---- @local ladder (s26 T6): models / local setup|connect ----
	"host": true, "key-env": true,
	// ---- agent dossier verbs (s26 T6): show/budget/model/backfill ----
	"set": true, "explore": true, "since": true, "budget": true,
	// ---- agent invoke (sVOL 007) ----
	"email": true, "note": true, "until": true, "expires": true, "kind": true,
	"secret": true, "secret-env": true, "meta": true, "authorize-url": true,
	"token-url": true, "client-id": true, "client-secret": true,
	"oauth-scopes": true, "port": true,
	// ---- creds mint-time contract (sVOL 020) ----
	"header": true, "scope": true, "enforcement": true, "days": true,
	// ---- calendar CRUD (sVOL 018) ----
	"title": true, "start": true, "duration": true, "tz": true, "rrule": true,
	"calendar": true, "occurrence": true,
	// ---- watch / agent ----
	"sla": true, "allow": true, "reply-mode": true, "exec": true,
	// ---- operator onboarding (`admin extractor on` / `admin byok seal`) ----
	"provider": true, "model": true,
	// ---- the agent config surface (s10 T4, Go-native `agents`) ----
	// Go-native-only commands still declare their value flags on BOTH sides:
	// this map's job is to know where a token ENDS, and a flag missing here
	// makes Command() name a flag's value as the command. main.ts declares
	// them for exactly that reason — there is no `agents` case in its switch.
	"allow-sender": true, "recipients-book": true, "enabled": true,
	"agent": true,
	// ---- the I/O contract's own flags ----
	"if-state": true, "as": true,
	// ---- triage verbs (sVOL 019) ----
	"add": true, "remove": true, "role": true,
	// ---- approvals needs-info (s10 T3) ----
	// `approvals` is Go-native, but the scanner still has to know `--question`
	// takes a value or `bullmoose --question "why?" approvals …` would name the
	// question text as the command. Declared on the TypeScript side too
	// (packages/cli/src/main.ts), because argv_test.go checks BOTH directions.
	"question": true,
	// `--reason` is `--question`'s counterpart on the reject path and was
	// missed when the above was added, so `bullmoose --reason "why" approvals
	// reject <id>` named "why" as the command — the exact failure the comment
	// above describes, one flag over. Found by the flag drift test.
	"reason": true,
	// ---- paging ----
	"n": true,
}

// ⚠️ `--status` is NOT here, and must not be added.
//
// It is the one flag in the tree whose ARITY depends on the command:
// `approvals --status <filter>` takes a value (cmd/approvals.go), while
// `watch --status` is a boolean (cmd/watch.go). This scanner runs BEFORE the
// command is known — deciding where a token ends is how it finds the command
// in the first place — so there is no answer it can give that is right for
// both. Adding it to valueFlags would make `bullmoose --status watch` swallow
// `watch`; leaving it in booleanFlags means `bullmoose --status pending
// approvals list` names `pending` as the command.
//
// Neither is a bug worth introducing, because both flags work in the position
// people actually use — AFTER the command, where the command's own parser
// owns the grammar. `argv_test.go` pins the collision so this stays a decision
// rather than an oversight, and so that "fixing" one side has to confront the
// other. If the pre-command position is ever needed, the fix is to rename one
// of them, not to teach this map a lie.

// booleanFlags mirrors the `type: "boolean"` entries of the same spec. Command()
// does not need it — a boolean consumes no token, so skipping it is already
// right — but help.go does: to answer "would parseArgs accept this argv?" it has
// to tell a flag that exists and takes nothing from a flag that does not exist
// at all. `argv_test.go` diffs it against main.ts in both directions, exactly as
// it does valueFlags.
var booleanFlags = map[string]bool{
	"force": true, "yes": true, "include-deleted": true, "clear": true,
	"once": true, "all-day": true, "ics": true, "destroy": true, "raw": true,
	"offline": true, "daemon": true, "status": true, "stop": true,
	"json": true, "ids": true, "dry-run": true, "unset": true, "no-sync": true,
	"help": true, "man": true, "markdown": true,
	// s26 T6 — `agent backfill --request-floor` mints the approval instead of
	// backfilling. Boolean, so the scanner skips it either way; help.go needs
	// it to tell "a flag that takes nothing" from "no such flag".
	"request-floor": true,
}

// shortValueFlags: the spec declares exactly two short options, and only one of
// them takes a value — `-n` (`packages/cli/src/main.ts:159`); `-h` is boolean
// (`:160`). Anything else beginning with `-` is left to consume nothing, which
// is the conservative direction: it can only make Command stop *earlier*, never
// swallow a command name.
var shortValueFlags = map[string]bool{"n": true}

// shortBooleanFlags: `-h`, and only `-h` (`packages/cli/src/main.ts:181`).
var shortBooleanFlags = map[string]string{"h": "help"}

// Command returns the subcommand named in argv, or "" when there is none —
// `bullmoose`, `bullmoose --help`, `bullmoose --json` and friends, all of which
// the Node CLI answers with help (`packages/cli/src/main.ts:184`).
func Command(argv []string) string {
	for i := 0; i < len(argv); i++ {
		arg := argv[i]
		switch {
		case arg == "--":
			// End of options: whatever follows is a positional, even if it
			// looks like a flag.
			if i+1 < len(argv) {
				return argv[i+1]
			}
			return ""

		case strings.HasPrefix(arg, "--"):
			name, _, inline := strings.Cut(strings.TrimPrefix(arg, "--"), "=")
			if !inline && valueFlags[name] {
				i++ // `--db /tmp/x` — the next token is the value, not the command
			}

		case len(arg) > 1 && strings.HasPrefix(arg, "-"):
			if shortValueFlags[strings.TrimPrefix(arg, "-")] {
				i++
			}

		default:
			// A bare `-` lands here, which is right: it is a positional meaning
			// stdin (`arch.md` §1.4), never a command, but it is also never
			// positionals[0] in practice — and answering `-` is still more
			// honest than skipping it and naming the next token.
			return arg
		}
	}
	return ""
}
