// Package delegate is the strangler seam (`.plans/s08-go-cli/arch.md` §4).
//
// The Go binary is the front door. Anything not yet implemented natively execs
// the Node CLI with the same argv, and the only thing this package parses is
// enough of argv to name the subcommand.
package delegate

import "os"

// native holds the commands this binary serves itself.
//
// Empty at T2, deliberately: every command delegates, which is exactly why
// `packages/cli/smoke/contract.mjs` passes 61/61 on day one (`arch.md` §3). T6
// flips entries in here one at a time (`devPlan.md:121`), each flip moving one
// invocation from `delegated` to `native` in the trace, and the contract suite
// stays at 61/61 throughout. Zero `delegated` for the shipped set is T6's
// done-when; a release with zero is what licenses deleting the Node CLI
// (`devPlan.md:132`).
var native = map[string]func(argv []string) int{}

// Dispatch routes one invocation and returns the process exit code.
//
// It may not return at all: when the delegate dies by a signal, Run re-raises
// that signal here so the parent reports the child's disposition rather than
// its own (`arch.md` §4).
func Dispatch(argv []string) int {
	command := Command(argv)

	if run, ok := native[command]; ok {
		Trace(os.Stderr, "native", command)
		return run(argv)
	}

	Trace(os.Stderr, "delegated", command)
	return Run(argv)
}
