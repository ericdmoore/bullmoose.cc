package markdown

// The MIME builder. The central assertion is NOT "these bytes match Node" —
// byte-identity was loosened for this path — but something stronger:
//
//	the message PARSES BACK, with Go's own net/mail and mime/multipart.
//
// That catches the failures that actually reach a recipient. A wrong boundary,
// a missing blank line before a part, an unterminated multipart: all of those
// produce a message that looks fine in a diff and renders as a wall of base64
// in someone's client. Round-tripping asserts the thing a mail client will do.

import (
	"encoding/base64"
	"io"
	"mime"
	"mime/multipart"
	"net/mail"
	"strings"
	"testing"
	"time"
)

func build(t *testing.T, m OutgoingMessage) string {
	t.Helper()
	if m.Date.IsZero() {
		m.Date = time.Date(2026, 8, 22, 15, 4, 5, 0, time.UTC)
	}
	if m.MessageID == "" {
		m.MessageID = "id@bullmoose.cc"
	}
	if len(m.From) == 0 {
		m.From = []MimeAddress{{Email: "eric@bullmoose.cc"}}
	}
	if len(m.To) == 0 {
		m.To = []MimeAddress{{Email: "grace@example.test"}}
	}
	raw, err := BuildMime(m)
	if err != nil {
		t.Fatalf("BuildMime: %v", err)
	}
	return string(raw)
}

// parseTree walks the message the way a mail client does and returns every
// part's media type, so structure can be asserted rather than eyeballed.
func parseTree(t *testing.T, raw string) ([]string, *mail.Message) {
	t.Helper()
	msg, err := mail.ReadMessage(strings.NewReader(raw))
	if err != nil {
		t.Fatalf("the message does not parse as RFC 5322: %v", err)
	}
	var types []string
	var walk func(r io.Reader, ctype string)
	walk = func(r io.Reader, ctype string) {
		mt, params, err := mime.ParseMediaType(ctype)
		if err != nil {
			t.Fatalf("bad Content-Type %q: %v", ctype, err)
		}
		types = append(types, mt)
		if !strings.HasPrefix(mt, "multipart/") {
			return
		}
		b, ok := params["boundary"]
		if !ok {
			t.Fatalf("%s has no boundary", mt)
		}
		mr := multipart.NewReader(r, b)
		for {
			p, err := mr.NextPart()
			if err == io.EOF {
				break
			}
			if err != nil {
				t.Fatalf("walking %s: %v", mt, err)
			}
			walk(p, p.Header.Get("Content-Type"))
		}
	}
	walk(msg.Body, msg.Header.Get("Content-Type"))
	return types, msg
}

func TestTextOnlyIsNotWrappedInAMultipart(t *testing.T) {
	// A one-child multipart is legal and some clients render it as empty, so
	// the wrapper only appears when there is something to alternate between.
	raw := build(t, OutgoingMessage{Subject: "hi", Text: "body", HasText: true})
	types, _ := parseTree(t, raw)
	if len(types) != 1 || types[0] != "text/plain" {
		t.Errorf("tree = %v, want a bare text/plain", types)
	}
}

func TestTextAndHTMLBecomeAlternative(t *testing.T) {
	raw := build(t, OutgoingMessage{Subject: "hi", Text: "body", HasText: true, HTML: "<p>body</p>", HasHTML: true})
	types, _ := parseTree(t, raw)
	want := []string{"multipart/alternative", "text/plain", "text/html"}
	if strings.Join(types, ",") != strings.Join(want, ",") {
		t.Errorf("tree = %v, want %v", types, want)
	}
}

func TestInlineImagesNestUnderRelated(t *testing.T) {
	raw := build(t, OutgoingMessage{
		Subject: "hi", Text: "b", HasText: true, HTML: "<img src=\"cid:c1\">", HasHTML: true,
		Inline: []InlinePart{{CID: "c1", Type: "image/png", Name: "cat.png", Content: []byte{1, 2, 3}}},
	})
	types, _ := parseTree(t, raw)
	want := []string{"multipart/related", "multipart/alternative", "text/plain", "text/html", "image/png"}
	if strings.Join(types, ",") != strings.Join(want, ",") {
		t.Errorf("tree = %v, want %v", types, want)
	}
	// The cid: in the HTML must match a Content-ID that actually exists, or the
	// image silently fails to render in every client.
	if !strings.Contains(raw, "Content-ID: <c1>") {
		t.Error("no Content-ID for the referenced cid")
	}
}

func TestAttachmentsNestUnderMixed(t *testing.T) {
	raw := build(t, OutgoingMessage{
		Subject: "hi", Text: "b", HasText: true,
		Attachments: []AttachmentPart{{Type: "application/pdf", Name: "notes.pdf", Content: []byte{9, 9}}},
	})
	types, _ := parseTree(t, raw)
	want := []string{"multipart/mixed", "text/plain", "application/pdf"}
	if strings.Join(types, ",") != strings.Join(want, ",") {
		t.Errorf("tree = %v, want %v", types, want)
	}
}

func TestTheFullTreeParses(t *testing.T) {
	// mixed > related > alternative, the deepest shape the builder emits.
	raw := build(t, OutgoingMessage{
		Subject: "hi", Text: "b", HasText: true, HTML: "<p>b</p>", HasHTML: true,
		Inline:      []InlinePart{{CID: "c1", Type: "image/png", Name: "a.png", Content: []byte{1}}},
		Attachments: []AttachmentPart{{Type: "application/pdf", Name: "n.pdf", Content: []byte{2}}},
	})
	types, _ := parseTree(t, raw)
	want := []string{"multipart/mixed", "multipart/related", "multipart/alternative",
		"text/plain", "text/html", "image/png", "application/pdf"}
	if strings.Join(types, ",") != strings.Join(want, ",") {
		t.Errorf("tree = %v, want %v", types, want)
	}
}

