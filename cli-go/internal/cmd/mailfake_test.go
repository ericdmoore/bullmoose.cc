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
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strconv"
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
	// state is the account's Email state, advanced by every MUTATING Email/set —
	// the axis --if-state and --dry-run turn on (sVOL 019 done-when #4/#5).
	state string
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
		state:   "emstate-1",
	}
}

// applySet is the triage half of Email/set: RFC 8620 PatchObject semantics over
// `keywords` and `mailboxIds`, plus destroy, plus the RFC 8621 guard that an
// email must belong to at least one mailbox — the same model
// packages/cli/smoke/server.mjs runs, so a triage test here and the contract
// suite are measuring the same server behaviour.
//
// It MUTATES the fixture, which is what makes the reconcile assertions real: the
// Email/get the CLI issues after a write returns the message as it now is, so a
// mirror row that disagrees is the port's fault and not the fake's.
// updateOrder is the request's key order. A real server answers `updated` in the
// order it processed the request (a JS object preserves insertion order), and the
// CLI echoes that order verbatim to match Node byte for byte. Ranging a Go MAP
// here instead made the fake's answer RANDOM — it passed locally and failed in
// CI, which is the whole reason this parameter exists.
func (f *mailFake) applySet(update map[string]json.RawMessage, updateOrder []string, destroy []string) string {
	updated, notUpdated, destroyed, notDestroyed := []string{}, []string{}, []string{}, []string{}
	mutated := false

	for _, id := range updateOrder {
		rawPatch := update[id]
		raw, ok := f.emails[id]
		if !ok {
			notUpdated = append(notUpdated, fmt.Sprintf(`%q:{"type":"notFound"}`, id))
			continue
		}
		var email map[string]any
		_ = json.Unmarshal([]byte(raw), &email)
		var patch map[string]any
		_ = json.Unmarshal(rawPatch, &patch)

		keywords := setOf(email["keywords"])
		mailboxes := setOf(email["mailboxIds"])
		touchedMailboxes := false
		bad := ""
		for path, value := range patch {
			head, sub, _ := strings.Cut(path, "/")
			switch head {
			case "keywords":
				applyPatchKey(keywords, sub, value)
			case "mailboxIds":
				touchedMailboxes = true
				applyPatchKey(mailboxes, sub, value)
			default:
				bad = "unknown path " + path
			}
		}
		if bad != "" {
			notUpdated = append(notUpdated,
				fmt.Sprintf(`%q:{"type":"invalidProperties","description":%q}`, id, bad))
			continue
		}
		// email.ts:403 — the guard the CLI is supposed to pre-empt client-side.
		if touchedMailboxes && len(mailboxes) == 0 {
			notUpdated = append(notUpdated, fmt.Sprintf(
				`%q:{"type":"invalidProperties","description":"an email must belong to at least one mailbox"}`, id))
			continue
		}
		email["keywords"] = keywords
		email["mailboxIds"] = mailboxes
		out, _ := json.Marshal(email)
		f.emails[id] = string(out)
		updated = append(updated, fmt.Sprintf(`%q:null`, id))
		mutated = true
	}

	for _, id := range destroy {
		if _, ok := f.emails[id]; !ok {
			notDestroyed = append(notDestroyed, fmt.Sprintf(`%q:{"type":"notFound"}`, id))
			continue
		}
		delete(f.emails, id)
		for i, qid := range f.queryIDs {
			if qid == id {
				f.queryIDs = append(f.queryIDs[:i], f.queryIDs[i+1:]...)
				break
			}
		}
		destroyed = append(destroyed, fmt.Sprintf("%q", id))
		mutated = true
	}

	oldState := f.state
	if mutated {
		f.state = "emstate-" + strconv.Itoa(len(f.calls)+1)
	}
	return fmt.Sprintf(`{"accountId":"a_you","oldState":%q,"newState":%q,`+
		`"created":{},"notCreated":{},"updated":{%s},"notUpdated":{%s},`+
		`"destroyed":[%s],"notDestroyed":{%s}}`,
		oldState, f.state, strings.Join(updated, ","), strings.Join(notUpdated, ","),
		strings.Join(destroyed, ","), strings.Join(notDestroyed, ","))
}

// setOf reads a JMAP `{id: true}` set out of a decoded email object.
func setOf(v any) map[string]any {
	out := map[string]any{}
	if m, ok := v.(map[string]any); ok {
		for k, on := range m {
			if on == true {
				out[k] = true
			}
		}
	}
	return out
}

// applyPatchKey is RFC 8620 §5.3's PatchObject over one set: no sub-path is a
// whole-property REPLACE, a sub-path with true adds, and null/false removes.
func applyPatchKey(target map[string]any, sub string, value any) {
	if sub == "" {
		for k := range target {
			delete(target, k)
		}
		if m, ok := value.(map[string]any); ok {
			for k, on := range m {
				if on == true {
					target[k] = true
				}
			}
		}
		return
	}
	if value == true {
		target[sub] = true
		return
	}
	delete(target, sub)
}

