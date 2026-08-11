package delegate

import (
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
)

// exitFail mirrors `EXIT.FAIL` in `packages/cli/src/io.ts:56` — "generic
// failure — nothing more specific applies". The shim failing to find its own
// backend is not the caller's usage error, and the §1.5 codes are a public
// interface a shim has no business extending (`io.ts:52-65`), so it borrows the
// generic one rather than inventing 127.
const exitFail = 1

// Run executes the Node CLI with this invocation's argv and returns its exit
// code. It does not return when the child dies by a signal — see raise.
func Run(argv []string) int {
	cli, err := nodeCLI(exeDir(), cwd())
	if err != nil {
		return fail(err)
	}
	node, err := nodeInterpreter()
	if err != nil {
		return fail(err)
	}
	return run(node, cli, argv)
}

func run(node, cli string, argv []string) int {
	// argv is forwarded verbatim. Not re-quoted, not reordered, not filtered:
	// the flags belong to the implementation being delegated to, and the shim
	// does not own their grammar (`arch.md` §4).
	//
	// A note on the alternative: on unix `syscall.Exec` would replace this
	// process with Node and get fds, exit code and signals right by
	// construction. Fork-and-wait is kept because the parent has to survive the
	// call — T6 mixes native and delegated commands in one binary, and T7 wants
	// a windows target where there is no execve.
	cmd := exec.Command(node, append([]string{cli}, argv...)...)

	// The three assignments the transparency of this shim rests on.
	//
	// `os/exec` passes an *os.File straight through as the child's descriptor,
	// and builds a pipe plus a copying goroutine only when the field holds
	// anything else. Wrapping these — a bufio.Writer, an io.MultiWriter that
	// tees to a log — costs two things. Both were measured, by putting
	// `struct{ io.Writer }{os.Stdout}` in place of the lines below and running
	// the result with a pty on fds 0-2:
	//
	//  1. isatty flips. The delegate reported `stdout.isTTY=false` where Node
	//     run directly on the same pty reported true — so colour and framing
	//     change under delegation, exactly as `arch.md` §4 warns.
	//  2. It hangs, forever. Wait waits for the stdin copier, and that copier
	//     never finishes while stdin is a terminal, so an interactive
	//     `bullmoose whoami` never returns.
	//
	// Correction to `arch.md` §4, which says a pumped shim makes "the
	// early-close/SIGPIPE cases in the contract suite fail". Measured, it does
	// not: the suite passes 61/61 either way, because `spawnSync` hands every
	// case an already-closed stdin and a non-TTY stdout
	// (`packages/cli/smoke/contract.mjs:51`). The suite cannot see this class of
	// bug at all — which is why `exec_test.go` asserts fd *identity* rather than
	// trusting a green contract run.
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	// cmd.Env stays nil, which means "inherit". BULLMOOSE_DB, NO_COLOR,
	// BULLMOOSE_TRACE and every other knob reach the delegate untouched.

	// Forward the two signals a user or a supervisor sends (`arch.md` §4). A
	// terminal ^C already reaches the child directly — it shares this process
	// group — so this covers `kill -TERM <pid>` and supervisors that signal the
	// parent alone. Notify has a second effect that matters more: it takes Go's
	// default disposition off SIGINT/SIGTERM, so this process cannot die while
	// the child is still shutting down. The child decides when the invocation
	// is over.
	sigs := make(chan os.Signal, 4)
	signal.Notify(sigs, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(sigs)

	if err := cmd.Start(); err != nil {
		return fail(fmt.Errorf("cannot run %s %s: %w", node, cli, err))
	}

	done := make(chan struct{})
	go func() {
		for {
			select {
			case s := <-sigs:
				// Best effort: the child may already have exited, and a race
				// there is not worth an error message the user cannot act on.
				_ = cmd.Process.Signal(s)
			case <-done:
				return
			}
		}
	}()

	waitErr := cmd.Wait()
	close(done)

	st := cmd.ProcessState
	if st == nil {
		return fail(fmt.Errorf("delegate produced no status: %v", waitErr))
	}

	// Death by signal is reported as death by that signal, not as a number of
	// this process's choosing: a caller's `wait` should see what it would have
	// seen with no shim in the way.
	if ws, ok := st.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
		return raise(ws.Signal())
	}

	// Exactly as it came back. `packages/cli/src/io.ts:96` maps every JMAP
	// SetError to a specific code, and scripts branch on those, so the shim
	// must not normalise, clamp or substitute.
	if code := st.ExitCode(); code >= 0 {
		return code
	}
	return fail(fmt.Errorf("delegate exited without a status (%v)", waitErr))
}

// fail reports a failure of the shim itself. On stderr, like every other
// non-record output (`arch.md` §1.1), so it cannot land in a pipeline's data.
func fail(err error) int {
	fmt.Fprintf(os.Stderr, "bullmoose: %v\n", err)
	return exitFail
}
