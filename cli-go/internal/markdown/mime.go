package markdown

// buildMime — a port of packages/cli/src/mime.ts.
//
// `send --expandMD html` does NOT hand the server a structured Email. It
// assembles a complete RFC 5322 message here, uploads it as a blob, and
// imports that. It has to: inline images are `cid:` references into sibling
// parts, and that nesting is a property of the MIME tree rather than of any
// JMAP field.
//
// The tree is built inside-out, and each layer only appears when something
// needs it — a plain text+html message is a bare multipart/alternative, not an
// alternative wrapped in a related wrapped in a mixed:
//
//	multipart/mixed          ← only when there are attachments
//	  multipart/related      ← only when there are inline images
//	    multipart/alternative← only when there is BOTH text and html
//	      text/plain
//	      text/html
//	    image/png  (Content-ID, disposition inline)
//	  application/pdf        (disposition attachment)
//
// ## The guards are the point of this file
//
// Every header value goes through stripCtl. RFC 5322 §2.2 forbids a bare CR or
// LF in a field body, and a value carrying one does not produce an invalid
// message — it produces EXTRA HEADERS. A subject containing a newline is a
// header-injection primitive, and the values here come from a Markdown file
// that may have arrived by mail (see .plans/s40-markdown-headers).
//
// `isAscii` is NOT that guard, and the TypeScript's comment says why: CR, LF
// and NUL all sit inside [\x00-\x7F], which is exactly how an earlier version
// let them through.
//
// ## Bcc is deliberately absent
//
// Bcc recipients travel in the SMTP envelope (EmailSubmission's rcptTo) and
// must never be written into the message, or every recipient learns who was
// blind-copied.

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"regexp"
	"strings"
	"time"
)

const crlf = "\r\n"

// MimeAddress is one addressee.
type MimeAddress struct {
	Name  string
	Email string
}

// OutgoingMessage is everything buildMime needs.
type OutgoingMessage struct {
	From        []MimeAddress
	To          []MimeAddress
	CC          []MimeAddress
	Subject     string
	MessageID   string
	Date        time.Time
	InReplyTo   string
	Text        string
	HTML        string
	HasText     bool
	HasHTML     bool
	Inline      []InlinePart
	Attachments []AttachmentPart
}

type node struct {
	headers string
	content string
}

// BuildMime renders the message to RFC 5322 bytes.
func BuildMime(msg OutgoingMessage) ([]byte, error) {
	headers := []string{
		"Date: " + rfc5322Date(msg.Date),
		"Message-ID: <" + msgID(msg.MessageID) + ">",
		"From: " + joinAddresses(msg.From),
		"To: " + joinAddresses(msg.To),
	}
	if len(msg.CC) > 0 {
		headers = append(headers, "Cc: "+joinAddresses(msg.CC))
	}
	// No Bcc header, ever — see the package comment.
	if msg.InReplyTo != "" {
		// Copied from inbound mail on a reply, so attacker-controlled.
		ref := msgID(msg.InReplyTo)
		headers = append(headers, "In-Reply-To: <"+ref+">", "References: <"+ref+">")
	}
	headers = append(headers, "Subject: "+encodeHeaderValue(msg.Subject), "MIME-Version: 1.0")

	body, err := bodyNode(msg)
	if err != nil {
		return nil, err
	}
	return []byte(strings.Join(headers, crlf) + crlf + body.headers + crlf + crlf + body.content), nil
}

func bodyNode(msg OutgoingMessage) (node, error) {
	n := alternativeNode(msg)
	if len(msg.Inline) > 0 {
		parts := []node{n}
		for _, p := range msg.Inline {
			parts = append(parts, binaryPart(p.Type, p.Content, []string{
				"Content-ID: <" + msgID(p.CID) + ">",
				`Content-Disposition: inline; filename="` + sanitizeName(p.Name) + `"`,
			}))
		}
		var err error
		if n, err = multipartNode("related", parts); err != nil {
			return node{}, err
		}
	}
	if len(msg.Attachments) > 0 {
		parts := []node{n}
		for _, p := range msg.Attachments {
			parts = append(parts, binaryPart(p.Type, p.Content, []string{
				`Content-Disposition: attachment; filename="` + sanitizeName(p.Name) + `"`,
			}))
		}
		var err error
		if n, err = multipartNode("mixed", parts); err != nil {
			return node{}, err
		}
	}
	return n, nil
}

