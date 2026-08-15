// Package smtp is popcorn's submission face (kettle-corn mode): the
// RFC 6409 subset legacy clients need to SEND through the JMAP system.
// EHLO/HELO, AUTH PLAIN/LOGIN (app-password tokens), MAIL, RCPT, DATA,
// RSET, NOOP, QUIT — over implicit TLS, no STARTTLS (downgrade attacks
// live there; the tailscale variant is WireGuard-wrapped regardless).
//
// SMTP submission and JMAP submission are the same abstraction, so the
// translation is direct: MAIL FROM/RCPT TO become the EmailSubmission
// envelope (which is why BCC works correctly — recipients live in the
// envelope, never the headers), DATA becomes the uploaded blob, and
// Email/import files the message in Sent so every JMAP client sees it.
package smtp

import (
	"bufio"
	"encoding/base64"
	"errors"
	"fmt"
	"log"
	"net"
	"strings"
	"time"

	"bullmoose.cc/popcorn/internal/jmap"
)

type Config struct {
	JMAPBase    string // "" → SRV discovery per login domain
	MaxSize     int    // DATA byte cap
	IdleTimeout time.Duration
}

type session struct {
	conn     net.Conn
	r        *bufio.Reader
	cfg      Config
	client   *jmap.Client
	user     string
	idByAddr map[string]string // identity email → identityId
	mailFrom string
	rcptTo   []string
}

const maxRcpt = 100

// maxCommandLine bounds one command or AUTH continuation line. RFC 5321
// §4.5.3.1.4 caps commands at 512 octets and RFC 4954 §4 asks for room for
// long AUTH exchanges; 4096 clears both and matches the read buffer, so a
// conforming line never needs a second fill.
const maxCommandLine = 4096

// errLineTooLong means the cap was hit with the rest of the line still
// unread. The session cannot resume from there — whatever follows the cut is
// not a command — so every caller closes the connection.
var errLineTooLong = errors.New("command line too long")

func Serve(conn net.Conn, cfg Config) {
	s := &session{conn: conn, r: bufio.NewReaderSize(conn, 4096), cfg: cfg}
	defer conn.Close()
	s.reply("220 popcorn ESMTP submission ready 🍿")

	for {
		_ = conn.SetDeadline(time.Now().Add(cfg.IdleTimeout))
		line, err := s.readLine()
		if errors.Is(err, errLineTooLong) {
			s.reply("500 5.5.2 line too long")
			return
		}
		if err != nil {
			return
		}
		verb, arg := split(line)

		switch verb {
		case "QUIT":
			s.reply("221 2.0.0 popcorn signing off")
			return
		case "EHLO":
			s.reply("250-popcorn at your service")
			s.reply("250-AUTH PLAIN LOGIN")
			s.reply(fmt.Sprintf("250-SIZE %d", s.cfg.MaxSize))
			s.reply("250 8BITMIME")
		case "HELO":
			s.reply("250 popcorn at your service")
		case "NOOP":
			s.reply("250 2.0.0 OK")
		case "RSET":
			s.mailFrom, s.rcptTo = "", nil
			s.reply("250 2.0.0 flushed")
		case "AUTH":
			if !s.auth(arg) {
				return
			}
		case "MAIL":
			s.mail(arg)
		case "RCPT":
			s.rcpt(arg)
		case "DATA":
			if !s.data() {
				return
			}
		case "STARTTLS":
			s.reply("502 5.5.1 no STARTTLS here — connect with implicit TLS")
		default:
			s.reply("502 5.5.2 command not implemented")
		}
	}
}

// ---- AUTH --------------------------------------------------------------

