package smtp

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// As in the pop3 suite: the real Serve loop runs over a net.Pipe and the real
// jmap client over an in-process http.RoundTripper, so nothing here can open a
// listener, dial a host, or resolve a name. This is the submission face of live
// mail infrastructure — the tests must not be able to send anything.
//
// http.DefaultTransport is a process global, so nothing in this file may call
// t.Parallel.

const (
	testBase  = "https://jmap.test"
	testUser  = "corny@example.test"
	testToken = "bm_app_password_token"
	testAlias = "alias@example.test"
)

func testConfig() Config {
	return Config{
		JMAPBase:    testBase,
		MaxSize:     25 << 20,
		IdleTimeout: 30 * time.Second,
	}
}

// ---- the JMAP server, in memory ---------------------------------------------

type recorded struct {
	URL  string
	Auth string
	Body []byte
}

type jmapStub struct {
	mu   sync.Mutex
	reqs []recorded

	roles      map[string]string
	identities []map[string]any
	notCreated bool // EmailSubmission/set refuses the submission
	failWith   string
}

func newStub() *jmapStub {
	return &jmapStub{
		roles: map[string]string{"inbox": "mb_inbox", "drafts": "mb_drafts", "sent": "mb_sent", "archive": "mb_archive"},
		identities: []map[string]any{
			{"id": "id_primary", "email": testUser},
			{"id": "id_alias", "email": testAlias},
		},
	}
}

func (s *jmapStub) RoundTrip(req *http.Request) (*http.Response, error) {
	var body []byte
	if req.Body != nil {
		body, _ = io.ReadAll(req.Body)
	}
	s.mu.Lock()
	s.reqs = append(s.reqs, recorded{URL: req.URL.String(), Auth: req.Header.Get("Authorization"), Body: body})
	s.mu.Unlock()

	respond := func(status int, payload string) (*http.Response, error) {
		return &http.Response{
			StatusCode: status,
			Body:       io.NopCloser(strings.NewReader(payload)),
			Header:     http.Header{},
			Request:    req,
		}, nil
	}
	if _, pass, ok := req.BasicAuth(); !ok || pass != testToken {
		return respond(401, `{"error":"unauthorized"}`)
	}
	switch {
	case strings.HasSuffix(req.URL.Path, "/.well-known/jmap"):
		return respond(200, `{
			"apiUrl": "https://jmap.test/api",
			"downloadUrl": "https://jmap.test/dl/{accountId}/{blobId}/{name}?type={type}",
			"uploadUrl": "https://jmap.test/upload/{accountId}",
			"primaryAccounts": {"urn:ietf:params:jmap:mail": "acct_1"}
		}`)
	case strings.HasPrefix(req.URL.Path, "/upload/"):
		return respond(201, `{"blobId":"blob_uploaded"}`)
	case req.URL.Path == "/api":
		return respond(200, s.dispatch(body))
	}
	return respond(404, "{}")
}

func (s *jmapStub) dispatch(body []byte) string {
	var envelope struct {
		MethodCalls []json.RawMessage `json:"methodCalls"`
	}
	_ = json.Unmarshal(body, &envelope)

	responses := []any{}
	for _, raw := range envelope.MethodCalls {
		name, _, tag := decodeCall(raw)
		switch name {
		case "Mailbox/get":
			list := []map[string]any{}
			for role, id := range s.roles {
				list = append(list, map[string]any{"id": id, "role": role})
			}
			responses = append(responses, []any{name, map[string]any{"list": list}, tag})
		case "Identity/get":
			responses = append(responses, []any{name, map[string]any{"list": s.identities}, tag})
		case "Email/import":
			responses = append(responses, []any{name, map[string]any{"created": map[string]any{"d": map[string]any{"id": "em_imported"}}}, tag})
		case "EmailSubmission/set":
			if s.notCreated {
				reason := s.failWith
				if reason == "" {
					reason = "forbiddenFrom"
				}
				responses = append(responses, []any{name, map[string]any{"notCreated": map[string]any{"s": map[string]any{"type": reason}}}, tag})
				continue
			}
			responses = append(responses, []any{name, map[string]any{"created": map[string]any{"s": map[string]any{"id": "sub_1"}}}, tag})
		default:
			responses = append(responses, []any{"error", map[string]any{"type": "unknownMethod"}, tag})
		}
	}
	out, _ := json.Marshal(map[string]any{"methodResponses": responses})
	return string(out)
}

