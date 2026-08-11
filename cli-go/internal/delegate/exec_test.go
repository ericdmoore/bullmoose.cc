package delegate

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
)

// TestDelegateInheritsFileDescriptors is the one `arch.md` §4 calls "the single
// easiest way to get a subtly wrong shim that still looks fine interactively".
//
// It asserts identity, not delivery: the child's fd 0/1/2 must be the *same
// files* this test handed the shim. That distinction is the whole test. A
// version of exec.go that wraps them in pipes and pumps bytes across produces
// identical output, passes anything that only greps stdout, and — measured —
// still passes packages/cli/smoke/contract.mjs 61/61, while flipping Node's
// isatty on a terminal and hanging forever on an interactive stdin (see the
// comment on the assignments in exec.go). os.SameFile compares device and
// inode, which a pipe can never satisfy, so this test fails where the contract
// suite cannot.
func TestDelegateInheritsFileDescriptors(t *testing.T) {
	dir := t.TempDir()
	inPath := filepath.Join(dir, "in")
	outPath := filepath.Join(dir, "out")
	errPath := filepath.Join(dir, "err")
	if err := os.WriteFile(inPath, []byte("payload\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	in, err := os.Open(inPath)
	if err != nil {
		t.Fatal(err)
	}
	defer in.Close()
	out, err := os.Create(outPath)
	if err != nil {
		t.Fatal(err)
	}
	defer out.Close()
	errf, err := os.Create(errPath)
	if err != nil {
		t.Fatal(err)
	}
	defer errf.Close()

	cmd := shimCmd(t, "@@stat", "@@stdin")
	cmd.Stdin, cmd.Stdout, cmd.Stderr = in, out, errf
	cmd.Env = append(cmd.Env, envTestFd+"=0="+inPath+";1="+outPath+";2="+errPath)
	if code := exitCodeOf(t, cmd); code != 0 {
		t.Fatalf("exit %d; stderr:\n%s", code, readFile(t, errPath))
	}

	report := readFile(t, outPath)
	for _, fd := range []string{"fd0", "fd1", "fd2"} {
		line := lineWithPrefix(report, fd+" ")
		if line == "" {
			t.Fatalf("%s missing from the child's report:\n%s", fd, report)
		}
		if !strings.Contains(line, "same=true") {
			t.Errorf("%s is not the parent's file — the shim copied the stream instead of inheriting the descriptor: %s", fd, line)
		}
		if !strings.Contains(line, "pipe=false") {
			t.Errorf("%s is a pipe; Node's isatty and framing answer differently through one: %s", fd, line)
		}
	}
	// And the inherited stdin really carries data, so "same file" is not being
	// satisfied by an fd nobody can read.
	if !strings.Contains(report, `stdin "payload\n"`) {
		t.Errorf("stdin did not reach the delegate:\n%s", report)
	}
}

// TestExitCodePropagatedExactly — `arch.md` §4: packages/cli/src/io.ts:96 maps
// every JMAP SetError to a specific code, and scripts branch on them, so the
// shim passes the number through untouched. 42 and 200 are here to catch a
// well-meaning clamp to the §1.5 range.
func TestExitCodePropagatedExactly(t *testing.T) {
	for _, want := range []int{0, 1, 2, 3, 4, 5, 42, 200} {
		cmd := shimCmd(t, "@@exit="+strconv.Itoa(want))
		if got := exitCodeOf(t, cmd); got != want {
			t.Errorf("exit code: want %d, got %d", want, got)
		}
	}
}

// TestChildKilledBySignalDiesTheSameWay — the parent reports the child's
// disposition, not its own: a caller's `wait` should see what it would have
// seen with no shim in the way.
func TestChildKilledBySignalDiesTheSameWay(t *testing.T) {
	for _, name := range []string{"TERM", "INT"} {
		cmd := shimCmd(t, "@@signal="+name)
		_ = cmd.Run()
		st := cmd.ProcessState
		if st == nil {
			t.Fatalf("%s: no process state", name)
		}
		ws, ok := st.Sys().(syscall.WaitStatus)
		if !ok {
			t.Fatalf("%s: no wait status", name)
		}
		if !ws.Signaled() {
			t.Errorf("%s: the shim exited with %d where the delegate was signalled", name, st.ExitCode())
			continue
		}
		if got := ws.Signal(); got != signalNamed(name) {
			t.Errorf("%s: the shim died of %v", name, got)
		}
	}
}

// TestSigpipeDeathReportsTheShellsCode records the one signal Go cannot
// re-raise, so the limitation is a pinned expectation rather than a surprise —
// see signal_unix.go. `sh` reports 141 for a SIGPIPE death too, so `$?` is
// unchanged and the contract suite's early-close cases
// (packages/cli/smoke/contract.mjs:118) cannot tell the difference.
func TestSigpipeDeathReportsTheShellsCode(t *testing.T) {
	cmd := shimCmd(t, "@@signal=PIPE")
	if got := exitCodeOf(t, cmd); got != 128+int(syscall.SIGPIPE) {
		t.Errorf("exit code: want %d, got %d", 128+int(syscall.SIGPIPE), got)
	}
}

// TestSignalsReachTheDelegate — SIGTERM sent to the front door alone (not the
// process group, which is what a terminal ^C would do) must reach the child,
// and the child's chosen exit code must be what the caller sees. 42 rather than
// the 143 this process would have produced by dying itself.
func TestSignalsReachTheDelegate(t *testing.T) {
	cmd := shimCmd(t, "@@onsignal=TERM:42")
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}

	// Wait until the delegate has installed its handler, or a signal sent too
	// early kills it by default and the test proves nothing.
	scan := bufio.NewScanner(stdout)
	if !scan.Scan() || scan.Text() != "ready" {
		_ = cmd.Process.Kill()
		t.Fatalf("delegate never announced itself (%q)", scan.Text())
	}
	if err := cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}

	var caught bool
	for scan.Scan() {
		if strings.Contains(scan.Text(), "child caught TERM") {
			caught = true
		}
	}
	_ = cmd.Wait()
	if !caught {
		t.Error("SIGTERM did not reach the delegate")
	}
	if got := cmd.ProcessState.ExitCode(); got != 42 {
		t.Errorf("exit code: want the delegate's 42, got %d", got)
	}
}

