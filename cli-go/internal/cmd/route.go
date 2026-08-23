package cmd

// The front door — what survived internal/delegate's demolition (s08 T7's
// last act: the Node CLI and the delegate died in one PR, soak waived by the
// only user).
//
// The delegate's job was a ROUTING DECISION: native or Node. With Node gone
// the decision is gone, but three of its duties outlive it unchanged, moved
// here rather than rewritten:
//
//	COMMAND IDENTIFICATION — parse argv only far enough to learn which
//	command was named. `bullmoose --db /tmp/x log` names `log`, not
//	`/tmp/x`, so the scanner must know every value-taking flag's arity.
//
//	HELP ROUTING — `bullmoose log --help` is a help invocation whose command
//	is `log`, resolved BEFORE any command runs (main.ts:205 made the same
//	call before its switch). Every help byte comes from the embedded
//	artifact.
//
//	THE FLAG GUARD — a flag the named command's implementation does not own.
//	The delegate sent these to Node so parse-error bytes stayed Node's
//	("under-inclusion is the safe direction"); with no Node to own them, the
//	refusal is OURS: exit 2, the flag named, no stack. The guard's premise —
//	never run a native path that silently ignores a flag the user typed —
//	is unchanged; only the refusal's author moved.
//
// What did NOT survive: exec/discovery of bullmoose.mjs, signal re-raising
// for the child (there is no child), and BULLMOOSE_TRACE — the port's
// progress instrument, retired with the port at 100%.

import (
	"strings"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/help"
	bmio "github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
)

// valueFlags is every value-taking long option in the CLI's vocabulary. Its
// job is to know where a token ENDS: a flag missing here makes commandOf name
// a flag's value as the command. Once a hand-kept mirror of main.ts's
// parseArgs spec (argv_test diffed the two), it is now self-authoritative —
// the per-command registry lists remain drift-checked against each parser's
// own AST and the help spec (parsergrammar_test.go), which is where a stale
// entry actually bites.
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
	// ---- agents budget/model, session plane (agenteconomics.go) ----
	"rate": true, "default": true,
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
	// ---- the agent config surface (s10 T4, `agents`) ----
	"allow-sender": true, "recipients-book": true, "enabled": true,
	"agent": true,
	// ---- the I/O contract's own flags ----
	"if-state": true, "as": true,
	// ---- triage verbs (sVOL 019) ----
	"add": true, "remove": true, "role": true,
	// ---- approvals needs-info (s10 T3) ----
	"question": true, "reason": true,
	// ---- cloud plan (s46 T2) ----
	"zone": true, "stack-version": true, "stack-base": true,
	// ---- paging ----
	"n": true,
}

// ⚠️ `--status` is NOT here, and must not be added.
//
// It is the one flag in the tree whose ARITY depends on the command:
// `approvals --status <filter>` takes a value (approvals.go), while
// `watch --status` is a boolean (watch.go). This scanner runs BEFORE the
// command is known — deciding where a token ends is how it finds the command
// in the first place — so there is no answer it can give that is right for
// both. Both flags work in the position people actually use — AFTER the
// command, where the command's own parser owns the grammar. route_test.go
// pins the collision so this stays a decision rather than an oversight.

// booleanFlags is every boolean long option. commandOf does not need it — a
// boolean consumes no token, so skipping it is already right — but the help
// and refusal paths do: to tell a flag that exists and takes nothing from a
// flag that does not exist at all.
var booleanFlags = map[string]bool{
	"force": true, "yes": true, "include-deleted": true, "clear": true,
	"once": true, "all-day": true, "ics": true, "destroy": true, "raw": true,
	"offline": true, "daemon": true, "status": true, "stop": true,
	"json": true, "ids": true, "dry-run": true, "unset": true, "no-sync": true,
	"help": true, "man": true, "markdown": true,
	"request-floor": true,
}

// shortValueFlags: exactly two short options exist, and only one takes a
// value — `-n`; `-h` is boolean. Anything else beginning with `-` consumes
// nothing, the conservative direction: it can only make commandOf stop
// EARLIER, never swallow a command name.
var shortValueFlags = map[string]bool{"n": true}