func (s *jmapStub) methods() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	names := []string{}
	for _, r := range s.reqs {
		var envelope struct {
			MethodCalls []json.RawMessage `json:"methodCalls"`
		}
		if json.Unmarshal(r.Body, &envelope) != nil {
			continue
		}
		for _, raw := range envelope.MethodCalls {
			name, _, _ := decodeCall(raw)
			names = append(names, name)
		}
	}
	return names
}

func (s *jmapStub) argsFor(t *testing.T, method string) map[string]json.RawMessage {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, r := range s.reqs {
		var envelope struct {
			MethodCalls []json.RawMessage `json:"methodCalls"`
		}
		if json.Unmarshal(r.Body, &envelope) != nil {
			continue
		}
		for _, raw := range envelope.MethodCalls {
			if name, args, _ := decodeCall(raw); name == method {
				return args
			}
		}
	}
	t.Fatalf("session never issued %s", method)
	return nil
}

// uploaded returns the bytes that were POSTed to the upload endpoint — the
// message as popcorn actually filed it.
func (s *jmapStub) uploaded(t *testing.T) string {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, r := range s.reqs {
		if strings.Contains(r.URL, "/upload/") {
			return string(r.Body)
		}
	}
	t.Fatal("nothing was uploaded")
	return ""
}

func (s *jmapStub) requestCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.reqs)
}

func decodeCall(raw json.RawMessage) (string, map[string]json.RawMessage, string) {
	var tuple [3]json.RawMessage
	_ = json.Unmarshal(raw, &tuple)
	var name, tag string
	var args map[string]json.RawMessage
	_ = json.Unmarshal(tuple[0], &name)
	_ = json.Unmarshal(tuple[1], &args)
	_ = json.Unmarshal(tuple[2], &tag)
	return name, args, tag
}

// ---- the SMTP client, in memory ---------------------------------------------

type conn struct {
	t    *testing.T
	c    net.Conn
	r    *bufio.Reader
	done chan struct{}
}

func dial(t *testing.T, cfg Config, stub *jmapStub) *conn {
	t.Helper()
	old := http.DefaultTransport
	http.DefaultTransport = stub
	t.Cleanup(func() { http.DefaultTransport = old })

	clientEnd, serverEnd := net.Pipe()
	done := make(chan struct{})
	go func() {
		defer close(done)
		Serve(serverEnd, cfg)
	}()
	c := &conn{t: t, c: clientEnd, r: bufio.NewReader(clientEnd), done: done}
	t.Cleanup(func() {
		clientEnd.Close()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("Serve did not return after the client hung up")
		}
	})
	if g := c.line(); !strings.HasPrefix(g, "220 ") {
		t.Fatalf("greeting = %q, want a 220", g)
	}
	return c
}

func (c *conn) send(format string, args ...any) {
	c.t.Helper()
	_ = c.c.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if _, err := fmt.Fprintf(c.c, format+"\r\n", args...); err != nil {
		c.t.Fatalf("send %q: %v", fmt.Sprintf(format, args...), err)
	}
}

func (c *conn) line() string {
	c.t.Helper()
	_ = c.c.SetReadDeadline(time.Now().Add(5 * time.Second))
	s, err := c.r.ReadString('\n')
	if err != nil {
		c.t.Fatalf("read: %v (got %q)", err, s)
	}
	if !strings.HasSuffix(s, "\r\n") {
		c.t.Errorf("line %q is not CRLF-terminated", s)
	}
	return strings.TrimRight(s, "\r\n")
}

// reply reads a full SMTP reply, following the "250-" continuation convention,
// and returns every line.
func (c *conn) reply() []string {
	c.t.Helper()
	lines := []string{}
	for {
		l := c.line()
		lines = append(lines, l)
		if len(l) < 4 || l[3] != '-' {
			return lines
		}
		if len(lines) > 50 {
			c.t.Fatalf("reply never terminated: %q", lines)
		}
	}
}

func (c *conn) cmd(format string, args ...any) string {
	c.t.Helper()
	c.send(format, args...)
	return c.reply()[0]
}

