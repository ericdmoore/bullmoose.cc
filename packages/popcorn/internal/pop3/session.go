// Package pop3 is the barely-conforming server core (RFC 1939): the
// AUTHORIZATION → TRANSACTION → UPDATE state machine, dot-stuffed
// multiline responses, and translation onto the jmap client. Commands:
// USER PASS CAPA STAT LIST UIDL RETR TOP DELE RSET NOOP QUIT.
package pop3

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"strconv"
	"strings"
	"time"

	"bullmoose.cc/popcorn/internal/jmap"
	"bullmoose.cc/popcorn/internal/wire"
)

type Config struct {
	JMAPBase    string // "" → SRV discovery per login domain
	DeleMode    string // "archive" (default) | "noop"
	MaxMessages int
	IdleTimeout time.Duration
}

// maxCommandLine bounds one command line, counted in raw octets including the
// CRLF — the same 2048 the old post-hoc check counted, so a line refused before
// is refused now.
//
// It is deliberately not SMTP's 4096, and the gap is not an oversight to tidy
// away. RFC 1939 §3 gives POP3 a keyword "three or four characters long" and
// arguments "up to 40 characters long"; RFC 2449 §4 raises the whole command to
// "255 octets, including the terminating CRLF". Nothing here is the long AUTH
// exchange that buys SMTP its headroom — this face speaks USER and PASS and
// has no SASL — so 2048 is already eight times the largest conforming command,
// and raising it to match SMTP would only widen what an unauthenticated client
// can make popcorn hold on the primary listener.
const maxCommandLine = 2048

type Session struct {
	conn    net.Conn
	r       *bufio.Reader
	cfg     Config
	user    string
	client  *jmap.Client
	msgs    []jmap.Msg
	deleted map[int]bool
	roles   map[string]string
}

func Serve(conn net.Conn, cfg Config) {
	s := &Session{
		conn:    conn,
		r:       bufio.NewReaderSize(conn, 4096),
		cfg:     cfg,
		deleted: map[int]bool{},
	}
	defer conn.Close()
	s.ok("popcorn POP3 ready 🍿")

	for {
		_ = conn.SetDeadline(time.Now().Add(cfg.IdleTimeout))
		// The cap is enforced while the line arrives, not once it is whole:
		// this read used to be ReadString followed by a length check, which
		// objected only after bufio had assembled every byte the client sent.
		// That is the check without the bound, and this is the listener an
		// unauthenticated stranger reaches first.
		line, err := wire.ReadLine(s.r, maxCommandLine)
		if errors.Is(err, wire.ErrTooLong) {
			// Answer, then hang up: the reader is parked mid-line and the tail
			// of the flood is not commands.
			s.err("line too long")
			return
		}
		if err != nil {
			return
		}
		verb, arg := splitCommand(line)

		switch verb {
		case "QUIT":
			s.quit()
			return
		case "CAPA":
			s.ok("capabilities follow")
			s.multiline([]string{"USER", "UIDL", "TOP", "IMPLEMENTATION popcorn"})
		case "NOOP":
			s.ok("")
		case "USER":
			// RFC 1939 §5 puts USER and PASS in AUTHORIZATION state only; a
			// session that has a client has already left it. Accepting them
			// here re-snapshotted the maildrop underneath the message numbers
			// the client had already been handed, so QUIT applied the old
			// numbers to the new snapshot: it archived whichever message now
			// sat at that index — silently, and looking to the user exactly
			// like mail loss — or panicked on a maildrop that had shrunk,
			// which on a connection goroutine is the whole daemon.
			if s.client != nil {
				s.err("already authenticated")
				continue
			}
			s.user = arg
			s.ok("send PASS (an app-password token, not your login password)")
		case "PASS":
			if s.client != nil { // see USER: AUTHORIZATION-state commands only
				s.err("already authenticated")
				continue
			}
			s.pass(arg)
		case "STAT", "LIST", "UIDL", "RETR", "TOP", "DELE", "RSET":
			if s.client == nil {
				s.err("not authenticated")
				continue
			}
			s.transaction(verb, arg)
		default:
			s.err("unknown command")
		}
	}
}

func (s *Session) pass(password string) {
	if s.user == "" {
		s.err("USER first")
		return
	}
	base, err := jmap.Discover(s.user, s.cfg.JMAPBase)
	if err == nil {
		s.client, err = jmap.Login(base, s.user, password)
	}
	if err == nil {
		s.roles, err = s.client.Mailboxes()
	}
	if err == nil {
		inbox := s.roles["inbox"]
		if inbox == "" {
			err = fmt.Errorf("account has no inbox")
		} else {
			// POP3 requires stable message numbers for the whole
			// transaction — snapshot the maildrop at login.
			s.msgs, err = s.client.ListMailbox(inbox, s.cfg.MaxMessages)
			// The marks are indices into that snapshot, so the two are one
			// value and are replaced together. Serve refuses USER/PASS once
			// authenticated, so nothing can reach this twice today; the reset
			// is here so that if something ever does, it re-snapshots with an
			// empty maildrop rather than QUIT-ing the old numbers against the
			// new list.
			s.deleted = map[int]bool{}
		}
	}
	if err != nil {
		s.client = nil
		log.Printf("auth failed for %s: %v", s.user, err)
		time.Sleep(time.Second) // cheap brute-force friction
		s.err("authentication failed")
		return
	}
	s.ok(fmt.Sprintf("maildrop has %d message(s)", len(s.msgs)))
}

