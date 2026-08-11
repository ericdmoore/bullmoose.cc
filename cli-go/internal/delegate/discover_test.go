package delegate

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestCliCandidatesOrder pins the search order, so moving the binary produces a
// predictable answer rather than a discovery.
func TestCliCandidatesOrder(t *testing.T) {
	got := cliCandidates("/opt/tools/bin", "/home/me/src/bullmoose.cc/packages/cli")

	// Nearest first: a copy shipped beside the binary wins over any checkout.
	if want := filepath.Join("/opt/tools/bin", cliBasename); got[0] != want {
		t.Errorf("first candidate: want %q, got %q", want, got[0])
	}
	if want := filepath.Join("/opt/tools/bin", cliRelPath); got[1] != want {
		t.Errorf("second candidate: want %q, got %q", want, got[1])
	}

	// The checkout above the working directory has to be reachable, or
	// `go run ./cli-go` (whose executable lives in a build cache) can never
	// find anything.
	want := filepath.Join("/home/me/src/bullmoose.cc", cliRelPath)
	if !contains(got, want) {
		t.Errorf("the cwd's checkout %q is not among the candidates:\n%s", want, strings.Join(got, "\n"))
	}
	// Both walks reach the root, and neither repeats itself.
	seen := map[string]bool{}
	for _, c := range got {
		if seen[c] {
			t.Errorf("duplicate candidate %q", c)
		}
		seen[c] = true
	}
}

func TestNodeCLIPrefersTheEnvironment(t *testing.T) {
	dir := t.TempDir()
	explicit := filepath.Join(dir, "explicit.mjs")
	if err := os.WriteFile(explicit, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	// A sibling that would otherwise win, to prove the environment beats it.
	sibling := filepath.Join(dir, cliBasename)
	if err := os.WriteFile(sibling, nil, 0o644); err != nil {
		t.Fatal(err)
	}

	t.Setenv(envNodeCLI, explicit)
	got, err := nodeCLI(dir, dir)
	if err != nil {
		t.Fatal(err)
	}
	if got != explicit {
		t.Errorf("want %q, got %q", explicit, got)
	}
}

func TestNodeCLIFallsBackToTheSibling(t *testing.T) {
	dir := t.TempDir()
	sibling := filepath.Join(dir, cliBasename)
	if err := os.WriteFile(sibling, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv(envNodeCLI, "")
	got, err := nodeCLI(dir, dir)
	if err != nil {
		t.Fatal(err)
	}
	if got != sibling {
		t.Errorf("want %q, got %q", sibling, got)
	}
}

// The error has to name both halves — arch.md §4: "else an error naming both.
// Never a silent fallback."
func TestNodeCLIErrorNamesBoth(t *testing.T) {
	dir := t.TempDir()
	t.Setenv(envNodeCLI, "")
	_, err := nodeCLI(dir, dir)
	if err == nil {
		t.Fatal("expected an error")
	}
	if !strings.Contains(err.Error(), envNodeCLI) {
		t.Errorf("must name the variable: %v", err)
	}
	if !strings.Contains(err.Error(), cliRelPath) {
		t.Errorf("must name the sibling path it looked for: %v", err)
	}
}

// A directory is not an implementation. Without this, `BULLMOOSE_NODE_CLI=.`
// would be accepted and fail later as an unreadable exec.
func TestNodeCLIRejectsADirectory(t *testing.T) {
	dir := t.TempDir()
	t.Setenv(envNodeCLI, dir)
	if _, err := nodeCLI(dir, dir); err == nil {
		t.Fatal("expected an error for a directory")
	}
}

func TestAncestors(t *testing.T) {
	got := ancestors(filepath.Join("/a", "b", "c"))
	want := []string{filepath.Join("/a", "b", "c"), filepath.Join("/a", "b"), "/a", "/"}
	if len(got) != len(want) {
		t.Fatalf("want %v, got %v", want, got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("ancestors[%d]: want %q, got %q", i, want[i], got[i])
		}
	}
	if ancestors("") != nil {
		t.Error("an empty directory has no ancestors")
	}
}

func contains(hay []string, needle string) bool {
	for _, h := range hay {
		if h == needle {
			return true
		}
	}
	return false
}