// auth reports whether the session may continue, on the same terms as data:
// a continuation line that blew the length cap leaves the reader mid-line,
// and there is no resuming from that.
func (s *session) auth(arg string) bool {
	if s.client != nil {
		s.reply("503 5.5.1 already authenticated")
		return true
	}
	mech, initial, _ := strings.Cut(arg, " ")
	var user, pass string
	switch strings.ToUpper(mech) {
	case "PLAIN":
		if initial == "" {
			s.reply("334 ")
			line, err := s.readLine()
			if err != nil {
				return false
			}
			initial = line
		}
		raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(initial))
		parts := strings.Split(string(raw), "\x00")
		if err != nil || len(parts) != 3 {
			s.reply("501 5.5.4 malformed AUTH PLAIN")
			return true
		}
		user, pass = parts[1], parts[2]
	case "LOGIN":
		s.reply("334 VXNlcm5hbWU6") // "Username:"
		uLine, err := s.readLine()
		if err != nil {
			return false
		}
		s.reply("334 UGFzc3dvcmQ6") // "Password:"
		pLine, err := s.readLine()
		if err != nil {
			return false
		}
		u, _ := base64.StdEncoding.DecodeString(strings.TrimSpace(uLine))
		p, _ := base64.StdEncoding.DecodeString(strings.TrimSpace(pLine))
		user, pass = string(u), string(p)
	default:
		s.reply("504 5.5.4 only PLAIN and LOGIN")
		return true
	}

	base, err := jmap.Discover(user, s.cfg.JMAPBase)
	var client *jmap.Client
	if err == nil {
		client, err = jmap.Login(base, user, pass)
	}
	var ids []jmap.Identity
	if err == nil {
		ids, err = client.Identities()
	}
	if err != nil || len(ids) == 0 {
		log.Printf("smtp auth failed for %s: %v", user, err)
		time.Sleep(time.Second)
		s.reply("535 5.7.8 authentication failed")
		return true
	}
	s.client, s.user = client, user
	s.idByAddr = map[string]string{}
	for _, id := range ids {
		s.idByAddr[strings.ToLower(id.Email)] = id.ID
	}
	s.reply("235 2.7.0 accepted")
	return true
}

// ---- envelope ----------------------------------------------------------

func (s *session) mail(arg string) {
	if s.client == nil {
		s.reply("530 5.7.0 authentication required")
		return
	}
	addr := extractAddr(arg, "FROM")
	if addr == "" {
		s.reply("501 5.5.4 usage: MAIL FROM:<address>")
		return
	}
	// The spoof guard: you may only submit as an identity you own. The
	// JMAP server enforces this again at submission — this just gives
	// legacy clients a comprehensible error at the right moment.
	if _, ok := s.idByAddr[strings.ToLower(addr)]; !ok {
		s.reply(fmt.Sprintf("550 5.7.1 %s is not an identity of %s", addr, s.user))
		return
	}
	s.mailFrom, s.rcptTo = addr, nil
	s.reply("250 2.1.0 sender OK")
}

func (s *session) rcpt(arg string) {
	if s.mailFrom == "" {
		s.reply("503 5.5.1 MAIL first")
		return
	}
	addr := extractAddr(arg, "TO")
	if addr == "" {
		s.reply("501 5.5.4 usage: RCPT TO:<address>")
		return
	}
	if len(s.rcptTo) >= maxRcpt {
		s.reply("452 4.5.3 too many recipients")
		return
	}
	s.rcptTo = append(s.rcptTo, addr)
	s.reply("250 2.1.5 recipient OK")
}

// data runs one DATA transaction. It reports whether the session may
// continue; false means the command stream can no longer be trusted and the
// connection must be closed.
func (s *session) data() bool {
	if s.mailFrom == "" || len(s.rcptTo) == 0 {
		s.reply("503 5.5.1 need MAIL and RCPT first")
		return true
	}
	s.reply("354 end with <CRLF>.<CRLF>")

	// Read the dot-terminated body, un-stuffing leading "..".
	var raw strings.Builder
	_ = s.conn.SetDeadline(time.Now().Add(5 * time.Minute))
	for {
		line, err := s.r.ReadString('\n')
		if err != nil {
			return false
		}
		trimmed := strings.TrimRight(line, "\r\n")
		if trimmed == "." {
			break
		}
		trimmed = strings.TrimPrefix(trimmed, ".")
		if raw.Len()+len(trimmed) > s.cfg.MaxSize {
			s.reply(fmt.Sprintf("552 5.3.4 message exceeds %d bytes", s.cfg.MaxSize))
			return s.discardBody()
		}
		raw.WriteString(trimmed)
		raw.WriteString("\r\n")
	}

	identityID := s.idByAddr[strings.ToLower(s.mailFrom)]
	subID, err := s.client.Send([]byte(raw.String()), s.mailFrom, s.rcptTo, identityID)
	if err != nil {
		log.Printf("smtp submit for %s failed: %v", s.user, err)
		s.reply("554 5.0.0 submission failed: " + oneLine(err.Error()))
	} else {
		// The id comes from the JMAP server, so it is interpolated through
		// oneLine like every other remote-controlled value: a CRLF in it
		// would let that server write extra reply lines into this stream.
		s.reply("250 2.0.0 queued as " + oneLine(subID))
	}
	s.mailFrom, s.rcptTo = "", nil
	return true
}

