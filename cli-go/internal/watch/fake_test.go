package watch

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/ws/wstest"

	_ "modernc.org/sqlite"
)

// The test double the reconnect/resume contract is measured against: one HTTP
// server that speaks BOTH halves of what `watch` needs — JMAP on /api/jmap and
// the push channel on /api/ws — plus a real SQLite mirror on disk.
//
// It is a real server on a real socket rather than an interface stub, because
// the property under test ("a dropped socket resumes at the cursor") is only
// meaningful if the socket can really drop.

const testAccountID = "t_test__a_1"

// mirrorSchema is the subset of packages/mailstore/sql/data-plane.sql plus
// db.ts's LOCAL_SCHEMA that the sync engine writes. It is transcribed rather
// than read from the .sql file so this test does not depend on a path outside
// the Go module; the columns are pinned by what mirror/sync.go INSERTs, which is
// itself a transcription of sync.ts.
const mirrorSchema = `
CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sync_state (
  account_id TEXT PRIMARY KEY, email_state TEXT, mailbox_state TEXT, last_sync INTEGER);
CREATE VIRTUAL TABLE IF NOT EXISTS cli_fts USING fts5 (
  email_id UNINDEXED, subject, from_text, to_text, preview, tokenize='unicode61');
CREATE TABLE IF NOT EXISTS mailboxes (
  id TEXT NOT NULL, account_id TEXT NOT NULL, parent_id TEXT, name TEXT NOT NULL,
  role TEXT, sort_order INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (account_id, id));
CREATE TABLE IF NOT EXISTS emails (
  id TEXT NOT NULL, account_id TEXT NOT NULL, blob_id TEXT NOT NULL, thread_id TEXT NOT NULL,
  message_id TEXT, in_reply_to TEXT, subject TEXT NOT NULL DEFAULT '',
  from_json TEXT NOT NULL DEFAULT '[]', to_json TEXT NOT NULL DEFAULT '[]',
  cc_json TEXT NOT NULL DEFAULT '[]', bcc_json TEXT NOT NULL DEFAULT '[]',
  preview TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL, received_at INTEGER NOT NULL,
  has_attachment INTEGER NOT NULL DEFAULT 0, attachments_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (account_id, id));
CREATE TABLE IF NOT EXISTS email_mailboxes (
  account_id TEXT NOT NULL, email_id TEXT NOT NULL, mailbox_id TEXT NOT NULL,
  PRIMARY KEY (account_id, email_id, mailbox_id));
CREATE TABLE IF NOT EXISTS email_keywords (
  account_id TEXT NOT NULL, email_id TEXT NOT NULL, keyword TEXT NOT NULL,
  PRIMARY KEY (account_id, email_id, keyword));
`

func newMirror(t *testing.T) *sql.DB {
	t.Helper()
	path := filepath.Join(t.TempDir(), "mail.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("open mirror: %v", err)
	}
	if _, err := db.Exec(mirrorSchema); err != nil {
		t.Fatalf("create mirror schema: %v", err)
	}
	// The same single connection cmd/watch.go pins, for the same reason: it is
	// what node:sqlite gives watch.ts, and a pooled writer would race itself.
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = db.Close() })
	return db
}

// fakeMail is one message on the fake server. Its INDEX is its state: the state
// after n messages is the string "n", so `Email/changes` from state s returns
// everything at index >= s. That is the smallest model with the property the
// test is about — a cursor that means something.
type fakeMail struct {
	ID      string
	Subject string
	Name    string
	Email   string
	Preview string
	At      time.Time
}

type fakeServer struct {
	srv *httptest.Server

	mu    sync.Mutex
	mail  []fakeMail
	conns []*wstest.Conn

	// refuse makes /api/ws answer 503 — the outage window, so "mail arrived
	// while disconnected" is a fact rather than a race.
	refuse atomic.Bool
	// refused counts rejected upgrade attempts, so a test can WAIT for the
	// client to have noticed the outage instead of sleeping.
	refused atomic.Int64
	// changesCalls counts Email/changes, the evidence that a resume happened at
	// all.
	changesCalls atomic.Int64
}

func newFakeServer(t *testing.T) *fakeServer {
	t.Helper()
	f := &fakeServer{}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/jmap", f.handleJMAP)
	mux.HandleFunc("/api/ws", f.handleWS)
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeServer) base() string { return f.srv.URL }

// deliver adds mail. The state advances by one per message, exactly as an
// append-only changelog does.
func (f *fakeServer) deliver(mails ...fakeMail) {
	f.mu.Lock()
	f.mail = append(f.mail, mails...)
	f.mu.Unlock()
}

// push sends a StateChange hint on every open socket. The payload is
// deliberately minimal: the watcher must not read anything out of it.
func (f *fakeServer) push() { f.broadcast(`{"@type":"StateChange","changed":{}}`) }

