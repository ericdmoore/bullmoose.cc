package jmap

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
)

// These tests never open a socket. jmap.Client builds its own http.Client with
// a nil Transport, which net/http resolves to http.DefaultTransport at request
// time — so swapping that global puts a whole JMAP server in this process while
// the client code under test runs completely unmodified. popcorn is live mail
// infrastructure: its tests must not be able to reach a port, a host, or DNS
// even by accident, and the SRV path in Discover is never exercised here for
// exactly that reason.
//
// Nothing in this file may call t.Parallel — the transport is a process global.

const (
	testBase    = "https://jmap.test"
	testUser    = "corny@example.test"
	testToken   = "bm_app_password_token"
	testAccount = "acct_1"
)

// recorded is one HTTP exchange the client attempted, captured before it could
// reach a socket. The Auth field exists so tests can assert where credentials
// travelled, not merely that a request happened.
type recorded struct {
	Method string
	URL    string
	Auth   string
	Body   []byte
}

// call is one JMAP method call pulled out of a request body.
type call struct {
	Name string
	Args map[string]json.RawMessage
	Tag  string
}

type jmapStub struct {
	mu   sync.Mutex
	reqs []recorded

	roles      map[string]string // Mailbox/get: role → mailbox id
	emails     []map[string]any  // Email/get: newest-first, as a server sorts it
	identities []map[string]any
	blob       []byte

	sessionStatus int      // non-200 → session fetch failure
	sessionBody   string   // overrides the default session document
	uploadStatus  int      // non-2xx → upload failure
	notUpdated    []string // ids Email/set refuses to update
	notCreated    bool     // EmailSubmission/set refuses the submission
	shortResponse bool     // return fewer methodResponses than methodCalls
}

func newStub() *jmapStub {
	return &jmapStub{
		roles: map[string]string{"inbox": "mb_inbox", "archive": "mb_archive", "drafts": "mb_drafts", "sent": "mb_sent"},
		blob:  []byte("Subject: hi\r\n\r\nbody\r\n"),
	}
}

func (s *jmapStub) RoundTrip(req *http.Request) (*http.Response, error) {
	var body []byte
	if req.Body != nil {
		body, _ = io.ReadAll(req.Body)
	}
	s.mu.Lock()
	s.reqs = append(s.reqs, recorded{Method: req.Method, URL: req.URL.String(), Auth: req.Header.Get("Authorization"), Body: body})
	s.mu.Unlock()

	if _, pass, ok := req.BasicAuth(); !ok || pass != testToken {
		return respond(req, 401, `{"error":"unauthorized"}`), nil
	}
	switch {
	case strings.HasSuffix(req.URL.Path, "/.well-known/jmap"):
		return respond(req, orInt(s.sessionStatus, 200), orStr(s.sessionBody, sessionDoc)), nil
	case strings.HasPrefix(req.URL.Path, "/upload/"):
		return respond(req, orInt(s.uploadStatus, 201), `{"blobId":"blob_uploaded"}`), nil
	case strings.HasPrefix(req.URL.Path, "/dl/"):
		return respondBytes(req, 200, s.blob), nil
	case req.URL.Path == "/api":
		return respond(req, 200, s.dispatch(body)), nil
	}
	return respond(req, 404, `{}`), nil
}

