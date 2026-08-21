// Deployed-binary drift (#242).
//
// popcorn is installed BY HAND. Merging a PR never updates the running daemon,
// so the repo and the process can disagree indefinitely and nothing says so.
// That is not hypothetical: on 2026-08-21 the running binary was built on
// Aug 15 and was missing three merged commits — #207 (dead hosts), #152
// (Watches) and #150, which is itself a fix to the installer that was not
// present in the installer being run. It was found by a human remembering to
// look, which is the part that does not scale.
//
// A Go binary already carries everything needed to notice: `go version -m`
// reports the toolchain that compiled it and, because the build happens inside
// a git checkout, `vcs.revision` / `vcs.modified` too. This test reads those
// and compares them to the repo.
//
// ## ⚠️ Build popcorn from the MAIN checkout, never a git worktree
//
// Measured 2026-08-21, and it is not obvious: when the build runs inside a
// linked worktree, Go stamps the MAIN checkout's HEAD, not the worktree's.
// Building at worktree HEAD 97bd671 produced `vcs.revision=a8df6b3`, which was
// the main checkout's HEAD on an unrelated branch — and `vcs.modified`
// described that tree's cleanliness too, not the one the code came from.
//
// So a worktree build embeds a revision that does not describe it. The binary
// is fine; the PROVENANCE is a lie, and every check below is then comparing
// against the wrong commit. This is how the first deploy on 2026-08-21 came to
// report `vcs.modified=true` from a clean worktree.
//
// Deploy from ~/Web/bullmoose.cc on main. If that is impossible, know that the
// revision recorded is the main checkout's and treat it as unverified.
//
// ## Why this is a test and not a CI step
//
// The subject lives on ONE machine, behind Tailscale, and CI cannot see it. A
// gate that cannot reach its subject is exactly the failure being fixed, so
// this is deliberately a test that SKIPS when there is no binary — inert in
// CI, and it bites on the host. Run it there:
//
//	cd packages/popcorn && go test ./deploy -run Drift -v
//
// Wire it into `cc.bullmoose.popcorn.certrenew` (already weekly) and drift
// becomes a thing that reports itself.
package deploy

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// deployedBinary resolves the installed daemon: POPCORN_BIN wins so the test
// can be pointed at a specific artifact, else the path install.sh writes.
func deployedBinary(t *testing.T) string {
	t.Helper()
	if p := os.Getenv("POPCORN_BIN"); p != "" {
		return p
	}
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skipf("no home directory to resolve the default install path: %v", err)
	}
	return filepath.Join(home, "bin", "popcorn")
}

// buildInfo runs `go version -m` and returns the toolchain plus the `build`
// key/value pairs. The first line is `<path>: <toolchain>`; the rest are
// tab-separated `mod`/`build`/`dep` records.
func buildInfo(t *testing.T, bin string) (toolchain string, kv map[string]string) {
	t.Helper()
	out, err := exec.Command("go", "version", "-m", bin).CombinedOutput()
	if err != nil {
		t.Fatalf("go version -m %s: %v\n%s", bin, err, out)
	}
	kv = map[string]string{}
	for i, line := range strings.Split(string(out), "\n") {
		if i == 0 {
			if _, after, ok := strings.Cut(line, ": "); ok {
				toolchain = strings.TrimSpace(after)
			}
			continue
		}
		f := strings.Split(strings.TrimSpace(line), "\t")
		// `build	key=value` and `build	-flag=value` both land here; the
		// vcs.* records are the ones this test cares about.
		if len(f) >= 2 && f[0] == "build" {
			if k, v, ok := strings.Cut(f[len(f)-1], "="); ok {
				kv[k] = v
			}
		}
	}
	return toolchain, kv
}

// pinnedToolchain reads the `toolchain` directive from packages/popcorn/go.mod
// — the repo's single statement of what should compile this binary (#240).
func pinnedToolchain(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "go.mod"))
	if err != nil {
		t.Fatalf("read ../go.mod: %v", err)
	}
	for _, line := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(line, "toolchain ") {
			return strings.TrimSpace(strings.TrimPrefix(line, "toolchain "))
		}
	}
	t.Fatal("no `toolchain` directive in ../go.mod — #240 pinned one; if it was removed, say why")
	return ""
}

func git(t *testing.T, args ...string) (string, bool) {
	t.Helper()
	out, err := exec.Command("git", args...).CombinedOutput()
	return strings.TrimSpace(string(out)), err == nil
}

// TestDriftDeployedToolchain — the binary must be compiled by the pinned
// toolchain. Go ships security fixes in the statically-linked stdlib, so this
// IS the daemon's patch level, not a cosmetic version string.
func TestDriftDeployedToolchain(t *testing.T) {
	bin := deployedBinary(t)
	if _, err := os.Stat(bin); err != nil {
		t.Skipf("no deployed binary at %s — nothing to compare (expected in CI)", bin)
	}
	got, _ := buildInfo(t, bin)
	want := pinnedToolchain(t)
	if got != want {
		t.Errorf("the running daemon was built by %s, but ../go.mod pins %s.\n"+
			"Go ships security fixes in the stdlib, so this is its PATCH LEVEL.\n"+
			"Fix: cd packages/popcorn && sh deploy/install.sh", got, want)
	}
}

// TestDriftDeployedRevision — the binary must be built from source that is not
// behind the repo. This is the check that would have caught the real 2026-08-21
// drift, which was three merged commits rather than a toolchain gap.
func TestDriftDeployedRevision(t *testing.T) {
	bin := deployedBinary(t)
	if _, err := os.Stat(bin); err != nil {
		t.Skipf("no deployed binary at %s — nothing to compare (expected in CI)", bin)
	}
	_, kv := buildInfo(t, bin)

	rev := kv["vcs.revision"]
	if rev == "" {
		t.Skip("binary carries no vcs.revision — built outside a checkout, or with -buildvcs=false")
	}
	if _, ok := git(t, "rev-parse", "--git-dir"); !ok {
		t.Skip("not inside a git checkout — cannot compare against the repo")
	}
	if _, ok := git(t, "cat-file", "-e", rev); !ok {
		t.Errorf("the running daemon was built from %s, which is NOT a commit in this repo.\n"+
			"It came from somewhere nobody can diff against. Rebuild from a known checkout.", rev[:12])
		return
	}

	// A dirty build tree means the artifact matches no commit at all — its
	// revision is a claim about its PARENT, not about itself.
	if kv["vcs.modified"] == "true" {
		t.Errorf("the running daemon was built from a MODIFIED tree at %s.\n"+
			"No commit describes what is actually running. Rebuild from a clean checkout.", rev[:12])
	}

	// The real question: has popcorn's source moved since this was built?
	// Scoped to packages/popcorn, so unrelated repo activity is not drift.
	newer, ok := git(t, "log", "--oneline", rev+"..HEAD", "--", ".")
	if !ok {
		t.Skipf("cannot walk %s..HEAD — shallow clone or detached history", rev[:12])
	}
	if newer != "" {
		t.Errorf("the running daemon is BEHIND the repo. Built from %s; since then "+
			"packages/popcorn has moved:\n\n%s\n\nFix: cd packages/popcorn && sh deploy/install.sh",
			rev[:12], newer)
	}
}
