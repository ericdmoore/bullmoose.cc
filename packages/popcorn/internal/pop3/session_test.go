package pop3

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Every test here drives the real Serve loop over a net.Pipe and the real jmap
// client over an in-process http.RoundTripper. Nothing listens, nothing dials,
// nothing resolves: popcorn is live mail infrastructure bound to a Tailscale
// address on the author's machine, and a test suite that can open a port is a
// test suite that can talk to it.
//
// http.DefaultTransport is a process global, so nothing in this file may call
// t.Parallel.

const (
	testBase  = "https://jmap.test"
	testUser  = "corny@example.test"
	testToken = "bm_app_password_token"
)

func testConfig() Config {
	return Config{
		JMAPBase:    testBase,
		DeleMode:    "archive",
		MaxMessages: 200,
		// Serve arms this as a read deadline on every command, so it must be
		// long enough that a slow machine never mistakes CI for an idle client.
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

	roles  map[string]string
	emails []map[string]any // newest-first, as a JMAP server sorts
	// emailsLater, when set, is what every listing after the first returns —
	// the server's view moving on between one login and the next.
	emailsLater []map[string]any
	listings    int
	blobs       map[string]string // blobId → raw RFC 5322 bytes
	notUpdated  []string          // ids Email/set refuses to move
}

func newStub() *jmapStub {
	return &jmapStub{
		roles: map[string]string{"inbox": "mb_inbox", "archive": "mb_archive"},
		emails: []map[string]any{
			{"id": "em_newest", "blobId": "blob_3", "size": 30},
			{"id": "em_middle", "blobId": "blob_2", "size": 20},
			{"id": "em_oldest", "blobId": "blob_1", "size": 10},
		},
		blobs: map[string]string{
			"blob_1": "Subject: one\r\n\r\nfirst body line\r\nsecond body line\r\n",
			// A message whose body contains a bare "." line and a line that
			// already starts with a dot: the two shapes that break a POP3
			// client if the server's dot-stuffing is wrong.
			"blob_2": "Subject: two\r\n\r\n.\r\n.hidden\r\nlast\r\n",
			"blob_3": "Subject: three\r\n\r\nthird\r\n",
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
	case strings.HasPrefix(req.URL.Path, "/dl/"):
		for id, raw := range s.blobs {
			if strings.Contains(req.URL.Path, id) {
				return respond(200, raw)
			}
		}
		return respond(404, "")
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
		case "Email/query":
			responses = append(responses, []any{name, map[string]any{"ids": []string{}}, tag})
		case "Email/get":
			list := s.emails
			if s.listings > 0 && s.emailsLater != nil {
				list = s.emailsLater
			}
			s.listings++
			responses = append(responses, []any{name, map[string]any{"list": list}, tag})
		case "Email/set":
			args := map[string]any{"updated": map[string]any{}}
			if len(s.notUpdated) > 0 {
				rejected := map[string]any{}
				for _, id := range s.notUpdated {
					rejected[id] = map[string]any{"type": "notFound"}
				}
				args["notUpdated"] = rejected
			}
			responses = append(responses, []any{name, args, tag})
		default:
			responses = append(responses, []any{"error", map[string]any{"type": "unknownMethod"}, tag})
		}
	}
	out, _ := json.Marshal(map[string]any{"methodResponses": responses})
	return string(out)
}

// methods lists every JMAP method the session issued, in order. "Which methods
// were sent" is the safety question for DELE: a request that was never made
// cannot have touched anyone's mail.
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

// ---- the POP3 client, in memory ---------------------------------------------

type conn struct {
	t    *testing.T
	c    net.Conn
	r    *bufio.Reader
	done chan struct{}
}

// dial starts a session on one end of a pipe. The read/write deadlines are the
// suite's hang insurance: net.Pipe is unbuffered, so a test that sends a second
// command before draining the first response would otherwise deadlock CI
// instead of failing it.
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
	if greeting := c.line(); !strings.HasPrefix(greeting, "+OK") {
		t.Fatalf("greeting = %q, want +OK", greeting)
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

// line reads one response line with its CRLF stripped. It fails the test on a
// short or absent line rather than returning "", so a desynced session shows up
// where it happened.
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

// body reads a multiline response up to and including the terminating ".",
// returning the payload lines exactly as they arrived — dot-stuffing intact,
// because that is what is being asserted.
func (c *conn) body() []string {
	c.t.Helper()
	lines := []string{}
	for {
		l := c.line()
		if l == "." {
			return lines
		}
		lines = append(lines, l)
		if len(lines) > 500 {
			c.t.Fatalf("multiline response never terminated: %q", lines)
		}
	}
}

func (c *conn) cmd(format string, args ...any) string {
	c.t.Helper()
	c.send(format, args...)
	return c.line()
}

// ok sends a command and requires +OK, returning the rest of the status line.
func (c *conn) ok(format string, args ...any) string {
	c.t.Helper()
	line := c.cmd(format, args...)
	if !strings.HasPrefix(line, "+OK") {
		c.t.Fatalf("%q → %q, want +OK", fmt.Sprintf(format, args...), line)
	}
	return strings.TrimSpace(strings.TrimPrefix(line, "+OK"))
}

func (c *conn) authenticate() {
	c.t.Helper()
	c.ok("USER %s", testUser)
	c.ok("PASS %s", testToken)
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

// TestMain captures the log package so failure paths can be asserted on rather
// than merely scrolling past, and so a passing run is quiet.
func TestMain(m *testing.M) {
	log.SetOutput(&logBuf)
	os.Exit(m.Run())
}

// ---- state machine -----------------------------------------------------------

// RFC 1939's AUTHORIZATION state is the only thing between an anonymous
// connection and somebody's mail. Each of these commands reads or mutates the
// maildrop, so each must be refused before PASS — and refused without the
// server going anywhere near the JMAP account.
func TestMaildropCommandsAreRefusedBeforeAuthentication(t *testing.T) {
	for _, cmd := range []string{"STAT", "LIST", "LIST 1", "UIDL", "RETR 1", "TOP 1 0", "DELE 1", "RSET"} {
		t.Run(cmd, func(t *testing.T) {
			stub := newStub()
			c := dial(t, testConfig(), stub)
			c.send("USER %s", testUser) // a username alone authenticates nothing
			c.line()

			if got := c.cmd("%s", cmd); !strings.HasPrefix(got, "-ERR") {
				t.Fatalf("%s before PASS → %q, want -ERR", cmd, got)
			}
			if n := stub.requestCount(); n != 0 {
				t.Errorf("%s before PASS made %d JMAP request(s); an unauthenticated command must not reach the account", cmd, n)
			}
		})
	}
}

// PASS without USER has no account to authenticate against. The check must come
// before the login attempt, or an empty username reaches Discover and turns into
// a lookup for whatever domain "" parses as.
func TestPassWithoutUserIsRefusedWithoutContactingTheServer(t *testing.T) {
	stub := newStub()
	c := dial(t, testConfig(), stub)

	if got := c.cmd("PASS %s", testToken); got != "-ERR USER first" {
		t.Fatalf("PASS without USER → %q", got)
	}
	if n := stub.requestCount(); n != 0 {
		t.Errorf("made %d JMAP request(s) for a session with no username", n)
	}
}

// A failed password must not end the connection with the token anywhere a human
// or a log shipper can read it, and must leave the session unauthenticated —
// "-ERR" followed by a usable TRANSACTION state would be the whole ballgame.
func TestFailedAuthenticationLeaksNothingAndGrantsNothing(t *testing.T) {
	stub := newStub()
	c := dial(t, testConfig(), stub)
	c.ok("USER %s", testUser)

	got := c.cmd("PASS bm_the_wrong_token")
	if got != "-ERR authentication failed" {
		t.Fatalf("bad PASS → %q", got)
	}
	if strings.Contains(got, "bm_the_wrong_token") {
		t.Error("the response echoed the password")
	}
	if l := logBuf.String(); strings.Contains(l, "bm_the_wrong_token") {
		t.Errorf("the password reached the log: %s", l)
	}
	if got := c.cmd("STAT"); got != "-ERR not authenticated" {
		t.Fatalf("STAT after a failed PASS → %q, want the session to stay locked", got)
	}
}

// An unparseable command is normal traffic — clients probe for extensions — so
// it must not desync or drop the session. The lowercase and mixed-case cases
// are here because verbs are case-insensitive in RFC 1939 and a client that
// sends "quit" must not be answered "-ERR unknown command".
func TestUnknownAndOddlyCasedCommands(t *testing.T) {
	stub := newStub()
	c := dial(t, testConfig(), stub)

	if got := c.cmd("XYZZY"); got != "-ERR unknown command" {
		t.Errorf("XYZZY → %q", got)
	}
	if got := c.cmd("STLS"); got != "-ERR unknown command" {
		t.Errorf("STLS → %q, want a refusal (popcorn is implicit-TLS only)", got)
	}
	c.ok("noop") // lowercase
	// Leading whitespace makes the verb empty rather than shifting it, so
	// " QUIT" is refused instead of quietly quitting. Refused, not fatal.
	if got := c.cmd("  NOOP  "); got != "-ERR unknown command" {
		t.Errorf("a leading-space command → %q, want a refusal rather than a shifted verb", got)
	}

	if got := c.ok("cApA"); got == "" {
		t.Error("CAPA should announce capabilities regardless of verb case")
	}
	caps := c.body()
	if len(caps) == 0 || !contains(caps, "UIDL") || !contains(caps, "TOP") {
		t.Errorf("CAPA = %q, want at least UIDL and TOP (clients feature-detect on these)", caps)
	}
}

// The 2048-byte cap is the only bound on a single command line. Without the
// disconnect, a client could keep a connection buffering unbounded input; with
// it, the session must end rather than resume mid-line and interpret the tail
// of the flood as commands.
func TestAnOverlongCommandLineEndsTheSession(t *testing.T) {
	stub := newStub()
	c := dial(t, testConfig(), stub)

	c.send("USER %s", strings.Repeat("a", 3000))
	if got := c.line(); got != "-ERR line too long" {
		t.Fatalf("overlong line → %q", got)
	}
	select {
	case <-c.done:
	case <-time.After(5 * time.Second):
		t.Fatal("session stayed open after an overlong line")
	}
}

// Refusing the line and not holding it are different promises, and the test
// above only makes the first — it passed just as well when the check ran after
// bufio had already assembled every byte the client sent. This is the second.
//
// What it counts is how much of the flood the session was willing to read.
// net.Pipe is unbuffered, so a Write returns only once the server has taken the
// bytes: this counter is what popcorn actually consumed, which under the old
// ReadString became memory one-for-one. That makes it a proxy for the
// allocation and not a measurement of it — the measurement is in
// internal/wire's TestReadLineBoundsWhatOneLineCanAllocate, on the code this
// loop now reads through. What this test adds is the part that test cannot see:
// that the live command loop on :995, before authentication, is what reads
// through it.
func TestAnOverlongCommandLineStopsBeingReadAtTheCap(t *testing.T) {
	c := dial(t, testConfig(), newStub())

	const flood = 4 << 20 // what an unauthenticated stranger offers to send
	var consumed int64
	// Written from a goroutine: the session stops mid-line and hangs up, so the
	// reply has to be read while the rest of this is still in flight. A
	// foreground write would deadlock the pipe against the server's reply.
	go func() {
		chunk := []byte(strings.Repeat("a", 512))
		for sent := 0; sent < flood; sent += len(chunk) {
			_ = c.c.SetWriteDeadline(time.Now().Add(5 * time.Second))
			n, err := c.c.Write(chunk)
			atomic.AddInt64(&consumed, int64(n))
			if err != nil {
				return
			}
		}
		// A terminator at the end, so that a reader which insists on assembling
		// the whole line still finishes and answers. This test must fail on its
		// assertion, naming the bytes, rather than on a read timeout that names
		// nothing.
		_ = c.c.SetWriteDeadline(time.Now().Add(5 * time.Second))
		n, _ := io.WriteString(c.c, "\r\n")
		atomic.AddInt64(&consumed, int64(n))
	}()

	if got := c.line(); got != "-ERR line too long" {
		t.Fatalf("overlong line → %q", got)
	}
	select {
	case <-c.done:
	case <-time.After(5 * time.Second):
		t.Fatal("session stayed open after an overlong line")
	}
	// One read buffer of slack over the cap: the reader works in whole
	// ReadSlice chunks, so it can hold up to a bufferful past the limit before
	// it can tell it is past it.
	if got := atomic.LoadInt64(&consumed); got > maxCommandLine+4096 {
		t.Fatalf("the session read %d bytes of a line it had already decided was too long (cap %d) — the bound has to stop the reader, not just the parser", got, maxCommandLine)
	}
}

// RFC 1939 §5 makes USER and PASS AUTHORIZATION-state commands: a session that
// has authenticated is in TRANSACTION state, where they are not valid. popcorn
// accepted them anyway, and PASS re-snapshots the maildrop — so a second login
// handed the client's existing message numbers a different list of messages.
// QUIT then applied those numbers to the new snapshot and archived whatever now
// sat at them: silent, unasked-for, and indistinguishable from mail loss to the
// person it happens to. When the maildrop had shrunk instead, the same line
// indexed past the end — a panic on a connection goroutine, which is the daemon
// and every other session on it.
func TestReauthenticationIsRefusedOnceTheTransactionHasStarted(t *testing.T) {
	stub := newStub()
	// The ordinary thing that happens to a maildrop between two logins:
	// another client files the oldest message and new mail arrives. Every
	// number shifts, so a re-snapshot points message 1 at a message the
	// client has never mentioned.
	stub.emailsLater = []map[string]any{
		{"id": "em_brand_new", "blobId": "blob_9", "size": 90},
		{"id": "em_newest", "blobId": "blob_3", "size": 30},
		{"id": "em_middle", "blobId": "blob_2", "size": 20},
	}
	c := dial(t, testConfig(), stub)
	c.authenticate()
	c.ok("DELE 1") // em_oldest — the message *this* session numbered 1

	if got := c.cmd("USER %s", testUser); got != "-ERR already authenticated" {
		t.Errorf("USER in TRANSACTION state → %q, want -ERR", got)
	}
	if got := c.cmd("PASS %s", testToken); got != "-ERR already authenticated" {
		t.Errorf("PASS in TRANSACTION state → %q, want -ERR", got)
	}
	// The maildrop the client was given is still the one it is talking about.
	if got := c.ok("STAT"); got != "2 50" {
		t.Errorf("STAT after a refused re-login = %q, want the original snapshot less the DELE", got)
	}
	if got := c.ok("QUIT"); got != "popcorn signing off" {
		t.Fatalf("QUIT → %q", got)
	}

	args := stub.argsFor(t, "Email/set")
	var update map[string]struct {
		MailboxIDs map[string]bool `json:"mailboxIds"`
	}
	if err := json.Unmarshal(args["update"], &update); err != nil {
		t.Fatalf("update: %v", err)
	}
	if _, ok := update["em_oldest"]; len(update) != 1 || !ok {
		t.Fatalf("QUIT archived %v, want exactly em_oldest — the message DELE 1 named", update)
	}
}

// The snapshot and the deletion marks are one value: the marks are indices
// into the snapshot, and pass() replaces it. Serve no longer lets a client
// reach pass() twice, so this calls it directly — the pairing is the
// invariant, and neither a relaxed state gate nor a second caller should be
// able to leave old numbers pointing into a new list.
func TestPassReplacesTheDeletionMarksAlongWithTheSnapshot(t *testing.T) {
	old := http.DefaultTransport
	http.DefaultTransport = newStub()
	t.Cleanup(func() { http.DefaultTransport = old })

	clientEnd, serverEnd := net.Pipe()
	t.Cleanup(func() { clientEnd.Close(); serverEnd.Close() })
	go func() { _, _ = io.Copy(io.Discard, clientEnd) }() // pass writes a +OK

	s := &Session{
		conn:    serverEnd,
		r:       bufio.NewReaderSize(serverEnd, 4096),
		cfg:     testConfig(),
		user:    testUser,
		deleted: map[int]bool{3: true}, // a mark against a maildrop being replaced
	}
	s.pass(testToken)

	if s.client == nil {
		t.Fatal("pass did not authenticate")
	}
	if len(s.deleted) != 0 {
		t.Errorf("deleted = %v after a fresh snapshot, want empty — those numbers index the maildrop that was just thrown away", s.deleted)
	}
}

// ---- the maildrop ------------------------------------------------------------

// The maildrop is snapshotted at login and numbered from the oldest message,
// and those numbers must hold still for the whole transaction — a client that
// asks for message 2 twice must get the same message both times, even if new
// mail arrives in between.
func TestLoginSnapshotsTheMaildropOldestFirst(t *testing.T) {
	stub := newStub()
	c := dial(t, testConfig(), stub)

	c.ok("USER %s", testUser)
	if got := c.ok("PASS %s", testToken); got != "maildrop has 3 message(s)" {
		t.Fatalf("PASS → %q", got)
	}
	if got := c.ok("STAT"); got != "3 60" {
		t.Errorf("STAT = %q, want 3 messages totalling 60 octets", got)
	}
	c.ok("LIST")
	if got, want := c.body(), []string{"1 10", "2 20", "3 30"}; !equal(got, want) {
		t.Errorf("LIST = %q, want %q (sizes ascend because numbering starts at the oldest)", got, want)
	}
	c.ok("UIDL")
	if got, want := c.body(), []string{"1 em_oldest", "2 em_middle", "3 em_newest"}; !equal(got, want) {
		t.Errorf("UIDL = %q, want %q", got, want)
	}
}

// Dot-stuffing is what keeps message content from being read as protocol. A
// body line of "." would end the response early — the client silently truncates
// the message — and ".hidden" would arrive as "hidden".
func TestRetrDotStuffsMessageContent(t *testing.T) {
	stub := newStub()
	c := dial(t, testConfig(), stub)
	c.authenticate()

	c.ok("RETR 2")
	got := c.body()
	// The trailing "" is not dot-stuffing: retr splits the message on "\n" and
	// re-emits every element with CRLF, so a message that ends in a newline —
	// i.e. every well-formed message — gains one empty line on the way out.
	// Pinned deliberately. It is a fidelity deviation, not a corruption, and a
	// fix should have to change this line on purpose.
	want := []string{"Subject: two", "", "..", "..hidden", "last", ""}
	if !equal(got, want) {
		t.Fatalf("RETR 2 = %q, want %q — leading dots must be doubled on the wire", got, want)
	}
}

// TOP is how clients preview mail without downloading it, and "n = 0" means
// headers only. Sending the body anyway would defeat the point on a metered
// link; dropping the blank separator line would make the client read the first
// body line as a header.
func TestTopSendsHeadersPlusExactlyNBodyLines(t *testing.T) {
	stub := newStub()
	c := dial(t, testConfig(), stub)
	c.authenticate()

	c.ok("TOP 1 0")
	if got, want := c.body(), []string{"Subject: one", ""}; !equal(got, want) {
		t.Errorf("TOP 1 0 = %q, want %q", got, want)
	}
	c.ok("TOP 1 1")
	if got, want := c.body(), []string{"Subject: one", "", "first body line"}; !equal(got, want) {
		t.Errorf("TOP 1 1 = %q, want %q", got, want)
	}
	if got := c.cmd("TOP 1"); !strings.HasPrefix(got, "-ERR") {
		t.Errorf("TOP with no line count → %q, want -ERR", got)
	}
	if got := c.cmd("TOP 1 -1"); !strings.HasPrefix(got, "-ERR") {
		t.Errorf("TOP 1 -1 → %q, want -ERR", got)
	}
}

// Message numbers come off the wire from an unauthenticated-until-a-moment-ago
// client and index a slice. Anything outside 1..len must be an -ERR, not a
// panic: an unrecovered panic on a connection goroutine takes the whole daemon
// down and with it every other user's session.
func TestOutOfRangeMessageNumbersAreRefused(t *testing.T) {
	for _, arg := range []string{"0", "-1", "4", "99999", "abc", "", "1.5", "9999999999999999999999"} {
		t.Run("RETR "+arg, func(t *testing.T) {
			stub := newStub()
			c := dial(t, testConfig(), stub)
			c.authenticate()
			if got := c.cmd("RETR %s", arg); !strings.HasPrefix(got, "-ERR") {
				t.Fatalf("RETR %q → %q, want -ERR", arg, got)
			}
			if got := c.ok("STAT"); got != "3 60" {
				t.Errorf("the session did not survive: STAT = %q", got)
			}
		})
	}
}

// ---- DELE: the never-destroys invariant --------------------------------------

// This is the property the package documentation states in prose:
// "POPCORN_DELE_MODE  archive (default) | noop — popcorn NEVER destroys".
//
// DELE marks a message and QUIT acts on the marks, so the test follows the same
// path a mail client does: delete one message out of three, confirm it vanishes
// from the client's view of the maildrop, and then confirm that what actually
// reached the server was a move — of exactly the message that was deleted, to
// the archive mailbox — and nothing else. The raw-bytes check is there because
// a structural assertion would still pass an Email/set that carried both an
// update and a destroy.
func TestDeleArchivesTheDeletedMessageAndOnlyThat(t *testing.T) {
	stub := newStub()
	c := dial(t, testConfig(), stub)
	c.authenticate()

	if got := c.ok("DELE 2"); !strings.Contains(got, "never destroys") {
		t.Errorf("DELE 2 → %q; the reply is where a user learns their mail is not gone", got)
	}
	// The client's view: message 2 is gone from the maildrop and cannot be read.
	if got := c.ok("STAT"); got != "2 40" {
		t.Errorf("STAT after DELE = %q, want the deleted message excluded", got)
	}
	c.ok("LIST")
	if got, want := c.body(), []string{"1 10", "3 30"}; !equal(got, want) {
		t.Errorf("LIST after DELE = %q, want %q — numbers must not be renumbered", got, want)
	}
	if got := c.cmd("RETR 2"); got != "-ERR message deleted" {
		t.Errorf("RETR of a deleted message → %q", got)
	}
	if got := c.cmd("DELE 2"); got != "-ERR message deleted" {
		t.Errorf("DELE twice → %q, want -ERR", got)
	}

	if got := c.ok("QUIT"); got != "popcorn signing off" {
		t.Errorf("QUIT → %q", got)
	}

	args := stub.argsFor(t, "Email/set")
	if _, ok := args["destroy"]; ok {
		t.Error("QUIT sent a destroy — popcorn must never destroy mail")
	}
	var update map[string]struct {
		MailboxIDs map[string]bool `json:"mailboxIds"`
	}
	if err := json.Unmarshal(args["update"], &update); err != nil {
		t.Fatalf("update: %v", err)
	}
	if len(update) != 1 {
		t.Fatalf("QUIT moved %d messages, want only the one DELE'd: %v", len(update), update)
	}
	// The message numbered 2 is the middle one. An off-by-one here archives
	// mail the user never deleted, which looks to them exactly like mail loss.
	if _, ok := update["em_middle"]; !ok {
		t.Fatalf("QUIT moved %v, want em_middle (the message DELE 2 named)", update)
	}
	if got := update["em_middle"].MailboxIDs; len(got) != 1 || !got["mb_archive"] {
		t.Errorf("em_middle moved to %v, want exactly the archive mailbox", got)
	}
	stub.mu.Lock()
	defer stub.mu.Unlock()
	for _, r := range stub.reqs {
		if strings.Contains(strings.ToLower(string(r.Body)), "destroy") {
			t.Errorf("a request mentioned destroy: %s", r.Body)
		}
	}
}

// The other half of the documented invariant: noop mode. An operator who sets
// POPCORN_DELE_MODE=noop is asking for DELE to be theatre — the client is told
// the message is deleted so it stops re-downloading it, and the server is never
// touched. Any write at all here is the bug.
func TestDeleModeNoopNeverWritesToTheServer(t *testing.T) {
	stub := newStub()
	cfg := testConfig()
	cfg.DeleMode = "noop"
	c := dial(t, cfg, stub)
	c.authenticate()

	c.ok("DELE 1")
	c.ok("DELE 3")
	if got := c.ok("QUIT"); got != "popcorn signing off" {
		t.Errorf("QUIT → %q", got)
	}
	for _, m := range stub.methods() {
		if m == "Email/set" {
			t.Fatalf("noop mode issued a write: %v", stub.methods())
		}
	}
}

// An account with no archive mailbox has nowhere to put a "deleted" message.
// Leaving it in the inbox is the only choice that keeps the promise; failing
// the session or falling back to a destroy would both break it. The client
// still gets +OK because from its side nothing went wrong.
func TestQuitWithNoArchiveMailboxLeavesTheMailAlone(t *testing.T) {
	stub := newStub()
	stub.roles = map[string]string{"inbox": "mb_inbox"}
	c := dial(t, testConfig(), stub)
	c.authenticate()

	c.ok("DELE 1")
	if got := c.ok("QUIT"); got != "popcorn signing off" {
		t.Errorf("QUIT → %q", got)
	}
	for _, m := range stub.methods() {
		if m == "Email/set" {
			t.Fatalf("wrote to the account with no archive mailbox: %v", stub.methods())
		}
	}
}

// If the archive move fails, the session must end in -ERR. POP3 clients treat
// +OK on QUIT as confirmation that the UPDATE state completed, which for a
// "delete after download" client is permission to forget the message — so a
// cheerful +OK over a failed move is how mail actually goes missing.
func TestQuitReportsAFailedArchiveInsteadOfClaimingSuccess(t *testing.T) {
	stub := newStub()
	stub.notUpdated = []string{"em_oldest"}
	c := dial(t, testConfig(), stub)
	c.authenticate()

	c.ok("DELE 1")
	if got := c.cmd("QUIT"); got != "-ERR update failed; no messages removed" {
		t.Fatalf("QUIT after a failed archive → %q, want -ERR", got)
	}
}

// RSET is the client's undo, and it must reach the server-side effect too: a
// session that RSETs and then quits has deleted nothing, so it must write
// nothing.
func TestRsetUndeletesEverything(t *testing.T) {
	stub := newStub()
	c := dial(t, testConfig(), stub)
	c.authenticate()

	c.ok("DELE 1")
	c.ok("DELE 2")
	if got := c.ok("RSET"); got != "3 60" {
		t.Errorf("RSET → %q, want the full maildrop back", got)
	}
	c.ok("RETR 1") // readable again
	c.body()
	c.ok("QUIT")
	for _, m := range stub.methods() {
		if m == "Email/set" {
			t.Fatalf("QUIT wrote to the server after RSET: %v", stub.methods())
		}
	}
}

// A session that is dropped rather than QUIT must not commit anything: RFC 1939
// says a connection closed without QUIT never enters the UPDATE state. Mail
// clients drop connections constantly.
func TestADroppedConnectionCommitsNothing(t *testing.T) {
	stub := newStub()
	c := dial(t, testConfig(), stub)
	c.authenticate()
	c.ok("DELE 1")

	c.c.Close()
	select {
	case <-c.done:
	case <-time.After(5 * time.Second):
		t.Fatal("Serve did not return after the client vanished")
	}
	for _, m := range stub.methods() {
		if m == "Email/set" {
			t.Fatalf("a dropped connection still archived mail: %v", stub.methods())
		}
	}
}

// ---- pure helpers ------------------------------------------------------------

// TOP's "n body lines" is defined relative to the blank line that ends the
// headers. A message with no blank line at all (truncated, or headers-only) has
// no body to limit, and must not be cut short of its headers.
func TestTopSlice(t *testing.T) {
	for _, tc := range []struct {
		name  string
		lines []string
		n     int
		want  []string
	}{
		{"zero body lines keeps the headers and the separator", []string{"H: 1", "", "a", "b"}, 0, []string{"H: 1", ""}},
		{"n body lines are counted after the separator", []string{"H: 1", "", "a", "b"}, 1, []string{"H: 1", "", "a"}},
		{"asking for more body than exists is not an error", []string{"H: 1", "", "a"}, 99, []string{"H: 1", "", "a"}},
		{"a message with no separator is all headers", []string{"H: 1", "H: 2"}, 0, []string{"H: 1", "H: 2"}},
		{"a CR-only separator still counts as the separator", []string{"H: 1", "\r", "a"}, 0, []string{"H: 1", "\r"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := topSlice(tc.lines, tc.n); !equal(got, tc.want) {
				t.Errorf("topSlice(%q, %d) = %q, want %q", tc.lines, tc.n, got, tc.want)
			}
		})
	}
}

// The verb is uppercased and the argument trimmed before dispatch, which is
// what makes "dele 1" and "DELE  1" the same command.
func TestSplitCommand(t *testing.T) {
	for _, tc := range []struct{ in, verb, arg string }{
		{"STAT", "STAT", ""},
		{"stat", "STAT", ""},
		{"dele 1", "DELE", "1"},
		{"TOP 1 10", "TOP", "1 10"},
		{"UIDL  2  ", "UIDL", "2"},
		{"", "", ""},
		{"USER corny@example.test", "USER", "corny@example.test"},
	} {
		verb, arg := splitCommand(tc.in)
		if verb != tc.verb || arg != tc.arg {
			t.Errorf("splitCommand(%q) = (%q, %q), want (%q, %q)", tc.in, verb, arg, tc.verb, tc.arg)
		}
	}
}

func contains(hay []string, needle string) bool {
	for _, h := range hay {
		if h == needle {
			return true
		}
	}
	return false
}

func equal(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
