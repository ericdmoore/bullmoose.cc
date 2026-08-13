//go:build !unix

package watch

import "os"

// processAlive where there is no signal 0. os.FindProcess succeeds
// unconditionally on Unix but actually opens a handle on Windows, so it IS a
// liveness probe there — which is why this file is the non-unix half rather than
// the shared implementation.
func processAlive(pid int) bool {
	p, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	_ = p.Release()
	return true
}
