package help

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"

	bmio "github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
)

// TestArtifactMatchesTheSpec is the drift check that makes the embedded artifact
// legitimate, and it is this design's ENTIRE safety story.
//
// The artifact is a capture of the Node CLI's help output. It can only ever be
// wrong one way — help.ts moved and nobody regenerated — so the check is: does
// the spec still hash to what it hashed to when these bytes were captured? Same
// mechanism as store/schema_test.go's DDL check (byte-equality against the
// canonical file on the TypeScript side, failing with the command that fixes it),
// and the hash rather than a second copy because the copy would be 220 KB.
//
// What a stale artifact would do, concretely, and why this is worth a test: a
// command added to help.ts and main.ts but not regenerated here is missing from
// the embedded command list, so the Go front door answers `unknown command` —
// exit 2 — for a command the Node CLI runs. That is a wrong answer, not a
// missing feature.
//
// Skips (rather than fails) when the repo is not above this checkout, exactly as
// store/schema_test.go and delegate/argv_test.go do: cli-go is buildable on its
// own, and a check that cannot run must say so rather than fail for the wrong
// reason. In CI the repo is always there.
func TestArtifactMatchesTheSpec(t *testing.T) {
	// RETIRED WITH THE NODE CLI. This test hashed packages/cli/src/help.ts
	// against the hash the artifact header records, catching the one failure
	// mode this design has: help.ts edited, artifact not regenerated. With
	// help.ts deleted, the artifact IS the help source — there is no spec left
	// to drift from, and the payload-integrity half (TestArtifactIsIntact)
	// carries the remaining guarantee: these bytes are the bytes the last
	// generation captured. The specHash in the header stays as provenance.
	//
	// The debt this leaves is real and named: EDITING help now means either a
	// hand-edit of artifact.txt (with its payload hash re-computed) or the
	// future Go help-spec port. The parser-grammar drift tests still hold
	// every command's flags to the artifact's documented pages, so the help
	// cannot silently disagree with the parsers — it can only go stale as a
	// whole, visibly, when commands change.
	spec := load()
	if spec.err != nil {
		t.Fatalf("the embedded artifact does not parse: %v", spec.err)
	}
	if spec.specHash == "" {
		t.Fatal("the artifact records no spec hash — its provenance header was damaged")
	}
}

// TestArtifactIsIntact is the half of the drift story that needs nothing but
// this directory: the payload still hashes to what the generator recorded.
//
// It exists because the spec hash alone does not cover it — a byte flipped
// inside a captured page (a bad merge, a stray editor save, a truncated copy)
// leaves help.ts untouched and would otherwise be printed to a user as help.
// This is also the check that makes `go test ./...` in a bare cli-go checkout,
// with no repo and no Node above it, still mean something.
func TestArtifactIsIntact(t *testing.T) {
	spec := load()
	if spec.err != nil {
		t.Fatalf("the embedded artifact does not parse: %v\n    fix: %s", spec.err, Regenerate)
	}
	if spec.bodyHash == "" {
		t.Fatalf("the artifact records no body hash, so corruption is undetectable here\n    fix: %s", Regenerate)
	}
	sum := sha256.Sum256([]byte(spec.body))
	if got := hex.EncodeToString(sum[:]); got != spec.bodyHash {
		t.Errorf("cli-go/internal/help/artifact.txt has been MODIFIED since it was generated — "+
			"this binary would print help that no renderer produced.\n"+
			"    body now: %s\n    recorded: %s\n    fix: %s", got, spec.bodyHash, Regenerate)
	}
}