// code sends a command and returns the three-digit status.
func (c *conn) code(format string, args ...any) string {
	c.t.Helper()
	line := c.cmd(format, args...)
	if len(line) < 3 {
		c.t.Fatalf("reply %q has no status code", line)
	}
	return line[:3]
}

func (c *conn) authenticate() {
	c.t.Helper()
	c.send("EHLO test")
	c.reply()
	creds := base64.StdEncoding.EncodeToString([]byte("\x00" + testUser + "\x00" + testToken))
	if got := c.code("AUTH PLAIN %s", creds); got != "235" {
		c.t.Fatalf("AUTH → %s, want 235", got)
	}
}

// ---- logs --------------------------------------------------------------------

var logBuf syncBuffer

type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

func TestMain(m *testing.M) {
	log.SetOutput(&logBuf)
	os.Exit(m.Run())
}

// ---- command ordering --------------------------------------------------------

// Submission has exactly one legal order, and every step of it is a gate on
// somebody else's outbound reputation. A command accepted out of sequence is
// either an unauthenticated send or a half-built envelope; both must be a
// refusal, and the refusal must not leave state behind that the next command
// can build on.
func TestCommandsOutOfSequenceAreRefused(t *testing.T) {
	for _, tc := range []struct {
		name string
		cmds []string
		want string
	}{
		{"MAIL before AUTH is not a submission", []string{"MAIL FROM:<" + testUser + ">"}, "530"},
		{"RCPT before AUTH", []string{"RCPT TO:<someone@example.test>"}, "503"},
		{"DATA before anything", []string{"DATA"}, "503"},
		{"RCPT before MAIL has no envelope to attach to", []string{"AUTH", "RCPT TO:<someone@example.test>"}, "503"},
		{"DATA before RCPT has no recipients", []string{"AUTH", "MAIL FROM:<" + testUser + ">", "DATA"}, "503"},
		{"DATA after RSET forgets the envelope", []string{"AUTH", "MAIL FROM:<" + testUser + ">", "RCPT TO:<a@example.test>", "RSET", "DATA"}, "503"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			stub := newStub()
			c := dial(t, testConfig(), stub)
			var got string
			for _, cmd := range tc.cmds {
				if cmd == "AUTH" {
					c.authenticate()
					continue
				}
				got = c.code("%s", cmd)
			}
			if got != tc.want {
				t.Fatalf("%v → %s, want %s", tc.cmds, got, tc.want)
			}
			for _, m := range stub.methods() {
				if m == "EmailSubmission/set" {
					t.Fatalf("an out-of-order sequence still submitted: %v", stub.methods())
				}
			}
		})
	}
}

// Re-AUTH inside an authenticated session would swap the identity set out from
// under an envelope that was already accepted against the old one.
func TestSecondAuthIsRefused(t *testing.T) {
	c := dial(t, testConfig(), newStub())
	c.authenticate()
	creds := base64.StdEncoding.EncodeToString([]byte("\x00" + testUser + "\x00" + testToken))
	if got := c.code("AUTH PLAIN %s", creds); got != "503" {
		t.Fatalf("second AUTH → %s, want 503", got)
	}
}

// STARTTLS is refused rather than unimplemented-by-omission: this face is
// implicit TLS only, and a server that answers STARTTLS with anything a client
// reads as "maybe" is where downgrade attacks live.
func TestStarttlsIsRefused(t *testing.T) {
	c := dial(t, testConfig(), newStub())
	line := c.cmd("STARTTLS")
	if !strings.HasPrefix(line, "502") {
		t.Fatalf("STARTTLS → %q, want a 502", line)
	}
	if got := c.code("NOOP"); got != "250" {
		t.Error("the session should survive a refused STARTTLS")
	}
}

// EHLO's advertisement is a contract: clients pick an auth mechanism and
// pre-check message size from it. A SIZE that does not match the configured cap
// makes a large send fail after the whole message has been transferred.
func TestEhloAdvertisesWhatTheSessionActuallySupports(t *testing.T) {
	cfg := testConfig()
	cfg.MaxSize = 1234
	c := dial(t, cfg, newStub())

	c.send("EHLO test")
	lines := c.reply()
	joined := strings.Join(lines, "\n")
	for _, want := range []string{"AUTH PLAIN LOGIN", "SIZE 1234"} {
		if !strings.Contains(joined, want) {
			t.Errorf("EHLO advertised %q, missing %q", lines, want)
		}
	}
	if last := lines[len(lines)-1]; last[3] == '-' {
		t.Errorf("the last EHLO line %q is a continuation; the client will hang", last)
	}
	// HELO is the fallback for clients that do not speak ESMTP, and must be a
	// single non-continued line.
	if got := c.cmd("HELO test"); !strings.HasPrefix(got, "250 ") {
		t.Errorf("HELO → %q", got)
	}
}

