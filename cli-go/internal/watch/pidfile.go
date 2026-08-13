package watch

import (
	"os"
	"strconv"
	"strings"
)

// The pidfile trio — watch.ts:367-391. Two files sit beside the mirror, named
// from it, so a `--db` pointing somewhere else gets its own watcher rather than
// fighting over one lock.

// Paths are the daemon's two sidecar files.
type Paths struct {
	Pid string
	Log string
}

// PidPaths is watch.ts:367 pidPaths.
func PidPaths(dbPath string) Paths {
	return Paths{Pid: dbPath + ".watch.pid", Log: dbPath + ".watch.log"}
}

// ReadAlivePid returns the pid in the file if that process is STILL RUNNING, and
// 0 otherwise — watch.ts:371. A stale file (the watcher was killed, or the box
// rebooted) is swept away rather than reported, because the alternative is a
// `watch` that refuses to start for a process that no longer exists and gives
// the operator no hint why.
//
// 0 rather than a *int for "none": a pid of 0 is never a watcher on any
// platform, so the zero value is unambiguous.
func ReadAlivePid(pidFile string) int {
	raw, err := os.ReadFile(pidFile)
	if err != nil {
		return 0
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil || pid <= 0 {
		return 0
	}
	if processAlive(pid) {
		return pid
	}
	_ = os.Remove(pidFile)
	return 0
}

// WritePid records the running watcher — watch.ts:389. Mode 0600: the pid is not
// a secret, but the file lives beside a db that holds a bearer token, and a
// world-writable pidfile is a way to make someone else's `--stop` signal a
// process of your choosing.
func WritePid(pidFile string, pid int) error {
	return os.WriteFile(pidFile, []byte(strconv.Itoa(pid)+"\n"), 0o600)
}
