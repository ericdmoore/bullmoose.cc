package cmd

// `bullmoose version` — which binary is this? GO-NATIVE with no Node twin,
// like `approvals`: the Node CLI never had a version surface because npm was
// its version surface, and Node gets zero new features (devPrinciples). The
// release pipeline (s08 T7) is what makes this command necessary — once
// binaries travel as GitHub-release artifacts, every support question starts
// "which build are you on", and a binary that cannot answer turns that into
// archaeology over file mtimes.
//
// Two sources, in order:
//
//   - releaseVersion, stamped by release-cli.yml via `-ldflags -X`. Its zero
//     value is "dev", so a stamped binary and a source build are DISTINGUISHABLE
//     — the property the workflow's smoke step asserts, because an ldflags path
//     is exactly the kind of stringly wiring that breaks silently when a
//     package moves.
//   - the VCS stamp Go embeds on its own (debug.ReadBuildInfo), which names the
//     commit for source builds and carries `+dirty` when the tree was modified.
//     A test binary has neither, and prints "unknown" rather than guessing.

import (
	"runtime"
	"runtime/debug"
	"strings"

	bmio "github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
)

// releaseVersion is `-ldflags "-X ...internal/cmd.releaseVersion=<tag>"` in
// .github/workflows/release-cli.yml. Renaming or moving it breaks that stamp
// SILENTLY (ldflags -X ignores unknown symbols) — the workflow's smoke step is
// the guard, not the compiler.
var releaseVersion = "dev"

// buildCommit reads the VCS stamp out of the running binary. Separated from
// runVersion so the test can cover the printing without depending on whether
// the test binary carries build info (it does not).
func buildCommit(info *debug.BuildInfo, ok bool) string {
	if !ok || info == nil {
		return "unknown"
	}
	rev, modified := "", false
	for _, s := range info.Settings {
		switch s.Key {
		case "vcs.revision":
			rev = s.Value
		case "vcs.modified":
			modified = s.Value == "true"
		}
	}
	if rev == "" {
		return "unknown"
	}
	if len(rev) > 12 {
		rev = rev[:12]
	}
	if modified {
		rev += "+dirty"
	}
	return rev
}

// versionArgs is the whole grammar: one boolean. Self-parsed rather than
// shared parse() because Go-native-only commands are held to delegate's flag
// tables by TestSelfParsingCommandsAreCovered, and that check walks a parser
// of the command's own — the approvals/agents convention.
type versionArgs struct{ JSON bool }

func parseVersion(argv []string) versionArgs {
	var a versionArgs
	for _, arg := range argv {
		if !strings.HasPrefix(arg, "--") {
			continue
		}
		name, _, _ := strings.Cut(strings.TrimPrefix(arg, "--"), "=")
		switch name {
		case "json":
			a.JSON = true
		}
	}
	return a
}

func runVersion(s *bmio.Streams, argv []string) int {
	a := parseVersion(argv)
	commit := buildCommit(debug.ReadBuildInfo())

	if a.JSON {
		if err := s.EmitJSON(map[string]any{
			"version": releaseVersion,
			"commit":  commit,
			"go":      runtime.Version(),
			"os":      runtime.GOOS,
			"arch":    runtime.GOARCH,
		}); err != nil {
			return die(s, err)
		}
		return 0
	}

	// One record, fixed field count, so `awk '{print $2}'` stays stable
	// whether or not the build knew its commit.
	s.Out("bullmoose " + releaseVersion + " " + runtime.GOOS + "/" + runtime.GOARCH +
		" " + runtime.Version() + " " + commit)
	return 0
}
