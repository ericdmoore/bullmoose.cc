package delegate

import (
	"strings"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/help"
)

// Routing for the two things that are rendered entirely out of the help spec:
// every help invocation, and `unknown command: x`.
//
// This lives beside the router rather than in a command, because help is not a
// command — `bullmoose log --help` is a help invocation whose command is `log`,
// and main.ts:205 makes exactly that call BEFORE its switch, before it even
// opens the database. The Go front door has to make the same call in the same
// place or `--help` would reach a native command that does not know the flag.
//
// What stays with Node, deliberately: an argv `node:util`'s parseArgs REFUSES.
// main.ts parses first and prints the parse error instead of help
// (`bullmoose help --no-such-flag` is a usage error, not the overview), and
// those strings are Node's own — `Unknown option '--x'. To specify a positional
// argument…` is parse_args.js's text, version-specific down to its unbalanced
// closing quote. Reproducing it would mean porting parseArgs' strict mode and
// pinning a Node internal in Go source; delegating means Node keeps printing it,
// which is the same reason ownedNatively declines what parseArgs refuses
// (native.go, TestOwnedNativelyRefusesWhatParseArgsRefuses).

// parsed is as much of main.ts's parseArgs result as the help block reads.
type parsed struct {
	// ok is false when parseArgs would THROW on this argv — an unknown flag, a
	// value flag with no value, a boolean with `=`, a short option that is not
	// one of the two declared. False means "delegate": Node owns the refusal.
	ok          bool
	positionals []string
	help        bool
	json        bool
	man         bool
	markdown    bool
}

// parseGlobal answers "would parseArgs accept this, and what did it see?".
//
// It is deliberately UNDER-inclusive: anything it is not certain about (short
// option groups, `-n5`, a short flag it does not know) comes back ok=false and
// delegates. Under-inclusion costs a process spawn on an exotic invocation;
// over-inclusion would print help for an argv the Node CLI rejects, which is a
// different answer, not a slower one.
func parseGlobal(argv []string) parsed {
	p := parsed{ok: true}
	for i := 0; i < len(argv); i++ {
		arg := argv[i]
		switch {
		case arg == "--":
			// End of options: everything after is a positional, even `--json`.
			p.positionals = append(p.positionals, argv[i+1:]...)
			return p

		case strings.HasPrefix(arg, "--"):
			name, _, inline := strings.Cut(strings.TrimPrefix(arg, "--"), "=")
			switch {
			case valueFlags[name]:
				if !inline {
					if !takesNextToken(argv, i) {
						p.ok = false // "argument missing" / "argument is ambiguous"
						return p
					}
					i++
				}
			case booleanFlags[name]:
				if inline {
					p.ok = false // "Option '--json' does not take an argument"
					return p
				}
				markGlobal(&p, name)
			default:
				p.ok = false // "Unknown option '--x'"
				return p
			}

		case len(arg) > 1 && strings.HasPrefix(arg, "-"):
			short := strings.TrimPrefix(arg, "-")
			switch {
			case shortValueFlags[short]:
				if !takesNextToken(argv, i) {
					p.ok = false
					return p
				}
				i++
			case shortBooleanFlags[short] != "":
				markGlobal(&p, shortBooleanFlags[short])
			default:
				// `-x`, `-abc`, `-n5`: parseArgs has rules for short groups and
				// attached values that this scanner does not model. Hand it over.
				p.ok = false
				return p
			}

		default:
			// A positional, including a bare `-` (stdin, §1.4) and the empty
			// string — which is falsy in main.ts, so `bullmoose ""` is the
			// no-command case, and lands there here too.
			p.positionals = append(p.positionals, arg)
		}
	}
	return p
}

// markGlobal records the four booleans the help block branches on.
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

// helpRequest resolves argv into a help invocation, or reports that it is not
// one. It is a transcription of main.ts:205-237's branches, and of nothing else:
// every byte it eventually prints comes from the artifact.
func helpRequest(argv []string) (help.Request, bool) {
	p := parseGlobal(argv)
	if !p.ok {
		return help.Request{}, false
	}
	command := ""
	if len(p.positionals) > 0 {
		command = p.positionals[0]
	}
	// main.ts:205 — `command === "help" || opts.help || !command`.
	if command != "help" && !p.help && command != "" {
		return help.Request{}, false
	}

	// main.ts:209 — `bullmoose <cmd> --help` takes its topic from the command
	// position; `bullmoose help <cmd>` from the one after. Which is why
	// `bullmoose help --help` is the OVERVIEW and not the `help` command's page:
	// it has no second positional. The generator pins both.
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
		// No command at all: the overview as chrome, exit 2 (main.ts:236).
		return help.Request{Mode: help.OverviewUsage}, true
	}
}

// unknownCommand reports whether argv names a command the Node CLI does not
// have — main.ts's switch default, which prints `unknown command: x` and the
// overview and exits 2.
//
// Answering it here rather than exec'ing Node to be told the same thing is what
// makes a typo survivable on a host with no Node. The command set comes from the
// embedded spec, so this can only be wrong if the artifact is stale — the case
// the drift checks exist for.
//
// One accepted divergence: main.ts opens (and CREATES) the mirror at :253 before
// it reaches the switch, so `bullmoose nosuchcommand` on a fresh machine leaves a
// mail.db behind and, if the path is unwritable, dies with an uncaught ENOENT
// and exit 7 instead of the §1.5 usage code. The native answer does neither: it
// is exit 2 with the documented bytes and no side effect on a typo.
func unknownCommand(argv []string) (string, bool) {
	command := Command(argv)
	if command == "" || command == "help" || help.HasCommand(command) {
		return "", false
	}
	if _, isNative := native[command]; isNative {
		return "", false // a Go-native-only command; Node's not having it is the point
	}
	if !parseGlobal(argv).ok {
		return "", false // parseArgs refuses it first, and its message is Node's
	}
	return command, true
}
