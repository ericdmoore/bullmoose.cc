package watch

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/jmap"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/mirror"
)

// run is one watcher under test, with its server, its mirror and its captured
// streams.
type run struct {
	server *fakeServer
	db     *sql.DB
	out    *safeBuf
	err    *safeBuf
}

// startWatcher boots a watcher over the fake server. Timings are compressed (a
// 20 ms backoff, a 5 ms debounce) so the reconnect path runs in milliseconds;
// everything else is the shipped code, including the real WebSocket client and
// the real sync engine against a real SQLite file.
func startWatcher(t *testing.T, jsonMode bool, execTemplate string) *run {
	t.Helper()
	r := &run{db: newMirror(t), server: newFakeServer(t), out: &safeBuf{}, err: &safeBuf{}}

	w := New(Options{
		DB:           r.db,
		Client:       jmap.NewClient(r.server.base(), "tok_test"),
		Base:         r.server.base(),
		Token:        "tok_test",
		Accounts:     []Account{{ID: testAccountID, Label: "you@example.com"}},
		Out:          bmio.NewTo(r.out, r.err),
		JSON:         jsonMode,
		Exec:         execTemplate,
		Debounce:     5 * time.Millisecond,
		FallbackSync: time.Hour, // off: these tests drive pushes, not the timer
		BackoffMin:   20 * time.Millisecond,
		BackoffMax:   80 * time.Millisecond,
		Jitter:       func() float64 { return 1.0 },
	})

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = w.Run(ctx)
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			t.Error("watcher did not shut down within 10s of ctx cancel")
		}
	})
	return r
}

// connected blocks until the watcher reports a live push channel.
func (r *run) connected(t *testing.T) {
	t.Helper()
	waitFor(t, "the push channel to connect", func() bool { return strings.Contains(r.err.String(), "connected") })
}

// events parses the NDJSON stdout into decoded records.
func (r *run) events(t *testing.T) []map[string]any {
	t.Helper()
	var records []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(r.out.String()), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var rec map[string]any
		if err := json.Unmarshal([]byte(line), &rec); err != nil {
			t.Fatalf("stdout line is not JSON (§1.3: every line is a whole value): %q — %v", line, err)
		}
		records = append(records, rec)
	}
	return records
}

func mail(id, subject string, minute int) fakeMail {
	return fakeMail{
		ID: id, Subject: subject, Name: "Stranger", Email: "stranger@example.com",
		Preview: "body of " + id,
		At:      time.Date(2026, 8, 13, 12, minute, 0, 0, time.UTC),
	}
}