// TestArgvForwardedVerbatim — `arch.md` §4: the shim must not normalise,
// reorder or interpret flags it does not own. The list is deliberately hostile:
// a flag the CLI rejects, `--`, a bare `-`, an empty argument, spaces, unicode,
// and something that looks like a Go flag.
func TestArgvForwardedVerbatim(t *testing.T) {
	args := []string{
		"@@args", "log", "-n", "100", "--json", "--no-such-flag", "--",
		"-", "", "a b", `--if-state=x"y`, "üñî çø∂é", "-test.v",
	}
	cmd := shimCmd(t, args...)
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("%v", err)
	}
	var got []string
	for _, l := range strings.Split(strings.TrimRight(string(out), "\n"), "\n") {
		got = append(got, strings.TrimPrefix(l, "argv "))
	}
	if len(got) != len(args) {
		t.Fatalf("argv length: want %d, got %d\n%s", len(args), len(got), out)
	}
	for i, a := range args {
		if want := fmt.Sprintf("%q", a); got[i] != want {
			t.Errorf("argv[%d]: want %s, got %s", i, want, got[i])
		}
	}
}

// TestMissingNodeCLIIsNamedNotGuessed — `arch.md` §4: "Never a silent fallback
// to 'command not found'."
func TestMissingNodeCLIIsNamedNotGuessed(t *testing.T) {
	cmd := shimCmd(t, "whoami")
	cmd.Env = withoutEnv(cmd.Env, envNodeCLI)
	var stdout, stderr strings.Builder
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	code := exitCodeOf(t, cmd)

	if code != exitFail {
		t.Errorf("exit code: want %d, got %d", exitFail, code)
	}
	if !strings.Contains(stderr.String(), envNodeCLI) {
		t.Errorf("the error must name %s:\n%s", envNodeCLI, stderr.String())
	}
	if !strings.Contains(stderr.String(), cliRelPath) {
		t.Errorf("the error must name the sibling path it tried:\n%s", stderr.String())
	}
	if stdout.String() != "" {
		t.Errorf("a failure of the shim must not write to stdout: %q", stdout.String())
	}
}

