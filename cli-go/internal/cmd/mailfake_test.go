package cmd

// The fake mail server `read` and `send` are tested against, plus the mirror seed
// they read their base/token/accounts from.
//
// It records every method call VERBATIM, in order, because for `send` the call
// SEQUENCE is the thing under test: create the draft, then submit it, with the
// Drafts → Sent move riding on the submission. A test that only checked the exit
// code would pass against a port that submitted first and never noticed.
//
// It serves the session resource too, and deliberately advertises an apiUrl that
// is NOT `<base>/api/jmap`, so a client that hardcoded the path fails here — the
// same trap the contract suite's own stub sets (session.go).

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
)

// recordedCall is one method invocation the CLI sent.
type recordedCall struct {
	Name string
	Args json.RawMessage
}

type mailFake struct {
	mu    sync.Mutex
	calls []recordedCall
	// downloads records blob-download paths (the `read --raw` path).
	downloads []string

	// Fixtures, held as RAW JSON so a test can pin exactly what the server said
	// — which is what `read --json` re-emits.
	mailboxes  string
	identities string
	emails     map[string]string // id → raw email object
	queryIDs   []string

	// Refusal knobs.
	refuseSubmission string // "method" | "seterror" | ""
	httpStatus       int    // non-zero → every JMAP POST answers this status
	emptyMailbox     bool

	// created holds the drafts Email/set made, so EmailSubmission/set can echo
	// the right emailId back.
	created map[string]string
	seq     int
	// base is the httptest server's URL, filled in by start so the session
	// resource can advertise absolute apiUrl/downloadUrl.
	base string
}

func newMailFake() *mailFake {
	return &mailFake{
		mailboxes: `[{"id":"mb_inbox","name":"Inbox","role":"inbox"},` +
			`{"id":"mb_drafts","name":"Drafts","role":"drafts"},` +
			`{"id":"mb_sent","name":"Sent","role":"sent"}]`,
		identities: `[{"id":"id_1","email":"you@stub.test","name":"You","textSignature":"Eric\nbullmoose"},` +
			`{"id":"id_2","email":"alias@stub.test","name":"","textSignature":""}]`,
		emails:  map[string]string{},
		created: map[string]string{},
	}
}

// addEmail registers a fixture message. The raw JSON is returned by Email/get
// unchanged, so a test controls both the values AND their key order.
func (f *mailFake) addEmail(id, raw string) {
	f.emails[id] = raw
	f.queryIDs = append(f.queryIDs, id)
}

func (f *mailFake) start(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(f.handle))
	t.Cleanup(srv.Close)
	f.base = srv.URL
	return srv
}