// ---- credentials -------------------------------------------------------------

// A malformed AUTH is the shape a wrong-protocol client or a scanner produces,
// and whatever it sent may well be a real password sent the wrong way. The
// refusal must not quote it back — SMTP replies are logged at both ends.
func TestMalformedAuthIsRefusedWithoutEchoingCredentials(t *testing.T) {
	for _, tc := range []struct {
		name, arg, want string
	}{
		{"not base64 at all", "PLAIN " + "hunter2!!not-base64", "501"},
		{"base64 of the wrong shape", "PLAIN " + base64.StdEncoding.EncodeToString([]byte("corny@example.test:hunter2")), "501"},
		{"too few NUL-separated fields", "PLAIN " + base64.StdEncoding.EncodeToString([]byte("corny@example.test\x00hunter2")), "501"},
		{"unknown mechanism", "CRAM-MD5", "504"},
		{"no mechanism at all", "", "504"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			stub := newStub()
			c := dial(t, testConfig(), stub)
			line := c.cmd("AUTH %s", tc.arg)
			if !strings.HasPrefix(line, tc.want) {
				t.Fatalf("AUTH %s → %q, want %s", tc.arg, line, tc.want)
			}
			if strings.Contains(line, "hunter2") {
				t.Errorf("the reply echoed the credential: %q", line)
			}
			if strings.Contains(logBuf.String(), "hunter2") {
				t.Errorf("the credential reached the log")
			}
			if n := stub.requestCount(); n != 0 {
				t.Errorf("a malformed AUTH made %d request(s) to the JMAP server", n)
			}
		})
	}
}

// AUTH LOGIN is the two-step form legacy clients use, and its challenges are
// fixed base64 strings the client matches on. Getting them wrong strands the
// client mid-handshake.
func TestAuthLoginWalksTheTwoStepChallenge(t *testing.T) {
	c := dial(t, testConfig(), newStub())

	c.send("AUTH LOGIN")
	if got := c.line(); got != "334 VXNlcm5hbWU6" {
		t.Fatalf("first challenge = %q, want the base64 of \"Username:\"", got)
	}
	c.send("%s", base64.StdEncoding.EncodeToString([]byte(testUser)))
	if got := c.line(); got != "334 UGFzc3dvcmQ6" {
		t.Fatalf("second challenge = %q, want the base64 of \"Password:\"", got)
	}
	c.send("%s", base64.StdEncoding.EncodeToString([]byte(testToken)))
	if got := c.line(); !strings.HasPrefix(got, "235") {
		t.Fatalf("AUTH LOGIN → %q, want 235", got)
	}
}

// AUTH PLAIN with no initial response has to work too — that is the form a
// client uses when it will not put credentials on the command line.
func TestAuthPlainAcceptsCredentialsOnTheContinuationLine(t *testing.T) {
	c := dial(t, testConfig(), newStub())

	c.send("AUTH PLAIN")
	if got := c.line(); !strings.HasPrefix(got, "334") {
		t.Fatalf("AUTH PLAIN → %q, want a 334 challenge", got)
	}
	c.send("%s", base64.StdEncoding.EncodeToString([]byte("\x00"+testUser+"\x00"+testToken)))
	if got := c.line(); !strings.HasPrefix(got, "235") {
		t.Fatalf("credentials on the continuation line → %q, want 235", got)
	}
}

// A rejected password must leave the session with nothing, and must not appear
// in the log line that records the failure.
func TestFailedAuthenticationGrantsNothing(t *testing.T) {
	c := dial(t, testConfig(), newStub())
	creds := base64.StdEncoding.EncodeToString([]byte("\x00" + testUser + "\x00bm_the_wrong_token"))

	if got := c.code("AUTH PLAIN %s", creds); got != "535" {
		t.Fatalf("bad AUTH → %s, want 535", got)
	}
	if strings.Contains(logBuf.String(), "bm_the_wrong_token") {
		t.Error("the password reached the log")
	}
	if got := c.code("MAIL FROM:<%s>", testUser); got != "530" {
		t.Fatalf("MAIL after a failed AUTH → %s, want 530", got)
	}
}