// Test_ReconnectResumesAtTheCursor is the reconnect/resume contract:
//
//	a dropped socket resumes from the cursor — no duplicate events, no gap.
//
// The shape of the test matters as much as the assertions. The socket really
// drops (no close handshake), the server really refuses reconnects for a while,
// and mail really arrives DURING the outage — so "resume" is not something the
// watcher can fake by having stayed connected. What proves the cursor is
// load-bearing is that messages delivered while the socket was down are
// announced exactly once, after it comes back, and the ones announced before it
// went down are not announced again.
func Test_ReconnectResumesAtTheCursor(t *testing.T) {
	r := startWatcher(t, true, "")

	// Mail that predates the watcher. The startup pass is a FULL resync, and a
	// full resync announces nothing (sync.ts:62) — otherwise every `watch` would
	// open by replaying the whole mailbox.
	r.server.deliver(mail("e_old", "before the watcher", 0))
	r.connected(t)

	// ---- while connected -------------------------------------------------
	r.server.deliver(mail("e_1", "first live message", 1), mail("e_2", "second live message", 2))
	r.server.push()
	waitFor(t, "the two live messages", func() bool { return len(r.events(t)) >= 2 })

	cursorBefore, err := mirror.Cursor(r.db, testAccountID)
	if err != nil {
		t.Fatalf("read cursor: %v", err)
	}

	// ---- the outage ------------------------------------------------------
	refusedBefore := r.server.refused.Load()
	r.server.refuse.Store(true)
	r.server.dropAll()
	waitFor(t, "the client to notice the socket is gone", func() bool {
		return r.server.refused.Load() > refusedBefore
	})

	// Mail that arrives with nobody listening. A watcher that trusted the socket
	// would lose these; a watcher that trusts the cursor cannot.
	r.server.deliver(mail("e_3", "arrived during the outage", 3), mail("e_4", "also during", 4))

	// ---- restored --------------------------------------------------------
	r.server.refuse.Store(false)
	waitFor(t, "the resumed messages", func() bool { return len(r.events(t)) >= 4 })
	// Give any (incorrect) extra event time to land before asserting there is none.
	time.Sleep(150 * time.Millisecond)

	got := r.events(t)
	var ids []string
	seen := map[string]int{}
	for _, rec := range got {
		id, _ := rec["id"].(string)
		ids = append(ids, id)
		seen[id]++
	}

	// NO GAP: everything delivered after the watcher started is announced.
	want := []string{"e_1", "e_2", "e_3", "e_4"}
	for _, id := range want {
		if seen[id] == 0 {
			t.Errorf("resume GAP: %s was never announced (got %v) — a message delivered while the socket was down was skipped", id, ids)
		}
	}
	// NO DUPLICATE: nothing is announced twice. This is the assertion a
	// resume-from-zero breaks — a reconnect that re-read the changelog from the
	// beginning re-announces e_1 and e_2.
	for id, n := range seen {
		if n > 1 {
			t.Errorf("resume DUPLICATE: %s announced %d times (got %v) — the reconnect replayed instead of resuming at the cursor", id, n, ids)
		}
	}
	// NO REPLAY OF PRE-EXISTING MAIL: the startup full resync is silent.
	if seen["e_old"] > 0 {
		t.Errorf("the startup full sync announced pre-existing mail (%v) — sync.ts:62 leaves createdIds empty on a full resync", ids)
	}
	// ORDER: the two windows stay in order relative to each other.
	if len(ids) == len(want) {
		for i := range want {
			if ids[i] != want[i] {
				t.Errorf("event order = %v, want %v", ids, want)
				break
			}
		}
	}
	// The resume really went through Email/changes — a full resync would also
	// produce "no duplicates", by announcing nothing at all.
	if r.server.changesCalls.Load() == 0 {
		t.Error("no Email/changes was ever issued: the watcher never resumed from a cursor")
	}
	// And the cursor advanced across the outage rather than being rewound.
	cursorAfter, err := mirror.Cursor(r.db, testAccountID)
	if err != nil {
		t.Fatalf("read cursor: %v", err)
	}
	if cursorAfter == cursorBefore {
		t.Errorf("cursor did not advance across the outage (still %q)", cursorAfter)
	}
	if cursorAfter != "5" {
		t.Errorf("cursor = %q, want %q (5 messages delivered in total)", cursorAfter, "5")
	}
}

// Test_EventShape checks one event's fields against watch.ts:270's object
// literal — the record an agent parses.
func Test_EventShape(t *testing.T) {
	r := startWatcher(t, true, "")
	r.connected(t)

	r.server.deliver(mail("e_shape", "a subject", 7))
	r.server.push()
	waitFor(t, "the event", func() bool { return len(r.events(t)) >= 1 })

	rec := r.events(t)[0]
	for key, want := range map[string]any{
		"event":      "created",
		"id":         "e_shape",
		"account":    "you@example.com",
		"from":       "Stranger",
		"subject":    "a subject",
		"preview":    "body of e_shape",
		"receivedAt": "2026-08-13T12:07:00.000Z",
		"mailboxes":  "inbox",
	} {
		if got := rec[key]; got != want {
			t.Errorf("event[%q] = %#v, want %#v", key, got, want)
		}
	}
	if len(rec) != 8 {
		t.Errorf("event has %d keys (%v), want the 8 watch.ts:270 emits", len(rec), rec)
	}
}

// Test_HumanOutputIsDataOnStdoutChromeOnStderr is §1.1 for a long-running
// command: the message rows are records, and every word about CONNECTING is
// chrome. It is what keeps `bullmoose watch --json | jq` from choking on a
// reconnect notice.
func Test_HumanOutputIsDataOnStdoutChromeOnStderr(t *testing.T) {
	r := startWatcher(t, false, "")
	r.connected(t)

	r.server.deliver(mail("e_human", "human row", 9))
	r.server.push()
	waitFor(t, "the row", func() bool { return strings.Contains(r.out.String(), "e_human") })

	row := strings.TrimSpace(r.out.String())
	if !strings.HasPrefix(row, "● 2026-08-13 12:09  ") {
		t.Errorf("row = %q, want watch.ts:284's `● <date>  <from>  <subject>  [<mailboxes>]  <id>`", row)
	}
	if !strings.Contains(row, "[inbox]") || !strings.HasSuffix(row, "e_human") {
		t.Errorf("row = %q, want the mailbox column and the id last", row)
	}
	for _, chrome := range []string{"[watch]", "connected", "sync ("} {
		if strings.Contains(r.out.String(), chrome) {
			t.Errorf("stdout carries chrome %q — §1.1 puts it on stderr", chrome)
		}
	}
	if !strings.Contains(r.err.String(), "[watch] connected — waiting for pushes") {
		t.Errorf("stderr does not carry the connection notice: %q", r.err.String())
	}
}