// alternativeNode wraps text and html — but ONLY when there are two of them. A
// single part is returned bare, so a text-only message is `text/plain` rather
// than a one-child multipart some clients render as an empty message.
func alternativeNode(msg OutgoingMessage) node {
	var parts []node
	if msg.HasText {
		parts = append(parts, textPart("text/plain", msg.Text))
	}
	if msg.HasHTML {
		parts = append(parts, textPart("text/html", msg.HTML))
	}
	if len(parts) == 0 {
		parts = append(parts, textPart("text/plain", ""))
	}
	if len(parts) == 1 {
		return parts[0]
	}
	n, err := multipartNode("alternative", parts)
	if err != nil {
		// A boundary needs 16 random bytes; if the OS cannot supply them the
		// message cannot be built, and a single alternative is still valid.
		return parts[0]
	}
	return n
}

func multipartNode(subtype string, parts []node) (node, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return node{}, err
	}
	boundary := "=_bm_" + hex.EncodeToString(b)
	var lines []string
	for _, p := range parts {
		lines = append(lines, "--"+boundary, p.headers, "", p.content)
	}
	lines = append(lines, "--"+boundary+"--", "")
	return node{
		headers: `Content-Type: multipart/` + subtype + `; boundary="` + boundary + `"`,
		content: strings.Join(lines, crlf),
	}, nil
}

// textPart base64s the body rather than sending it 8bit or quoted-printable.
// It is the encoding that cannot be corrupted by a relay that rewraps lines,
// and rewrapping is what breaks a Markdown code block in transit.
func textPart(mediaType, content string) node {
	return node{
		headers: strings.Join([]string{
			"Content-Type: " + mediaType + "; charset=utf-8",
			"Content-Transfer-Encoding: base64",
		}, crlf),
		content: wrap76(base64.StdEncoding.EncodeToString([]byte(content))),
	}
}

func binaryPart(mediaType string, content []byte, extra []string) node {
	h := append([]string{"Content-Type: " + mediaType, "Content-Transfer-Encoding: base64"}, extra...)
	return node{
		headers: strings.Join(h, crlf),
		content: wrap76(base64.StdEncoding.EncodeToString(content)),
	}
}

func rfc5322Date(d time.Time) string {
	return d.UTC().Format("Mon, 02 Jan 2006 15:04:05 +0000")
}

func joinAddresses(as []MimeAddress) string {
	out := make([]string, 0, len(as))
	for _, a := range as {
		out = append(out, FormatAddress(a))
	}
	return strings.Join(out, ", ")
}

var plainName = regexp.MustCompile(`^[\w .'-]+$`)

// FormatAddress renders one addressee, quoting or encoding the display name
// only when it needs it.
func FormatAddress(a MimeAddress) string {
	email := stripCtl(a.Email)
	if a.Name == "" {
		return email
	}
	raw := stripCtl(a.Name)
	var name string
	switch {
	case plainName.MatchString(raw):
		name = raw
	case isASCII(raw):
		name = `"` + strings.ReplaceAll(strings.ReplaceAll(raw, `\`, `\\`), `"`, `\"`) + `"`
	default:
		name = encodeWord(raw)
	}
	return name + " <" + email + ">"
}

// stripCtl is the header-injection guard. A bare CR or LF in a field body does
// not make an invalid message — it makes EXTRA HEADERS.
func stripCtl(v string) string {
	return ctlRe.ReplaceAllString(v, " ")
}

var (
	ctlRe   = regexp.MustCompile("[\r\n\x00]+")
	msgIDRe = regexp.MustCompile(`[<>\s]+`)
)

// msgID: the value sits inside angle brackets, so `<`, `>` and whitespace
// would end the field early.
func msgID(v string) string { return msgIDRe.ReplaceAllString(stripCtl(v), "") }

// EncodeHeaderValue applies RFC 2047 only when the value is not ASCII.
func EncodeHeaderValue(v string) string { return encodeHeaderValue(v) }

func encodeHeaderValue(v string) string {
	safe := stripCtl(v)
	if isASCII(safe) {
		return safe
	}
	return encodeWord(safe)
}

func encodeWord(v string) string {
	return "=?utf-8?B?" + base64.StdEncoding.EncodeToString([]byte(v)) + "?="
}

func isASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] > 0x7F {
			return false
		}
	}
	return true
}

// sanitizeName keeps a filename inside its quoted parameter.
func sanitizeName(n string) string {
	return strings.NewReplacer(`"`, "", "\r", " ", "\n", " ").Replace(n)
}

func wrap76(s string) string {
	var b bytes.Buffer
	for i := 0; i < len(s); i += 76 {
		if i > 0 {
			b.WriteString(crlf)
		}
		end := i + 76
		if end > len(s) {
			end = len(s)
		}
		b.WriteString(s[i:end])
	}
	return b.String()
}
