package cmd

// `init` against a fake session resource, plus the assertion this whole wave
// exists for: the mirror the GO binary creates is the mirror the NODE CLI reads.
//
// "Same file, same schema" is devPlan.md decision 4, and it is the difference
// between a port and a fork. A user mid-migration keeps their local mail; a
// machine with both binaries gets the same answers from either. TestNodeCanRead…
// below is what makes that a fact rather than an intention.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/store"
)

// ---- fake session ----------------------------------------------------------

type sessionFake struct {
	mu       sync.Mutex
	requests []string
	status   int
	body     string
}

// The session resource, with TWO accounts and a primaryAccounts pointing at the
// second — so "the primary is the first account" cannot pass by luck, and the
// stored ORDER (which a Go map would scramble) is observable.
const sessionBody = `{"username":"eric@bullmoose.cc",` +
	`"accounts":{"t_1__a_1":{"name":"Eric"},"t_1__a_2":{"name":"Team"}},` +
	`"primaryAccounts":{"urn:ietf:params:jmap:mail":"t_1__a_2"},` +
	`"apiUrl":"/api","downloadUrl":"/api/download/{accountId}/{blobId}"}`

func (f *sessionFake) start(t *testing.T) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.requests = append(f.requests, r.Method+" "+r.URL.Path)
		w.Header().Set("content-type", "application/json")
		if f.status != 0 {
			w.WriteHeader(f.status)
			_, _ = w.Write([]byte(f.body))
			return
		}
		body := f.body
		if body == "" {
			body = sessionBody
		}
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func (f *sessionFake) seen() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.requests...)
}

func runIni(t *testing.T, args ...string) (out, errOut string, code int) {
	t.Helper()
	var o, e strings.Builder
	s := bmio.NewTo(&o, &e)
	code = runInit(s, append([]string{"init"}, args...))
	return o.String(), e.String(), code
}

// ---- the happy path --------------------------------------------------------

func TestInitStoresTheSessionsView(t *testing.T) {
	fake := &sessionFake{}
	srv := fake.start(t)
	dbPath := filepath.Join(t.TempDir(), "mail.db")

	out, errOut, code := runIni(t, "--base", srv.URL, "--token", "bm_op_token", "--db", dbPath)
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	if out != "configured: eric@bullmoose.cc / t_1__a_2 @ "+srv.URL+"\n" {
		t.Errorf("stdout = %q", out)
	}
	if got := fake.seen(); len(got) != 1 || got[0] != "GET /.well-known/jmap" {
		t.Errorf("requests = %v, want one session fetch", got)
	}

	db, err := store.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	// The default account is the session's primary for MAIL, not the first key.
	if got := store.GetConfig(db, "accountId"); got != "t_1__a_2" {
		t.Errorf("accountId = %q, want the session's primary mail account", got)
	}
	if got := store.GetConfig(db, "token"); got != "bm_op_token" {
		t.Errorf("token = %q", got)
	}
	// Order comes from the session's JSON, not from Go's map iteration — two runs
	// of the same command must store the same bytes.
	if got := store.GetConfig(db, "accounts"); got !=
		`[{"accountId":"t_1__a_1","name":"Eric"},{"accountId":"t_1__a_2","name":"Team"}]` {
		t.Errorf("accounts = %s", got)
	}
}

func TestInitJSON(t *testing.T) {
	fake := &sessionFake{}
	srv := fake.start(t)
	out, errOut, code := runIni(t, "--base", srv.URL, "--token", "bm_op_token",
		"--json", "--db", filepath.Join(t.TempDir(), "mail.db"))
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	want := `{"base":"` + srv.URL + `","accountId":"t_1__a_2","username":"eric@bullmoose.cc",` +
		`"accounts":[{"accountId":"t_1__a_1","name":"Eric"},{"accountId":"t_1__a_2","name":"Team"}],` +
		`"validated":true}`
	if got := strings.TrimRight(out, "\n"); got != want {
		t.Errorf("--json =\n%s\nwant\n%s", got, want)
	}
}

