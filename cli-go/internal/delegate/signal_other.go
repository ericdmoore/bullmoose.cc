//go:build !unix

package delegate

import "syscall"

// raise, where processes cannot be signalled. Windows has no execve and no
// kill(2), so the best available report of a signalled child is the shell's
// 128+N convention. T7 (`devPlan.md:129`) decides whether windows ships at all.
func raise(sig syscall.Signal) int {
	return 128 + int(sig)
}
