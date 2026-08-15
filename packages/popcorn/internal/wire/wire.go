// Package wire is the reading both protocol faces do before they know who is
// on the other end, with a bound on what one line of it can cost.
//
// bufio's line helpers have no such bound. ReadString and ReadBytes loop over
// the fixed buffer collecting fragments and then join them, so what comes back
// is as long as the client cared to make it: an allocation the client chooses
// and popcorn does not, on one of 64 shared connection slots, before
// authentication. ReadSlice is the primitive that does not do that — it works
// inside the existing buffer and says so when a line will not fit — and
// everything here is built on it.
//
// A cap checked after the read is a different thing and not a substitute. It
// bounds what the caller will *parse*; the hazard is what the process was made
// to *hold*, which by then it already has. SMTP learned this in #141; POP3 was
// left with the post-hoc form until this package existed to share. Both faces
// now read through the same code, so the next protocol edge here is learned
// once instead of twice.
package wire

import (
	"bufio"
	"errors"
	"strings"
)

// ErrTooLong means the cap was reached with the rest of the line still unread.
// The session cannot resume from there — whatever follows the cut is not a
// command — so every caller answers and then closes the connection.
var ErrTooLong = errors.New("line too long")

// ReadLine reads one line, CRLF stripped, and refuses to buffer more than max
// bytes of it.
//
// max counts raw octets including the terminator, which is how both protocols'
// RFCs state their limits, and so how a caller can set it straight from one.
func ReadLine(r *bufio.Reader, max int) (string, error) {
	var line strings.Builder
	for {
		chunk, err := r.ReadSlice('\n')
		// Before the copy, not after: this is the whole difference between a
		// bound and a complaint.
		if len(chunk) > max-line.Len() {
			return "", ErrTooLong
		}
		line.Write(chunk) // copies; chunk aliases r's buffer until the next read
		if err == bufio.ErrBufferFull {
			// Longer than the whole buffer, so this is a fragment and the rest
			// of the line is still coming.
			continue
		}
		if err != nil {
			return "", err
		}
		return strings.TrimRight(line.String(), "\r\n"), nil
	}
}

// Drain consumes and throws away whole lines until it reads a complete one
// equal to term (CRLF stripped), reporting whether it found it. It gives up
// after budget bytes: a drain a client can extend forever is a connection slot
// held open for free, which is the shape of the problem it is here to end.
//
// It reads through ReadSlice for the same reason ReadLine does — a drain that
// grew to hold a line it is about to discard would be its own version of the
// thing it exists to fix — and that is what makes partial necessary. A line
// longer than the buffer arrives in more than one ReadSlice and only its last
// piece ends at a newline, so without the flag a body line whose final bytes
// happen to be ".\r\n" — because the filler ahead of them landed exactly on a
// fill boundary — is indistinguishable from the terminator. A drain that stops
// there is still inside somebody's message, and hands the rest of it back to
// the command reader to be executed.
func Drain(r *bufio.Reader, budget int, term string) (bool, error) {
	partial := false // mid-way through a line longer than the read buffer
	for budget > 0 {
		chunk, err := r.ReadSlice('\n')
		budget -= len(chunk)
		if err == bufio.ErrBufferFull {
			partial = true
			continue
		}
		if err != nil {
			return false, err
		}
		if !partial && strings.TrimRight(string(chunk), "\r\n") == term {
			return true, nil
		}
		partial = false
	}
	return false, nil
}
