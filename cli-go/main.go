// Command bullmoose is the Go front door for the bullmoose CLI.
//
// s08 T2 (`.plans/s08-go-cli/devPlan.md:52`): it implements nothing and
// delegates everything to the TypeScript CLI, which is the point. Because every
// command delegates, `packages/cli/smoke/contract.mjs` passes 61/61 against this
// binary from the first commit (`.plans/s08-go-cli/arch.md` §3), and it keeps
// passing as commands migrate — the suite never goes red, it quietly changes
// which implementation it is exercising.
//
// Run the suite against this binary (cli-go is its own module — the repo root
// is npm's, not Go's):
//
//	(cd cli-go && go build -o bin/bullmoose .)
//	BULLMOOSE_CLI_BIN=$PWD/cli-go/bin/bullmoose npm run -w @bullmoose/cli smoke
//
// `BULLMOOSE_TRACE=1` reports `native` or `delegated` per invocation on stderr;
// that split is the port's progress metric, and without it a green contract run
// cannot tell a correct Go implementation from an absent one (arch.md §4).
package main

import (
	"os"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/cmd"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/delegate"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
)

func main() {
	// §1.2, before any output: a native command's every write may hit a pipe a
	// `| head` already closed, and the guard lets that exit 0 instead of dying
	// on SIGPIPE (bmio.InstallSIGPIPE, io.ts:287 installEpipeGuard). No-op for
	// delegated commands — Node installs its own guard in the child.
	bmio.InstallSIGPIPE()

	// Wire the native commands into the delegate's routing map. Derived from
	// cmd's registry so routing, the cli/008 capability table and the per-command
	// owned-flag guard stay one source (cmd.Install). Go-native-only commands
	// (approvals, s08) are also registered as native-only so Dispatch never
	// delegates a command Node does not have.
	cmd.Install(delegate.Register, delegate.RegisterNativeOnly, delegate.RegisterFlags)

	// Dispatch does not always return: a child that died by a signal is
	// reported by re-raising that signal here, so the parent's disposition is
	// the child's (arch.md §4). os.Exit covers the ordinary path.
	os.Exit(delegate.Dispatch(os.Args[1:]))
}
