package cmd

// `bullmoose sync` against a fake changelog server.
//
// The fake models the ONE thing the sync protocol is about: a cursor that means
// something. A message's INDEX is the state, so the state after n messages is
// "n" and Email/changes from state s returns everything at index >= s. That is
// the smallest model in which "the cursor advanced" and "nothing was skipped" are
// different claims — the same model internal/watch's fake uses, for the same
// reason.
//
// It can also DROP a connection mid-pass, because the property that matters most
// here cannot be observed any other way: a sync that dies after fetching but
// before committing must REPLAY that window on the next run, never skip it.
// Replaying is idempotent (INSERT OR REPLACE); skipping loses mail permanently
// and silently.

import (
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
)

type syncMail struct {
	ID      string
	Subject string
}

type syncFake struct {
	mu   sync.Mutex
	base string
	// mail per account. The account's state is len(mail).
	mail map[string][]syncMail
	// order is the account order the session advertises.
	order []string

	// abortEmailGetAt drops the connection on the Nth Email/get (1-based), which
	// is a real transport failure rather than an error response: a client that
	// only handled `["error", …]` would pass a 500-based test and still lose mail.
	abortEmailGetAt int
	emailGetCalls   int

	// requests counts JMAP POSTs, so the batched clean-probe's "N idle inboxes
	// cost about one round trip" is a measurement rather than a claim.
	requests int
	calls    []string
	// downloads records blob fetches (`--blobs`).
	downloads []string
}

func newSyncFake(t *testing.T, accounts ...string) *syncFake {
	t.Helper()
	f := &syncFake{mail: map[string][]syncMail{}, order: accounts}
	for _, a := range accounts {
		f.mail[a] = nil
	}
	srv := httptest.NewServer(http.HandlerFunc(f.handle))
	t.Cleanup(srv.Close)
	f.base = srv.URL
	return f
}

// deliver appends mail, advancing that account's state by one per message —
// exactly what an append-only changelog does.
func (f *syncFake) deliver(accountID string, mails ...syncMail) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.mail[accountID] = append(f.mail[accountID], mails...)
}

func (f *syncFake) seenCalls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.calls...)
}

func (f *syncFake) countCalls(name string) int {
	n := 0
	for _, c := range f.seenCalls() {
		if c == name {
			n++
		}
	}
	return n
}

func (f *syncFake) requestCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.requests
}

func (f *syncFake) reset() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls, f.requests = nil, 0
}

func (f *syncFake) accountsJSON() string {
	parts := make([]string, len(f.order))
	for i, a := range f.order {
		parts[i] = fmt.Sprintf(`{"accountId":%q,"address":"%s@stub.test"}`, a, a)
	}
	return "[" + strings.Join(parts, ",") + "]"
}

