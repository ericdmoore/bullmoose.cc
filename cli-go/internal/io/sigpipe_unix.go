//go:build unix

package bmio

import (
	"os/signal"
	"syscall"
)

// syscallEPIPE is the errno a write to a broken pipe returns, as an error value
// errors.Is can match (IsBrokenPipe, emit.go). syscall.Errno implements error.
var syscallEPIPE error = syscall.EPIPE

// InstallSIGPIPE is the Go equivalent of io.ts:287 installEpipeGuard — the load
// that lets `bullmoose log | head -3` exit 0 instead of dying.
//
// Go's default for a write to a broken stdout/stderr (fd 1 or 2) is to kill the
// process with SIGPIPE — exit 141 (os/signal package docs). That is a different
// disposition than io.ts's clean exit 0. signal.Ignore takes SIGPIPE off the
// runtime's default handler, so the write instead returns EPIPE to Streams.write
// (emit.go), which recognises it and exits 0. Without this the guard in
// Streams.write could never run: the process would already be dying.
//
// Idempotent. s08 T6 calls it once from main before any output; T5 only proves
// it, in main_test.go, against a real closed pipe.
func InstallSIGPIPE() {
	signal.Ignore(syscall.SIGPIPE)
}