// dispatch answers each methodCall in order, the way a JMAP server batches.
// It does not resolve the `#ids` back-reference — nothing under test depends
// on the server's resolution, only on what the client does with the result.
func (s *jmapStub) dispatch(body []byte) string {
	var envelope struct {
		MethodCalls []json.RawMessage `json:"methodCalls"`
	}
	_ = json.Unmarshal(body, &envelope)

	responses := []any{}
	for _, raw := range envelope.MethodCalls {
		c := decodeCall(raw)
		switch c.Name {
		case "Mailbox/get":
			list := []map[string]any{}
			for role, id := range s.roles {
				list = append(list, map[string]any{"id": id, "role": role})
			}
			responses = append(responses, []any{c.Name, map[string]any{"list": list}, c.Tag})
		case "Email/query":
			responses = append(responses, []any{c.Name, map[string]any{"ids": []string{}}, c.Tag})
		case "Email/get":
			responses = append(responses, []any{c.Name, map[string]any{"list": s.emails}, c.Tag})
		case "Identity/get":
			responses = append(responses, []any{c.Name, map[string]any{"list": s.identities}, c.Tag})
		case "Email/import":
			responses = append(responses, []any{c.Name, map[string]any{"created": map[string]any{"d": map[string]any{"id": "em_imported"}}}, c.Tag})
		case "EmailSubmission/set":
			if s.notCreated {
				responses = append(responses, []any{c.Name, map[string]any{"notCreated": map[string]any{"s": map[string]any{"type": "forbiddenFrom"}}}, c.Tag})
				continue
			}
			responses = append(responses, []any{c.Name, map[string]any{"created": map[string]any{"s": map[string]any{"id": "sub_1"}}}, c.Tag})
		case "Email/set":
			args := map[string]any{"updated": map[string]any{}}
			if len(s.notUpdated) > 0 {
				rejected := map[string]any{}
				for _, id := range s.notUpdated {
					rejected[id] = map[string]any{"type": "notFound"}
				}
				args["notUpdated"] = rejected
			}
			responses = append(responses, []any{c.Name, args, c.Tag})
		default:
			responses = append(responses, []any{"error", map[string]any{"type": "unknownMethod"}, c.Tag})
		}
	}
	if s.shortResponse {
		responses = responses[:0]
	}
	out, _ := json.Marshal(map[string]any{"methodResponses": responses})
	return string(out)
}

// callsMade returns the JMAP method names the client sent, in order. Tests
// assert on this set because "which methods were issued" is the safety
// question — an Email/set that is not there cannot have moved anyone's mail.
func (s *jmapStub) callsMade() []string {
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
			names = append(names, decodeCall(raw).Name)
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
			if c := decodeCall(raw); c.Name == method {
				return c.Args
			}
		}
	}
	t.Fatalf("client never issued %s; it issued %v", method, s.callsMade())
	return nil
}

func decodeCall(raw json.RawMessage) call {
	var tuple [3]json.RawMessage
	_ = json.Unmarshal(raw, &tuple)
	var c call
	_ = json.Unmarshal(tuple[0], &c.Name)
	_ = json.Unmarshal(tuple[1], &c.Args)
	_ = json.Unmarshal(tuple[2], &c.Tag)
	return c
}

const sessionDoc = `{
  "apiUrl": "https://jmap.test/api",
  "downloadUrl": "https://jmap.test/dl/{accountId}/{blobId}/{name}?type={type}",
  "uploadUrl": "https://jmap.test/upload/{accountId}",
  "primaryAccounts": {"urn:ietf:params:jmap:mail": "acct_1"},
  "accounts": {"acct_1": {}}
}`

func respond(req *http.Request, status int, body string) *http.Response {
	return respondBytes(req, status, []byte(body))
}

func respondBytes(req *http.Request, status int, body []byte) *http.Response {
	return &http.Response{
		StatusCode: status,
		Body:       io.NopCloser(strings.NewReader(string(body))),
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Request:    req,
	}
}

func orInt(v, fallback int) int {
	if v != 0 {
		return v
	}
	return fallback
}

func orStr(v, fallback string) string {
	if v != "" {
		return v
	}
	return fallback
}

// install puts the stub in front of every request the process makes for the
// duration of the test, and returns a logged-in client.
func install(t *testing.T, s *jmapStub) *jmapStub {
	t.Helper()
	old := http.DefaultTransport
	http.DefaultTransport = s
	t.Cleanup(func() { http.DefaultTransport = old })
	return s
}