func (f *syncFake) handle(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.URL.Path == "/.well-known/jmap":
		accounts := make([]string, len(f.order))
		for i, a := range f.order {
			accounts[i] = fmt.Sprintf(`%q:{"name":%q}`, a, a)
		}
		w.Header().Set("content-type", "application/json")
		fmt.Fprintf(w, `{"username":"you@stub.test","accounts":{%s},`+
			`"primaryAccounts":{"urn:ietf:params:jmap:mail":%q},`+
			`"apiUrl":%q,"downloadUrl":%q}`,
			strings.Join(accounts, ","), f.order[0],
			f.base+"/jmap-endpoint", f.base+"/dl/{accountId}/{blobId}/{name}/{type}")
		return
	case strings.HasPrefix(r.URL.Path, "/dl/"):
		f.mu.Lock()
		f.downloads = append(f.downloads, r.URL.EscapedPath())
		f.mu.Unlock()
		w.Header().Set("content-type", "message/rfc822")
		_, _ = w.Write([]byte("Subject: raw\r\n\r\nbody\r\n"))
		return
	case r.URL.Path != "/jmap-endpoint":
		w.WriteHeader(404)
		return
	}

	var req struct {
		MethodCalls [][]json.RawMessage `json:"methodCalls"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	f.mu.Lock()
	f.requests++
	out := make([]string, 0, len(req.MethodCalls))
	for _, mc := range req.MethodCalls {
		var name, callID string
		_ = json.Unmarshal(mc[0], &name)
		_ = json.Unmarshal(mc[2], &callID)
		f.calls = append(f.calls, name)
		if name == "Email/get" {
			f.emailGetCalls++
			if f.abortEmailGetAt != 0 && f.emailGetCalls == f.abortEmailGetAt {
				f.mu.Unlock()
				// A dropped connection: no status, no body, no JMAP envelope.
				panic(http.ErrAbortHandler)
			}
		}
		out = append(out, f.invoke(name, mc[1], callID))
	}
	f.mu.Unlock()

	w.Header().Set("content-type", "application/json")
	fmt.Fprintf(w, `{"methodResponses":[%s]}`, strings.Join(out, ","))
}

// invoke runs with f.mu held.
func (f *syncFake) invoke(name string, args json.RawMessage, callID string) string {
	var a struct {
		AccountID  string   `json:"accountId"`
		SinceState string   `json:"sinceState"`
		Position   int      `json:"position"`
		Limit      int      `json:"limit"`
		IDs        []string `json:"ids"`
	}
	_ = json.Unmarshal(args, &a)
	mail := f.mail[a.AccountID]
	state := strconv.Itoa(len(mail))
	reply := func(result string) string {
		return fmt.Sprintf(`[%q,%s,%q]`, name, result, callID)
	}

	switch name {
	case "Mailbox/get":
		return reply(fmt.Sprintf(`{"accountId":%q,"state":"mbstate-1","list":[`+
			`{"id":"mb_inbox","parentId":null,"name":"Inbox","role":"inbox","sortOrder":0}]}`, a.AccountID))

	case "Email/changes":
		since, err := strconv.Atoi(a.SinceState)
		if err != nil || since < 0 || since > len(mail) {
			since = 0
		}
		created := make([]string, 0)
		for _, m := range mail[since:] {
			created = append(created, m.ID)
		}
		ids, _ := json.Marshal(created)
		return reply(fmt.Sprintf(`{"accountId":%q,"oldState":%q,"newState":%q,`+
			`"hasMoreChanges":false,"created":%s,"updated":[],"destroyed":[]}`,
			a.AccountID, a.SinceState, state, ids))

	case "Email/query":
		out := make([]string, 0)
		for i := a.Position; i < len(mail) && (a.Limit == 0 || len(out) < a.Limit); i++ {
			out = append(out, mail[i].ID)
		}
		ids, _ := json.Marshal(out)
		return reply(fmt.Sprintf(`{"accountId":%q,"queryState":%q,"position":%d,"ids":%s}`,
			a.AccountID, state, a.Position, ids))

	case "Email/get":
		want := map[string]bool{}
		for _, id := range a.IDs {
			want[id] = true
		}
		var list []string
		for _, m := range mail {
			if !want[m.ID] {
				continue
			}
			list = append(list, fmt.Sprintf(`{"id":%q,"blobId":"blob_%s","threadId":"th_%s",`+
				`"mailboxIds":{"mb_inbox":true},"keywords":{},"size":100,`+
				`"receivedAt":"2026-08-01T00:00:00.000Z","messageId":["<%s@stub.test>"],`+
				`"inReplyTo":null,"from":[{"name":"Sender","email":"s@stub.test"}],`+
				`"to":[{"name":null,"email":"you@stub.test"}],"cc":null,"bcc":null,`+
				`"subject":%q,"hasAttachment":false,"preview":"preview","attachments":[]}`,
				m.ID, m.ID, m.ID, m.ID, m.Subject))
		}
		return reply(fmt.Sprintf(`{"accountId":%q,"state":%q,"list":[%s],"notFound":[]}`,
			a.AccountID, state, strings.Join(list, ",")))
	}
	return fmt.Sprintf(`["error",{"type":"unknownMethod"},%q]`, callID)
}

// ---- helpers ---------------------------------------------------------------

// cursorOf reads the stored resume point — the whole subject of these tests.
func cursorOf(t *testing.T, dbPath, accountID string) string {
	t.Helper()
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var state sql.NullString
	err = db.QueryRow("SELECT email_state FROM sync_state WHERE account_id = ?", accountID).Scan(&state)
	if err == sql.ErrNoRows {
		return ""
	}
	if err != nil {
		t.Fatal(err)
	}
	return state.String
}

// mirroredIDs is every message id the mirror holds for an account, sorted.
func mirroredIDs(t *testing.T, dbPath, accountID string) []string {
	t.Helper()
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	rows, err := db.Query("SELECT id FROM emails WHERE account_id = ?", accountID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

func syncFixture(t *testing.T, accounts ...string) (*syncFake, string) {
	t.Helper()
	fake := newSyncFake(t, accounts...)
	return fake, seedMailMirror(t, fake.base, "bm_token", fake.accountsJSON())
}

// ---- the tests -------------------------------------------------------------

// TestSyncFansOutAcrossAccounts: `sync` is one of the three commands db.ts names
// as legitimately fanning out, so a selector-less run syncs EVERY account and
// reports one progress line each. A port that resolved through the single-account
// rule would silently sync one inbox and look like it worked.
func TestSyncFansOutAcrossAccounts(t *testing.T) {
	fake, dbPath := syncFixture(t, "a_you", "a_team")
	fake.deliver("a_you", syncMail{"em_1", "yours"})
	fake.deliver("a_team", syncMail{"em_2", "theirs"}, syncMail{"em_3", "theirs too"})

	out, errOut, code := runCmd(t, runSync, dbPath, "sync")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	if out != "" {
		t.Errorf("stdout = %q — progress is not a record (arch.md §1.1)", out)
	}
	for _, want := range []string{"a_you@stub.test", "a_team@stub.test"} {
		if !strings.Contains(errOut, want) {
			t.Errorf("stderr = %q, missing a line for %s", errOut, want)
		}
	}
	if got := mirroredIDs(t, dbPath, "a_you"); !equalStrings(got, []string{"em_1"}) {
		t.Errorf("a_you mirror = %v", got)
	}
	if got := mirroredIDs(t, dbPath, "a_team"); !equalStrings(got, []string{"em_2", "em_3"}) {
		t.Errorf("a_team mirror = %v", got)
	}
	// Each account keeps its OWN cursor; one shared cursor would make the second
	// account replay or skip depending on which synced last.
	if got := cursorOf(t, dbPath, "a_you"); got != "1" {
		t.Errorf("a_you cursor = %q, want 1", got)
	}
	if got := cursorOf(t, dbPath, "a_team"); got != "2" {
		t.Errorf("a_team cursor = %q, want 2", got)
	}
}

// TestSyncAdvancesTheCursorAndTheSecondRunIsANoOp is the pair of claims the whole
// protocol rests on: the first pass commits a resume point, and a pass with
// nothing to do costs one probe and touches neither the network nor the mirror
// beyond it.
func TestSyncAdvancesTheCursorAndTheSecondRunIsANoOp(t *testing.T) {
	fake, dbPath := syncFixture(t, "a_you")
	fake.deliver("a_you", syncMail{"em_1", "one"}, syncMail{"em_2", "two"})

	if _, errOut, code := runCmd(t, runSync, dbPath, "sync"); code != 0 {
		t.Fatalf("first sync: exit %d: %s", code, errOut)
	}
	if got := cursorOf(t, dbPath, "a_you"); got != "2" {
		t.Fatalf("cursor after the first pass = %q, want 2", got)
	}

	fake.reset()
	_, errOut, code := runCmd(t, runSync, dbPath, "sync")
	if code != 0 {
		t.Fatalf("second sync: exit %d: %s", code, errOut)
	}
	if !strings.Contains(errOut, "clean (no changes)") {
		t.Errorf("stderr = %q — an unchanged account must report clean", errOut)
	}
	// One probe, and nothing else: no Mailbox/get, no Email/query, no Email/get.
	if got := fake.seenCalls(); len(got) != 1 || got[0] != "Email/changes" {
		t.Errorf("a no-op sync made %v — the clean probe must short-circuit the engine", got)
	}
	if got := cursorOf(t, dbPath, "a_you"); got != "2" {
		t.Errorf("cursor moved on a no-op: %q", got)
	}

	// And a third pass, after real mail, is incremental rather than a full resync.
	fake.deliver("a_you", syncMail{"em_3", "three"})
	fake.reset()
	_, errOut, code = runCmd(t, runSync, dbPath, "sync")
	if code != 0 {
		t.Fatalf("third sync: exit %d: %s", code, errOut)
	}
	if !strings.Contains(errOut, "incremental → state 3") {
		t.Errorf("stderr = %q — new mail after a cursor is an INCREMENTAL pass", errOut)
	}
	if fake.countCalls("Email/query") != 0 {
		t.Errorf("the third pass re-paged the whole mailbox: %v", fake.seenCalls())
	}
	if got := mirroredIDs(t, dbPath, "a_you"); !equalStrings(got, []string{"em_1", "em_2", "em_3"}) {
		t.Errorf("mirror = %v", got)
	}
}

// TestSyncReplaysAnInterruptedPassRatherThanSkippingIt is the property `watch`
// guarantees and `sync` must too: the cursor is written ONCE, at the end, and
// only from the state the server reported. A pass that dies mid-flight therefore
// leaves the OLD cursor in place and the next pass re-reads the same window.
//
// The failure this rules out is silent and permanent. If the cursor advanced
// before the rows landed, the two messages fetched by the dying pass would never
// appear in any later Email/changes, and no error would ever be reported — the
// mailbox would simply be missing mail nobody could point at.
func TestSyncReplaysAnInterruptedPassRatherThanSkippingIt(t *testing.T) {
	fake, dbPath := syncFixture(t, "a_you")
	fake.deliver("a_you", syncMail{"em_1", "one"})
	if _, errOut, code := runCmd(t, runSync, dbPath, "sync"); code != 0 {
		t.Fatalf("seed sync: exit %d: %s", code, errOut)
	}
	if got := cursorOf(t, dbPath, "a_you"); got != "1" {
		t.Fatalf("cursor = %q, want 1", got)
	}

	// Mail arrives, and the pass that would collect it dies after Email/changes
	// has already reported the new state.
	fake.deliver("a_you", syncMail{"em_2", "two"}, syncMail{"em_3", "three"})
	fake.mu.Lock()
	fake.emailGetCalls, fake.abortEmailGetAt = 0, 1
	fake.mu.Unlock()

	_, errOut, code := runCmd(t, runSync, dbPath, "sync")
	if code != 1 {
		t.Fatalf("an interrupted sync must exit 1, got %d: %s", code, errOut)
	}
	if !strings.Contains(errOut, "FAILED") {
		t.Errorf("stderr = %q — the failure must be reported per account", errOut)
	}
	if got := cursorOf(t, dbPath, "a_you"); got != "1" {
		t.Fatalf("the cursor advanced to %q despite the pass failing — em_2 and em_3 "+
			"are now unreachable by any future Email/changes", got)
	}
	if got := mirroredIDs(t, dbPath, "a_you"); !equalStrings(got, []string{"em_1"}) {
		t.Errorf("mirror = %v — the dead pass should have written nothing new", got)
	}

	// The connection comes back. The same window replays, and nothing was lost.
	fake.mu.Lock()
	fake.abortEmailGetAt = 0
	fake.mu.Unlock()
	if _, errOut, code := runCmd(t, runSync, dbPath, "sync"); code != 0 {
		t.Fatalf("recovery sync: exit %d: %s", code, errOut)
	}
	if got := mirroredIDs(t, dbPath, "a_you"); !equalStrings(got, []string{"em_1", "em_2", "em_3"}) {
		t.Errorf("mirror = %v — the replayed window must contain the mail the dead pass fetched", got)
	}
	if got := cursorOf(t, dbPath, "a_you"); got != "3" {
		t.Errorf("cursor = %q, want 3", got)
	}
}

// TestSyncReportsOneAccountsFailureWithoutLosingTheOthers: a broken account is
// reported and costs exit 1, but it does not abort the run — the other accounts
// still sync, which is the difference between a partial outage and a total one.
func TestSyncReportsOneAccountsFailureWithoutLosingTheOthers(t *testing.T) {
	fake, dbPath := syncFixture(t, "a_you", "a_team")
	fake.deliver("a_you", syncMail{"em_1", "one"})
	fake.deliver("a_team", syncMail{"em_2", "two"})
	// a_you is synced first (session order), so the first Email/get is its own.
	fake.mu.Lock()
	fake.abortEmailGetAt = 1
	fake.mu.Unlock()

	_, errOut, code := runCmd(t, runSync, dbPath, "sync")
	if code != 1 {
		t.Fatalf("exit = %d, want 1", code)
	}
	if !strings.Contains(errOut, "a_you@stub.test") || !strings.Contains(errOut, "FAILED") {
		t.Errorf("stderr = %q — the broken account must be named", errOut)
	}
	if got := mirroredIDs(t, dbPath, "a_team"); !equalStrings(got, []string{"em_2"}) {
		t.Errorf("a_team = %v — one broken account must not abort the run", got)
	}
	if got := cursorOf(t, dbPath, "a_you"); got != "" {
		t.Errorf("a_you cursor = %q, want none — the failed pass committed nothing", got)
	}
}

// TestSyncJSONRecords pins the three record shapes, which differ per branch: a
// clean account carries no `mode`, a failed one carries only its error, and a
// synced one spreads the whole SyncStats. `createdIds` is `[]` and not `null`,
// so `jq '.createdIds | length'` answers 0 rather than erroring.
func TestSyncJSONRecords(t *testing.T) {
	fake, dbPath := syncFixture(t, "a_you")
	fake.deliver("a_you", syncMail{"em_1", "one"})

	out, errOut, code := runCmd(t, runSync, dbPath, "sync", "--json")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	want := `{"account":"a_you@stub.test","clean":false,"mode":"full","mailboxes":1,` +
		`"created":1,"updated":0,"destroyed":0,"newState":"1",` +
		`"createdIds":[],"updatedIds":[],"destroyedIds":[]}`
	if got := strings.TrimRight(out, "\n"); got != want {
		t.Errorf("--json =\n  %s\nwant\n  %s", got, want)
	}

	// The clean branch.
	out, _, code = runCmd(t, runSync, dbPath, "sync", "--json")
	if code != 0 {
		t.Fatal(code)
	}
	if got := strings.TrimRight(out, "\n"); got != `{"account":"a_you@stub.test","clean":true}` {
		t.Errorf("clean --json = %s", got)
	}

	// The incremental branch names the ids it moved, which is what `watch`
	// announces and what a script would act on.
	fake.deliver("a_you", syncMail{"em_2", "two"})
	out, _, code = runCmd(t, runSync, dbPath, "sync", "--json")
	if code != 0 {
		t.Fatal(code)
	}
	if !strings.Contains(out, `"mode":"incremental"`) || !strings.Contains(out, `"createdIds":["em_2"]`) {
		t.Errorf("incremental --json = %s", out)
	}
}

// TestSyncBlobsMirrorsTheSource — `--blobs <dir>` is what makes the static binary
// an archiver: metadata in SQLite, RFC 5322 source on disk. Blob ids are content
// hashes, so a second run must NOT re-download.
func TestSyncBlobsMirrorsTheSource(t *testing.T) {
	fake, dbPath := syncFixture(t, "a_you")
	fake.deliver("a_you", syncMail{"em_1", "one"}, syncMail{"em_2", "two"})
	dir := filepath.Join(t.TempDir(), "blobs")

	if _, errOut, code := runCmd(t, runSync, dbPath, "sync", "--blobs", dir); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	for _, name := range []string{"blob_em_1.eml", "blob_em_2.eml"} {
		body, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if !strings.Contains(string(body), "Subject: raw") {
			t.Errorf("%s = %q", name, body)
		}
	}
	before := len(fake.downloads)
	if before != 2 {
		t.Errorf("downloads = %d, want 2", before)
	}
	// A re-run over the same directory re-checks cheaply and downloads nothing.
	fake.deliver("a_you", syncMail{"em_3", "three"})
	if _, errOut, code := runCmd(t, runSync, dbPath, "sync", "--blobs", dir); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	if got := len(fake.downloads) - before; got != 1 {
		t.Errorf("the second pass downloaded %d blobs, want 1 (only the new message)", got)
	}
}

// TestSyncProbesEveryAccountInOneRequest: the batched clean-probe is the reason
// `sync` on a login with many idle accounts is cheap. One request carries an
// Email/changes per cursored account — this is what JMAP batching is for, and a
// port that looped instead would turn one round trip into N.
func TestSyncProbesEveryAccountInOneRequest(t *testing.T) {
	fake, dbPath := syncFixture(t, "a_you", "a_team")
	fake.deliver("a_you", syncMail{"em_1", "one"})
	fake.deliver("a_team", syncMail{"em_2", "two"})
	if _, errOut, code := runCmd(t, runSync, dbPath, "sync"); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}

	fake.reset()
	if _, errOut, code := runCmd(t, runSync, dbPath, "sync"); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	if got := fake.requestCount(); got != 1 {
		t.Errorf("two idle accounts cost %d requests, want 1", got)
	}
	if got := fake.countCalls("Email/changes"); got != 2 {
		t.Errorf("the probe carried %d Email/changes calls, want one per account", got)
	}
}

// TestSyncSelectorFiltersTheFanOut — `--account` narrows the set; an unmatched
// selector is exit 3 and syncs nothing, rather than quietly syncing everything.
func TestSyncSelectorFiltersTheFanOut(t *testing.T) {
	fake, dbPath := syncFixture(t, "a_you", "a_team")
	fake.deliver("a_you", syncMail{"em_1", "one"})
	fake.deliver("a_team", syncMail{"em_2", "two"})

	if _, errOut, code := runCmd(t, runSync, dbPath, "sync", "--account", "a_team"); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	if got := mirroredIDs(t, dbPath, "a_team"); !equalStrings(got, []string{"em_2"}) {
		t.Errorf("a_team = %v", got)
	}
	if got := mirroredIDs(t, dbPath, "a_you"); len(got) != 0 {
		t.Errorf("a_you = %v — the selector should have excluded it", got)
	}

	_, errOut, code := runCmd(t, runSync, dbPath, "sync", "--account", "nobody")
	if code != 3 {
		t.Errorf("exit = %d, want 3", code)
	}
	if !strings.Contains(errOut, `no account matches "nobody"`) {
		t.Errorf("stderr = %q", errOut)
	}
}
