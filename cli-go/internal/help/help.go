// Package help serves the CLI's help surface from an embedded artifact.
//
// ── Why an artifact rather than a port of the renderers ─────────────────────
//
// packages/cli/src/help.ts is a structured spec plus four renderers: the human
// overview and per-command page, `--json` (the whole spec, which is what agents
// read), `--man` (roff, → man/bullmoose.1) and `--markdown` (→ docs/cli.md).
// Porting them would mean porting a word wrap, roff escaping and Markdown table
// escaping into a second language and then defending every off-by-one forever
// against a byte-identity requirement — for output that never varies.
//
// It never varies because the wrap is FIXED-WIDTH: help.ts wraps at
// `wrap(desc, 76)` and `wrapHanging(…, 22, 78)`, not at the terminal's width, and
// nothing in the help path reads the database, the network, the environment or
// the clock. Every one of those outputs is therefore a CONSTANT, and a constant
// does not need a renderer — it needs to be shipped.
//
// So packages/cli/tools/gen-help-artifact.mjs RUNS the Node CLI once per help
// invocation and captures each one's stdout, stderr and exit code into
// artifact.txt; this package looks them up. Byte-identity is not asserted here,
// it is structural: the Go binary prints Node's own bytes.
//
// ONE mode is no longer a replay: `help --json`. It is a machine surface, not a
// rendering, and it was missing the structure a machine needs (spec.go's header
// says which and why), so the captured JSON is decoded, given a derived
// `options`/`arguments` layer, and re-encoded. Every HUMAN mode above — the
// overview, each command page, --man, --markdown — is still bytes-in-bytes-out,
// and TestServeRendersTheCapturedBytes now checks every one of them rather than
// a sample, precisely because one mode stopped being one.
//
// ── The failure mode this design has, and what covers it ────────────────────
//
// Essentially one: a STALE artifact — help.ts edited, artifact not regenerated.
// Three checks bite on it, deliberately from different directions:
//
//   - artifact_test.go's TestArtifactMatchesTheSpec hashes the real
//     packages/cli/src/help.ts and compares it with the hash the header records,
//     failing with the command that fixes it — the same shape as
//     store/schema_test.go's DDL drift check;
//   - TestArtifactIsIntact hashes the payload against the header's own record,
//     which needs neither the repo nor Node and so is the check that still means
//     something in a bare cli-go checkout;
//   - packages/cli/src/helpArtifact.test.ts re-renders every entry from the spec
//     in process and byte-compares the whole file, so any change to help.ts OR
//     to a renderer fails within milliseconds, with no build and no spawn.
//
// Staleness is also why `commands` is in the header: a command added to Node
// without regenerating would make the Go front door answer "unknown command" for
// a command that exists, which is the worst thing a stale embed could do, and
// the spec hash is what stops it.
package help

import (
	_ "embed"
	"fmt"
	"strconv"
	"strings"
	"sync"

	bmio "github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
)

// artifact is packages/cli/tools/gen-help-artifact.mjs's output, written
// straight into this directory because `go:embed` cannot reach outside cli-go's
// module (the same constraint that makes internal/store/sql/*.sql copies).
// GENERATED — never hand-edit; `npm run -w @bullmoose/cli gen:docs` rewrites it.
//
//go:embed artifact.txt
var artifact string

// formatLine is the artifact's first line. A format change is a breaking change
// for this parser, so the version is checked rather than assumed.
const formatLine = "bullmoose-help-artifact 1"

// SpecPath is the file the artifact is generated from, repo-relative — named
// here because the drift test hashes it and every failure message points at it.
const SpecPath = "packages/cli/src/help.ts"

// Regenerate names the fix for damage this package can report. The generator
// (the Node CLI's gen:docs) is GONE — since the Node CLI's removal the
// artifact is the help source itself, so the only fixes are restoring the
// file from git or hand-editing a payload and re-recording its hash.
const Regenerate = "the artifact is canonical since the Node CLI's removal — restore cli-go/internal/help/artifact.txt from git"

// entry is one captured invocation: the bytes it wrote, and how it exited.
// stdout and stderr are never both non-empty (the generator refuses to write an
// artifact where they are), so replaying one then the other cannot reorder
// anything a reader could observe.
type entry struct {
	exit           int
	stdout, stderr string
}