func login(t *testing.T, s *jmapStub) *Client {
	t.Helper()
	install(t, s)
	c, err := Login(testBase, testUser, testToken)
	if err != nil {
		t.Fatalf("Login: %v", err)
	}
	return c
}

// ---- the invariant popcorn is named for -------------------------------------

// POPCORN_DELE_MODE is documented as "archive (default) | noop — popcorn NEVER
// destroys", which is a promise about someone's mail made in prose. Archive is
// the only place popcorn writes to a mailbox on a user's behalf, so this is the
// wire-level form of that promise: the request that DELE ultimately produces
// moves messages and says nothing that could remove one.
//
// The assertion is deliberately made on raw bytes as well as on structure. A
// future edit that adds "destroy" alongside "update" would still produce a
// well-formed Email/set with a correct update map, and a structural check alone
// would pass it.
func TestArchiveMovesMailAndNeverDestroysIt(t *testing.T) {
	s := newStub()
	c := login(t, s)

	if err := c.Archive([]string{"em_1", "em_7"}, "mb_archive"); err != nil {
		t.Fatalf("Archive: %v", err)
	}

	if got, want := s.callsMade(), []string{"Email/set"}; len(got) != 1 || got[0] != want[0] {
		t.Fatalf("Archive issued %v, want exactly %v", got, want)
	}
	args := s.argsFor(t, "Email/set")
	for _, forbidden := range []string{"destroy", "onDestroyRemoveEmails", "onSuccessDestroyEmail"} {
		if _, ok := args[forbidden]; ok {
			t.Errorf("Email/set carried %q — popcorn must never destroy mail", forbidden)
		}
	}
	s.mu.Lock()
	bodies := s.reqs
	s.mu.Unlock()
	for _, r := range bodies {
		if strings.Contains(strings.ToLower(string(r.Body)), "destroy") {
			t.Errorf("request body mentions destroy: %s", r.Body)
		}
	}

	var update map[string]struct {
		MailboxIDs map[string]bool `json:"mailboxIds"`
	}
	if err := json.Unmarshal(args["update"], &update); err != nil {
		t.Fatalf("update: %v", err)
	}
	if len(update) != 2 {
		t.Fatalf("update touched %d messages, want the 2 that were passed in", len(update))
	}
	for _, id := range []string{"em_1", "em_7"} {
		if got := update[id].MailboxIDs; len(got) != 1 || !got["mb_archive"] {
			t.Errorf("%s moved to %v, want exactly {mb_archive:true}", id, got)
		}
	}
}

// A partial archive must be an error, because pop3's QUIT turns an error into
// "-ERR update failed; no messages removed". Swallowing notUpdated would send
// the client a +OK for mail that never moved, and POP3 clients treat +OK on
// QUIT as permission to forget the message.
func TestArchiveReportsMessagesTheServerRefusedToMove(t *testing.T) {
	s := newStub()
	s.notUpdated = []string{"em_7"}
	c := login(t, s)

	err := c.Archive([]string{"em_1", "em_7"}, "mb_archive")
	if err == nil {
		t.Fatal("Archive reported success while the server refused a message")
	}
	if !strings.Contains(err.Error(), "1 message") {
		t.Errorf("error %q should say how many messages were left behind", err)
	}
}

// ---- submission --------------------------------------------------------------