func (s *Session) transaction(verb, arg string) {
	switch verb {
	case "STAT":
		n, size := s.tally()
		s.ok(fmt.Sprintf("%d %d", n, size))
	case "LIST":
		s.scanListing(arg, func(i int, m jmap.Msg) string { return strconv.Itoa(m.Size) })
	case "UIDL":
		s.scanListing(arg, func(i int, m jmap.Msg) string { return m.ID })
	case "RETR":
		s.retr(arg, -1)
	case "TOP":
		parts := strings.Fields(arg)
		if len(parts) != 2 {
			s.err("usage: TOP msg n")
			return
		}
		lines, err := strconv.Atoi(parts[1])
		if err != nil || lines < 0 {
			s.err("bad line count")
			return
		}
		s.retr(parts[0], lines)
	case "DELE":
		i, m := s.lookup(arg)
		if m == nil {
			return
		}
		s.deleted[i] = true
		s.ok(fmt.Sprintf("message %d deleted (server keeps a copy — popcorn archives, never destroys)", i))
	case "RSET":
		s.deleted = map[int]bool{}
		n, size := s.tally()
		s.ok(fmt.Sprintf("%d %d", n, size))
	}
}

func (s *Session) quit() {
	if s.client != nil && len(s.deleted) > 0 && s.cfg.DeleMode != "noop" {
		archive := s.roles["archive"]
		ids := make([]string, 0, len(s.deleted))
		for i := range s.deleted {
			ids = append(ids, s.msgs[i-1].ID)
		}
		if archive == "" {
			log.Printf("no archive mailbox; leaving %d 'deleted' message(s) in place", len(ids))
		} else if err := s.client.Archive(ids, archive); err != nil {
			log.Printf("archive on QUIT failed: %v", err)
			s.err("update failed; no messages removed")
			return
		}
	}
	s.ok("popcorn signing off")
}

// ---- helpers -----------------------------------------------------------

func (s *Session) tally() (int, int) {
	n, size := 0, 0
	for i, m := range s.msgs {
		if !s.deleted[i+1] {
			n++
			size += m.Size
		}
	}
	return n, size
}

// lookup resolves a 1-based message number, replying -ERR on any problem.
func (s *Session) lookup(arg string) (int, *jmap.Msg) {
	i, err := strconv.Atoi(strings.TrimSpace(arg))
	if err != nil || i < 1 || i > len(s.msgs) {
		s.err("no such message")
		return 0, nil
	}
	if s.deleted[i] {
		s.err("message deleted")
		return 0, nil
	}
	return i, &s.msgs[i-1]
}

func (s *Session) scanListing(arg string, field func(int, jmap.Msg) string) {
	if strings.TrimSpace(arg) != "" {
		i, m := s.lookup(arg)
		if m == nil {
			return
		}
		s.ok(fmt.Sprintf("%d %s", i, field(i, *m)))
		return
	}
	n, size := s.tally()
	s.ok(fmt.Sprintf("%d messages (%d octets)", n, size))
	lines := make([]string, 0, n)
	for i, m := range s.msgs {
		if !s.deleted[i+1] {
			lines = append(lines, fmt.Sprintf("%d %s", i+1, field(i+1, m)))
		}
	}
	s.multiline(lines)
}

// retr streams a message (topLines < 0) or its headers + topLines (TOP).
func (s *Session) retr(arg string, topLines int) {
	_, m := s.lookup(arg)
	if m == nil {
		return
	}
	body, err := s.client.Download(m.BlobID)
	if err != nil {
		log.Printf("download %s: %v", m.BlobID, err)
		s.err("could not fetch message")
		return
	}
	defer body.Close()
	raw, err := io.ReadAll(io.LimitReader(body, 64<<20))
	if err != nil {
		s.err("could not fetch message")
		return
	}
	// Big messages stream slower than the idle deadline allows.
	_ = s.conn.SetDeadline(time.Now().Add(5 * time.Minute))

	lines := strings.Split(string(raw), "\n")
	if topLines >= 0 {
		lines = topSlice(lines, topLines)
		s.ok("top of message follows")
	} else {
		s.ok(fmt.Sprintf("%d octets", len(raw)))
	}
	w := bufio.NewWriterSize(s.conn, 32<<10)
	for _, line := range lines {
		line = strings.TrimRight(line, "\r")
		if strings.HasPrefix(line, ".") {
			line = "." + line // RFC 1939 §3 dot-stuffing
		}
		w.WriteString(line)
		w.WriteString("\r\n")
	}
	w.WriteString(".\r\n")
	w.Flush()
}

// topSlice keeps all headers, the blank separator, and n body lines.
func topSlice(lines []string, n int) []string {
	for i, line := range lines {
		if strings.TrimRight(line, "\r") == "" {
			end := i + 1 + n
			if end > len(lines) {
				end = len(lines)
			}
			return lines[:end]
		}
	}
	return lines // headers only, no body separator found
}

func splitCommand(line string) (string, string) {
	verb, arg, _ := strings.Cut(line, " ")
	return strings.ToUpper(strings.TrimSpace(verb)), strings.TrimSpace(arg)
}

func (s *Session) ok(msg string)  { fmt.Fprintf(s.conn, "+OK %s\r\n", msg) }
func (s *Session) err(msg string) { fmt.Fprintf(s.conn, "-ERR %s\r\n", msg) }

func (s *Session) multiline(lines []string) {
	w := bufio.NewWriter(s.conn)
	for _, line := range lines {
		if strings.HasPrefix(line, ".") {
			line = "." + line
		}
		w.WriteString(line)
		w.WriteString("\r\n")
	}
	w.WriteString(".\r\n")
	w.Flush()
}
