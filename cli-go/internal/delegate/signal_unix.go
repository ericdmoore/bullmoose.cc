//go:build unix

package delegate

import (
	"os/signal"
	"syscall"
	"time"
)

// raise makes this process die the way the delegate died.
//
// `arch.md` §4: "the parent reports the child's disposition rather than its
// own". Exiting 128+N would give the same `$?` in a shell, but not the same
// wait status: a supervisor asking WIFSIGNALED, or a `sh` deciding whether to
// print "Broken pipe", would see an ordinary exit where there was a signal.
// The contract suite drives everything through a real `sh`
// (`packages/cli/smoke/contract.mjs:51`), so this is the disposition it sees.
// SIGPIPE is the one exception, and it is measured rather than assumed: the Go
// runtime installs its own SIGPIPE handler and ignores a kill(2)-delivered one
// (it only dies for a write to a broken fd 1 or 2), so signal.Reset does not
// restore SIG_DFL and this falls through to the 128+13 below. Nothing observable
// is lost: `sh` reports 141 for a SIGPIPE death anyway, so `$?` is identical, and
// the CLI turns a broken pipe into a clean exit 0 long before it could die of one
// (`packages/cli/src/io.ts:287`, installEpipeGuard — §1.2 "EPIPE is not an
// error"). What a supervisor reading the raw wait status loses is WIFSIGNALED,
// for the one signal the CLI is built never to die from.
func raise(sig syscall.Signal) int {
	// Put the default disposition back first — while Notify is in force the
	// signal would be delivered to a channel nobody is reading any more.
	signal.Reset(sig)
	if err := syscall.Kill(syscall.Getpid(), sig); err == nil {
		// kill(2) delivers an unblocked signal before it returns, so execution
		// normally stops on the line above. Reaching here means the signal was
		// ignored or blocked; wait a beat rather than racing the kernel to the
		// fallback.
		time.Sleep(50 * time.Millisecond)
	}
	// The shell's convention, and what `sh` would have reported for us anyway.
	return 128 + int(sig)
}
