package bmio

import (
	"os"

	"golang.org/x/term"
)

// §1.6 — no TTY assumptions, honour NO_COLOR (io.ts:252).

// Stream is the minimal view colour policy needs: whether the destination is a
// terminal. It mirrors io.ts's `{ isTTY?: boolean }` (io.ts:260), the only
// property colorEnabled reads, and keeps the policy unit-testable without a real
// terminal.
type Stream struct {
	isTTY bool
}

// NewStream builds a Stream with an explicit TTY answer. Callers that already
// know (and every test) use this, exactly as io.ts passes a fake `{ isTTY }`.
func NewStream(isTTY bool) Stream { return Stream{isTTY: isTTY} }

// Stdout and Stderr report whether the real descriptor is a terminal.
//
// isatty via golang.org/x/term — see the dependency note in go.mod. It runs the
// OS's terminal ioctl on the actual fd (os.Stdout.Fd()), which is what Node's
// own isatty does for process.stdout.isTTY (io.ts:260), so colour turns on and
// off identically across the two implementations. The coarse stdlib alternative,
// os.Stat().Mode()&os.ModeCharDevice, cannot tell a terminal from /dev/null —
// both are character devices — and would enable colour on `cmd > /dev/null`,
// diverging from Node in exactly the contract this file exists to hold.
func Stdout() Stream { return Stream{isTTY: term.IsTerminal(int(os.Stdout.Fd()))} }
func Stderr() Stream { return Stream{isTTY: term.IsTerminal(int(os.Stderr.Fd()))} }

// ColorEnabled reports whether ANSI colour is allowed on a stream — io.ts:260.
// Colour is opt-out by environment and off by default under a pipe. The exact
// rule, transcribed rather than reinvented:
//
//	NO_COLOR set AND non-empty  → off  (an EMPTY NO_COLOR does NOT force off:
//	                                    io.ts:262 tests `!== undefined && !== ""`,
//	                                    and the contract sets NO_COLOR="")
//	TERM == "dumb"              → off
//	otherwise                   → on iff the stream is a TTY
func ColorEnabled(s Stream) bool {
	if v, ok := os.LookupEnv("NO_COLOR"); ok && v != "" {
		return false
	}
	if os.Getenv("TERM") == "dumb" {
		return false
	}
	return s.isTTY
}

// Dim wraps text in the ANSI dim SGR, or returns it unchanged where colour is
// not allowed — io.ts:268. io.ts defaults its stream to stderr; Go has no
// default parameters, so the stream is always explicit here.
func Dim(text string, s Stream) string {
	if ColorEnabled(s) {
		return "\x1b[2m" + text + "\x1b[0m"
	}
	return text
}
