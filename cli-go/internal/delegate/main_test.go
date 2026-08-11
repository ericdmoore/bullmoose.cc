package delegate

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// The test harness.
//
// Everything worth asserting about a shim lives at the process boundary —
// `packages/cli/src/contract.test.ts:13` makes the same point about the TypeScript
// side: "A process cannot see its own EPIPE, its own exit code, or whether
// `--ids | xargs` composes; those are properties of the process boundary." Add
// fd identity to that list. So these tests spawn real processes.
//
// This binary therefore plays three roles, chosen by env and argv:
//
//	node    — the fake interpreter the shim delegates to. Recognised by argv[1]
//	          being the sentinel CLI path, and it reports what it was handed.
//	shim    — Dispatch itself, i.e. the front door under test.
//	default — the test suite.
//
// Re-execing the test binary rather than `go build`ing a fixture keeps the
// tests hermetic and fast, and guarantees the shim under test is the same code
// `main.go` runs.

const (
	envTestRole = "BULLMOOSE_TEST_ROLE"
	envTestCLI  = "BULLMOOSE_TEST_CLI" // sentinel standing in for bullmoose.mjs
	envTestFd   = "BULLMOOSE_TEST_FD"  // "0=<path>;1=<path>;2=<path>"
)

var (
	testExe string // this binary, absolute
	testCLI string // the sentinel path
)

func TestMain(m *testing.M) {
	// Checked first: the delegate inherits the whole environment, shim role
	// included, so argv is the only thing that can tell the two apart.
	if cli := os.Getenv(envTestCLI); cli != "" && len(os.Args) > 1 && os.Args[1] == cli {
		fakeNode(os.Args[2:])
	}
	if os.Getenv(envTestRole) == "shim" {
		os.Exit(Dispatch(os.Args[1:]))
	}

	exe, err := os.Executable()
	if err != nil {
		fmt.Fprintf(os.Stderr, "cannot locate the test binary: %v\n", err)
		os.Exit(1)
	}
	testExe = exe

	dir, err := os.MkdirTemp("", "bullmoose-delegate-")
	if err != nil {
		fmt.Fprintf(os.Stderr, "cannot create the sentinel: %v\n", err)
		os.Exit(1)
	}
	testCLI = filepath.Join(dir, "fake-cli.mjs")
	if err := os.WriteFile(testCLI, []byte("// stands in for packages/cli/bin/bullmoose.mjs\n"), 0o644); err != nil {
		fmt.Fprintf(os.Stderr, "cannot write the sentinel: %v\n", err)
		os.Exit(1)
	}

	code := m.Run()
	_ = os.RemoveAll(dir)
	os.Exit(code)
}

// shimCmd builds an invocation of the front door, pointed at this binary as
// both the interpreter and (via the sentinel) the CLI. cmd.Dir is a scratch
// directory so discovery can never wander into the real checkout.
func shimCmd(t *testing.T, args ...string) *exec.Cmd {
	t.Helper()
	cmd := exec.Command(testExe, args...)
	cmd.Dir = t.TempDir()
	// Later entries win in os/exec's dedup, so these override anything the
	// developer's shell already exported.
	cmd.Env = append(os.Environ(),
		envTestRole+"=shim",
		envTestCLI+"="+testCLI,
		envNodeCLI+"="+testCLI,
		envNode+"="+testExe,
		envTrace+"=",
	)
	return cmd
}

// exitCodeOf runs cmd to completion and returns its exit code, failing the test
// on anything that is not a clean exit-with-status.
func exitCodeOf(t *testing.T, cmd *exec.Cmd) int {
	t.Helper()
	err := cmd.Run()
	if cmd.ProcessState == nil {
		t.Fatalf("no process state: %v", err)
	}
	return cmd.ProcessState.ExitCode()
}

// ───────────────────────────── the fake delegate ─────────────────────────────

