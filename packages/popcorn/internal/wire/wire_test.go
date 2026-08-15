package wire

import (
	"bufio"
	"io"
	"runtime"
	"strings"
	"testing"
)

// The read buffer both faces give their sessions. Every boundary that matters
// here is a boundary against this number, so the tests state it once.
const bufSize = 4096

func reader(s string) *bufio.Reader {
	return bufio.NewReaderSize(strings.NewReader(s), bufSize)
}

// ---- the bound ---------------------------------------------------------------

// allocatedBy reports how many bytes the allocator handed out while f ran.
//
// TotalAlloc is cumulative and unaffected by collection, so this measures what
// was allocated rather than what is still live — which is the number that
// matters: the hazard is a stranger being able to make popcorn allocate at all,
// not whether the collector catches up afterwards.
func allocatedBy(f func()) uint64 {
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	f()
	runtime.ReadMemStats(&after)
	return after.TotalAlloc - before.TotalAlloc
}

// The claim this package exists to make, measured rather than asserted by
// analogy: reading one enormous line costs memory proportional to the cap, not
// to the line.
//
// "Rejects the line" and "does not allocate the line" are different claims, and
// bufio's own ReadString passes the first while failing the second — so it is
// the control here. Both sides read the same bytes through the same size of
// buffer, and the number this test trusts is the ratio between two measurements
// taken on this machine on this run, not a constant somebody picked.
func TestReadLineBoundsWhatOneLineCanAllocate(t *testing.T) {
	// One "line" from a client that has not authenticated and never will.
	const flood = 8 << 20
	line := strings.Repeat("a", flood) + "\r\n"

	// The control: what this package replaced, on the same input. bufio
	// collects the fragments and then joins them, so the cost tracks the line.
	//
	// The reader is built outside the measured call in both cases, so what is
	// being compared is the read and not the fixed cost of the buffer.
	var got string
	var err error
	br := reader(line)
	control := allocatedBy(func() {
		got, err = br.ReadString('\n')
	})
	if err != nil || len(got) != flood+2 {
		t.Fatalf("control read %d bytes, err %v; want the whole %d-byte line", len(got), err, flood+2)
	}
	if control < flood {
		t.Fatalf("the control allocated %d bytes for an %d-byte line — this measurement is not measuring what the test thinks it is", control, flood)
	}

	// Both faces' caps. The 2048 case never reaches a second ReadSlice (the
	// first bufferful already overshoots); the 4096 case accumulates one
	// bufferful first and stops on the next, which is the path that would
	// notice a builder allowed to keep growing.
	for _, max := range []int{2048, 4096} {
		var berr error
		br := reader(line)
		bounded := allocatedBy(func() {
			_, berr = ReadLine(br, max)
		})
		if berr != ErrTooLong {
			t.Fatalf("cap %d: ReadLine on an %d-byte line = %v, want ErrTooLong", max, flood, berr)
		}
		// Generous — the expectation is single-digit kilobytes — because the
		// finding is four orders of magnitude, and a threshold tight enough to
		// flake would only teach people to loosen it.
		if bounded > 64<<10 {
			t.Errorf("cap %d: reading an %d-byte line allocated %d bytes; the cap must bound the memory, not just the verdict", max, flood, bounded)
		}
		if bounded*100 > control {
			t.Errorf("cap %d: allocated %d bytes against the control's %d — that is not a bound, it is a discount", max, bounded, control)
		}
		t.Logf("cap %d: %d bytes, against %d for bufio's own ReadString on the same line", max, bounded, control)
	}
}

// The cap counts raw octets including the terminator, because that is how both
// RFCs state their limits and therefore how a caller sets it from one. Off by
// one in either direction is either a conforming command refused or a cap that
// is not the number it says.
func TestReadLineCountsTheTerminatorInTheCap(t *testing.T) {
	for _, tc := range []struct {
		name string
		raw  string
		max  int
		want string
		err  error
	}{
		{"exactly at the cap", "ab\r\n", 4, "ab", nil},
		{"one octet over", "abc\r\n", 4, "", ErrTooLong},
		{"the CRLF is what pushes it over", "abcd\r\n", 5, "", ErrTooLong},
		{"a bare LF still counts its one octet", "abcd\n", 5, "abcd", nil},
		{"well under", "NOOP\r\n", 2048, "NOOP", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ReadLine(reader(tc.raw), tc.max)
			if err != tc.err || got != tc.want {
				t.Errorf("ReadLine(%q, %d) = (%q, %v), want (%q, %v)", tc.raw, tc.max, got, err, tc.want, tc.err)
			}
		})
	}
}