// BCC correctness is the stated reason SMTP submission maps onto JMAP the way
// it does: recipients live in the EmailSubmission envelope, never in the
// headers. If the envelope were ever derived from the message instead, a BCC'd
// recipient would either be dropped or exposed to everyone else on the message.
// The fixture makes them disagree on purpose.
func TestSendTakesRecipientsFromTheEnvelopeNotTheHeaders(t *testing.T) {
	s := newStub()
	c := login(t, s)

	raw := []byte("From: corny@example.test\r\nTo: visible@example.test\r\nSubject: hi\r\n\r\nbody\r\n")
	id, err := c.Send(raw, "corny@example.test", []string{"visible@example.test", "secret@example.test"}, "id_1")
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	if id != "sub_1" {
		t.Errorf("submission id = %q, want the server's id", id)
	}

	args := s.argsFor(t, "EmailSubmission/set")
	var create map[string]struct {
		EmailID    string `json:"emailId"`
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
	if sub.Envelope.MailFrom.Email != "corny@example.test" {
		t.Errorf("mailFrom = %q", sub.Envelope.MailFrom.Email)
	}
	if len(sub.Envelope.RcptTo) != 2 || sub.Envelope.RcptTo[1].Email != "secret@example.test" {
		t.Fatalf("rcptTo = %+v, want both envelope recipients including the one absent from the headers", sub.Envelope.RcptTo)
	}
	if sub.IdentityID != "id_1" {
		t.Errorf("identityId = %q, want the identity the sender was checked against", sub.IdentityID)
	}

	// The message must be uploaded byte-for-byte. Anything that reserializes
	// it here would break DKIM on a signed message and silently corrupt
	// 8-bit bodies.
	s.mu.Lock()
	defer s.mu.Unlock()
	var uploaded []byte
	for _, r := range s.reqs {
		if strings.HasPrefix(r.URL, testBase+"/upload/") {
			uploaded = r.Body
		}
	}
	if string(uploaded) != string(raw) {
		t.Errorf("uploaded %q, want the DATA bytes verbatim", uploaded)
	}
}

// The import lands in Drafts and the submission moves it to Sent on success —
// that is what makes a message sent through popcorn show up in every other
// JMAP client's Sent folder. A missing onSuccessUpdateEmail leaves the user's
// sent mail stuck in Drafts marked $draft.
func TestSendFilesTheMessageInSent(t *testing.T) {
	s := newStub()
	c := login(t, s)
	if _, err := c.Send([]byte("x"), "corny@example.test", []string{"a@example.test"}, "id_1"); err != nil {
		t.Fatalf("Send: %v", err)
	}

	imp := s.argsFor(t, "Email/import")
	if !strings.Contains(string(imp["emails"]), "mb_drafts") {
		t.Errorf("import did not target drafts: %s", imp["emails"])
	}
	sub := s.argsFor(t, "EmailSubmission/set")
	onSuccess := string(sub["onSuccessUpdateEmail"])
	for _, want := range []string{`"mailboxIds/mb_drafts":null`, `"mailboxIds/mb_sent":true`, `"keywords/$draft":null`} {
		if !strings.Contains(strings.ReplaceAll(onSuccess, " ", ""), want) {
			t.Errorf("onSuccessUpdateEmail %s missing %s", onSuccess, want)
		}
	}
}

// Failing closed matters more than failing gracefully: if the account has no
// drafts/sent mailbox, popcorn must not upload the message and then report
// success it cannot back up. The upload assertion is the point — a rejected
// submission that still uploaded leaves an orphan blob per attempt.
func TestSendRefusesAnAccountWithoutDraftsOrSent(t *testing.T) {
	s := newStub()
	s.roles = map[string]string{"inbox": "mb_inbox"}
	c := login(t, s)

	if _, err := c.Send([]byte("x"), "corny@example.test", []string{"a@example.test"}, "id_1"); err == nil {
		t.Fatal("Send accepted a message it had nowhere to file")
	}
	for _, name := range s.callsMade() {
		if name == "Email/import" || name == "EmailSubmission/set" {
			t.Errorf("client kept going after the precondition failed: %v", s.callsMade())
		}
	}
}

// A rejected submission must not read as a queued one. smtp/session.go replies
// "250 2.0.0 queued as "+id on any non-error return, so a silent empty id here
// would tell the sending client their mail was accepted when the server
// refused it — the single worst failure mode a submission agent has.
func TestSendReportsARejectedSubmissionAsAnError(t *testing.T) {
	s := newStub()
	s.notCreated = true
	c := login(t, s)

	id, err := c.Send([]byte("x"), "corny@example.test", []string{"a@example.test"}, "id_1")
	if err == nil {
		t.Fatalf("Send returned id %q and no error for a submission the server rejected", id)
	}
	if !strings.Contains(err.Error(), "forbiddenFrom") {
		t.Errorf("error %q should carry the server's reason", err)
	}
}

// ---- credentials -------------------------------------------------------------

// The password is an app-password token that grants full mailbox access. It
// belongs in the Authorization header and nowhere else: URLs are logged by
// every proxy and server on the path, and request bodies end up in error
// strings (call() embeds the response body on non-200, and smtp replies with
// that text to the client).
func TestCredentialsTravelOnlyInTheAuthorizationHeader(t *testing.T) {
	s := newStub()
	s.emails = []map[string]any{{"id": "em_1", "blobId": "blob_1", "size": 10}}
	c := login(t, s)

	if _, err := c.Mailboxes(); err != nil {
		t.Fatalf("Mailboxes: %v", err)
	}
	if _, err := c.ListMailbox("mb_inbox", 10); err != nil {
		t.Fatalf("ListMailbox: %v", err)
	}
	body, err := c.Download("blob_1")
	if err != nil {
		t.Fatalf("Download: %v", err)
	}
	body.Close()
	if _, err := c.Upload([]byte("raw"), "message/rfc822"); err != nil {
		t.Fatalf("Upload: %v", err)
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.reqs) < 5 {
		t.Fatalf("expected requests for login, mailboxes, list, download and upload; got %d", len(s.reqs))
	}
	for _, r := range s.reqs {
		if strings.Contains(r.URL, testToken) {
			t.Errorf("token in URL: %s", r.URL)
		}
		if strings.Contains(string(r.Body), testToken) {
			t.Errorf("token in request body for %s", r.URL)
		}
		if !strings.HasPrefix(r.Auth, "Basic ") {
			t.Errorf("%s %s sent no Basic credentials (%q)", r.Method, r.URL, r.Auth)
		}
	}
}

// Errors from this package are handed straight to remote clients: pop3 logs
// them and smtp puts them in a 554 reply. None of them may carry the token.
func TestErrorsDoNotCarryTheToken(t *testing.T) {
	s := newStub()
	install(t, s)

	_, err := Login(testBase, testUser, "bm_wrong_token_value")
	if err == nil {
		t.Fatal("Login accepted a rejected token")
	}
	if strings.Contains(err.Error(), "bm_wrong_token_value") {
		t.Errorf("login error leaks the password: %v", err)
	}

	s.uploadStatus = 413
	c := login(t, s)
	if _, err := c.Upload([]byte("raw"), "message/rfc822"); err == nil {
		t.Error("Upload ignored a 413")
	} else if strings.Contains(err.Error(), testToken) {
		t.Errorf("upload error leaks the password: %v", err)
	}
}

// ---- session and listing -----------------------------------------------------

// A session document that parses but names no API endpoint or account would
// otherwise produce a Client that fails on its first real call — after popcorn
// has already told the user "+OK maildrop has 0 messages".
func TestLoginRejectsASessionItCannotUse(t *testing.T) {
	for _, tc := range []struct {
		name string
		doc  string
	}{
		{"no apiUrl", `{"primaryAccounts":{"urn:ietf:params:jmap:mail":"acct_1"}}`},
		{"no account anywhere", `{"apiUrl":"https://jmap.test/api","primaryAccounts":{},"accounts":{}}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := newStub()
			s.sessionBody = tc.doc
			install(t, s)
			if _, err := Login(testBase, testUser, testToken); err == nil {
				t.Fatal("Login accepted an unusable session")
			}
		})
	}
}

// POP3 message numbers count up from the oldest message, and clients remember
// them (and UIDLs) between sessions. The server sorts newest-first, so the
// client reverses. Getting this backwards renumbers every message in the
// maildrop and makes "leave mail on server" clients redownload or skip mail.
func TestListMailboxNumbersMessagesOldestFirst(t *testing.T) {
	s := newStub()
	s.emails = []map[string]any{ // as the server returns them: newest first
		{"id": "em_newest", "blobId": "blob_3", "size": 30},
		{"id": "em_middle", "blobId": "blob_2", "size": 20},
		{"id": "em_oldest", "blobId": "blob_1", "size": 10},
	}
	c := login(t, s)

	msgs, err := c.ListMailbox("mb_inbox", 200)
	if err != nil {
		t.Fatalf("ListMailbox: %v", err)
	}
	want := []string{"em_oldest", "em_middle", "em_newest"}
	for i, id := range want {
		if msgs[i].ID != id {
			t.Fatalf("message %d is %s, want %s (POP3 numbers count up from the oldest)", i+1, msgs[i].ID, id)
		}
	}
	if msgs[0].Size != 10 || msgs[0].BlobID != "blob_1" {
		t.Errorf("message 1 = %+v, want the oldest message's size and blob", msgs[0])
	}
}

// A short methodResponses array is a malformed server answer, and this one is
// indexed by position. The guard turns an index-out-of-range panic — which in
// popcorn is an unrecovered panic on a connection goroutine, i.e. the whole
// daemon — into an error on one session.
func TestListMailboxRejectsAShortResponseInsteadOfPanicking(t *testing.T) {
	s := newStub()
	s.shortResponse = true
	c := login(t, s)

	if _, err := c.ListMailbox("mb_inbox", 200); err == nil {
		t.Fatal("ListMailbox accepted a response with no method responses")
	}
}

// A JMAP method error arrives as a normal 200 with an "error" tuple where the
// result should be. Reading it as a result would produce an empty maildrop
// (which a POP3 client reads as "all your mail was deleted") rather than a
// failed login.
func TestMethodErrorsBecomeGoErrors(t *testing.T) {
	raw := json.RawMessage(`["error",{"type":"accountNotFound"},"m"]`)
	if _, err := respArgs(raw, "Mailbox/get"); err == nil {
		t.Fatal("an error tuple was read as a successful response")
	} else if !strings.Contains(err.Error(), "accountNotFound") {
		t.Errorf("error %q should carry the server's type", err)
	}

	if _, err := respArgs(json.RawMessage(`["Email/get",{},"g"]`), "Mailbox/get"); err == nil {
		t.Fatal("a response for a different method was accepted")
	}
}

// ---- discovery ---------------------------------------------------------------

// The override exists so popcorn can run without SRV records, and it must win
// outright — a fallback to DNS when the operator has pinned a host is how a
// deployment silently starts talking to someone else's server.
func TestDiscoverPrefersTheOverrideAndNeverResolvesIt(t *testing.T) {
	for _, tc := range []struct {
		name, email, override, want string
		wantErr                     bool
	}{
		{name: "override wins", email: "corny@example.test", override: "https://jmap.test", want: "https://jmap.test"},
		{name: "trailing slash is trimmed so paths do not double up", email: "corny@example.test", override: "https://jmap.test/", want: "https://jmap.test"},
		{name: "override is used even for an unparseable login", email: "not-an-email", override: "https://jmap.test", want: "https://jmap.test"},
		{name: "no domain to look up is an error, not a lookup", email: "not-an-email", wantErr: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := Discover(tc.email, tc.override)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("Discover(%q, %q) = %q, want an error", tc.email, tc.override, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("Discover(%q, %q): %v", tc.email, tc.override, err)
			}
			if got != tc.want {
				t.Errorf("Discover(%q, %q) = %q, want %q", tc.email, tc.override, got, tc.want)
			}
		})
	}
}