// TestArtifactCoversEverySpecCommand is the self-consistency half: the artifact
// must answer for every command it itself claims exists. A generator that
// skipped a command, or a hand-edit that dropped an entry, shows up here without
// needing the repo at all.
func TestArtifactCoversEverySpecCommand(t *testing.T) {
	spec := load()
	if spec.err != nil {
		t.Fatalf("artifact does not parse: %v", spec.err)
	}
	if len(spec.commands) < 20 {
		t.Fatalf("only %d commands in the artifact — it did not parse the way this test assumes", len(spec.commands))
	}
	for name := range spec.commands {
		e, ok := spec.entries["command:"+name]
		if !ok {
			t.Errorf("no page for `bullmoose help %s`, which the artifact's own command list promises\n    fix: %s", name, Regenerate)
			continue
		}
		if e.exit != 0 || e.stdout == "" || e.stderr != "" {
			t.Errorf("`help %s` should be stdout and exit 0 (§1.1: help that was asked for is a record); got exit=%d out=%dB err=%dB",
				name, e.exit, len(e.stdout), len(e.stderr))
		}
		if !strings.HasPrefix(e.stdout, "bullmoose "+name+" — ") {
			t.Errorf("`help %s` does not open with its own heading: %q", name, firstLine(e.stdout))
		}
	}

	// The invocations that are not per-command, and the stream/exit each one owes
	// the contract. `overview` and `overview-usage` are the same text on
	// different streams with different codes, which is the distinction only
	// main.ts knows and the whole reason the generator captures invocations
	// rather than calling the renderers.
	for _, c := range []struct {
		key    string
		exit   int
		stdout bool
	}{
		{"overview", 0, true},
		{"overview-usage", 2, false},
		{"json", 0, true},
		{"man", 0, true},
		{"markdown", 0, true},
		{"unknown-topic", 2, false},
		{"unknown-command", 2, false},
	} {
		e, ok := spec.entries[c.key]
		if !ok {
			t.Errorf("the artifact has no %q entry\n    fix: %s", c.key, Regenerate)
			continue
		}
		if e.exit != c.exit {
			t.Errorf("%s exits %d, want %d", c.key, e.exit, c.exit)
		}
		if (e.stdout != "") != c.stdout || (e.stderr != "") == c.stdout {
			t.Errorf("%s wrote to the wrong stream: out=%dB err=%dB, want stdout=%v",
				c.key, len(e.stdout), len(e.stderr), c.stdout)
		}
	}

	// `help --json` is the surface agents read; it must still be JSON after a
	// round trip through the frame.
	if json := spec.entries["json"].stdout; !strings.HasPrefix(json, "{\n  \"name\": \"bullmoose\"") || !strings.HasSuffix(json, "}\n") {
		t.Errorf("the --json entry is not a whole JSON document (%dB, starts %q)", len(json), firstLine(json))
	}
}

// TestServeRendersTheCapturedBytes pins the lookup itself: what Serve writes is
// what was captured, on the stream it was captured from, with the exit code it
// was captured with. Nothing here re-renders anything.
//
// Every HUMAN-facing mode is in this list, and that is the point: the overview,
// each command page, the man page and the Markdown are byte-for-byte Node's, and
// this is what says so. `help --json` is deliberately NOT here — it is the one
// mode that is re-emitted with the derived argument structure (spec.go), and its
// relationship to these bytes is pinned instead by spec_test.go's
// TestUnenrichedRoundTripIsByteIdentical (the enrichment is additive) and
// TestServeJSONIsASupersetOfTheCapture (nothing was lost).
func TestServeRendersTheCapturedBytes(t *testing.T) {
	spec := load()
	for _, c := range []struct {
		name string
		req  Request
		key  string
	}{
		{"overview", Request{Mode: Overview}, "overview"},
		{"no command", Request{Mode: OverviewUsage}, "overview-usage"},
		{"man", Request{Mode: Man}, "man"},
		{"markdown", Request{Mode: Markdown}, "markdown"},
		{"a command page", Request{Mode: Topic, Topic: "rm"}, "command:rm"},
	} {
		t.Run(c.name, func(t *testing.T) {
			var out, err bytes.Buffer
			code := Serve(bmio.NewTo(&out, &err), c.req)
			want := spec.entries[c.key]
			if code != want.exit {
				t.Errorf("exit = %d, want %d", code, want.exit)
			}
			if out.String() != want.stdout {
				t.Errorf("stdout is not the captured bytes (%dB vs %dB)", out.Len(), len(want.stdout))
			}
			if err.String() != want.stderr {
				t.Errorf("stderr is not the captured bytes (%dB vs %dB)", err.Len(), len(want.stderr))
			}
		})
	}

	// And every per-command page, not just the one above: `help --json` grew a
	// second renderer, so the promise that NOTHING ELSE did is worth checking
	// exhaustively rather than by sample.
	for _, name := range Commands() {
		var out, err bytes.Buffer
		Serve(bmio.NewTo(&out, &err), Request{Mode: Topic, Topic: name})
		if want := spec.entries["command:"+name]; out.String() != want.stdout || err.String() != want.stderr {
			t.Errorf("`help %s` is no longer the captured bytes (%dB vs %dB) — a human help "+
				"page is being rendered rather than replayed", name, out.Len(), len(want.stdout))
		}
	}
}