// Test_PushIsOnlyAHint: the watcher must never read data out of a push. Garbage,
// a frame of another type, and a StateChange that names nothing must all be
// harmless — the changelog is the truth, so the hint's CONTENT is never used.
func Test_PushIsOnlyAHint(t *testing.T) {
	r := startWatcher(t, true, "")
	r.connected(t)

	r.server.deliver(mail("e_hint", "delivered", 11))
	r.server.broadcast("not json at all")
	r.server.broadcast(`{"@type":"SomethingElse"}`)
	r.server.broadcast(`{"@type":"StateChange"}`) // no `changed` key at all

	waitFor(t, "the message the hint did not describe", func() bool { return len(r.events(t)) >= 1 })
	if got := r.events(t)[0]["id"]; got != "e_hint" {
		t.Errorf("announced %v, want e_hint", got)
	}
}

// Test_PushURL pins the endpoint watch.ts:306 builds.
func Test_PushURL(t *testing.T) {
	for _, c := range []struct{ base, scheme string }{
		{"https://mail.bullmoose.cc", "wss://mail.bullmoose.cc/api/ws"},
		{"http://127.0.0.1:8787", "ws://127.0.0.1:8787/api/ws"},
	} {
		got := PushURL(c.base, "acc_1", "tok")
		if !strings.HasPrefix(got, c.scheme+"?") {
			t.Errorf("PushURL(%q) = %q, want it to start %q", c.base, got, c.scheme)
		}
		if !strings.Contains(got, "accountId=acc_1") || !strings.Contains(got, "access_token=tok") {
			t.Errorf("PushURL(%q) = %q, want both query params (a WebSocket cannot send an Authorization header)", c.base, got)
		}
	}
}

// Test_cli006_EndToEndThroughTheWatcher is the whole chain: a stranger sends
// mail whose SUBJECT is a shell payload, the watcher syncs it, fires the
// operator's `--exec` hook, and the payload runs as data.
//
// Everything in between is real — a real socket, a real JMAP round trip, a real
// SQLite mirror, a real `sh`. It is the only test that proves the fields the
// hook receives are the ones that came off the wire, rather than ones a test
// handed straight to BuildHookPlan.
func Test_cli006_EndToEndThroughTheWatcher(t *testing.T) {
	dir := t.TempDir()
	pwned := filepath.Join(dir, "pwned")
	captured := filepath.Join(dir, "captured")
	payload := "x; touch " + pwned

	// The template is the LEGACY, unquoted `{subject}` shape — the exact one the
	// finding calls RCE ("the equally natural unquoted form is exploitable"). It
	// must reach the shell as the literal `{subject}`, and the payload must reach
	// the hook only through $BM_SUBJECT.
	r := startWatcher(t, false,
		`printf %s {subject} > `+captured+`; printf %s "$BM_SUBJECT" >> `+captured)
	r.connected(t)

	r.server.deliver(mail("e_evil", payload, 13))
	r.server.push()
	waitFor(t, "the hook to run", func() bool {
		_, err := os.Stat(captured)
		return err == nil
	})
	// The hook is fire-and-forget, so give a would-be `touch` its chance.
	time.Sleep(200 * time.Millisecond)

	if _, err := os.Stat(pwned); err == nil {
		t.Fatalf("REMOTE CODE EXECUTION: a subject line created %s", pwned)
	}
	got, err := os.ReadFile(captured)
	if err != nil {
		t.Fatalf("read captured: %v", err)
	}
	if string(got) != "{subject}"+payload {
		t.Errorf("hook wrote %q, want the literal %q followed by the sender's bytes %q",
			got, "{subject}", payload)
	}
}