func (f *mailFake) handle(w http.ResponseWriter, r *http.Request) {
	if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
		w.WriteHeader(401)
		_, _ = w.Write([]byte(`{"error":"bad token"}`))
		return
	}
	switch {
	case r.URL.Path == "/.well-known/jmap":
		w.Header().Set("content-type", "application/json")
		fmt.Fprintf(w, `{"username":"you@stub.test","accounts":{},"primaryAccounts":{},`+
			`"apiUrl":%q,"downloadUrl":%q}`,
			f.base+"/jmap-endpoint",
			f.base+"/dl/{accountId}/{blobId}/{name}/{type}")
		return
	case strings.HasPrefix(r.URL.Path, "/dl/"):
		f.mu.Lock()
		// EscapedPath, not Path: the assertion is about what encodeURIComponent
		// produced, and net/http decodes %2F back to a slash in Path.
		f.downloads = append(f.downloads, r.URL.EscapedPath())
		f.mu.Unlock()
		w.Header().Set("content-type", "message/rfc822")
		_, _ = w.Write([]byte("Subject: raw\r\n\r\nraw body\r\n"))
		return
	case r.URL.Path != "/jmap-endpoint":
		w.WriteHeader(404)
		return
	}
	if f.httpStatus != 0 {
		w.WriteHeader(f.httpStatus)
		_, _ = w.Write([]byte(`{"error":"forbidden"}`))
		return
	}

	var req struct {
		MethodCalls [][]json.RawMessage `json:"methodCalls"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, 0, len(req.MethodCalls))
	for _, mc := range req.MethodCalls {
		var name, callID string
		_ = json.Unmarshal(mc[0], &name)
		_ = json.Unmarshal(mc[2], &callID)
		f.calls = append(f.calls, recordedCall{Name: name, Args: mc[1]})
		out = append(out, f.invoke(name, mc[1], callID))
	}
	w.Header().Set("content-type", "application/json")
	fmt.Fprintf(w, `{"methodResponses":[%s]}`, strings.Join(out, ","))
}

func (f *mailFake) invoke(name string, args json.RawMessage, callID string) string {
	reply := func(result string) string {
		return fmt.Sprintf(`[%q,%s,%q]`, name, result, callID)
	}
	fail := func(typ, description string) string {
		if description == "" {
			return fmt.Sprintf(`["error",{"type":%q},%q]`, typ, callID)
		}
		return fmt.Sprintf(`["error",{"type":%q,"description":%q},%q]`, typ, description, callID)
	}
	switch name {
	case "Mailbox/get":
		return reply(`{"accountId":"a_you","state":"1","list":` + f.mailboxes + `}`)
	case "Identity/get":
		return reply(`{"accountId":"a_you","state":"1","list":` + f.identities + `}`)
	case "Email/query":
		if f.emptyMailbox {
			return reply(`{"accountId":"a_you","queryState":"1","position":0,"ids":[]}`)
		}
		ids, _ := json.Marshal(f.queryIDs)
		return reply(`{"accountId":"a_you","queryState":"1","position":0,"ids":` + string(ids) + `}`)
	case "Email/get":
		var a struct {
			IDs []string `json:"ids"`
		}
		_ = json.Unmarshal(args, &a)
		var list []string
		var notFound []string
		for _, id := range a.IDs {
			if raw, ok := f.emails[id]; ok {
				list = append(list, raw)
				continue
			}
			notFound = append(notFound, id)
		}
		nf, _ := json.Marshal(notFound)
		return reply(fmt.Sprintf(`{"accountId":"a_you","state":"1","list":[%s],"notFound":%s}`,
			strings.Join(list, ","), nf))
	case "Email/set":
		var a struct {
			Create map[string]json.RawMessage `json:"create"`
		}
		_ = json.Unmarshal(args, &a)
		created := []string{}
		for cid := range a.Create {
			f.seq++
			id := fmt.Sprintf("em_new_%d", f.seq)
			f.created[cid] = id
			// The draft is registered so the post-send reconcile's Email/get
			// finds it, with the mirror-shaped properties that reconcile asks for.
			f.emails[id] = fmt.Sprintf(`{"id":%q,"blobId":"b_1","threadId":"th_1",`+
				`"mailboxIds":{"mb_sent":true},"keywords":{"$seen":true},"size":42,`+
				`"receivedAt":"2026-08-01T00:00:00.000Z","messageId":["<1@stub.test>"],`+
				`"inReplyTo":null,"from":[{"name":"You","email":"you@stub.test"}],`+
				`"to":[{"name":null,"email":"a@b.com"}],"cc":null,"bcc":null,`+
				`"subject":"hi","hasAttachment":false,"preview":"p","attachments":[]}`, id)
			created = append(created, fmt.Sprintf(`%q:{"id":%q}`, cid, id))
		}
		return reply(fmt.Sprintf(`{"accountId":"a_you","oldState":"1","newState":"2",`+
			`"created":{%s},"notCreated":{},"updated":{},"notUpdated":{}}`, strings.Join(created, ",")))
	case "EmailSubmission/set":
		if f.refuseSubmission == "method" {
			// The scope wall: services/jmap/src/methods/common.ts:110 via
			// packages/auth-core/src/principal.ts:277.
			return fail("forbidden", `token lacks the "send" scope`)
		}
		if f.refuseSubmission == "seterror" {
			// A per-object refusal, submission.ts:150's catch — the shape an
			// outbound-bound refusal would take.
			return reply(`{"accountId":"a_you","oldState":"2","newState":"2","created":{},` +
				`"notCreated":{"s":{"type":"forbidden","description":"recipient(s) not in the governing book: x@y.test"}}}`)
		}
		var a struct {
			Create map[string]struct {
				EmailID string `json:"emailId"`
			} `json:"create"`
		}
		_ = json.Unmarshal(args, &a)
		created := []string{}
		for cid, spec := range a.Create {
			f.seq++
			created = append(created, fmt.Sprintf(`%q:{"id":"es_%d","emailId":%q}`, cid, f.seq, spec.EmailID))
		}
		return reply(fmt.Sprintf(`{"accountId":"a_you","oldState":"2","newState":"3",`+
			`"created":{%s},"notCreated":{}}`, strings.Join(created, ",")))
	default:
		return fail("unknownMethod", name)
	}
}

// reset clears the recorded calls, for a test that drives two invocations.
func (f *mailFake) reset() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = nil
}

// names is the recorded call sequence, for the assertion that matters most.
func (f *mailFake) names() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, len(f.calls))
	for i, c := range f.calls {
		out[i] = c.Name
	}
	return out
}

// argsOf returns the raw args of the first call to a method.
func (f *mailFake) argsOf(method string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range f.calls {
		if c.Name == method {
			return string(c.Args)
		}
	}
	return ""
}

// ---- mirror seed -----------------------------------------------------------

// seedMailMirror writes the config the commands read (base/token/accounts) plus
// the mirror tables `read`'s owner lookup and `send`'s reconcile touch. The
// schema is the subset of packages/mailstore/sql/data-plane.sql + db.ts's
// LOCAL_SCHEMA those two use.
func seedMailMirror(t *testing.T, base, token string, accounts string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "mail.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("open seed db: %v", err)
	}
	defer db.Close()
	for _, stmt := range []string{
		`CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
		`CREATE TABLE emails (
		   id TEXT NOT NULL, account_id TEXT NOT NULL, blob_id TEXT NOT NULL,
		   thread_id TEXT NOT NULL, message_id TEXT, in_reply_to TEXT,
		   subject TEXT NOT NULL DEFAULT '', from_json TEXT NOT NULL DEFAULT '[]',
		   to_json TEXT NOT NULL DEFAULT '[]', cc_json TEXT NOT NULL DEFAULT '[]',
		   bcc_json TEXT NOT NULL DEFAULT '[]', preview TEXT NOT NULL DEFAULT '',
		   size INTEGER NOT NULL, received_at INTEGER NOT NULL,
		   has_attachment INTEGER NOT NULL DEFAULT 0,
		   attachments_json TEXT NOT NULL DEFAULT '[]',
		   PRIMARY KEY (account_id, id))`,
		`CREATE TABLE email_mailboxes (account_id TEXT, email_id TEXT, mailbox_id TEXT,
		   PRIMARY KEY (account_id, email_id, mailbox_id))`,
		`CREATE TABLE email_keywords (account_id TEXT, email_id TEXT, keyword TEXT,
		   PRIMARY KEY (account_id, email_id, keyword))`,
		`CREATE VIRTUAL TABLE cli_fts USING fts5 (
		   email_id UNINDEXED, subject, from_text, to_text, preview, tokenize='unicode61')`,
	} {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatalf("seed schema: %v", err)
		}
	}
	ins := func(k, v string) {
		if _, err := db.Exec(`INSERT INTO config(key,value) VALUES(?,?)`, k, v); err != nil {
			t.Fatalf("insert %s: %v", k, err)
		}
	}
	ins("base", base)
	ins("token", token)
	ins("accountId", "a_you")
	if accounts == "" {
		accounts = `[{"accountId":"a_you","address":"you@stub.test","name":"You"}]`
	}
	ins("accounts", accounts)
	return path
}

// runCmd invokes one native command with captured streams and an appended --db.
func runCmd(t *testing.T, run func(*bmio.Streams, []string) int, dbPath, command string, argv ...string) (out, errOut string, code int) {
	t.Helper()
	var o, e strings.Builder
	s := bmio.NewTo(&o, &e)
	args := append([]string{command}, argv...)
	args = append(args, "--db", dbPath)
	code = run(s, args)
	return o.String(), e.String(), code
}

// withStdin points os.Stdin at a file for the duration of a test, so the
// stdin-fallback branch of readInput is exercised deterministically rather than
// depending on how the test binary was launched.
func withStdin(t *testing.T, content string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "stdin")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	prev := os.Stdin
	os.Stdin = f
	t.Cleanup(func() {
		os.Stdin = prev
		_ = f.Close()
	})
}
