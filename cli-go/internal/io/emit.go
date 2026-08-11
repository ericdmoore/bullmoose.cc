package bmio

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strings"
)

// §1.1 stdout is data / §1.2 EPIPE is not an error / §1.3 --json is NDJSON /
// §1.8 composition affordances, all in one output object.
//
// Streams is the output side of the contract. stdout carries records and
// nothing else; stderr carries progress, warnings and errors (io.ts:195). A
// write to a reader that closed early is not a failure — it exits 0 (io.ts:272).

// Streams routes output and turns a broken pipe into a clean exit. Build one
// with New() for the process streams, or NewTo(out, err) for a test.
type Streams struct {
	out io.Writer
	err io.Writer
	// exit ends the process. In production it is os.Exit and never returns,
	// exactly like process.exit in io.ts:289/292. It is a field so a test can
	// observe the broken-pipe and write-error paths without the test binary
	// exiting.
	exit func(int)
}

// New writes to the process's real stdout/stderr and exits the process on a
// write error, which is the behaviour the contract asserts.
func New() *Streams {
	return &Streams{out: os.Stdout, err: os.Stderr, exit: func(code int) { os.Exit(code) }}
}

// NewTo captures output into arbitrary writers and makes exit a no-op — for
// tests that assert on framing rather than on process disposition.
func NewTo(out, err io.Writer) *Streams {
	return &Streams{out: out, err: err, exit: func(int) {}}
}

// write is the one place a write error is interpreted. io.ts installs its guard
// on the stream 'error' event and on uncaughtException (io.ts:287) because a
// broken pipe surfaces asynchronously there; in Go a write returns its error
// synchronously, so every output method funnels through here.
func (s *Streams) write(w io.Writer, str string) {
	if _, err := io.WriteString(w, str); err != nil {
		if IsBrokenPipe(err) {
			// The downstream reader got what it asked for, so nothing failed
			// (io.ts:289). `log | head -3` is the canonical case.
			s.exit(int(ExitOK))
			return
		}
		// Not a broken pipe: the stream cannot be trusted, so do not try to
		// print through it. Exit non-zero so `set -e` sees the failure
		// (io.ts:291).
		s.exit(int(ExitFail))
	}
}

// Out writes a record — the thing the user asked for. stdout, one line
// (io.ts:206). Results go here; everything about producing them goes to Note.
func (s *Streams) Out(line string) { s.write(s.out, line+"\n") }

// OutRaw writes bytes straight to stdout with no trailing newline — `read --raw`,
// `help --man` (io.ts:211). It shares the broken-pipe guard, which is why the
// contract's `help --man | head -2` case (contract.mjs:126) exits 0.
func (s *Streams) OutRaw(chunk string) { s.write(s.out, chunk) }

// Note writes chrome: progress, summaries, decoration, hints. stderr
// (io.ts:216).
func (s *Streams) Note(line string) { s.write(s.err, line+"\n") }

// Warn writes a warning, prefixed so it is greppable — stderr (io.ts:221).
func (s *Streams) Warn(line string) { s.Note("warning: " + line) }

// EmitJSON writes one JSON value on one line — io.ts:232. Compact on purpose:
// under --json every line of stdout is a complete value, so `| head` truncates
// cleanly and `| jq` streams instead of buffering (io.ts:227).
func (s *Streams) EmitJSON(value any) error {
	line, err := marshalCompact(value)
	if err != nil {
		return err
	}
	s.Out(line)
	return nil
}

// EmitNDJSON writes a collection as one record per line, with no wrapping array
// (io.ts:237, §1.3).
func (s *Streams) EmitNDJSON(rows []any) error {
	for _, row := range rows {
		if err := s.EmitJSON(row); err != nil {
			return err
		}
	}
	return nil
}

// EmitIDs writes one bare identifier per line and nothing else — the `xargs`
// shape (io.ts:248, §1.8).
func (s *Streams) EmitIDs(ids []string) {
	for _, id := range ids {
		s.Out(id)
	}
}

// marshalCompact renders one JSON value on a single line, with HTML escaping
// OFF so bytes match JSON.stringify (io.ts:233): encoding/json escapes <, > and
// & to < etc. by default, which JSON.stringify does not. Both are valid
// JSON, but the vector-driven port keeps the two implementations byte-identical
// where it costs nothing.
func marshalCompact(value any) (string, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(value); err != nil {
		return "", err
	}
	// Encoder.Encode appends a newline; Out adds its own, so trim this one.
	return strings.TrimRight(buf.String(), "\n"), nil
}

// IsBrokenPipe reports whether a write failed because the reader closed early —
// the Go analogue of io.ts:302 (EPIPE / ERR_STREAM_DESTROYED /
// ERR_STREAM_WRITE_AFTER_END). On a real pipe the kernel returns EPIPE; writing
// after the fd is closed surfaces as ErrClosed on any platform, which stands in
// for Node's write-after-end.
func IsBrokenPipe(err error) bool {
	return errors.Is(err, syscallEPIPE) ||
		errors.Is(err, io.ErrClosedPipe) ||
		errors.Is(err, os.ErrClosed)
}