// A line longer than the read buffer but shorter than the cap arrives in more
// than one ReadSlice, and must come back whole. This is the case the cap makes
// possible for SMTP — maxCommandLine is 4096 there, the buffer is 4096, so an
// AUTH continuation of exactly buffer length is reassembled rather than refused.
func TestReadLineReassemblesALineThatCrossesTheBuffer(t *testing.T) {
	long := strings.Repeat("x", bufSize)
	got, err := ReadLine(reader(long+"\r\n"), 64<<10)
	if err != nil {
		t.Fatalf("ReadLine on a %d-byte line: %v", len(long), err)
	}
	if got != long {
		t.Errorf("reassembled %d bytes, want %d", len(got), len(long))
	}
}

// A line that ends without a terminator is a client that hung up mid-command.
// The caller gets the error and nothing else: a half-line handed back as a
// command is a command the client did not send.
func TestReadLineReportsATruncatedLineRatherThanGuessing(t *testing.T) {
	got, err := ReadLine(reader("USER corny"), 2048)
	if err != io.EOF {
		t.Errorf("ReadLine on an unterminated line = %v, want io.EOF", err)
	}
	if got != "" {
		t.Errorf("ReadLine returned %q for a line that never ended", got)
	}
}

// ---- the drain ---------------------------------------------------------------

// The boundary case the flag exists for, at the unit level: a line longer than
// the buffer whose final bytes are the terminator's. The fill lands so that
// ReadSlice returns ".\r\n" on its own, which is byte-for-byte what the real
// terminator looks like — and it is not one, because it is the tail of a line
// the drain is in the middle of.
//
// Getting this wrong stops the drain inside somebody's message and hands the
// rest of it to the command reader, which is exactly the smuggling the drain
// was added to prevent.
func TestDrainDoesNotStopAtATerminatorThatIsOnlyALineTail(t *testing.T) {
	// A body line of one whole bufferful of filler, then ".", so the reader
	// sees bufSize bytes with no newline followed by ".\r\n".
	body := strings.Repeat("y", bufSize) + ".\r\n" +
		"RCPT TO:<attacker@evil.example>\r\n" +
		".\r\n" +
		"NOOP\r\n" // must still be here for the command loop afterwards

	r := reader(body)
	found, err := Drain(r, 1<<20, ".")
	if err != nil || !found {
		t.Fatalf("Drain = (%v, %v), want the terminator found", found, err)
	}
	rest, _ := ReadLine(r, 2048)
	if rest != "NOOP" {
		t.Errorf("the drain stopped at %q — a dot on a fill boundary is a line tail, not the end of the body", rest)
	}
}

// The ordinary case, kept next to the boundary one so a change that breaks the
// flag cannot be mistaken for a change that breaks the terminator.
func TestDrainStopsAtTheTerminatorAndLeavesTheRest(t *testing.T) {
	r := reader("one\r\ntwo\r\n.\r\nNOOP\r\n")
	found, err := Drain(r, 1<<20, ".")
	if err != nil || !found {
		t.Fatalf("Drain = (%v, %v), want the terminator found", found, err)
	}
	if rest, _ := ReadLine(r, 2048); rest != "NOOP" {
		t.Errorf("after the drain the reader is at %q, want NOOP", rest)
	}
}

// Draining is itself a way to hold a connection open for free, so it is
// bounded. Running out of budget is not an error — the caller distinguishes
// "never terminated" from "connection failed", and logs only the first.
func TestDrainGivesUpWhenTheBudgetRunsOut(t *testing.T) {
	endless := strings.Repeat("y", 100) + "\r\n"
	found, err := Drain(reader(strings.Repeat(endless, 100)), 512, ".")
	if found || err != nil {
		t.Errorf("Drain over budget = (%v, %v), want (false, nil)", found, err)
	}
}

// The budget bounds bytes read, not lines, or a single line with no newline in
// it would be read forever — which is the same unbounded read in a different
// costume.
func TestDrainBoundsALineThatNeverEnds(t *testing.T) {
	// bytes.Reader would return EOF and end the loop by accident; this never
	// does, so only the budget can stop it.
	found, err := Drain(bufio.NewReaderSize(endlessReader{}, bufSize), 1<<20, ".")
	if found || err != nil {
		t.Errorf("Drain over a line that never ends = (%v, %v), want (false, nil)", found, err)
	}
}

// endlessReader is one line with no end to it: the client that connects and
// streams, which is the traffic every bound in this package is against.
type endlessReader struct{}

func (endlessReader) Read(p []byte) (int, error) {
	for i := range p {
		p[i] = 'y'
	}
	return len(p), nil
}
