//go:build unix

package cmd

import "syscall"

// The two platform-specific halves of daemon management.

// detachAttr puts the daemon in its own SESSION. Node gets this from
// `spawn(..., { detached: true })` (main.ts:931); in Go it is Setsid, and it is
// what stops a Ctrl-C in the launching terminal from killing the watcher through
// the foreground process group.
func detachAttr() *syscall.SysProcAttr { return &syscall.SysProcAttr{Setsid: true} }

// terminate asks a running watcher to stop — `process.kill(pid, "SIGTERM")`
// (main.ts:895). SIGTERM, never SIGKILL: the watcher's handler closes its
// sockets and removes its pidfile, and a killed watcher would leave a stale one.
func terminate(pid int) error { return syscall.Kill(pid, syscall.SIGTERM) }
