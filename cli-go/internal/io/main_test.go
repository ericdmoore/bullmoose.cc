package bmio

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"testing"
)

// The §1.2 broken-pipe guard can only be proven at the process boundary: a
// process cannot observe its own SIGPIPE disposition or exit code
// (packages/cli/src/contract.test.ts:13 makes the same point). And the contract
// suite cannot exercise it on the NATIVE path while every command still
// delegates (arch.md §3) — it drives the Node CLI. So this package proves it in
// isolation, by re-execing the test binary as a flooding writer and closing the
// reader early, exactly the way `bullmoose log | head -1` does.
//
// This is entirely inside the io test binary: no hidden subcommand in the real
// `bullmoose`, no change to main.go, delegate.native, or the trace split. The
// re-exec pattern mirrors delegate/main_test.go's fakeNode.

const envSelftest = "BULLMOOSE_IO_SELFTEST"

var testExe string // this test binary, for re-exec

func TestMain(m *testing.M) {
	// Chosen by env before the suite runs, so the same binary can play the
	// flooding child. argv is untouched, so a stray value cannot trigger it.
	switch os.Getenv(envSelftest) {
	case "flood-guarded":
		floodStdout(true) // InstallSIGPIPE, then write forever — must exit 0
	case "flood-unguarded":
		floodStdout(false) // no guard — Go's runtime must kill it with SIGPIPE
	}

	exe, err := os.Executable()
	if err != nil {
		fmt.Fprintf(os.Stderr, "cannot locate the test binary: %v\n", err)
		os.Exit(1)
	}
	testExe = exe
	os.Exit(m.Run())
}

// floodStdout writes records to real stdout until something stops it. With the
// guard installed, a reader that closed early makes the next write return EPIPE,
// which Streams turns into a clean exit 0 (io.ts:289). Without the guard, Go's
// runtime kills the process with SIGPIPE on that write before Streams can see
// the error (os/signal docs) — which is exactly the disposition the guard
// exists to change. The cap is a safety net: reaching it means no broken pipe
// ever arrived, and code 3 lets a test tell that apart from a clean guarded exit.
func floodStdout(guard bool) {
	if guard {
		InstallSIGPIPE()
	}
	s := New()
	for i := 0; i < 50_000_000; i++ {
		s.Out(fmt.Sprintf("line %d — filler bytes to move the pipe along", i))
	}
	os.Exit(3)
}

// TestBrokenPipeGuardExitsCleanEndToEnd is the headline proof: with the guard,
// `flood | (read one line, close)` exits 0 and leaves no stack trace — the Go
// equivalent of the contract's `log | head -3` case (contract.mjs:104).
func TestBrokenPipeGuardExitsCleanEndToEnd(t *testing.T) {
	code, stderr := runFloodClosingReaderEarly(t, "flood-guarded")

	if code != 0 {
		t.Fatalf("guarded flood into a closed reader exited %d, want 0 (a closed reader is not a failure); stderr:\n%s", code, stderr)
	}
	// io.ts's whole reason for the guard: no ten-line stack trace on stderr
	// (io.ts:279). The Go failure mode would be a panic or a goroutine dump.
	for _, noise := range []string{"panic:", "goroutine ", "runtime error"} {
		if strings.Contains(stderr, noise) {
			t.Errorf("broken pipe leaked %q to stderr:\n%s", noise, stderr)
		}
	}
}

// runFloodClosingReaderEarly starts the flooding child, reads exactly one line,
// closes the read end, and returns the child's exit code and stderr. Closing the
// pipe's read end is the harshest form of the early-close case — `| head -1`.
func runFloodClosingReaderEarly(t *testing.T, mode string) (int, string) {
	t.Helper()
	cmd := exec.Command(testExe)
	cmd.Env = append(os.Environ(), envSelftest+"="+mode)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}

	// Read one line — this also guarantees the child is running and has begun
	// writing, so the close below really lands mid-stream.
	line, readErr := bufio.NewReader(stdout).ReadString('\n')
	if readErr != nil || !strings.HasPrefix(line, "line 0") {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		t.Fatalf("did not read the child's first record (line=%q err=%v)", line, readErr)
	}
	// Close the read end: the child's next write meets a broken pipe.
	if err := stdout.Close(); err != nil {
		t.Fatalf("closing the read end: %v", err)
	}

	_ = cmd.Wait()
	if cmd.ProcessState == nil {
		t.Fatal("no process state for the flooding child")
	}
	return cmd.ProcessState.ExitCode(), stderr.String()
}
