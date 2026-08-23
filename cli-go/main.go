// Command bullmoose is the bullmoose CLI.
//
// It began as a strangler front door (s08 T2): a Go binary that implemented
// nothing and delegated everything to the TypeScript CLI, flipping commands
// native wave by wave while a 75-case contract suite held both binaries to
// the same behaviour. The port completed with s43 (the agent daemon), the
// delegation count reached zero, and the Node CLI and the delegate machinery
// were removed together — this binary is no longer a front door to anything;
// it is the CLI.
//
// What remains of the strangler era is the part that was always load-bearing:
// internal/cmd's Route (command identification, help routing, and the flag
// guard that refuses rather than silently ignores a flag a command does not
// own), and the drift tests that keep each command's grammar, help page and
// registry entry from diverging — they caught real bugs in every wave and
// they outlive the port.
package main

import (
	"os"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/cmd"
	bmio "github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
)

func main() {
	// §1.2, before any output: every write may hit a pipe a `| head` already
	// closed, and the guard lets that exit 0 instead of dying on SIGPIPE.
	bmio.InstallSIGPIPE()
	os.Exit(cmd.Route(os.Args[1:]))
}
