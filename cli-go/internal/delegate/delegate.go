// Package delegate is the strangler seam (`.plans/s08-go-cli/arch.md` §4).
//
// The Go binary is the front door. Anything not yet implemented natively execs
// the Node CLI with the same argv, and the only thing this package parses is
// enough of argv to name the subcommand.
package delegate

import (
	"os"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/help"
	bmio "github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
)

// native holds the commands this binary serves itself.
//
// Empty at T2, deliberately: every command delegates, which is exactly why
// `packages/cli/smoke/contract.mjs` passes 61/61 on day one (`arch.md` §3). T6
// fills it via Register (from cmd.Install in main.go), one wave at a time
// (`devPlan.md:121`), each flip moving one invocation from `delegated` to
// `native` in the trace while the contract suite stays at 61/61. Zero
// `delegated` for the shipped set is T6's done-when; a release with zero is what
// licenses deleting the Node CLI (`devPlan.md:132`).
var native = map[string]func(argv []string) int{}

// Dispatch routes one invocation and returns the process exit code.
//
// A PORTED native command (one that shadows a TypeScript command) serves the
// invocation only when its argv is one the native commands fully own
// (ownedNatively, native.go): help and unowned/unknown flags still go to Node, so
// those paths stay byte-identical. That guard exists to preserve byte-identity
// against a Node twin.
//
// A GO-NATIVE-ONLY command (nativeOnly, native.go) has no Node twin, so there is
// nothing to be byte-identical to and nothing to delegate to — `approvals` (s08,
// the first strictly-more-capable command) is the case. It runs native
// unconditionally; delegating it would hit "command not found" in the Node CLI.
//
// HELP is routed before either, and for the same reason main.ts:205 checks it
// before its switch and before it opens the database: `bullmoose log --help` is a
// help invocation whose command is `log`, so a router that dispatched on the
// command alone would hand `--help` to a native command that does not know it.
// Its bytes come from an embedded artifact of Node's own output (internal/help),
// so byte-identity there is structural rather than asserted. An argv parseArgs
// would REFUSE is not a help invocation and still delegates — Node owns those
// messages (help.go).
//
// Dispatch may not return at all: when the delegate dies by a signal, Run
// re-raises that signal here so the parent reports the child's disposition rather
// than its own (`arch.md` §4).
func Dispatch(argv []string) int {
	command := Command(argv)

	// A Go-native-only command has no Node twin and therefore no help page in
	// the spec either, so it answers its own `--help` rather than being told it
	// does not exist. First, as before.
	if run, ok := native[command]; ok && nativeOnly[command] {
		Trace(os.Stderr, "native", command)
		return run(argv)
	}

	if req, ok := helpRequest(argv); ok {
		Trace(os.Stderr, "native", command)
		return help.Serve(bmio.New(), req)
	}

	if run, ok := native[command]; ok && ownedNatively(argv) {
		Trace(os.Stderr, "native", command)
		return run(argv)
	}

	// A command neither binary has. Rendered from the same spec, so a typo does
	// not need Node to be answered.
	if name, ok := unknownCommand(argv); ok {
		Trace(os.Stderr, "native", command)
		return help.Serve(bmio.New(), help.Request{Mode: help.UnknownCommand, Topic: name})
	}

	Trace(os.Stderr, "delegated", command)
	return Run(argv)
}