// TestUnknownTopicSubstitutesTheSentinel covers the one help output that cannot
// be enumerated: the topic is arbitrary user text, so it is captured once with a
// sentinel and substituted here. The sentinel must not survive into the output,
// and the message must name what the user actually typed.
func TestUnknownTopicSubstitutesTheSentinel(t *testing.T) {
	for _, c := range []struct {
		mode  Mode
		topic string
	}{
		{Topic, "nosuchthing"},
		{Topic, "admin agent bind"}, // a seeAlso entry that is not a command
		{UnknownCommand, "logg"},
		{UnknownCommand, "--weird"},
	} {
		var out, err bytes.Buffer
		code := Serve(bmio.NewTo(&out, &err), Request{Mode: c.mode, Topic: c.topic})
		if code != 2 {
			t.Errorf("%q: exit = %d, want 2 (§1.5 usage)", c.topic, code)
		}
		if out.Len() != 0 {
			t.Errorf("%q: an error's help is chrome — nothing may reach stdout (§1.1)", c.topic)
		}
		if !strings.HasPrefix(err.String(), "unknown command: "+c.topic+"\n") {
			t.Errorf("%q: message does not name the topic: %q", c.topic, firstLine(err.String()))
		}
		if strings.Contains(err.String(), load().placeholder) {
			t.Errorf("%q: the sentinel leaked into the output", c.topic)
		}
	}
}

// TestServeRefusesRatherThanApproximates is the mutation this design has to
// survive: if a lookup ever misses, the one unacceptable answer is a plausible
// generic help message, because that is indistinguishable from working. It must
// say the binary is broken and exit non-zero.
func TestServeRefusesRatherThanApproximates(t *testing.T) {
	var out, err bytes.Buffer
	code := Serve(bmio.NewTo(&out, &err), Request{Mode: Mode(99)})
	if code == 0 {
		t.Error("an unroutable request exited 0")
	}
	if out.Len() != 0 {
		t.Error("a broken lookup must not write to stdout")
	}
	if !strings.Contains(err.String(), Regenerate) {
		t.Errorf("the refusal must name the fix, got %q", err.String())
	}
}

// TestParseRejectsCorruption pins the frame. A byte-length that does not line up
// with the payload — the shape a truncated or hand-edited artifact takes — must
// be an error, not a silently shifted parse that serves one entry's bytes under
// another's name.
func TestParseRejectsCorruption(t *testing.T) {
	good := "bullmoose-help-artifact 1\nplaceholder __X__\ncommands log\n--\nentry command:log 0 4 0\nhelp\n\n"
	if s := parse(good); s.err != nil {
		t.Fatalf("the well-formed fixture did not parse: %v", s.err)
	} else if s.entries["command:log"].stdout != "help" {
		t.Fatalf("fixture parsed wrong: %q", s.entries["command:log"].stdout)
	}

	for _, c := range []struct{ name, src string }{
		{"no header terminator", "bullmoose-help-artifact 1\n"},
		{"wrong version", strings.Replace(good, " 1\n", " 99\n", 1)},
		{"stdout length too long", strings.Replace(good, "0 4 0", "0 40 0", 1)},
		{"stdout length too short", strings.Replace(good, "0 4 0", "0 3 0", 1)},
		{"missing count", strings.Replace(good, "entry command:log 0 4 0", "entry command:log 0 4", 1)},
		{"no entries", "bullmoose-help-artifact 1\nplaceholder __X__\ncommands log\n--\n"},
		{"no commands", strings.Replace(good, "commands log\n", "", 1)},
	} {
		if s := parse(c.src); s.err == nil {
			t.Errorf("%s: parsed clean, so a corrupt artifact would be served as help", c.name)
		}
	}
}

// TestEmbeddedArtifactIsTheCommittedFile guards the seam between the generator
// and the compiler: `go:embed` takes whatever is in this directory, so a build
// from a tree where the file was replaced would ship those bytes. Cheap to check,
// and it is the only thing standing between "the drift test passed" and "the
// drift test passed against a different file".
func TestEmbeddedArtifactIsTheCommittedFile(t *testing.T) {
	onDisk, err := os.ReadFile("artifact.txt")
	if err != nil {
		t.Fatalf("artifact.txt: %v", err)
	}
	if string(onDisk) != artifact {
		t.Errorf("the embedded artifact and cli-go/internal/help/artifact.txt differ (%d vs %d bytes)",
			len(artifact), len(onDisk))
	}
}

// repoFile reads a repo-relative file by walking up from the test's directory,
// the way store/schema_test.go and delegate/argv_test.go find theirs.
func repoFile(t *testing.T, rel string) ([]byte, bool) {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		if b, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(rel))); err == nil {
			return b, true
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Logf("%s not found above the test directory — help drift is unchecked in this checkout", rel)
			return nil, false
		}
		dir = parent
	}
}