func TestBodyContentSurvivesTheRoundTrip(t *testing.T) {
	// Base64 is used precisely so a relay that rewraps lines cannot corrupt a
	// Markdown code block. Assert the bytes actually come back.
	body := "line one\nline two\n\n    indented code\n"
	raw := build(t, OutgoingMessage{Subject: "s", Text: body, HasText: true})
	_, msg := parseTree(t, raw)
	enc, _ := io.ReadAll(msg.Body)
	got, err := base64.StdEncoding.DecodeString(strings.ReplaceAll(string(enc), crlf, ""))
	if err != nil {
		t.Fatalf("body is not decodable base64: %v", err)
	}
	if string(got) != body {
		t.Errorf("body round-trip:\n want %q\n got  %q", body, got)
	}
}

func TestHeaderInjectionIsStripped(t *testing.T) {
	// THE security property. A bare CR/LF in a field body does not produce an
	// invalid message — it produces EXTRA HEADERS. These values can come from a
	// Markdown file that arrived by mail (s40).
	raw := build(t, OutgoingMessage{
		Subject: "hello\r\nBcc: sneak@evil.test",
		To:      []MimeAddress{{Name: "Grace\r\nBcc: x@evil.test", Email: "grace@example.test"}},
		Text:    "b", HasText: true,
	})
	_, msg := parseTree(t, raw)
	if bcc := msg.Header.Get("Bcc"); bcc != "" {
		t.Fatalf("header injection succeeded: Bcc = %q", bcc)
	}
	if strings.Count(raw, "Subject:") != 1 {
		t.Errorf("the subject split into more than one header:\n%s", raw)
	}
}

func TestBccIsNeverWritten(t *testing.T) {
	// Bcc travels in the SMTP envelope. In the message it would tell every
	// recipient who was blind-copied.
	raw := build(t, OutgoingMessage{Subject: "s", Text: "b", HasText: true,
		CC: []MimeAddress{{Email: "cc@example.test"}}})
	if strings.Contains(raw, "Bcc:") {
		t.Error("a Bcc header was written into the message")
	}
	if !strings.Contains(raw, "Cc: cc@example.test") {
		t.Error("Cc should be present")
	}
}

func TestNonASCIISubjectIsEncodedWord(t *testing.T) {
	raw := build(t, OutgoingMessage{Subject: "café ☕", Text: "b", HasText: true})
	_, msg := parseTree(t, raw)
	dec, err := (&mime.WordDecoder{}).DecodeHeader(msg.Header.Get("Subject"))
	if err != nil {
		t.Fatalf("subject does not decode: %v", err)
	}
	if dec != "café ☕" {
		t.Errorf("subject = %q", dec)
	}
}

func TestFormatAddress(t *testing.T) {
	for _, tc := range []struct{ name, email, want string }{
		{"", "a@b.test", "a@b.test"},
		{"Grace Hopper", "g@b.test", "Grace Hopper <g@b.test>"},
		{"Hopper, Grace", "g@b.test", `"Hopper, Grace" <g@b.test>`},
		{`Grace "Amazing"`, "g@b.test", `"Grace \"Amazing\"" <g@b.test>`},
	} {
		if got := FormatAddress(MimeAddress{Name: tc.name, Email: tc.email}); got != tc.want {
			t.Errorf("FormatAddress(%q) = %q, want %q", tc.name, got, tc.want)
		}
	}
	// Non-ASCII names are encoded, and the result must still decode.
	got := FormatAddress(MimeAddress{Name: "José", Email: "j@b.test"})
	if !strings.HasPrefix(got, "=?utf-8?B?") {
		t.Errorf("non-ascii name should be an encoded word, got %q", got)
	}
}

func TestFilenamesCannotEscapeTheirParameter(t *testing.T) {
	// Asserted on the PARSED part's headers, not on a substring of the raw
	// message. The text "X-Evil" legitimately survives INSIDE the quoted
	// filename after sanitising — harmless. The property is that it never
	// becomes a HEADER.
	//
	// The first version of this test grepped the raw bytes and failed on that
	// harmless text. That is the fourth assertion this session written against
	// what was convenient to read rather than against the property; the tell
	// is always the same — a string check standing in for a structural one.
	raw := build(t, OutgoingMessage{Subject: "s", Text: "b", HasText: true,
		Attachments: []AttachmentPart{{Type: "text/plain", Name: "a\".txt\r\nX-Evil: 1", Content: []byte{1}}}})

	msg, err := mail.ReadMessage(strings.NewReader(raw))
	if err != nil {
		t.Fatalf("does not parse: %v", err)
	}
	if msg.Header.Get("X-Evil") != "" {
		t.Error("a filename injected a top-level header")
	}
	_, params, err := mime.ParseMediaType(msg.Header.Get("Content-Type"))
	if err != nil {
		t.Fatalf("bad Content-Type: %v", err)
	}
	mr := multipart.NewReader(msg.Body, params["boundary"])
	for {
		p, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("walking parts: %v", err)
		}
		if p.Header.Get("X-Evil") != "" {
			t.Error("a filename injected a PART header")
		}
	}
}