// ---- the envelope ------------------------------------------------------------

// The spoof guard. An app-password token authenticates an account, not an
// address, so the only thing stopping a submission as anyone at all is this
// check against the account's own identities. The JMAP server checks again —
// this one exists so the refusal happens at MAIL FROM, before the message is
// transferred, and so a bug here is a bug in depth rather than the only gate.
func TestMailFromMustNameAnIdentityTheAccountOwns(t *testing.T) {
	for _, tc := range []struct {
		name, from, want string
	}{
		{"the account's own address", testUser, "250"},
		{"another identity on the same account", testAlias, "250"},
		{"identity matching is case-insensitive", strings.ToUpper(testUser), "250"},
		{"somebody else entirely", "ceo@bank.example", "550"},
		{"an address that merely contains one", testUser + ".evil.example", "550"},
		{"the null sender has no identity", "", "501"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := dial(t, testConfig(), newStub())
			c.authenticate()
			if got := c.code("MAIL FROM:<%s>", tc.from); got != tc.want {
				t.Fatalf("MAIL FROM:<%s> → %s, want %s", tc.from, got, tc.want)
			}
		})
	}
}

// The recipient cap is the blast radius of a stolen token in one transaction.
// The 101st recipient must be refused without killing the envelope — a 452 is a
// "that one, not this session" answer.
func TestRecipientsAreCapped(t *testing.T) {
	c := dial(t, testConfig(), newStub())
	c.authenticate()
	c.code("MAIL FROM:<%s>", testUser)

	for i := 0; i < maxRcpt; i++ {
		if got := c.code("RCPT TO:<r%d@example.test>", i); got != "250" {
			t.Fatalf("recipient %d → %s, want 250", i, got)
		}
	}
	if got := c.code("RCPT TO:<one-too-many@example.test>"); got != "452" {
		t.Fatalf("recipient %d → %s, want 452", maxRcpt+1, got)
	}
}

// ---- DATA --------------------------------------------------------------------

// DATA is the one place message content and protocol share a channel. The
// terminating "." must end the message, a line the client stuffed as ".." must
// arrive as ".", and bare LF must become CRLF — a message that keeps a bare LF
// in its headers is a message a downstream MTA may reject or, worse, split.
func TestDataUnstuffsDotsAndNormalisesLineEndings(t *testing.T) {
	stub := newStub()
	c := dial(t, testConfig(), stub)
	c.authenticate()
	c.code("MAIL FROM:<%s>", testUser)
	c.code("RCPT TO:<someone@example.test>")

	if got := c.code("DATA"); got != "354" {
		t.Fatalf("DATA → %s, want 354", got)
	}
	c.send("Subject: dots")
	c.send("")
	c.send("..stuffed leading dot")
	c.send("...two stuffed")
	c.send("no dot here")
	c.send("") // a trailing blank line inside the body
	c.send(".")

	if got := c.line(); !strings.HasPrefix(got, "250") {
		t.Fatalf("end of DATA → %q, want 250", got)
	}
	want := "Subject: dots\r\n\r\n.stuffed leading dot\r\n..two stuffed\r\nno dot here\r\n\r\n"
	if got := stub.uploaded(t); got != want {
		t.Errorf("uploaded %q, want %q", got, want)
	}
}

