//go:build !unix

package bmio

import "syscall"

// syscallEPIPE is the broken-pipe errno as an error value (IsBrokenPipe,
// emit.go). Windows' syscall package defines EPIPE too, so the same match works.
var syscallEPIPE error = syscall.EPIPE

// InstallSIGPIPE is a no-op where there is no SIGPIPE. Windows has no such
// signal (delegate/signal_other.go makes the same point); a broken pipe there
// surfaces directly as a write error, which Streams.write (emit.go) already
// turns into a clean exit 0. T7 (devPlan.md:129) decides whether windows ships.
func InstallSIGPIPE() {}
