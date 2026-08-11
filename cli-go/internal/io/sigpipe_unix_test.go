//go:build unix

package bmio

import (
	"bufio"
	"os"
	"os/exec"
	"syscall"
	"testing"
)

// TestWithoutGuardGoWouldDieOfSigpipe is the bite for InstallSIGPIPE: it proves
// the guard is what changes the disposition, not something incidental. The SAME
// flood, closed the SAME way, but with no InstallSIGPIPE, must die by SIGPIPE —
// Go's default for a write to a broken fd 1 (os/signal docs). If this ever
// stopped being signalled, the clean-exit test above would be passing for a
// reason other than the guard, and the guard could be deleted unnoticed.
//
// `sh` reports 141 for a SIGPIPE death, so `$?` is identical to the guarded
// case at the shell (io.ts:287 and delegate/signal_unix.go both note this); the
// difference is only visible in the raw wait status, which is what this asserts.
func TestWithoutGuardGoWouldDieOfSigpipe(t *testing.T) {
	cmd := exec.Command(testExe)
	cmd.Env = append(os.Environ(), envSelftest+"=flood-unguarded")
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	line, readErr := bufio.NewReader(stdout).ReadString('\n')
	if readErr != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		t.Fatalf("did not read the child's first record: %v", readErr)
	}
	_ = line
	if err := stdout.Close(); err != nil {
		t.Fatalf("closing the read end: %v", err)
	}

	_ = cmd.Wait()
	st := cmd.ProcessState
	if st == nil {
		t.Fatal("no process state")
	}
	ws, ok := st.Sys().(syscall.WaitStatus)
	if !ok {
		t.Fatalf("no wait status")
	}
	if !ws.Signaled() || ws.Signal() != syscall.SIGPIPE {
		t.Errorf("unguarded flood exited with %v (signaled=%v); want death by SIGPIPE — "+
			"if this is no longer signalled, InstallSIGPIPE is not what makes the guarded case exit 0",
			st, ws.Signaled())
	}
}