// TestBadNodeCLIIsNotSilentlyIgnored — an explicit setting that points nowhere
// is an error, not a fall-through to some other CLI on the box. Delegating to
// an implementation other than the one named is the outcome that would make the
// trace metric lie.
func TestBadNodeCLIIsNotSilentlyIgnored(t *testing.T) {
	cmd := shimCmd(t, "whoami")
	cmd.Env = append(cmd.Env, envNodeCLI+"="+filepath.Join(t.TempDir(), "nope.mjs"))
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if code := exitCodeOf(t, cmd); code != exitFail {
		t.Errorf("exit code: want %d, got %d", exitFail, code)
	}
	if !strings.Contains(stderr.String(), "nope.mjs") {
		t.Errorf("the error must name the path that was set:\n%s", stderr.String())
	}
}

// ───────────────────────────── trace, on stderr ──────────────────────────────

func TestTraceReportsDelegationOnStderr(t *testing.T) {
	cmd := shimCmd(t, "log", "-n", "5", "--json", "@@out=record")
	cmd.Env = append(cmd.Env, envTrace+"=1")
	var stdout, stderr strings.Builder
	cmd.Stdout, cmd.Stderr = &stdout, &stderr

	if code := exitCodeOf(t, cmd); code != 0 {
		t.Fatalf("exit %d: %s", code, stderr.String())
	}
	if want := "bullmoose: delegated log\n"; stderr.String() != want {
		t.Errorf("trace line: want %q, got %q", want, stderr.String())
	}
	// The reason it is on stderr at all: every §1.3 case parses stdout as
	// NDJSON, so one stray byte there would break them all.
	if stdout.String() != "record\n" {
		t.Errorf("trace leaked into stdout: %q", stdout.String())
	}
}

func TestTraceIsSilentByDefault(t *testing.T) {
	cmd := shimCmd(t, "log")
	cmd.Env = withoutEnv(cmd.Env, envTrace)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if code := exitCodeOf(t, cmd); code != 0 {
		t.Fatalf("exit %d", code)
	}
	if stderr.String() != "" {
		t.Errorf("stderr must be silent without %s: %q", envTrace, stderr.String())
	}
}

// TestTraceFileCountsInvocations — the sink T3's progress metric is counted
// from, because the contract suite runs most cases as `$BM … 2>/dev/null`.
func TestTraceFileCountsInvocations(t *testing.T) {
	log := filepath.Join(t.TempDir(), "split.log")
	for _, command := range []string{"log", "mailboxes", "whoami"} {
		cmd := shimCmd(t, command)
		cmd.Env = withoutEnv(cmd.Env, envTrace) // the file sink stands alone
		cmd.Env = append(cmd.Env, envTraceFile+"="+log)
		var stderr strings.Builder
		cmd.Stderr = &stderr
		if code := exitCodeOf(t, cmd); code != 0 {
			t.Fatalf("exit %d: %s", code, stderr.String())
		}
		if stderr.String() != "" {
			t.Errorf("the file sink must not switch stderr on: %q", stderr.String())
		}
	}
	got := strings.Count(readFile(t, log), "bullmoose: delegated ")
	if got != 3 {
		t.Errorf("want 3 delegated lines, got %d:\n%s", got, readFile(t, log))
	}
}

// TestTraceNamesTheCommandNotTheFlagValue — the trace is the port's progress
// metric, so it has to name what the Node CLI would call the command
// (packages/cli/src/main.ts:183), not the first token that lacks a dash.
func TestTraceNamesTheCommandNotTheFlagValue(t *testing.T) {
	cmd := shimCmd(t, "--db", "/tmp/mail.db", "mailboxes")
	cmd.Env = append(cmd.Env, envTrace+"=1")
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if code := exitCodeOf(t, cmd); code != 0 {
		t.Fatalf("exit %d: %s", code, stderr.String())
	}
	if want := "bullmoose: delegated mailboxes\n"; stderr.String() != want {
		t.Errorf("trace line: want %q, got %q", want, stderr.String())
	}
}

// ───────────────────────────── small helpers ─────────────────────────────────

func readFile(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func lineWithPrefix(s, prefix string) string {
	for _, l := range strings.Split(s, "\n") {
		if strings.HasPrefix(l, prefix) {
			return l
		}
	}
	return ""
}

func withoutEnv(env []string, key string) []string {
	out := make([]string, 0, len(env))
	for _, kv := range env {
		if !strings.HasPrefix(kv, key+"=") {
			out = append(out, kv)
		}
	}
	return out
}