// The envelope the message is submitted with comes from MAIL FROM and RCPT TO,
// never from the headers. This is what makes BCC work: the header set here
// names only one recipient and the envelope names three, and the two must not
// be reconciled.
func TestSubmissionEnvelopeComesFromTheCommandsNotTheHeaders(t *testing.T) {
	stub := newStub()
	c := dial(t, testConfig(), stub)
	c.authenticate()
	c.code("MAIL FROM:<%s>", testAlias)
	c.code("RCPT TO:<visible@example.test>")
	c.code("RCPT TO:<bcc1@example.test>")
	c.code("RCPT TO:<bcc2@example.test>")
	c.code("DATA")
	c.send("From: %s", testAlias)
	c.send("To: visible@example.test")
	c.send("Subject: quietly")
	c.send("")
	c.send("body")
	c.send(".")
	if got := c.line(); !strings.HasPrefix(got, "250") {
		t.Fatalf("DATA → %q", got)
	}

	args := stub.argsFor(t, "EmailSubmission/set")
	var create map[string]struct {
		IdentityID string `json:"identityId"`
		Envelope   struct {
			MailFrom struct {
				Email string `json:"email"`
			} `json:"mailFrom"`
			RcptTo []struct {
				Email string `json:"email"`
			} `json:"rcptTo"`
		} `json:"envelope"`
	}
	if err := json.Unmarshal(args["create"], &create); err != nil {
		t.Fatalf("create: %v", err)
	}
	sub := create["s"]
	if len(sub.Envelope.RcptTo) != 3 {
		t.Fatalf("envelope carried %d recipients, want the 3 from RCPT TO", len(sub.Envelope.RcptTo))
	}
	if sub.Envelope.MailFrom.Email != testAlias {
		t.Errorf("mailFrom = %q, want the address MAIL FROM named", sub.Envelope.MailFrom.Email)
	}
	// The identity must be the one that address resolved to, not the account's
	// default — submitting an alias under the primary identity is how a
	// carefully chosen From address silently becomes the wrong one.
	if sub.IdentityID != "id_alias" {
		t.Errorf("identityId = %q, want id_alias", sub.IdentityID)
	}
	if !strings.Contains(stub.uploaded(t), "To: visible@example.test") {
		t.Error("the uploaded message should still carry its own headers verbatim")
	}
}

// The size cap has to be enforced during the transfer, not after it, or the
// cap is not a memory bound at all.
//
// Note what is NOT asserted: what the session does next. On a 552 the reader
// returns without draining the rest of the body, so the remaining lines are
// parsed as commands — see the report accompanying this suite. Pinning that
// behaviour here would make it look intended.
func TestOversizedMessagesAreRejectedDuringTransfer(t *testing.T) {
	cfg := testConfig()
	cfg.MaxSize = 64
	stub := newStub()
	c := dial(t, cfg, stub)
	c.authenticate()
	c.code("MAIL FROM:<%s>", testUser)
	c.code("RCPT TO:<someone@example.test>")
	c.code("DATA")

	c.send("Subject: too big")
	c.send("")
	c.send("%s", strings.Repeat("x", 200))
	if got := c.line(); !strings.HasPrefix(got, "552") {
		t.Fatalf("oversized DATA → %q, want 552", got)
	}
	for _, m := range stub.methods() {
		if m == "EmailSubmission/set" {
			t.Fatal("an oversized message was submitted anyway")
		}
	}
}

// A submission the server refused must be a 5xx, not a 250. "250 queued" for a
// message that was never queued is the worst answer a submission agent can
// give: the client deletes its copy and the mail is simply gone.
func TestARejectedSubmissionIsReportedAsAFailure(t *testing.T) {
	stub := newStub()
	stub.notCreated = true
	c := dial(t, testConfig(), stub)
	c.authenticate()
	c.code("MAIL FROM:<%s>", testUser)
	c.code("RCPT TO:<someone@example.test>")
	c.code("DATA")
	c.send("Subject: nope")
	c.send("")
	c.send("body")
	c.send(".")

	line := c.line()
	if !strings.HasPrefix(line, "554") {
		t.Fatalf("rejected submission → %q, want 554", line)
	}
	// The envelope is cleared either way, so the next message starts clean
	// rather than inheriting the failed one's recipients.
	if got := c.code("DATA"); got != "503" {
		t.Errorf("DATA after a failed submission → %s, want 503 (the envelope must be gone)", got)
	}
}

// ---- parsing -----------------------------------------------------------------

// oneLine is the only thing between a server-supplied error string and an SMTP
// reply. SMTP replies are newline-delimited, so an error containing CRLF would
// let the far end write additional reply lines into the stream — a client that
// reads "250 2.0.0 queued" out of an error message believes a rejected message
// was sent.
func TestOneLineCannotForgeAnExtraReplyLine(t *testing.T) {
	for _, tc := range []struct{ name, in string }{
		{"CRLF injection", "rejected\r\n250 2.0.0 queued as forged"},
		{"bare LF injection", "rejected\n250 2.0.0 queued"},
		{"bare CR injection", "rejected\r250 2.0.0 queued"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := oneLine(tc.in)
			if strings.ContainsAny(got, "\r\n") {
				t.Fatalf("oneLine(%q) = %q, still contains a line break", tc.in, got)
			}
		})
	}
	if got := oneLine(strings.Repeat("e", 5000)); len(got) != 200 {
		t.Errorf("oneLine truncated to %d bytes, want a 200-byte bound on remote-controlled text", len(got))
	}
}

