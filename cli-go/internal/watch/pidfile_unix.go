//go:build unix

package watch

import "syscall"

// processAlive is `process.kill(pid, 0)` (watch.ts:378) — the liveness probe
// that signal 0 exists for: permission and existence are checked, nothing is
// delivered. EPERM counts as ALIVE: the process is there, it just is not ours,
// and treating it as dead would delete a live watcher's pidfile.
func processAlive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || err == syscall.EPERM
}