// shortBooleanFlags: `-h`, and only `-h`.
var shortBooleanFlags = map[string]string{"h": "help"}

// commandOf returns the subcommand named in argv, or "" when there is none —
// `bullmoose`, `bullmoose --help`, `bullmoose --json` and friends, all
// answered with help.
func commandOf(argv []string) string {
	for i := 0; i < len(argv); i++ {
		arg := argv[i]
		switch {
		case arg == "--":
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
			// stdin (§1.4), never a command in practice — and answering `-` is
			// still more honest than skipping it and naming the next token.
			return arg
		}
	}
	return ""
}

// parsed is the global scan's result. refusal, when set, is the parse error
// in the CLI's own words — the strings that used to be Node's parse_args.js
// (version-specific down to an unbalanced quote) and are now simply ours.
type parsed struct {
	ok          bool
	refusal     string
	positionals []string
	help        bool
	json        bool
	man         bool
	markdown    bool
}

// parseGlobal answers "is this argv well-formed against the global
// vocabulary, and what did it say?".
func parseGlobal(argv []string) parsed {
	p := parsed{ok: true}
	refuse := func(msg string) parsed {
		p.ok, p.refusal = false, msg
		return p
	}
	for i := 0; i < len(argv); i++ {
		arg := argv[i]
		switch {
		case arg == "--":
			p.positionals = append(p.positionals, argv[i+1:]...)
			return p
		case strings.HasPrefix(arg, "--"):
			name, _, inline := strings.Cut(strings.TrimPrefix(arg, "--"), "=")
			switch {
			case valueFlags[name]:
				if !inline {
					if !takesNextToken(argv, i) {
						return refuse("option '--" + name + "' needs a value")
					}
					i++
				}
			case booleanFlags[name]:
				if inline {
					return refuse("option '--" + name + "' does not take a value")
				}
				markGlobal(&p, name)
			default:
				return refuse("unknown option '--" + name + "'")
			}
		case len(arg) > 1 && strings.HasPrefix(arg, "-"):
			short := strings.TrimPrefix(arg, "-")
			switch {
			case shortValueFlags[short]:
				if !takesNextToken(argv, i) {
					return refuse("option '-" + short + "' needs a value")
				}
				i++
			case shortBooleanFlags[short] != "":
				markGlobal(&p, shortBooleanFlags[short])
			default:
				// `-x`, `-abc`, `-n5`: short groups and attached values were
				// never part of this CLI's grammar (`-n 100`, spelled out, is).
				return refuse("unknown option '-" + short + "' (the short options are -n <count> and -h)")
			}
		default:
			p.positionals = append(p.positionals, arg)
		}
	}
	return p
}

func markGlobal(p *parsed, name string) {
	switch name {
	case "help":
		p.help = true
	case "json":
		p.json = true
	case "man":
		p.man = true
	case "markdown":
		p.markdown = true
	}
}

// takesNextToken reports whether argv[i+1] can serve as the value of the
// option at argv[i]. A bare "-" IS a legal value (`mailbox move X --parent -`
// is how you say "top level"), so the ambiguity rule is "starts with - AND is
// longer than one character".
func takesNextToken(argv []string, i int) bool {
	if i+1 >= len(argv) {
		return false
	}
	next := argv[i+1]
	return !(len(next) > 1 && strings.HasPrefix(next, "-"))
}