// broadcast puts an arbitrary text frame on every open socket — for the cases
// that prove the payload is never interpreted.
func (f *fakeServer) broadcast(payload string) {
	f.mu.Lock()
	conns := append([]*wstest.Conn(nil), f.conns...)
	f.mu.Unlock()
	for _, c := range conns {
		_ = c.WriteText(payload)
	}
}

// dropAll kills every open socket WITHOUT a close handshake.
func (f *fakeServer) dropAll() {
	f.mu.Lock()
	conns := f.conns
	f.conns = nil
	f.mu.Unlock()
	for _, c := range conns {
		_ = c.Drop()
	}
}

func (f *fakeServer) handleWS(w http.ResponseWriter, r *http.Request) {
	if f.refuse.Load() {
		f.refused.Add(1)
		http.Error(w, "unavailable", http.StatusServiceUnavailable)
		return
	}
	conn, err := wstest.Upgrade(w, r)
	if err != nil {
		return
	}
	f.mu.Lock()
	f.conns = append(f.conns, conn)
	f.mu.Unlock()
	// Hold the handler open: the hijacked connection must outlive it, and
	// draining is also how the client's close frame is observed.
	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			return
		}
	}
}

func (f *fakeServer) handleJMAP(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Using       []string          `json:"using"`
		MethodCalls []json.RawMessage `json:"methodCalls"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	responses := make([]any, 0, len(req.MethodCalls))
	for _, raw := range req.MethodCalls {
		var call []json.RawMessage
		if err := json.Unmarshal(raw, &call); err != nil || len(call) != 3 {
			continue
		}
		var name, callID string
		_ = json.Unmarshal(call[0], &name)
		_ = json.Unmarshal(call[2], &callID)
		var args map[string]any
		_ = json.Unmarshal(call[1], &args)
		responses = append(responses, []any{name, f.method(name, args), callID})
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"methodResponses": responses})
}

func (f *fakeServer) method(name string, args map[string]any) map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	state := strconv.Itoa(len(f.mail))

	switch name {
	case "Mailbox/get":
		return map[string]any{
			"accountId": testAccountID,
			"state":     "mbstate-1",
			"list": []any{map[string]any{
				"id": "mb_inbox", "parentId": nil, "name": "Inbox",
				"role": "inbox", "sortOrder": 0,
			}},
		}

	case "Email/changes":
		f.changesCalls.Add(1)
		since, _ := strconv.Atoi(fmt.Sprint(args["sinceState"]))
		if since < 0 || since > len(f.mail) {
			since = 0
		}
		created := make([]string, 0)
		for _, m := range f.mail[since:] {
			created = append(created, m.ID)
		}
		return map[string]any{
			"accountId": testAccountID, "oldState": args["sinceState"], "newState": state,
			"hasMoreChanges": false,
			"created":        created, "updated": []string{}, "destroyed": []string{},
		}

	case "Email/query":
		position := intArg(args["position"])
		limit := intArg(args["limit"])
		ids := make([]string, 0)
		for i := position; i < len(f.mail) && (limit == 0 || len(ids) < limit); i++ {
			ids = append(ids, f.mail[i].ID)
		}
		return map[string]any{
			"accountId": testAccountID, "queryState": state,
			"position": position, "ids": ids, "total": len(f.mail),
		}

	case "Email/get":
		want := map[string]bool{}
		if list, ok := args["ids"].([]any); ok {
			for _, id := range list {
				want[fmt.Sprint(id)] = true
			}
		}
		out := make([]any, 0, len(want))
		for _, m := range f.mail {
			if !want[m.ID] {
				continue
			}
			out = append(out, map[string]any{
				"id": m.ID, "blobId": "blob_" + m.ID, "threadId": "th_" + m.ID,
				"mailboxIds": map[string]any{"mb_inbox": true},
				"keywords":   map[string]any{},
				"size":       len(m.Preview) + 100,
				"receivedAt": m.At.UTC().Format(time.RFC3339),
				"messageId":  []string{"<" + m.ID + "@example.com>"},
				"inReplyTo":  nil,
				"from":       []any{map[string]any{"name": m.Name, "email": m.Email}},
				"to":         []any{map[string]any{"name": nil, "email": "you@example.com"}},
				"cc":         nil, "bcc": nil,
				"subject": m.Subject, "hasAttachment": false,
				"preview": m.Preview, "attachments": []any{},
			})
		}
		return map[string]any{"accountId": testAccountID, "state": state, "list": out, "notFound": []string{}}
	}
	return map[string]any{}
}

func intArg(v any) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	}
	return 0
}

// safeBuf is a writer a *bmio.Streams can share across the watcher's goroutines.
type safeBuf struct {
	mu   sync.Mutex
	data []byte
}

func (b *safeBuf) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.data = append(b.data, p...)
	return len(p), nil
}

func (b *safeBuf) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return string(b.data)
}

// waitFor polls until cond holds, so a test states the condition it is waiting
// on rather than a sleep that is either flaky or slow.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}
