package bmio

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

// §1.1 / §1.3 / §1.8 framing, and the §1.2 broken-pipe handler in isolation.
// The end-to-end broken-pipe proof against a real closed pipe is in
// main_test.go; these assert the pieces.

func TestOutAndNoteRouteToTheRightStream(t *testing.T) {
	var out, err bytes.Buffer
	s := NewTo(&out, &err)

	s.Out("a record")   // §1.1 — results to stdout
	s.Note("progress")  // §1.1 — chrome to stderr
	s.Warn("watch out") // §1.1 — greppable warning to stderr

	if out.String() != "a record\n" {
		t.Errorf("stdout = %q, want the record and one newline", out.String())
	}
	if got := err.String(); got != "progress\nwarning: watch out\n" {
		t.Errorf("stderr = %q, want note then prefixed warning", got)
	}
}

func TestOutRawHasNoTrailingNewline(t *testing.T) {
	var out bytes.Buffer
	NewTo(&out, &out).OutRaw("raw bytes")
	if out.String() != "raw bytes" {
		t.Errorf("OutRaw wrote %q, want the bytes verbatim with no newline", out.String())
	}
}

func TestEmitJSONIsOneCompactLine(t *testing.T) {
	var out bytes.Buffer
	s := NewTo(&out, &out)

	// A value with an HTML-significant byte: JSON.stringify leaves `<` alone,
	// and marshalCompact must too (SetEscapeHTML(false), io.ts:233).
	if err := s.EmitJSON(map[string]string{"id": "em_001", "subject": "a < b"}); err != nil {
		t.Fatal(err)
	}
	line := out.String()
	if strings.Count(line, "\n") != 1 || !strings.HasSuffix(line, "\n") {
		t.Errorf("EmitJSON produced %q, want exactly one line", line)
	}
	// The literal "<" must survive; encoding/json's default HTML escape
	// (backslash-u-003c) must not appear. JSON.stringify leaves "<" alone
	// (io.ts:233). escaped is that 6-byte sequence written without triggering
	// this source file's own unicode escaping.
	escaped := "\\u003c"
	if strings.Contains(line, escaped) || !strings.Contains(line, "a < b") {
		t.Errorf("EmitJSON must leave < literal like JSON.stringify, not escape it: %q", line)
	}
	var back map[string]string
	if err := json.Unmarshal([]byte(line), &back); err != nil {
		t.Fatalf("the line is not valid JSON: %v (%q)", err, line)
	}
	if back["id"] != "em_001" || back["subject"] != "a < b" {
		t.Errorf("round-trip changed the value: %v", back)
	}
}

func TestEmitNDJSONIsOnePerLineWithNoArray(t *testing.T) {
	var out bytes.Buffer
	s := NewTo(&out, &out)

	rows := []any{
		map[string]string{"id": "em_001"},
		map[string]string{"id": "em_002"},
		map[string]string{"id": "em_003"},
	}
	if err := s.EmitNDJSON(rows); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimRight(out.String(), "\n"), "\n")
	if len(lines) != 3 {
		t.Fatalf("NDJSON produced %d lines, want 3: %q", len(lines), out.String())
	}
	for _, l := range lines {
		if strings.HasPrefix(l, "[") {
			t.Errorf("NDJSON must not wrap in an array: %q", l)
		}
		var obj map[string]string
		if err := json.Unmarshal([]byte(l), &obj); err != nil {
			t.Errorf("line is not one JSON value: %q", l)
		}
	}
}

func TestEmitIDsAreBare(t *testing.T) {
	var out bytes.Buffer
	NewTo(&out, &out).EmitIDs([]string{"em_001", "em_002"})
	if out.String() != "em_001\nem_002\n" {
		t.Errorf("EmitIDs = %q, want one bare id per line and nothing else", out.String())
	}
}

// TestBrokenPipeWriteExitsZero — the §1.2 guard, in isolation: a write that
// fails with EPIPE exits 0, because the downstream reader got what it asked for
// (io.ts:289).
func TestBrokenPipeWriteExitsZero(t *testing.T) {
	var code int
	called := false
	s := &Streams{
		out:  errWriter{syscallEPIPE},
		err:  errWriter{syscallEPIPE},
		exit: func(c int) { code, called = c, true },
	}
	s.Out("this line meets a closed reader")
	if !called {
		t.Fatal("a broken-pipe write must trigger exit")
	}
	if code != int(ExitOK) {
		t.Errorf("broken pipe exited %d, want %d (a closed reader is not a failure)", code, int(ExitOK))
	}
}

// TestNonPipeWriteErrorExitsOne — any OTHER write error means the stream cannot
// be trusted; exit non-zero so `set -e` sees it (io.ts:291).
func TestNonPipeWriteErrorExitsOne(t *testing.T) {
	var code int
	s := &Streams{
		out:  errWriter{errPlain("disk full")},
		err:  errWriter{errPlain("disk full")},
		exit: func(c int) { code = c },
	}
	s.Out("nowhere to go")
	if code != int(ExitFail) {
		t.Errorf("a non-pipe write error exited %d, want %d", code, int(ExitFail))
	}
}

// errWriter fails every write with a fixed error.
type errWriter struct{ err error }

func (w errWriter) Write([]byte) (int, error) { return 0, w.err }
