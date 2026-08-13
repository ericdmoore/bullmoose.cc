//go:build !unix

package cmd

import (
	"os"
	"syscall"
)

// Daemon management where there is no session concept and no kill(2). Windows
// ships from T7 only if it is wanted (devPlan.md:129); until then this keeps the
// module cross-compiling, which is the point of the Go port in the first place.

// detachAttr: nothing to set. A Windows child is not in the parent's process
// group to begin with, so it survives the parent exiting.
func detachAttr() *syscall.SysProcAttr { return nil }

// terminate falls back to an unconditional kill, because Windows has no SIGTERM
// to deliver. The watcher therefore does NOT get to clean up its own pidfile
// there; ReadAlivePid's stale-file sweep is what covers that.
func terminate(pid int) error {
	p, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return p.Kill()
}