// fakeNode stands in for `node packages/cli/bin/bullmoose.mjs`. Directives are
// passed as ordinary arguments with an `@@` prefix — which also exercises the
// forwarding path, since they only arrive if argv survived it verbatim.
func fakeNode(args []string) {
	code := 0
	for _, a := range args {
		switch {
		case a == "@@args":
			for _, x := range args {
				fmt.Printf("argv %q\n", x)
			}
		case a == "@@stat":
			reportFds()
		case a == "@@stdin":
			b, _ := io.ReadAll(os.Stdin)
			fmt.Printf("stdin %q\n", string(b))
		case strings.HasPrefix(a, "@@out="):
			fmt.Println(strings.TrimPrefix(a, "@@out="))
		case strings.HasPrefix(a, "@@err="):
			fmt.Fprintln(os.Stderr, strings.TrimPrefix(a, "@@err="))
		case strings.HasPrefix(a, "@@exit="):
			code, _ = strconv.Atoi(strings.TrimPrefix(a, "@@exit="))
		case strings.HasPrefix(a, "@@signal="):
			suicide(strings.TrimPrefix(a, "@@signal="))
		case strings.HasPrefix(a, "@@onsignal="):
			code = awaitSignal(strings.TrimPrefix(a, "@@onsignal="))
		}
	}
	os.Exit(code)
}

// reportFds is the fd-inheritance probe. os.SameFile is the portable
// device+inode comparison, so "same=true" means the child holds the very file
// the parent held — not a pipe carrying a copy of its bytes.
func reportFds() {
	want := map[string]string{}
	for _, pair := range strings.Split(os.Getenv(envTestFd), ";") {
		if k, v, ok := strings.Cut(pair, "="); ok {
			want[k] = v
		}
	}
	for i, f := range []*os.File{os.Stdin, os.Stdout, os.Stderr} {
		fi, err := f.Stat()
		if err != nil {
			fmt.Printf("fd%d error=%v\n", i, err)
			continue
		}
		same := "unchecked"
		if p := want[strconv.Itoa(i)]; p != "" {
			wfi, werr := os.Stat(p)
			same = strconv.FormatBool(werr == nil && os.SameFile(fi, wfi))
		}
		fmt.Printf("fd%d same=%s pipe=%t mode=%s\n",
			i, same, fi.Mode()&os.ModeNamedPipe != 0, fi.Mode().String())
	}
}

// awaitSignal implements `@@onsignal=TERM:42`: announce readiness, wait for the
// named signal, exit with the given code. The announcement removes the race —
// a signal sent before the handler is installed would kill the process by
// default and the test would be measuring nothing.
func awaitSignal(spec string) int {
	name, codeStr, _ := strings.Cut(spec, ":")
	code, _ := strconv.Atoi(codeStr)
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, signalNamed(name))
	fmt.Println("ready")
	select {
	case <-ch:
		fmt.Println("child caught " + name)
		return code
	case <-time.After(30 * time.Second):
		fmt.Println("child timed out")
		return 99
	}
}

// suicide makes the delegate die by a signal, by handing the pid to `sh`.
//
// A Go process cannot kill itself with SIGPIPE — the runtime keeps its own
// handler and ignores one delivered by kill(2) — and `sh -c 'kill -PIPE $$'`
// can. It is the better stand-in anyway: a different program entirely, dying in
// this pid, which is what the shim actually delegates to.
func suicide(name string) {
	_ = syscall.Exec("/bin/sh", []string{"sh", "-c", "kill -" + name + " $$"}, os.Environ())
	// Only reached if exec failed; die some other way so the test sees a
	// failure rather than a hang.
	os.Exit(97)
}

func signalNamed(name string) syscall.Signal {
	switch strings.ToUpper(name) {
	case "INT":
		return syscall.SIGINT
	case "TERM":
		return syscall.SIGTERM
	case "PIPE":
		return syscall.SIGPIPE
	case "HUP":
		return syscall.SIGHUP
	}
	return syscall.SIGTERM
}
