package bmio

import (
	"strings"
	"testing"
)

// Colour policy is io.ts:260, and the cases below are the exact clauses the
// contract suite depends on: no ANSI under a pipe (contract.mjs:342), NO_COLOR
// honoured (contract.mjs:347), and — the subtle one — an EMPTY NO_COLOR must NOT
// force colour off, because the smoke harness sets NO_COLOR="" for its normal
// runs (contract.mjs:93).

func TestColorEnabled(t *testing.T) {
	cases := []struct {
		name    string
		noColor *string // nil = leave as baseline "", non-nil = set to this
		term    string
		isTTY   bool
		want    bool
	}{
		{"tty, clean env → on", nil, "xterm-256color", true, true},
		{"pipe (not a tty) → off", nil, "xterm-256color", false, false},
		{"NO_COLOR=1 overrides a tty → off", ptr("1"), "xterm-256color", true, false},
		{"NO_COLOR empty does NOT force off", ptr(""), "xterm-256color", true, true},
		{"TERM=dumb → off even on a tty", nil, "dumb", true, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			// A clean baseline so the developer's own environment cannot leak in.
			if c.noColor == nil {
				t.Setenv("NO_COLOR", "")
			} else {
				t.Setenv("NO_COLOR", *c.noColor)
			}
			t.Setenv("TERM", c.term)

			if got := ColorEnabled(NewStream(c.isTTY)); got != c.want {
				t.Errorf("ColorEnabled = %v, want %v", got, c.want)
			}
		})
	}
}

func TestDim(t *testing.T) {
	t.Setenv("NO_COLOR", "")
	t.Setenv("TERM", "xterm-256color")

	// On a tty, dim wraps with the ANSI dim SGR and a reset (io.ts:269).
	on := Dim("hint", NewStream(true))
	if !strings.HasPrefix(on, "\x1b[2m") || !strings.HasSuffix(on, "\x1b[0m") || !strings.Contains(on, "hint") {
		t.Errorf("Dim on a tty = %q, want it wrapped in the dim SGR", on)
	}

	// Off a tty, the text is returned unchanged — no escape can reach a pipe.
	if off := Dim("hint", NewStream(false)); off != "hint" {
		t.Errorf("Dim under a pipe = %q, want the text unchanged", off)
	}
}

func ptr(s string) *string { return &s }