// addEmail registers a fixture message. The raw JSON is returned by Email/get
// unchanged, so a test controls both the values AND their key order.
func (f *mailFake) addEmail(id, raw string) {
	f.emails[id] = raw
	f.queryIDs = append(f.queryIDs, id)
}

// addTriageEmail registers a message with the FULL mirror property set, so the
// Email/get a triage verb issues to reconcile finds every column sync.ts writes.
// mailboxes/keywords are what the verbs move and flag.
func (f *mailFake) addTriageEmail(id string, mailboxes []string, keywords []string) {
	set := func(keys []string) string {
		parts := make([]string, len(keys))
		for i, k := range keys {
			parts[i] = fmt.Sprintf(`%q:true`, k)
		}
		return "{" + strings.Join(parts, ",") + "}"
	}
	f.addEmail(id, fmt.Sprintf(`{"id":%q,"blobId":"b_%s","threadId":"th_%s",`+
		`"mailboxIds":%s,"keywords":%s,"size":42,`+
		`"receivedAt":"2026-08-01T00:00:00.000Z","messageId":["<%s@stub.test>"],`+
		`"inReplyTo":null,"from":[{"name":"Sender","email":"s@stub.test"}],`+
		`"to":[{"name":null,"email":"you@stub.test"}],"cc":null,"bcc":null,`+
		`"subject":"subject of %s","hasAttachment":false,"preview":"preview","attachments":[]}`,
		id, id, id, set(mailboxes), set(keywords), id, id))
}

// mailboxesOf reads a message's current mailbox membership OUT OF THE FAKE — the
// server's view, as against the mirror's. A triage test that only checked the
// mirror could not tell a real Email/set from a local-only write (019 done-when
// #2, the choreography assertion).
func (f *mailFake) mailboxesOf(id string) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var e struct {
		MailboxIDs map[string]bool `json:"mailboxIds"`
	}
	_ = json.Unmarshal([]byte(f.emails[id]), &e)
	out := make([]string, 0, len(e.MailboxIDs))
	for k := range e.MailboxIDs {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// keywordsOf is mailboxesOf for keywords.
func (f *mailFake) keywordsOf(id string) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var e struct {
		Keywords map[string]bool `json:"keywords"`
	}
	_ = json.Unmarshal([]byte(f.emails[id]), &e)
	out := make([]string, 0, len(e.Keywords))
	for k := range e.Keywords {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// exists reports whether the fake still holds a message — `rm --force`'s subject.
func (f *mailFake) exists(id string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	_, ok := f.emails[id]
	return ok
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
			IfInState *string                    `json:"ifInState"`
			Create    map[string]json.RawMessage `json:"create"`
			Update    map[string]json.RawMessage `json:"update"`
			Destroy   []string                   `json:"destroy"`
		}
		_ = json.Unmarshal(args, &a)
		// ifInState is honoured exactly as services/jmap/src/methods/email.ts:234
		// does: refuse the WHOLE method before touching anything, so the triage
		// tests can assert both halves of "exit 5 and changed nothing".
		if a.IfInState != nil && *a.IfInState != f.state {
			return fail("stateMismatch", "")
		}
		if len(a.Update) > 0 || len(a.Destroy) > 0 {
			return reply(f.applySet(a.Update, updateKeyOrder(args), a.Destroy))
		}
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
		// The triage verbs resolve `--role archive` out of the mirror first, and
		// their reconcile leaves sync_state alone — both need the tables to exist.
		`CREATE TABLE mailboxes (id TEXT NOT NULL, account_id TEXT NOT NULL, parent_id TEXT,
		   name TEXT NOT NULL, role TEXT, sort_order INTEGER NOT NULL DEFAULT 0,
		   PRIMARY KEY (account_id, id))`,
		`CREATE TABLE sync_state (account_id TEXT PRIMARY KEY, email_state TEXT,
		   mailbox_state TEXT, last_sync INTEGER)`,
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

// updateKeyOrder reads `update`'s keys in DOCUMENT order. json.Unmarshal into a
// map discards that order and Go then randomises iteration, so the fake needs
// the raw bytes to answer the way a real server does.
func updateKeyOrder(args json.RawMessage) []string {
	var envelope struct {
		Update json.RawMessage `json:"update"`
	}
	if err := json.Unmarshal(args, &envelope); err != nil || len(envelope.Update) == 0 {
		return nil
	}
	dec := json.NewDecoder(bytes.NewReader(envelope.Update))
	if tok, err := dec.Token(); err != nil {
		return nil
	} else if delim, ok := tok.(json.Delim); !ok || delim != '{' {
		return nil
	}
	var keys []string
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return keys
		}
		key, _ := tok.(string)
		keys = append(keys, key)
		var skip json.RawMessage
		if err := dec.Decode(&skip); err != nil {
			return keys
		}
	}
	return keys
}