// discardBody consumes the remainder of a DATA body that will not be
// submitted, stopping at the terminating dot, and reports whether the
// session may continue.
//
// Returning without it left the rest of the message in the reader, where
// Serve read it as commands: a "RCPT TO:<attacker@evil.example>" line typed
// into a message body was answered "250 recipient OK" and joined the
// envelope, which was still live. So the envelope goes first, then the body.
//
// Draining is itself the hazard — a client that never sends the dot would
// keep us reading — so it is bounded by the same byte count the message was
// already allowed. One DATA therefore never reads more than 2×MaxSize, and a
// body that outlasts that budget costs its sender the connection rather than
// this process's attention. Nothing is lost by hanging up: the 552 has
// already been sent, so the client has its answer.
//
// It reads through ReadSlice rather than ReadString because a drain that
// grew a buffer to hold a line it is about to throw away would be its own
// version of the problem it exists to fix.
func (s *session) discardBody() bool {
	s.mailFrom, s.rcptTo = "", nil
	partial := false // mid-way through a line longer than the read buffer
	for budget := s.cfg.MaxSize; budget > 0; {
		chunk, err := s.r.ReadSlice('\n')
		budget -= len(chunk)
		if err == bufio.ErrBufferFull {
			// Longer than the whole buffer, so not the terminator. The flag
			// matters: without it a line ending in ".\r\n" on a fill
			// boundary would arrive looking exactly like the end of the body.
			partial = true
			continue
		}
		if err != nil {
			return false
		}
		if !partial && strings.TrimRight(string(chunk), "\r\n") == "." {
			return true
		}
		partial = false
	}
	log.Printf("smtp: %s sent no end-of-DATA within %d bytes of a rejected message; closing", s.user, s.cfg.MaxSize)
	return false
}

// ---- helpers -----------------------------------------------------------

// readLine reads one command or AUTH continuation line, CRLF stripped, and
// refuses to buffer more than maxCommandLine bytes of it.
//
// The bound is the point: ReadString grows bufio's buffer to hold whatever
// arrives before a newline, so a client that opens a connection and streams
// without ever sending one is an allocation it controls and popcorn does
// not — before it has authenticated, on one of 64 shared slots. ReadSlice
// keeps the buffer at its fixed size and the copy stops at the cap.
func (s *session) readLine() (string, error) {
	var line strings.Builder
	for {
		chunk, err := s.r.ReadSlice('\n')
		if len(chunk) > maxCommandLine-line.Len() {
			return "", errLineTooLong
		}
		line.Write(chunk) // copies; chunk aliases the buffer until the next read
		if err == bufio.ErrBufferFull {
			continue
		}
		if err != nil {
			return "", err
		}
		return strings.TrimRight(line.String(), "\r\n"), nil
	}
}

func (s *session) reply(line string) { fmt.Fprintf(s.conn, "%s\r\n", line) }

func split(line string) (string, string) {
	verb, arg, _ := strings.Cut(line, " ")
	return strings.ToUpper(strings.TrimSpace(verb)), strings.TrimSpace(arg)
}

// extractAddr parses `FROM:<a@b> PARAM=X` / `TO:<a@b>` (angle brackets
// optional, params ignored).
func extractAddr(arg, keyword string) string {
	rest, ok := cutPrefixFold(arg, keyword+":")
	if !ok {
		return ""
	}
	rest = strings.TrimSpace(rest)
	if i := strings.IndexByte(rest, '<'); i >= 0 {
		if j := strings.IndexByte(rest[i:], '>'); j > 0 {
			return rest[i+1 : i+j]
		}
		return ""
	}
	addr, _, _ := strings.Cut(rest, " ")
	return addr
}

func cutPrefixFold(s, prefix string) (string, bool) {
	if len(s) >= len(prefix) && strings.EqualFold(s[:len(prefix)], prefix) {
		return s[len(prefix):], true
	}
	return s, false
}

func oneLine(s string) string {
	s = strings.ReplaceAll(strings.ReplaceAll(s, "\r", " "), "\n", " ")
	if len(s) > 200 {
		s = s[:200]
	}
	return s
}