// TestInitAcceptsTheUrlAlias — cli/010 §5: `--url` parses, is documented, and
// used to be silently discarded, failing with "init requires --base" and no hint.
func TestInitAcceptsTheUrlAlias(t *testing.T) {
	fake := &sessionFake{}
	srv := fake.start(t)
	_, errOut, code := runIni(t, "--url", srv.URL, "--token", "bm_op_token",
		"--db", filepath.Join(t.TempDir(), "mail.db"))
	if code != 0 {
		t.Fatalf("--url was not honoured: exit %d: %s", code, errOut)
	}
}

func TestInitRequiresBaseAndToken(t *testing.T) {
	for _, argv := range [][]string{{}, {"--base", "https://x"}, {"--token", "bm_1"}} {
		_, errOut, code := runIni(t, append(argv, "--db", filepath.Join(t.TempDir(), "mail.db"))...)
		if code != int(bmio.ExitUsage) {
			t.Errorf("%v: exit = %d, want 2", argv, code)
		}
		if !strings.Contains(errOut, initUsage) {
			t.Errorf("%v: stderr = %q", argv, errOut)
		}
	}
}

// ---- offline ---------------------------------------------------------------

// TestInitOfflineTouchesNoNetwork is the point of --offline: prepping a machine
// before it has connectivity. The contract suite's exit-4 fixture builds a mirror
// this way with a deliberately wrong token (contract.mjs:247), so it must not
// validate anything.
func TestInitOfflineTouchesNoNetwork(t *testing.T) {
	fake := &sessionFake{}
	srv := fake.start(t)
	dbPath := filepath.Join(t.TempDir(), "mail.db")

	out, errOut, code := runIni(t, "--base", srv.URL, "--token", "wrong-token",
		"--account", "t_1__a_1", "--offline", "--db", dbPath)
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	if len(fake.seen()) != 0 {
		t.Errorf("--offline reached the network: %v", fake.seen())
	}
	if out != "configured (offline, unvalidated): t_1__a_1 @ "+srv.URL+"\n" {
		t.Errorf("stdout = %q", out)
	}

	db, err := store.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if got := store.GetConfig(db, "token"); got != "wrong-token" {
		t.Errorf("token = %q — --offline stores what it was given, unvalidated", got)
	}
	// No session was fetched, so there is no account list to store; db.ts:159
	// falls back to the single default account when the blob is absent.
	if got := store.GetConfig(db, "accounts"); got != "" {
		t.Errorf("accounts = %q, want nothing stored offline", got)
	}
}

func TestInitOfflineNeedsAnAccount(t *testing.T) {
	_, errOut, code := runIni(t, "--base", "https://x", "--token", "bm_1", "--offline",
		"--db", filepath.Join(t.TempDir(), "mail.db"))
	if code != int(bmio.ExitUsage) {
		t.Errorf("exit = %d, want 2", code)
	}
	if !strings.Contains(errOut, "--offline requires an accountId") {
		t.Errorf("stderr = %q", errOut)
	}
}

func TestInitOfflineJSON(t *testing.T) {
	out, _, code := runIni(t, "--base", "https://x", "--token", "bm_1", "--account", "a_1",
		"--offline", "--json", "--db", filepath.Join(t.TempDir(), "mail.db"))
	if code != 0 {
		t.Fatal(code)
	}
	if got := strings.TrimRight(out, "\n"); got != `{"base":"https://x","accountId":"a_1","validated":false}` {
		t.Errorf("--json = %s", got)
	}
}

// ---- bootstrap bundles -----------------------------------------------------

