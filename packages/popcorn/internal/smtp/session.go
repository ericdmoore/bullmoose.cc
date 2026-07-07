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

func Serve(conn net.Conn, cfg Config) {
	s := &session{conn: conn, r: bufio.NewReaderSize(conn, 4096), cfg: cfg}
	defer conn.Close()
	s.reply("220 popcorn ESMTP submission ready 🍿")

	for {
		_ = conn.SetDeadline(time.Now().Add(cfg.IdleTimeout))
		line, err := s.r.ReadString('\n')
		if err != nil {
			return
		}
		verb, arg := split(strings.TrimRight(line, "\r\n"))

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
			s.auth(arg)
		case "MAIL":
			s.mail(arg)
		case "RCPT":
			s.rcpt(arg)
		case "DATA":
			s.data()
		case "STARTTLS":
			s.reply("502 5.5.1 no STARTTLS here — connect with implicit TLS")
		default:
			s.reply("502 5.5.2 command not implemented")
		}
	}
}

// ---- AUTH --------------------------------------------------------------

func (s *session) auth(arg string) {
	if s.client != nil {
		s.reply("503 5.5.1 already authenticated")
		return
	}
	mech, initial, _ := strings.Cut(arg, " ")
	var user, pass string
	switch strings.ToUpper(mech) {
	case "PLAIN":
		if initial == "" {
			s.reply("334 ")
			initial = s.readLine()
		}
		raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(initial))
		parts := strings.Split(string(raw), "\x00")
		if err != nil || len(parts) != 3 {
			s.reply("501 5.5.4 malformed AUTH PLAIN")
			return
		}
		user, pass = parts[1], parts[2]
	case "LOGIN":
		s.reply("334 VXNlcm5hbWU6") // "Username:"
		u, _ := base64.StdEncoding.DecodeString(strings.TrimSpace(s.readLine()))
		s.reply("334 UGFzc3dvcmQ6") // "Password:"
		p, _ := base64.StdEncoding.DecodeString(strings.TrimSpace(s.readLine()))
		user, pass = string(u), string(p)
	default:
		s.reply("504 5.5.4 only PLAIN and LOGIN")
		return
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
		return
	}
	s.client, s.user = client, user
	s.idByAddr = map[string]string{}
	for _, id := range ids {
		s.idByAddr[strings.ToLower(id.Email)] = id.ID
	}
	s.reply("235 2.7.0 accepted")
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

func (s *session) data() {
	if s.mailFrom == "" || len(s.rcptTo) == 0 {
		s.reply("503 5.5.1 need MAIL and RCPT first")
		return
	}
	s.reply("354 end with <CRLF>.<CRLF>")

	// Read the dot-terminated body, un-stuffing leading "..".
	var raw strings.Builder
	_ = s.conn.SetDeadline(time.Now().Add(5 * time.Minute))
	for {
		line, err := s.r.ReadString('\n')
		if err != nil {
			return
		}
		trimmed := strings.TrimRight(line, "\r\n")
		if trimmed == "." {
			break
		}
		trimmed = strings.TrimPrefix(trimmed, ".")
		if raw.Len()+len(trimmed) > s.cfg.MaxSize {
			s.reply(fmt.Sprintf("552 5.3.4 message exceeds %d bytes", s.cfg.MaxSize))
			return
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
		s.reply("250 2.0.0 queued as " + subID)
	}
	s.mailFrom, s.rcptTo = "", nil
}

// ---- helpers -----------------------------------------------------------

func (s *session) readLine() string {
	line, err := s.r.ReadString('\n')
	if err != nil {
		return ""
	}
	return strings.TrimRight(line, "\r\n")
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