// artifactSpec is the parsed artifact.
type artifactSpec struct {
	// placeholder is the sentinel standing in for the arbitrary user text in the
	// two "unknown command: x" payloads — the one help output that cannot be
	// enumerated, so it is captured once and substituted.
	placeholder string
	// specHash is the sha256 of packages/cli/src/help.ts at generation time, and
	// bodyHash the sha256 of everything after the header. Both are the drift
	// tests' oracles; nothing at runtime reads either. Two of them because there
	// are two ways to be wrong: the spec moved (needs the repo to detect), or
	// these bytes are no longer the generated ones (detectable from a bare
	// cli-go checkout, with no Node in sight).
	specHash string
	bodyHash string
	// body is the framed region the bodyHash covers, kept for that check.
	body string
	// commands is the Node CLI's command set, from the spec itself.
	commands map[string]bool
	entries  map[string]entry
	err      error
}

var (
	once   sync.Once
	loaded artifactSpec
)

// load parses the artifact once, lazily. Lazily because the parse is pure cost
// for `bullmoose log`: the port's headline is startup time, and no read command
// touches help.
func load() artifactSpec {
	once.Do(func() { loaded = parse(artifact) })
	return loaded
}

// parse reads the length-framed artifact. Length-framed rather than JSON so the
// committed file stays diffable — a reviewer sees the help text change, not a
// wall of escapes — and because help text contains every plausible delimiter
// (backticks, pipes, `---`, leading roff dots) and escaping any of it is where
// byte-identity would go to die.
func parse(src string) artifactSpec {
	s := artifactSpec{commands: map[string]bool{}, entries: map[string]entry{}}

	head, body, ok := strings.Cut(src, "\n--\n")
	if !ok {
		s.err = fmt.Errorf("no header terminator")
		return s
	}
	lines := strings.Split(head, "\n")
	if len(lines) == 0 || lines[0] != formatLine {
		s.err = fmt.Errorf("bad format line %q, want %q", firstLine(head), formatLine)
		return s
	}
	for _, line := range lines[1:] {
		switch field, rest, _ := strings.Cut(line, " "); field {
		case "placeholder":
			s.placeholder = rest
		case "commands":
			for _, name := range strings.Fields(rest) {
				s.commands[name] = true
			}
		case "spec":
			// `spec <path> sha256=<hex>`
			if _, hash, ok := strings.Cut(rest, "sha256="); ok {
				s.specHash = hash
			}
		case "body":
			if _, hash, ok := strings.Cut(rest, "sha256="); ok {
				s.bodyHash = hash
			}
		}
	}
	s.body = body

	for body != "" {
		header, rest, ok := strings.Cut(body, "\n")
		if !ok {
			s.err = fmt.Errorf("truncated entry header %q", firstLine(body))
			return s
		}
		f := strings.Fields(header)
		if len(f) != 5 || f[0] != "entry" {
			s.err = fmt.Errorf("malformed entry header %q", header)
			return s
		}
		exit, err1 := strconv.Atoi(f[2])
		outLen, err2 := strconv.Atoi(f[3])
		errLen, err3 := strconv.Atoi(f[4])
		if err1 != nil || err2 != nil || err3 != nil || outLen < 0 || errLen < 0 {
			s.err = fmt.Errorf("malformed entry header %q", header)
			return s
		}
		// +2 for the newline that follows each payload — present so the file
		// reads as text, and checked so a mis-encoded length cannot slide the
		// parse silently down the file.
		if len(rest) < outLen+errLen+2 {
			s.err = fmt.Errorf("entry %s is truncated", f[1])
			return s
		}
		stdout := rest[:outLen]
		stderr := rest[outLen+1 : outLen+1+errLen]
		if rest[outLen] != '\n' || rest[outLen+1+errLen] != '\n' {
			s.err = fmt.Errorf("entry %s: payload lengths do not line up with the frame", f[1])
			return s
		}
		s.entries[f[1]] = entry{exit: exit, stdout: stdout, stderr: stderr}
		body = rest[outLen+errLen+2:]
	}

	if len(s.entries) == 0 || s.placeholder == "" || len(s.commands) == 0 {
		s.err = fmt.Errorf("artifact is empty (%d entries, %d commands)", len(s.entries), len(s.commands))
	}
	return s
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}

// Mode names one shape of help invocation. The shapes, and the precedence
// between them, are main.ts:205-237's — not this package's invention.
type Mode uint8