func TestInitFromABootstrapBundle(t *testing.T) {
	fake := &sessionFake{}
	srv := fake.start(t)
	dir := t.TempDir()
	bundle := filepath.Join(dir, "bundle.json")
	if err := os.WriteFile(bundle, []byte(
		`{"base":"`+srv.URL+`","token":"bm_from_bundle","accountId":"t_1__a_1"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	dbPath := filepath.Join(dir, "mail.db")

	out, errOut, code := runIni(t, "--base", "file://"+bundle, "--db", dbPath)
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	// The bundle's accountId wins over the session's primary, because it was
	// named explicitly.
	if !strings.Contains(out, "/ t_1__a_1 @") {
		t.Errorf("stdout = %q", out)
	}
	db, err := store.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if got := store.GetConfig(db, "token"); got != "bm_from_bundle" {
		t.Errorf("token = %q", got)
	}

	// An explicit flag still wins over the file (db.ts:19).
	dbPath2 := filepath.Join(dir, "mail2.db")
	if _, errOut, code := runIni(t, "--base", "file://"+bundle, "--token", "bm_explicit",
		"--db", dbPath2); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	db2, err := store.Open(dbPath2)
	if err != nil {
		t.Fatal(err)
	}
	defer db2.Close()
	if got := store.GetConfig(db2, "token"); got != "bm_explicit" {
		t.Errorf("the flag lost to the file: token = %q", got)
	}
}

func TestInitBootstrapFailures(t *testing.T) {
	dir := t.TempDir()
	bad := filepath.Join(dir, "bad.json")
	if err := os.WriteFile(bad, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name, base string
		want       bmio.ExitCode
		contains   string
	}{
		{"missing file", "file://" + filepath.Join(dir, "nope.json"), bmio.ExitNotFound, "bootstrap file not found"},
		{"unparseable", "file://" + bad, bmio.ExitUsage, "not valid JSON"},
	}
	for _, c := range cases {
		_, errOut, code := runIni(t, "--base", c.base, "--db", filepath.Join(dir, "mail.db"))
		if code != int(c.want) {
			t.Errorf("%s: exit = %d, want %d", c.name, code, c.want)
		}
		if !strings.Contains(errOut, c.contains) {
			t.Errorf("%s: stderr = %q", c.name, errOut)
		}
	}
}

// ---- refusals --------------------------------------------------------------

// TestInitRefusesAnAccountTheSessionDoesNotServe, and NAMES the ones it does —
// the difference between a dead end and a next step.
func TestInitRefusesAnAccountTheSessionDoesNotServe(t *testing.T) {
	fake := &sessionFake{}
	srv := fake.start(t)
	dbPath := filepath.Join(t.TempDir(), "mail.db")

	_, errOut, code := runIni(t, "--base", srv.URL, "--token", "bm_1",
		"--account", "t_9__a_9", "--db", dbPath)
	if code != int(bmio.ExitNotFound) {
		t.Errorf("exit = %d, want 3", code)
	}
	if !strings.Contains(errOut, "account t_9__a_9 not in session; available: t_1__a_1, t_1__a_2") {
		t.Errorf("stderr = %q", errOut)
	}
	// And nothing was written: a mirror configured for an account the server does
	// not serve is worse than no mirror.
	if _, err := os.Stat(dbPath); err == nil {
		db, _ := store.Open(dbPath)
		defer db.Close()
		if got := store.GetConfig(db, "token"); got != "" {
			t.Errorf("a refused init still stored a token: %q", got)
		}
	}
}

func TestInitSessionRefusalMapsToExitCode(t *testing.T) {
	fake := &sessionFake{status: 401, body: `{"error":"bad token"}`}
	srv := fake.start(t)
	_, errOut, code := runIni(t, "--base", srv.URL, "--token", "wrong",
		"--db", filepath.Join(t.TempDir(), "mail.db"))
	if code != int(bmio.ExitAuth) {
		t.Errorf("exit = %d, want 4", code)
	}
	if !strings.Contains(errOut, "session fetch failed: HTTP 401") {
		t.Errorf("stderr = %q", errOut)
	}
}

// ---- the mirror ------------------------------------------------------------

// TestInitCreatesAMirrorTheGoReadCommandsCanRead: `init` then `mailboxes`/`log`
// on a machine that has never had Node. Before this wave store.Open did not run
// the DDL and nothing in Go created one, so these queries had no tables.
func TestInitCreatesAMirrorTheGoReadCommandsCanRead(t *testing.T) {
	fake := &sessionFake{}
	srv := fake.start(t)
	dbPath := filepath.Join(t.TempDir(), "mail.db")
	if _, errOut, code := runIni(t, "--base", srv.URL, "--token", "bm_1", "--db", dbPath); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}

	for _, c := range []struct {
		name string
		run  func(*bmio.Streams, []string) int
		argv []string
	}{
		{"mailboxes", runMailboxes, []string{"mailboxes", "--db", dbPath}},
		{"log", runLog, []string{"log", "--db", dbPath}},
		{"search", runSearch, []string{"search", "anything", "--db", dbPath}},
		{"accounts", runAccounts, []string{"accounts", "--db", dbPath}},
	} {
		var o, e strings.Builder
		if code := c.run(bmio.NewTo(&o, &e), c.argv); code != 0 {
			t.Errorf("`%s` on a Go-created mirror exited %d: %s", c.name, code, e.String())
		}
	}
}

// TestNodeCanReadTheMirrorGoCreated is the cross-runtime assertion, and it is
// stronger than "node opened the file": it compares the whole of sqlite_master
// against the schema NODE builds from the canonical .sql files (db.ts:113's two
// execs). A drifted embedded copy, a table Go created differently, or an FTS
// option that only one side sets all show up here as a diff.
//
// It covers the mirror's CONTENT as well as its shape. A schema both runtimes
// agree on is worth nothing if the rows a Go `sync` writes are not the rows a
// Node `log` reads, so a second mirror here is created AND SYNCED by the Go
// binary, and the Node side runs main.ts:1065's own log query over it. That is
// the half decision 4 ("same file, same schema") is actually about: a user
// mid-migration keeps their local mail, and a machine with both binaries gets the
// same answers from either.
func TestNodeCanReadTheMirrorGoCreated(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not on PATH — the cross-runtime half is unavailable")
	}
	dataPlane, ok := repoPath(t, "packages/mailstore/sql/data-plane.sql")
	local, ok2 := repoPath(t, "packages/cli/sql/local.sql")
	if !ok || !ok2 {
		t.Skip("the canonical .sql files are not above this checkout")
	}

	fake := &sessionFake{}
	srv := fake.start(t)
	dir := t.TempDir()
	goMirror := filepath.Join(dir, "go.db")
	if _, errOut, code := runIni(t, "--base", srv.URL, "--token", "bm_1", "--db", goMirror); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}

	// The second mirror: created by `init` and FILLED by `sync`, both native, from
	// a server that has actually delivered mail. Its account id is the syncFake's,
	// which the node script reads out of the file rather than being told.
	mail := newSyncFake(t, "a_you")
	mail.deliver("a_you",
		syncMail{"em_1", "first message"},
		syncMail{"em_2", "second message"})
	syncedMirror := filepath.Join(dir, "go-synced.db")
	if _, errOut, code := runIni(t, "--base", mail.base, "--token", "bm_1", "--db", syncedMirror); code != 0 {
		t.Fatalf("init for the synced mirror: exit %d: %s", code, errOut)
	}
	if _, errOut, code := runCmd(t, runSync, syncedMirror, "sync"); code != 0 {
		t.Fatalf("sync: exit %d: %s", code, errOut)
	}

	// The node side: open the GO-created file with node:sqlite (proving the file
	// is readable by the other runtime at all), read the config rows the Node CLI
	// would read, and build a fresh mirror from the canonical schema for
	// comparison.
	script := `
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const [goPath, freshPath, dataPlane, local, syncedPath] = process.argv.slice(1);

const go = new DatabaseSync(goPath);
const config = Object.fromEntries(
  go.prepare("SELECT key, value FROM config").all().map((r) => [r.key, r.value]));
const goSchema = go.prepare(
  "SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();
// db.ts:113 — re-running the canonical schema over an existing mirror must be a
// no-op, which is what lets either CLI open the other's file.
go.exec(fs.readFileSync(dataPlane, "utf8"));
go.exec(fs.readFileSync(local, "utf8"));

const fresh = new DatabaseSync(freshPath);
fresh.exec(fs.readFileSync(dataPlane, "utf8"));
fresh.exec(fs.readFileSync(local, "utf8"));
const nodeSchema = fresh.prepare(
  "SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();

// The GO-SYNCED mirror, read with the Node CLI's OWN queries: cmdLog
// (main.ts:1065) and cmdSearch's FTS join (main.ts:1090). Verbatim, so this fails
// if a Go-written row is shaped in a way the TypeScript's SQL cannot see.
const synced = new DatabaseSync(syncedPath);
const accountId = synced.prepare("SELECT value FROM config WHERE key = 'accountId'").get().value;
const log = synced.prepare(
  ` + "`" + `SELECT e.id, e.account_id, e.subject, e.from_json, e.preview, e.received_at,
     EXISTS (SELECT 1 FROM email_keywords k WHERE k.account_id = e.account_id
             AND k.email_id = e.id AND k.keyword = '$seen') AS seen,
     (SELECT group_concat(COALESCE(m.role, m.name)) FROM email_mailboxes em
        JOIN mailboxes m ON m.account_id = em.account_id AND m.id = em.mailbox_id
      WHERE em.account_id = e.account_id AND em.email_id = e.id) AS mailboxes
   FROM emails e WHERE e.account_id = ? ORDER BY e.received_at DESC LIMIT 20` + "`" + `).all(accountId);
const found = synced.prepare(
  ` + "`" + `SELECT e.id FROM cli_fts f JOIN emails e ON e.id = f.email_id
   WHERE e.account_id = ? AND cli_fts MATCH ?` + "`" + `).all(accountId, "second");
const cursor = synced.prepare(
  "SELECT email_state FROM sync_state WHERE account_id = ?").get(accountId);

process.stdout.write(JSON.stringify({
  config, goSchema, nodeSchema,
  log: log.map((r) => ({ ...r, from: JSON.parse(r.from_json), from_json: undefined })),
  found: found.map((r) => r.id),
  cursor: cursor ? cursor.email_state : null,
}));
`
	// Output(), NOT CombinedOutput(): node 22 prints an ExperimentalWarning for
	// node:sqlite on stderr, and folding that into stdout would make the JSON
	// unparseable and this test red for a reason that has nothing to do with the
	// schemas. CI runs node 22 (mail-typecheck.yml), so this is not hypothetical.
	cmd := exec.Command(node, "-e", script, goMirror, filepath.Join(dir, "node.db"),
		dataPlane, local, syncedMirror)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("node could not read the mirror the Go CLI created: %v\n%s", err, stderr.String())
	}
	var answer struct {
		Config               map[string]string `json:"config"`
		GoSchema, NodeSchema []struct{ Type, Name, SQL string }
		Log                  []struct {
			ID        string  `json:"id"`
			AccountID string  `json:"account_id"`
			Subject   string  `json:"subject"`
			Preview   string  `json:"preview"`
			Seen      int     `json:"seen"`
			Mailboxes *string `json:"mailboxes"`
			From      []struct {
				Name  *string `json:"name"`
				Email string  `json:"email"`
			} `json:"from"`
		} `json:"log"`
		Found  []string `json:"found"`
		Cursor *string  `json:"cursor"`
	}
	if err := json.Unmarshal(out, &answer); err != nil {
		t.Fatalf("node said: %s (%v)", out, err)
	}

	if answer.Config["accountId"] != "t_1__a_2" || answer.Config["token"] != "bm_1" {
		t.Errorf("node read back %v — the Node CLI would not consider this mirror configured",
			answer.Config)
	}

	// ---- the rows a Go `sync` wrote, as the Node CLI sees them --------------
	if len(answer.Log) != 2 {
		t.Fatalf("the Node CLI's log query found %d rows in a Go-synced mirror, want 2: %+v",
			len(answer.Log), answer.Log)
	}
	// Newest first, and every column the human/--json renderers read is populated:
	// a NULL mailboxes would print `[]` and mean "the join found nothing", which is
	// how a membership row written under the wrong account surfaces.
	for _, r := range answer.Log {
		if r.AccountID != "a_you" || r.Preview != "preview" {
			t.Errorf("row %s = %+v", r.ID, r)
		}
		if r.Mailboxes == nil || *r.Mailboxes != "inbox" {
			t.Errorf("row %s has mailboxes %v — Node's join over the Go-written membership "+
				"rows found nothing", r.ID, r.Mailboxes)
		}
		if r.Seen != 0 {
			t.Errorf("row %s reads as seen; the fixture has no keywords", r.ID)
		}
		if len(r.From) != 1 || r.From[0].Email != "s@stub.test" {
			t.Errorf("row %s from = %+v — from_json must survive JSON.parse", r.ID, r.From)
		}
	}
	// The FTS index Go wrote is queryable by Node's own MATCH.
	if len(answer.Found) != 1 || answer.Found[0] != "em_2" {
		t.Errorf("Node's `search` over a Go-written cli_fts found %v, want [em_2]", answer.Found)
	}
	// And the cursor: a Node `sync` against this mirror would resume where Go
	// stopped rather than re-paging the mailbox.
	if answer.Cursor == nil || *answer.Cursor != "2" {
		t.Errorf("sync_state.email_state = %v, want \"2\" — Node would not resume from Go's cursor",
			answer.Cursor)
	}
	// The same file, read by the GO log command, must say the same thing: the two
	// implementations are interchangeable on identical state, not merely
	// non-destructive to each other.
	goLog, _, code := runCmd(t, runLog, syncedMirror, "log", "--json")
	if code != 0 {
		t.Fatalf("go log over its own mirror exited %d", code)
	}
	goLines := strings.Split(strings.TrimRight(goLog, "\n"), "\n")
	if len(goLines) != len(answer.Log) {
		t.Errorf("go log returned %d rows, node's query %d — the same file, two answers",
			len(goLines), len(answer.Log))
	}
	for i, line := range goLines {
		var row struct {
			ID        string  `json:"id"`
			Subject   string  `json:"subject"`
			Seen      int     `json:"seen"`
			Mailboxes *string `json:"mailboxes"`
		}
		if err := json.Unmarshal([]byte(line), &row); err != nil {
			t.Fatalf("go log line %d is not JSON: %s", i, line)
		}
		n := answer.Log[i]
		if row.ID != n.ID || row.Subject != n.Subject || row.Seen != n.Seen {
			t.Errorf("row %d: go=%+v node=%+v", i, row, n)
		}
	}
	goNames, nodeNames := schemaIndex(answer.GoSchema), schemaIndex(answer.NodeSchema)
	for name, sql := range nodeNames {
		got, ok := goNames[name]
		if !ok {
			t.Errorf("the Go mirror is missing %s, which the Node CLI creates — a command that "+
				"reads it would fail on a Go-provisioned machine", name)
			continue
		}
		if got != sql {
			t.Errorf("%s differs between the two CLIs:\n  go   %s\n  node %s", name, got, sql)
		}
	}
	for name := range goNames {
		if _, ok := nodeNames[name]; !ok {
			t.Errorf("the Go mirror has %s and the Node one does not — the schemas have forked", name)
		}
	}
	if len(nodeNames) < 30 {
		t.Fatalf("only %d schema objects — the comparison did not run properly", len(nodeNames))
	}
}

func schemaIndex(rows []struct{ Type, Name, SQL string }) map[string]string {
	out := map[string]string{}
	for _, r := range rows {
		// Internal shadow tables of an fts5 index carry no `sql` worth comparing
		// and are created by SQLite itself, not by either CLI.
		if r.SQL == "" {
			continue
		}
		out[r.Type+" "+r.Name] = strings.Join(strings.Fields(r.SQL), " ")
	}
	names := make([]string, 0, len(out))
	for n := range out {
		names = append(names, n)
	}
	sort.Strings(names)
	return out
}

// repoPath resolves a repo-relative path by walking up from the test directory.
func repoPath(t *testing.T, rel string) (string, bool) {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		p := filepath.Join(dir, filepath.FromSlash(rel))
		if _, err := os.Stat(p); err == nil {
			return p, true
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", false
		}
		dir = parent
	}
}