// extractAddr reads the address that becomes the envelope. Every wrong answer
// here is either a refused legitimate send or an accepted illegitimate one.
func TestExtractAddr(t *testing.T) {
	for _, tc := range []struct {
		name, arg, keyword, want string
	}{
		{"the ordinary form", "FROM:<corny@example.test>", "FROM", "corny@example.test"},
		{"keyword casing is the client's choice", "from:<corny@example.test>", "FROM", "corny@example.test"},
		{"mixed case", "FrOm:<corny@example.test>", "FROM", "corny@example.test"},
		{"space after the colon", "FROM: <corny@example.test>", "FROM", "corny@example.test"},
		{"ESMTP parameters are ignored", "FROM:<corny@example.test> SIZE=1024 BODY=8BITMIME", "FROM", "corny@example.test"},
		{"angle brackets are optional", "FROM:corny@example.test", "FROM", "corny@example.test"},
		{"bare address with parameters", "TO:someone@example.test NOTIFY=NEVER", "TO", "someone@example.test"},
		{"RCPT uses its own keyword", "TO:<someone@example.test>", "TO", "someone@example.test"},

		// Refusals. A "" return is what the caller turns into a 501, so each of
		// these is a command that must not produce an envelope.
		{"the null sender is not an identity", "FROM:<>", "FROM", ""},
		{"the wrong keyword is not a near miss", "TO:<someone@example.test>", "FROM", ""},
		{"an unterminated bracket is not an address", "FROM:<corny@example.test", "FROM", ""},
		{"no colon", "FROM <corny@example.test>", "FROM", ""},
		{"empty argument", "", "FROM", ""},
		{"the keyword alone", "FROM:", "FROM", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := extractAddr(tc.arg, tc.keyword); got != tc.want {
				t.Errorf("extractAddr(%q, %q) = %q, want %q", tc.arg, tc.keyword, got, tc.want)
			}
		})
	}
}

func TestSplitUppercasesTheVerbAndTrimsTheArgument(t *testing.T) {
	for _, tc := range []struct{ in, verb, arg string }{
		{"QUIT", "QUIT", ""},
		{"quit", "QUIT", ""},
		{"MaIl FROM:<a@b.test>", "MAIL", "FROM:<a@b.test>"},
		{"RCPT  TO:<a@b.test>  ", "RCPT", "TO:<a@b.test>"},
		{"EHLO", "EHLO", ""},
		{"", "", ""},
	} {
		verb, arg := split(tc.in)
		if verb != tc.verb || arg != tc.arg {
			t.Errorf("split(%q) = (%q, %q), want (%q, %q)", tc.in, verb, arg, tc.verb, tc.arg)
		}
	}
}

// A client that sends bare LF instead of CRLF is out of spec but common. The
// command must still be understood, because the alternative is a session that
// answers every command with 502 and looks like an outage.
func TestBareLFCommandsAreUnderstood(t *testing.T) {
	c := dial(t, testConfig(), newStub())
	_ = c.c.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if _, err := io.WriteString(c.c, "NOOP\n"); err != nil {
		t.Fatalf("write: %v", err)
	}
	if got := c.line(); !strings.HasPrefix(got, "250") {
		t.Fatalf("bare-LF NOOP → %q, want 250", got)
	}
}

// QUIT must close the connection, not merely answer. A submission session left
// open after QUIT holds one of the 64 shared connection slots.
func TestQuitClosesTheConnection(t *testing.T) {
	c := dial(t, testConfig(), newStub())
	if got := c.cmd("QUIT"); !strings.HasPrefix(got, "221") {
		t.Fatalf("QUIT → %q, want 221", got)
	}
	select {
	case <-c.done:
	case <-time.After(5 * time.Second):
		t.Fatal("the session stayed open after QUIT")
	}
}
