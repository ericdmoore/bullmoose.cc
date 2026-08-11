package cmd

import (
	"strings"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
)

// args is the parsed view a native command needs. It is intentionally NARROW:
// delegate.Dispatch only routes an invocation here when every flag it carries is
// one this set understands (delegate/native.go ownedNatively), so this parser
// never has to reject an unknown flag or render help — those went to Node. That
// keeps the whole flag grammar and the help system (packages/cli/src/help.ts,
// ~1k lines) on the TypeScript side until a later wave.
type args struct {
	JSON        bool
	IDs         bool
	DB          string
	Account     string
	Mailbox     string
	N           string // -n / --n, default "20" as main.ts:159
	Positionals []string
}

// ownedValue mirrors the value-taking subset of main.ts:64-163 that the wave-1
// commands actually read. Kept in lockstep with delegate's ownedNatively guard:
// a flag parsed here as value-taking must also be skipped there, or the two
// disagree about where a token ends.
var ownedValue = map[string]bool{"db": true, "account": true, "mailbox": true, "n": true}

// parse walks argv the way node:util parseArgs (main.ts:65) would for this
// narrow flag set: `--flag value`, `--flag=value`, `-n value`, booleans, and a
// `--` end-of-options marker. Positionals[0] is the command name (main.ts:183).
func parse(argv []string) args {
	a := args{N: "20"} // main.ts:159 default
	endOpts := false
	for i := 0; i < len(argv); i++ {
		arg := argv[i]
		switch {
		case endOpts:
			a.Positionals = append(a.Positionals, arg)

		case arg == "--":
			endOpts = true

		case strings.HasPrefix(arg, "--"):
			name, inlineVal, inline := strings.Cut(strings.TrimPrefix(arg, "--"), "=")
			value := func() string {
				if inline {
					return inlineVal
				}
				if i+1 < len(argv) {
					i++
					return argv[i]
				}
				return ""
			}
			switch name {
			case "json":
				a.JSON = true
			case "ids":
				a.IDs = true
			case "db":
				a.DB = value()
			case "account":
				a.Account = value()
			case "mailbox":
				a.Mailbox = value()
			case "n":
				a.N = value()
			}

		case arg == "-n":
			if i+1 < len(argv) {
				i++
				a.N = argv[i]
			}

		default:
			// A positional, including a bare "-" (stdin marker, arch.md §1.4).
			a.Positionals = append(a.Positionals, arg)
		}
	}
	return a
}

// die is the one exit path, io.ts:436: `error: <message>` on stderr, and the
// code the §1.5 table maps the error to (bmio.ExitCodeFor). A CliError carries
// its own code (usage → 2, notFound → 3); anything else falls to 1.
func die(s *bmio.Streams, err error) int {
	s.Note("error: " + bmio.ErrorMessage(err))
	return int(bmio.ExitCodeFor(err))
}