const (
	// Overview — `help`, `--help`, `-h`, `help --help`. Help that was ASKED for
	// is the requested data, so it is stdout and exit 0 (§1.1).
	Overview Mode = iota
	// OverviewUsage — `bullmoose` with no command. The same text, but printed
	// because the invocation was wrong, so it is chrome: stderr, exit 2.
	OverviewUsage
	// Topic — `help <cmd>` / `<cmd> --help`.
	Topic
	// JSON — `help --json`: the whole spec, and the surface an agent should read
	// rather than scraping the text. The only mode Serve re-encodes rather than
	// replays, so that flags and positionals arrive structured (spec.go).
	JSON
	// Man — `help --man`: roff, the source of man/bullmoose.1.
	Man
	// Markdown — `help --markdown`: the source of docs/cli.md.
	Markdown
	// UnknownCommand — the switch default at main.ts:429: a command the Node CLI
	// does not have. Not a help request, but it is rendered ENTIRELY out of the
	// help spec (the message plus the whole overview), so it is served from here.
	UnknownCommand
)

// Request is one resolved help invocation. Topic is read for Topic and
// UnknownCommand and ignored otherwise.
type Request struct {
	Mode  Mode
	Topic string
}

// HasCommand reports whether the Node CLI has this command, from the spec's own
// command list. It is what lets the Go front door answer an unknown command
// instead of exec'ing Node to be told the same thing.
func HasCommand(name string) bool { return load().commands[name] }

// Commands returns the spec's command names — for the tests, and for anything
// that needs the same list the overview lists.
func Commands() []string {
	s := load()
	names := make([]string, 0, len(s.commands))
	for n := range s.commands {
		names = append(names, n)
	}
	return names
}

// Serve renders one help invocation and returns its exit code.
func Serve(s *bmio.Streams, req Request) int {
	spec := load()
	if spec.err != nil {
		return corrupt(s, spec.err.Error())
	}

	// `help --json` is the one mode that is not a replay. It is the surface
	// agents read, and prose flags are not a surface a machine can read, so it is
	// re-emitted with the derived structure spec.go describes. Enrichment is
	// strictly additive and provably so (TestUnenrichedRoundTripIsByteIdentical);
	// when it cannot be proved for these bytes, Structured says so and the
	// captured JSON is replayed unchanged below.
	if req.Mode == JSON {
		if structured, ok := Structured(); ok {
			if out, err := encodeSpec(structured); err == nil {
				s.OutRaw(out)
				return 0
			}
		}
	}

	key, topic := "", ""
	switch req.Mode {
	case Overview:
		key = "overview"
	case OverviewUsage:
		key = "overview-usage"
	case JSON:
		key = "json"
	case Man:
		key = "man"
	case Markdown:
		key = "markdown"
	case Topic:
		if spec.commands[req.Topic] {
			key = "command:" + req.Topic
		} else {
			// `help nosuchthing` — main.ts:224 answers with the same message the
			// switch default does.
			key, topic = "unknown-topic", req.Topic
		}
	case UnknownCommand:
		key, topic = "unknown-command", req.Topic
	default:
		return corrupt(s, fmt.Sprintf("unroutable help mode %d", req.Mode))
	}

	e, ok := spec.entries[key]
	if !ok {
		// Unreachable while the artifact matches the spec, which is what the
		// drift checks in artifact_test.go and helpArtifact.test.ts are for. A
		// generic message here instead would be the one way this design can lie
		// — approximate help that reads like the real thing — so it says the
		// artifact is broken and refuses, loudly.
		return corrupt(s, fmt.Sprintf("no entry %q", key))
	}

	stdout, stderr := e.stdout, e.stderr
	if topic != "" {
		stdout = strings.ReplaceAll(stdout, spec.placeholder, topic)
		stderr = strings.ReplaceAll(stderr, spec.placeholder, topic)
	}
	// Raw on both sides: the captured bytes already carry their own newlines,
	// and OutRaw/NoteRaw share the broken-pipe guard, which is what makes
	// `help --man | head -2` exit 0 (contract.mjs:126).
	if stderr != "" {
		s.NoteRaw(stderr)
	}
	if stdout != "" {
		s.OutRaw(stdout)
	}
	return e.exit
}

// corrupt reports a broken embed. Not a help message and not shaped like one: a
// binary that cannot find its own help text has a build problem, and printing
// something plausible instead would hide it.
func corrupt(s *bmio.Streams, detail string) int {
	s.Note("bullmoose: the embedded help artifact is unusable (" + detail + ")")
	s.Note("  this binary was built from a broken cli-go/internal/help/artifact.txt; regenerate with: " + Regenerate)
	return int(bmio.ExitFail)
}
