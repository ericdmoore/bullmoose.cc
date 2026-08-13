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
	// ---- paging ----
	"n": true,
}

// shortValueFlags: the spec declares exactly two short options, and only one of
// them takes a value — `-n` (`packages/cli/src/main.ts:159`); `-h` is boolean
// (`:160`). Anything else beginning with `-` is left to consume nothing, which
// is the conservative direction: it can only make Command stop *earlier*, never
// swallow a command name.
var shortValueFlags = map[string]bool{"n": true}

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