// helpRequest resolves argv into a help invocation, or reports that it is not
// one. A transcription of main.ts:205-237's branches, and of nothing else:
// every byte it eventually prints comes from the artifact.
func helpRequest(argv []string) (help.Request, bool) {
	p := parseGlobal(argv)
	if !p.ok {
		return help.Request{}, false // the parse refusal outranks help
	}
	command := ""
	if len(p.positionals) > 0 {
		command = p.positionals[0]
	}
	if command != "help" && !p.help && command != "" {
		return help.Request{}, false
	}
	// `bullmoose <cmd> --help` takes its topic from the command position;
	// `bullmoose help <cmd>` from the one after. Which is why `bullmoose help
	// --help` is the OVERVIEW and not the `help` command's page.
	topic := ""
	if command != "" && command != "help" {
		topic = command
	} else if len(p.positionals) > 1 {
		topic = p.positionals[1]
	}
	switch {
	case p.json:
		return help.Request{Mode: help.JSON}, true
	case p.man:
		return help.Request{Mode: help.Man}, true
	case p.markdown:
		return help.Request{Mode: help.Markdown}, true
	case topic != "":
		return help.Request{Mode: help.Topic, Topic: topic}, true
	case p.help || command == "help":
		return help.Request{Mode: help.Overview}, true
	default:
		// No command at all: the overview as chrome, exit 2.
		return help.Request{Mode: help.OverviewUsage}, true
	}
}

// unownedFlag names the first flag in argv the command's implementation does
// not own, "" when every flag is owned. The delegate's ownedNatively with the
// verdict inverted into a name: the premise — never run a native path that
// silently ignores a flag the user typed (on `send` that means mail leaving
// under the wrong assumptions) — survives its author.
func unownedFlag(argv []string, s spec) string {
	value, boolean, short := set(s.value), set(s.boolean), set(s.short)
	for i := 0; i < len(argv); i++ {
		arg := argv[i]
		switch {
		case arg == "--":
			return ""
		case strings.HasPrefix(arg, "--"):
			name, _, inline := strings.Cut(strings.TrimPrefix(arg, "--"), "=")
			switch {
			case value[name]:
				if !inline {
					if !takesNextToken(argv, i) {
						return "--" + name // owned, but valueless — refuse by name
					}
					i++
				}
			case boolean[name]:
				if inline {
					return "--" + name // `--json=x`
				}
			default:
				return "--" + name
			}
		case len(arg) > 1 && strings.HasPrefix(arg, "-"):
			shortName := strings.TrimPrefix(arg, "-")
			if !short[shortName] {
				return arg
			}
			if !takesNextToken(argv, i) {
				return arg
			}
			i++
		}
	}
	return ""
}

func set(names []string) map[string]bool {
	m := make(map[string]bool, len(names))
	for _, n := range names {
		m[n] = true
	}
	return m
}

// Route is the CLI's whole dispatch: help, refusals, then the command.
// Order preserved from the delegate era, because each step's position was
// load-bearing there and stays so:
//
//  1. a Go-NATIVE-ONLY command first — it has no help page in the artifact,
//     so it answers its own `--help` rather than being told it does not exist;
//  2. help, resolved before any command runs;
//  3. the global parse refusal — a malformed argv is answered before the
//     command it half-names;
//  4. the command, behind its flag guard;
//  5. `unknown command: x`, rendered from the embedded spec.
func Route(argv []string) int { return routeTo(bmio.New(), argv) }

// routeTo is Route against explicit streams — the test seam, and the one
// place every branch shares a Streams so a broken pipe mid-help exits 0
// exactly as it does mid-command.
func routeTo(streams *bmio.Streams, argv []string) int {
	command := commandOf(argv)

	if s, ok := registry[command]; ok && s.goNative {
		return s.run(streams, argv)
	}
	if req, ok := helpRequest(argv); ok {
		return help.Serve(streams, req)
	}
	if p := parseGlobal(argv); !p.ok {
		streams.Note("error: " + p.refusal)
		streams.Note("see `bullmoose help` for the command list, or `bullmoose help <command>` for one command's flags")
		return int(bmio.ExitUsage)
	}
	if s, ok := registry[command]; ok {
		if flag := unownedFlag(argv, s); flag != "" {
			streams.Note("error: " + flag + " is not a flag of `bullmoose " + command + "` — see `bullmoose help " + command + "`")
			return int(bmio.ExitUsage)
		}
		return s.run(streams, argv)
	}
	return help.Serve(streams, help.Request{Mode: help.UnknownCommand, Topic: command})
}
