package delegate

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// Finding the implementation to delegate to.
//
// `arch.md` §4: "Discovery of the Node CLI is explicit — BULLMOOSE_NODE_CLI,
// else a sibling path, else a clear error naming both. Never a silent fallback
// to 'command not found'." So every failure below names what was tried and what
// to set, because the alternative is a user staring at `node: no such file`.

const (
	// envNodeCLI points at `packages/cli/bin/bullmoose.mjs` (or a copy of it).
	envNodeCLI = "BULLMOOSE_NODE_CLI"
	// envNode overrides the Node interpreter. Undocumented in the plan but
	// necessary in practice: nvm/asdf users have several, and the tests need to
	// substitute a fake one to observe the process boundary.
	envNode = "BULLMOOSE_NODE"

	cliBasename = "bullmoose.mjs"
)

// cliRelPath is the CLI's location inside a checkout, as
// `packages/cli/package.json` declares its `bin` entry.
var cliRelPath = filepath.Join("packages", "cli", "bin", cliBasename)

// nodeCLI resolves the Node CLI this invocation delegates to.
func nodeCLI(exeDir, cwd string) (string, error) {
	// An explicit setting is never quietly ignored: a typo'd path is an error
	// naming the variable, not a fall-through to some other CLI on the box.
	// Delegating to a *different* implementation than the operator named is the
	// one outcome that would make the trace metric lie.
	if p := os.Getenv(envNodeCLI); p != "" {
		if isFile(p) {
			return p, nil
		}
		return "", fmt.Errorf("%s=%s is not a file", envNodeCLI, p)
	}

	tried := cliCandidates(exeDir, cwd)
	for _, c := range tried {
		if isFile(c) {
			return c, nil
		}
	}
	return "", fmt.Errorf(
		"cannot find the Node CLI to delegate to.\n"+
			"  set %s=/path/to/%s, or run from a checkout where one of these exists:\n    %s",
		envNodeCLI, cliBasename, strings.Join(tried, "\n    "))
}

// cliCandidates lists the sibling paths tried when envNodeCLI is unset, nearest
// first. Kept pure (no filesystem, no environment) so the search order is a unit
// test rather than a thing you discover by moving a binary around.
//
// Two roots, because the binary legitimately lives in two places: inside a
// checkout during development (`cli-go/bin/bullmoose`, so the repo root is two
// levels up) and next to a shipped copy of the CLI after `scp`.
func cliCandidates(exeDir, cwd string) []string {
	var out []string
	seen := map[string]bool{}
	add := func(p string) {
		if !seen[p] {
			seen[p] = true
			out = append(out, p)
		}
	}
	if exeDir != "" {
		add(filepath.Join(exeDir, cliBasename)) // shipped side by side
		for _, a := range ancestors(exeDir) {
			add(filepath.Join(a, cliRelPath))
		}
	}
	// The cwd walk is what makes `go run ./cli-go` and `go test` work at all:
	// there the executable sits in a build cache with no checkout above it.
	for _, a := range ancestors(cwd) {
		add(filepath.Join(a, cliRelPath))
	}
	return out
}

// ancestors returns dir and every directory above it, up to the root.
func ancestors(dir string) []string {
	if dir == "" {
		return nil
	}
	var out []string
	for {
		out = append(out, dir)
		parent := filepath.Dir(dir)
		if parent == dir {
			return out
		}
		dir = parent
	}
}

// nodeInterpreter resolves the `node` to run the CLI with.
//
// The CLI is invoked as `node bullmoose.mjs …` rather than executed through its
// own `#!/usr/bin/env node` shebang (`packages/cli/bin/bullmoose.mjs:1`): a copy
// that lost its executable bit would otherwise fail as EACCES, which reads as a
// permissions problem rather than a missing interpreter.
func nodeInterpreter() (string, error) {
	if p := os.Getenv(envNode); p != "" {
		return p, nil
	}
	p, err := exec.LookPath("node")
	if err != nil {
		return "", fmt.Errorf("node is not on PATH — set %s=/path/to/node (%v)", envNode, err)
	}
	return p, nil
}

// cwd is the working directory, or "" — a process whose cwd was unlinked still
// has to produce the error message rather than a panic.
func cwd() string {
	d, err := os.Getwd()
	if err != nil {
		return ""
	}
	return d
}

func isFile(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

// exeDir is the directory holding this binary, symlinks resolved so that a
// `~/bin/bullmoose` symlink into a checkout still finds the checkout.
func exeDir() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	return filepath.Dir(exe)
}
