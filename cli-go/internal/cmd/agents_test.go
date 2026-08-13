package cmd

// `agents` is GO-NATIVE with no Node twin, so it gets its OWN Go tests against a
// FAKE control-plane server — not a Node-parity check. The fake reproduces the
// slice of the provision worker's admin API this command uses
// (services/provision/src/index.ts): the binding list, the create route, the two
// kill-switch verbs and the guarded delete, including the refusals that carry
// the honesty rules (404 on a missing account, 409 while work is queued).
//
// Three assertions carry most of the weight, and each is written as a claim
// about BEHAVIOUR rather than about a string:
//
//   - the fail-closed guard is asserted by "the server saw nothing" — a refusal
//     that still sent the request would be a guard in name only;
//   - `show`'s activity POINTER is asserted together with a JMAP endpoint that
//     fails the test if it is touched at all, so "activity is a pointer, not a
//     panel" cannot decay into a quietly-added dossier fetch;
//   - `remove`'s default is asserted by which ROUTE was called, not by the
//     word printed, because the reversible/irreversible distinction is the
//     route.

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
)

// ---- fake provision (admin API) server -------------------------------------

type fakeBinding struct {
	id, accountID, name, triggerOn string
	enabled                        int
	config                         map[string]any
	bookID                         string // "" == NULL
	queued                         int    // pending/running invocations
}

type adminCall struct {
	method, path string
	body         map[string]any
}

type fakeAdmin struct {
	mu sync.Mutex
	// reportsBook mirrors a provision worker that projects recipients_book_id
	// (the s10 T4 read change). false reproduces a PRE-s10 worker, which is a
	// state the CLI must render as UNREPORTED rather than as "no book".
	reportsBook bool
	bindings    []*fakeBinding
	calls       []adminCall
	nextID      int
	// noAccountFor makes POST /agent-bindings 404 the way the real worker does
	// when the address has no account.
	noAccountFor map[string]bool
}

func newAdmin() *fakeAdmin {
	return &fakeAdmin{reportsBook: true, noAccountFor: map[string]bool{}}
}

func (fa *fakeAdmin) add(b *fakeBinding) *fakeBinding {
	if b.accountID == "" {
		b.accountID = "a_eric"
	}
	if b.triggerOn == "" {
		b.triggerOn = "mailbox-delivery"
	}
	fa.bindings = append(fa.bindings, b)
	return b
}

func (fa *fakeAdmin) start(t *testing.T) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(fa.handle))
	t.Cleanup(srv.Close)
	return srv
}

func (fa *fakeAdmin) sawWrites() []adminCall {
	fa.mu.Lock()
	defer fa.mu.Unlock()
	var out []adminCall
	for _, c := range fa.calls {
		if c.method != "GET" {
			out = append(out, c)
		}
	}
	return out
}

func (fa *fakeAdmin) handle(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") != "Bearer admin-secret" {
		http.Error(w, `{"error":"unauthorized"}`, 401)
		return
	}
	fa.mu.Lock()
	defer fa.mu.Unlock()

	var body map[string]any
	_ = json.NewDecoder(r.Body).Decode(&body)
	fa.calls = append(fa.calls, adminCall{method: r.Method, path: r.URL.Path, body: body})

	write := func(status int, v any) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(v)
	}

	switch {
	case r.Method == "GET" && r.URL.Path == "/agent-bindings":
		email := r.URL.Query().Get("email")
		rows := []map[string]any{}
		for _, b := range fa.bindings {
			if email != "" && email != b.accountID+"@x" {
				continue
			}
			row := map[string]any{
				"id": b.id, "account_id": b.accountID, "name": b.name,
				"trigger_on": b.triggerOn, "sla_seconds": nil, "enabled": b.enabled,
				"config_json": mustJSON(b.config),
			}
			if fa.reportsBook {
				if b.bookID == "" {
					row["recipients_book_id"] = nil
				} else {
					row["recipients_book_id"] = b.bookID
				}
			}
			rows = append(rows, row)
		}
		write(200, map[string]any{"bindings": rows})

	case r.Method == "POST" && r.URL.Path == "/agent-bindings":
		email, _ := body["email"].(string)
		if fa.noAccountFor[email] {
			write(404, map[string]any{"error": "no account for " + email})
			return
		}
		fa.nextID++
		id := fmt.Sprintf("bind_new%d", fa.nextID)
		book, _ := body["recipientsBookId"].(string)
		name, _ := body["name"].(string)
		cfg, _ := body["config"].(map[string]any)
		fa.add(&fakeBinding{id: id, name: name, enabled: 1, config: cfg, bookID: book})
		_, hasSLA := body["slaSeconds"]
		write(200, map[string]any{"ok": true, "bindingId": id, "accountId": "a_eric", "watchdog": hasSLA})

	case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/disable"),
		r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/enable"):
		parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/agent-bindings/"), "/")
		b := fa.find(parts[0])
		if b == nil {
			write(404, map[string]any{"error": "no agent binding " + parts[0]})
			return
		}
		enable := parts[1] == "enable"
		was := b.enabled
		if enable {
			b.enabled = 1
		} else {
			b.enabled = 0
		}
		note := fmt.Sprintf("%d queued invocation(s) are HELD, not cancelled — they resume on enable", b.queued)
		if enable {
			note = fmt.Sprintf("%d queued invocation(s) will now drain", b.queued)
		}
		write(200, map[string]any{
			"ok": true, "bindingId": b.id, "accountId": b.accountID, "name": b.name,
			"enabled": enable, "changed": (was == 1) != enable,
			"pendingInvocations": b.queued, "note": note,
		})

	case r.Method == "DELETE" && strings.HasPrefix(r.URL.Path, "/agent-bindings/"):
		id := strings.TrimPrefix(r.URL.Path, "/agent-bindings/")
		b := fa.find(id)
		if b == nil {
			write(404, map[string]any{"error": "no agent binding " + id})
			return
		}
		if b.queued > 0 {
			// The real refusal: deleting a binding with queued work would make
			// those rows permanently invisible.
			write(409, map[string]any{
				"error": fmt.Sprintf("binding %s still has %d pending/running invocation(s) — "+
					"deleting it would strand them", b.id, b.queued),
			})
			return
		}
		fa.remove(id)
		write(200, map[string]any{
			"ok": true, "deleted": true, "bindingId": b.id, "accountId": b.accountID, "name": b.name,
			"steps": []any{map[string]any{"step": "d1:watchdog-responder", "ok": true, "detail": "none was armed"},
				map[string]any{"step": "d1:agent-binding", "ok": true}},
		})

	default:
		write(404, map[string]any{"error": "no route " + r.Method + " " + r.URL.Path})
	}
}

func (fa *fakeAdmin) find(id string) *fakeBinding {
	for _, b := range fa.bindings {
		if b.id == id {
			return b
		}
	}
	return nil
}

func (fa *fakeAdmin) remove(id string) {
	out := fa.bindings[:0]
	for _, b := range fa.bindings {
		if b.id != id {
			out = append(out, b)
		}
	}
	fa.bindings = out
}

func mustJSON(v map[string]any) string {
	if v == nil {
		return "{}"
	}
	b, _ := json.Marshal(v)
	return string(b)
}

// ---- mirror seed + runner --------------------------------------------------

// forbiddenJMAP is a mail endpoint that fails the test the moment it is called.
// It is what makes "activity is a POINTER, not a panel" a testable claim: a
// future `show` that quietly fetches the proposal queue trips this, not a
// reviewer.
func forbiddenJMAP(t *testing.T) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("agents must not talk to the mail/JMAP plane: %s %s — activity is a POINTER, "+
			"the dossier belongs to /approvals and the s03.E console", r.Method, r.URL.Path)
		http.Error(w, "{}", 500)
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

// seedAgentsMirror writes BOTH credential pairs: the mail login (base/token,
// pointed at forbiddenJMAP) and the operator's admin pair (adminUrl/adminToken).
func seedAgentsMirror(t *testing.T, jmapBase, adminURL, adminToken string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "mail.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("open seed db: %v", err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`); err != nil {
		t.Fatalf("create config: %v", err)
	}
	ins := func(k, v string) {
		if v == "" {
			return
		}
		if _, err := db.Exec(`INSERT INTO config(key,value) VALUES(?,?)`, k, v); err != nil {
			t.Fatalf("insert %s: %v", k, err)
		}
	}
	ins("base", jmapBase)
	ins("token", "bm_mail")
	ins("accountId", "a_eric")
	ins("accounts", `[{"accountId":"a_eric","address":"eric@bullmoose.cc","name":"Eric"}]`)
	ins("adminUrl", adminURL)
	ins("adminToken", adminToken)
	return path
}

func agEnv(t *testing.T, fa *fakeAdmin) string {
	t.Helper()
	return seedAgentsMirror(t, forbiddenJMAP(t), fa.start(t).URL, "admin-secret")
}

// runAG invokes the command with captured streams and an appended --db.
func runAG(t *testing.T, dbPath string, args ...string) (out, errOut string, code int) {
	t.Helper()
	var o, e strings.Builder
	s := bmio.NewTo(&o, &e)
	argv := append([]string{"agents"}, args...)
	argv = append(argv, "--db", dbPath)
	code = runAgents(s, argv)
	return o.String(), e.String(), code
}

// ---- list ------------------------------------------------------------------

// list puts the four config facts on one line, and the two bounds side by side.
func TestAgents_List(t *testing.T) {
	fa := newAdmin()
	fa.add(&fakeBinding{id: "bind_photos", name: "photos", enabled: 1, bookID: "ab_invitees",
		config: map[string]any{"replyMode": "draft", "allowedSenders": []string{"eric@bullmoose.cc"}, "persona": "p"}})
	fa.add(&fakeBinding{id: "bind_analyst", name: "analyst", enabled: 0,
		config: map[string]any{"replyMode": "send", "pipeline": "ledger"}})
	db := agEnv(t, fa)

	out, errOut, code := runAG(t, db, "list")
	if code != 0 {
		t.Fatalf("list exit %d: %s", code, errOut)
	}
	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
	if len(lines) != 2 {
		t.Fatalf("want 2 rows, got %d: %q", len(lines), out)
	}
	// analyst sorts first; it is DISABLED and has NO governing book.
	if !strings.Contains(lines[0], "analyst") || !strings.Contains(lines[0], "disabled") {
		t.Errorf("analyst row = %q", lines[0])
	}
	if !strings.Contains(lines[0], "none") {
		t.Errorf("a binding with no governing book must read `none`, got %q", lines[0])
	}
	if strings.Contains(lines[0], "any") && !strings.Contains(lines[0], "no gate") {
		t.Errorf("no-book must never render as unrestricted: %q", lines[0])
	}
	if !strings.Contains(lines[1], "book:ab_invitees") || !strings.Contains(lines[1], "eric@bullmoose.cc") {
		t.Errorf("photos row must show both bounds, got %q", lines[1])
	}
	if !strings.Contains(errOut, "FAIL-CLOSED") && !strings.Contains(errOut, "CANNOT SEND") {
		t.Errorf("the legend must say what `none` means, got %q", errOut)
	}

	// --ids is the xargs shape and nothing else.
	out, _, code = runAG(t, db, "list", "--ids")
	if code != 0 || strings.Join(strings.Fields(out), " ") != "bind_analyst bind_photos" {
		t.Fatalf("--ids = %q (exit %d)", out, code)
	}

	// --json: NDJSON, one binding per line, stable shape.
	out, _, code = runAG(t, db, "list", "--json")
	if code != 0 {
		t.Fatalf("--json exit %d", code)
	}
	rows := strings.Split(strings.TrimRight(out, "\n"), "\n")
	if len(rows) != 2 {
		t.Fatalf("--json rows = %d", len(rows))
	}
	var analyst, photos map[string]any
	_ = json.Unmarshal([]byte(rows[0]), &analyst)
	_ = json.Unmarshal([]byte(rows[1]), &photos)

	ao := analyst["outbound"].(map[string]any)
	if ao["state"] != "none" || ao["failClosed"] != true || ao["governingBookId"] != nil {
		t.Errorf("unbound binding json = %v", ao)
	}
	po := photos["outbound"].(map[string]any)
	if po["state"] != "book" || po["governingBookId"] != "ab_invitees" || po["failClosed"] != false {
		t.Errorf("bound binding json = %v", po)
	}
	if photos["replyMode"] != "draft" || photos["enabled"] != true {
		t.Errorf("photos core json = %v", photos)
	}
}

// A provision worker that does not project recipients_book_id must read as
// UNREPORTED. Rendering it as "none" would be a fail-closed claim the CLI has
// no evidence for, and the two states have opposite meanings.
func TestAgents_List_UnreportedBookIsNotNone(t *testing.T) {
	fa := newAdmin()
	fa.reportsBook = false
	fa.add(&fakeBinding{id: "bind_x", name: "photos", enabled: 1, bookID: "ab_real"})
	db := agEnv(t, fa)

	out, _, code := runAG(t, db, "list")
	if code != 0 {
		t.Fatalf("exit %d", code)
	}
	if !strings.Contains(out, "unreported") {
		t.Errorf("a worker that omits the column must read `unreported`, got %q", out)
	}
	out, _, _ = runAG(t, db, "list", "--json")
	var row map[string]any
	_ = json.Unmarshal([]byte(strings.TrimSpace(out)), &row)
	o := row["outbound"].(map[string]any)
	if o["state"] != "unreported" || o["failClosed"] != false {
		t.Errorf("unreported must not be reported as fail-closed: %v", o)
	}
}

// ---- show ------------------------------------------------------------------

// show prints the config core, separates the read-only remainder, and points at
// the activity surface instead of rebuilding it. The JMAP endpoint in this
// environment fails the test if it is touched at all.
func TestAgents_Show_ActivityIsAPointerNotAPanel(t *testing.T) {
	fa := newAdmin()
	fa.add(&fakeBinding{id: "bind_photos", name: "photos", enabled: 1, bookID: "ab_invitees",
		config: map[string]any{
			"replyMode": "draft", "allowedSenders": []string{"eric@bullmoose.cc"},
			"persona": "you are photos", "pipeline": "reply",
		}})
	db := agEnv(t, fa)

	out, errOut, code := runAG(t, db, "show", "photos")
	if code != 0 {
		t.Fatalf("show exit %d: %s", code, errOut)
	}
	if !strings.Contains(out, "for activity: bullmoose approvals list --agent photos") {
		t.Fatalf("show must print the activity POINTER, got:\n%s", out)
	}
	// The config core and the read-only remainder are separated, and the
	// remainder is labelled as not editable here.
	if !strings.Contains(out, "config core") || !strings.Contains(out, "read-only remainder") {
		t.Errorf("the two halves must be labelled, got:\n%s", out)
	}
	if !strings.Contains(out, "persona") || !strings.Contains(out, "pipeline") {
		t.Errorf("the blob remainder must be shown read-only, got:\n%s", out)
	}
	if strings.Contains(out, "allowedSenders:   —") {
		t.Errorf("the inbound allowlist must render, got:\n%s", out)
	}
	// It is a POINTER, not a dossier: no queue, no history, no score.
	for _, forbidden := range []string{"rationale", "RATIONALE", "pending proposal", "acceptance rate"} {
		if strings.Contains(out, forbidden) {
			t.Errorf("show must not reimplement the dossier (found %q):\n%s", forbidden, out)
		}
	}

	// --json carries the pointer too — an agent reading JSON is told where
	// activity lives just as a human is.
	out, _, code = runAG(t, db, "show", "photos", "--json")
	if code != 0 {
		t.Fatalf("show --json exit %d", code)
	}
	var v map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(out)), &v); err != nil {
		t.Fatalf("show --json is not one object: %v", err)
	}
	act, ok := v["activity"].(map[string]any)
	if !ok || act["pointer"] != "bullmoose approvals list --agent photos" {
		t.Fatalf("show --json activity = %v", v["activity"])
	}
	if _, dossier := v["proposals"]; dossier {
		t.Errorf("show --json must not carry a proposal list")
	}
}

// The pointer must name a flag `approvals` actually parses. Printing a pointer
// at a flag that does not exist is the same class of lie as a config control
// with no backing field.
func TestAgents_ActivityPointerIsARealCommand(t *testing.T) {
	pointer := activityPointer("photos")
	parsed := parseApprovals(strings.Fields(pointer)[1:]) // drop "bullmoose"
	if parsed.Agent != "photos" {
		t.Fatalf("approvals does not parse the pointer %q — Agent = %q", pointer, parsed.Agent)
	}
	if positionalAt(parsed, 1) != "list" {
		t.Fatalf("the pointer must name a real verb, got %q", positionalAt(parsed, 1))
	}
}

// And the filter actually narrows the queue.
func TestApprovals_AgentFilter(t *testing.T) {
	fs := newFake(true)
	fs.add(&fakeProp{id: "p_photos", kind: "reply-draft", tier: 2, agent: "photos", rationale: "a"})
	fs.add(&fakeProp{id: "p_analyst", kind: "reply-draft", tier: 2, agent: "analyst", rationale: "b"})
	db := newEnv(t, fs, true)

	out, _, code := runAP(t, db, "list", "--agent", "photos", "--ids")
	if code != 0 {
		t.Fatalf("exit %d", code)
	}
	if got := strings.Fields(out); len(got) != 1 || got[0] != "p_photos" {
		t.Fatalf("--agent photos = %v, want [p_photos]", got)
	}
}

// ---- edit: the fail-closed test -------------------------------------------

// THE fail-closed test. Every spelling of "unbounded" — including the empty
// value, which is the one that reads as "send anywhere" — is refused as a usage
// error, BEFORE the network. The server seeing nothing is the assertion that
// matters: a refusal that still sent the request would be a guard in name only.
func TestAgents_Edit_CannotProduceAnUnboundedOutboundState(t *testing.T) {
	for _, spelling := range []string{"", "*", "all", "any", "none", "null", "-", "unrestricted", "ANY"} {
		fa := newAdmin()
		fa.add(&fakeBinding{id: "bind_photos", name: "photos", enabled: 1, bookID: "ab_invitees"})
		db := agEnv(t, fa)

		out, errOut, code := runAG(t, db, "edit", "photos", "--recipients-book", spelling)
		if code != int(bmio.ExitUsage) {
			t.Fatalf("--recipients-book %q exit %d, want %d (usage) — out=%q err=%q",
				spelling, code, bmio.ExitUsage, out, errOut)
		}
		if !strings.Contains(errOut, "fail-closed") {
			t.Errorf("--recipients-book %q must explain the invariant, got %q", spelling, errOut)
		}
		if !strings.Contains(errOut, "agents remove") {
			t.Errorf("--recipients-book %q must point at the verb that DOES stop a send, got %q", spelling, errOut)
		}
		if w := fa.sawWrites(); len(w) != 0 {
			t.Fatalf("--recipients-book %q reached the server: %v", spelling, w)
		}
	}
}

// A real book id gets past the invariant and lands on the honest gap: there is
// no server surface for this write anywhere, and the CLI says so rather than
// inventing a D1 path.
func TestAgents_Edit_ConfigWritesHaveNoServerSurface(t *testing.T) {
	cases := [][]string{
		{"--reply-mode", "send"},
		{"--allow-sender", "bob@example.com"},
		{"--recipients-book", "ab_other"},
	}
	for _, flags := range cases {
		fa := newAdmin()
		fa.add(&fakeBinding{id: "bind_photos", name: "photos", enabled: 1, bookID: "ab_invitees"})
		db := agEnv(t, fa)

		_, errOut, code := runAG(t, db, append([]string{"edit", "photos"}, flags...)...)
		if code != int(bmio.ExitFail) {
			t.Fatalf("%v exit %d, want %d", flags, code, bmio.ExitFail)
		}
		if !strings.Contains(errOut, "no server surface") || !strings.Contains(errOut, "PATCH /agent-bindings") {
			t.Errorf("%v must name the gap, got %q", flags, errOut)
		}
		if w := fa.sawWrites(); len(w) != 0 {
			t.Fatalf("%v wrote something: %v", flags, w)
		}
	}
}

// The one field of the typed core that DOES have a surface goes through the two
// explicit kill-switch verbs.
func TestAgents_Edit_EnabledUsesTheKillSwitchVerbs(t *testing.T) {
	fa := newAdmin()
	fa.add(&fakeBinding{id: "bind_photos", name: "photos", enabled: 1, bookID: "ab_x", queued: 3})
	db := agEnv(t, fa)

	out, errOut, code := runAG(t, db, "edit", "photos", "--enabled", "false")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	w := fa.sawWrites()
	if len(w) != 1 || w[0].method != "POST" || w[0].path != "/agent-bindings/bind_photos/disable" {
		t.Fatalf("--enabled false must POST the disable verb, saw %v", w)
	}
	if !strings.Contains(out, "DISABLED") {
		t.Errorf("out = %q", out)
	}
	// Queued work is HELD, not cancelled — the count must reach the operator.
	if !strings.Contains(errOut, "HELD") || !strings.Contains(errOut, "3") {
		t.Errorf("the held-queue count must be surfaced, got %q", errOut)
	}
	if !strings.Contains(errOut, "reversible") {
		t.Errorf("disable must advertise its own undo, got %q", errOut)
	}

	_, _, code = runAG(t, db, "edit", "photos", "--enabled", "true")
	if code != 0 {
		t.Fatalf("enable exit %d", code)
	}
	if w := fa.sawWrites(); w[len(w)-1].path != "/agent-bindings/bind_photos/enable" {
		t.Fatalf("--enabled true must POST enable, saw %v", w)
	}

	// A non-boolean is a usage error, not a guess.
	if _, _, code = runAG(t, db, "edit", "photos", "--enabled", "maybe"); code != int(bmio.ExitUsage) {
		t.Fatalf("--enabled maybe exit %d, want 2", code)
	}
}

// ---- create ----------------------------------------------------------------

// `create --kind photos` produces a FAIL-CLOSED binding: with no --recipients-book
// the request carries no recipientsBookId at all (the column stays NULL, which
// the runtime reads as "cannot send"), and the operator is told so in words.
func TestAgents_Create_PhotosIsFailClosed(t *testing.T) {
	fa := newAdmin()
	db := agEnv(t, fa)

	out, errOut, code := runAG(t, db, "create", "--kind", "photos", "--email", "photos@bullmoose.cc")
	if code != 0 {
		t.Fatalf("create exit %d: %s", code, errOut)
	}
	w := fa.sawWrites()
	if len(w) != 1 || w[0].path != "/agent-bindings" {
		t.Fatalf("saw %v", w)
	}
	if v, present := w[0].body["recipientsBookId"]; present {
		t.Fatalf("an unbounded create must OMIT recipientsBookId, sent %v", v)
	}
	cfg, _ := w[0].body["config"].(map[string]any)
	if cfg["replyMode"] != "draft" {
		t.Errorf("a new binding must default to draft, got %v", cfg["replyMode"])
	}
	if _, leaked := cfg["allowedRecipients"]; leaked {
		t.Errorf("the outbound bound is a BOOK — create must never write a recipient list: %v", cfg)
	}
	if !strings.Contains(errOut, "CANNOT SEND") {
		t.Errorf("an unbounded create must say the binding cannot send, got %q", errOut)
	}
	if !strings.Contains(out, "created") {
		t.Errorf("out = %q", out)
	}

	// Naming a book carries it through as the typed column.
	fa2 := newAdmin()
	db2 := agEnv(t, fa2)
	if _, errOut, code = runAG(t, db2, "create", "--kind", "photos", "--email", "photos@bullmoose.cc",
		"--recipients-book", "ab_invitees"); code != 0 {
		t.Fatalf("bounded create exit %d: %s", code, errOut)
	}
	if got := fa2.sawWrites()[0].body["recipientsBookId"]; got != "ab_invitees" {
		t.Fatalf("recipientsBookId = %v", got)
	}
	// It must NOT claim the book is governed — no wire exposes write_policy.
	if !strings.Contains(errOut, "NOT verified") {
		t.Errorf("create must not claim a book is governed when it cannot check, got %q", errOut)
	}
}

// Every kind is fail-closed, and the wildcard is refused for all of them.
func TestAgents_Create_EveryKindRefusesAnUnboundedBound(t *testing.T) {
	for _, kind := range []string{"analyst", "photos", "newsletters", "custom"} {
		fa := newAdmin()
		db := agEnv(t, fa)
		args := []string{"create", "--kind", kind, "--email", kind + "@bullmoose.cc", "--recipients-book", "*"}
		if kind == "custom" {
			args = append(args, "--name", "thing")
		}
		_, errOut, code := runAG(t, db, args...)
		if code != int(bmio.ExitUsage) {
			t.Fatalf("kind %s: exit %d, want 2 — %s", kind, code, errOut)
		}
		if len(fa.sawWrites()) != 0 {
			t.Fatalf("kind %s wrote despite the refusal", kind)
		}
	}
	// And `custom` — the blank case — still refuses to be nameless rather than
	// silently inventing one.
	fa := newAdmin()
	db := agEnv(t, fa)
	if _, _, code := runAG(t, db, "create", "--kind", "custom", "--email", "x@bullmoose.cc"); code != int(bmio.ExitUsage) {
		t.Fatalf("custom with no --name exit %d, want 2", code)
	}
}

// create binds; it does not mint an identity. The server's 404 is surfaced with
// the provisioning call that WOULD mint one, rather than being faked.
func TestAgents_Create_DoesNotFakeIdentityMinting(t *testing.T) {
	fa := newAdmin()
	fa.noAccountFor["ghost@bullmoose.cc"] = true
	db := agEnv(t, fa)

	_, errOut, code := runAG(t, db, "create", "--kind", "analyst", "--email", "ghost@bullmoose.cc")
	if code != int(bmio.ExitNotFound) {
		t.Fatalf("exit %d, want 3", code)
	}
	if !strings.Contains(errOut, "no account for ghost@bullmoose.cc") {
		t.Errorf("the server's sentence must survive verbatim, got %q", errOut)
	}
	if !strings.Contains(errOut, "admin account create") || !strings.Contains(errOut, "does not mint") {
		t.Errorf("the refusal must point at the provisioning call, got %q", errOut)
	}

	// --dry-run says what it would do and writes nothing.
	fa2 := newAdmin()
	db2 := agEnv(t, fa2)
	_, errOut, code = runAG(t, db2, "create", "--kind", "analyst", "--email", "a@bullmoose.cc", "--dry-run")
	if code != 0 {
		t.Fatalf("dry-run exit %d", code)
	}
	if len(fa2.sawWrites()) != 0 {
		t.Fatalf("--dry-run wrote: %v", fa2.sawWrites())
	}
	if !strings.Contains(errOut, "POST /agent-bindings") || !strings.Contains(errOut, "nothing written") {
		t.Errorf("dry-run must state the plan, got %q", errOut)
	}
}

// ---- remove ----------------------------------------------------------------

// remove defaults to the REVERSIBLE verb. Asserted by the route, because the
// reversible/irreversible distinction IS the route.
func TestAgents_Remove_DefaultsToReversible(t *testing.T) {
	fa := newAdmin()
	fa.add(&fakeBinding{id: "bind_photos", name: "photos", enabled: 1, bookID: "ab_x", queued: 2})
	db := agEnv(t, fa)

	out, errOut, code := runAG(t, db, "remove", "photos")
	if code != 0 {
		t.Fatalf("remove exit %d: %s", code, errOut)
	}
	w := fa.sawWrites()
	if len(w) != 1 {
		t.Fatalf("saw %v", w)
	}
	if w[0].method != "POST" || w[0].path != "/agent-bindings/bind_photos/disable" {
		t.Fatalf("the default must be disable, saw %s %s", w[0].method, w[0].path)
	}
	if !strings.Contains(out, "DISABLED") {
		t.Errorf("out = %q", out)
	}
	if !strings.Contains(errOut, "reversible") {
		t.Errorf("the default must advertise its reversibility, got %q", errOut)
	}
	// The binding still exists.
	if fa.find("bind_photos") == nil {
		t.Fatalf("the default removed the row — that is destroy, not disable")
	}

	// Again with an EMPTY queue, so the route assertion is what bites rather
	// than the server's queued-work 409 short-circuiting first: a `remove` that
	// defaulted to destroy would succeed here and delete the row.
	fa2 := newAdmin()
	fa2.add(&fakeBinding{id: "bind_quiet", name: "quiet", enabled: 1})
	db2 := agEnv(t, fa2)
	if _, errOut, code = runAG(t, db2, "remove", "quiet"); code != 0 {
		t.Fatalf("quiet remove exit %d: %s", code, errOut)
	}
	if w := fa2.sawWrites(); len(w) != 1 || w[0].method != "POST" ||
		w[0].path != "/agent-bindings/bind_quiet/disable" {
		t.Fatalf("the default must be the reversible route even with an empty queue, saw %v", w)
	}
	if fa2.find("bind_quiet") == nil {
		t.Fatalf("the default destroyed a binding with an empty queue")
	}
}

// --destroy needs explicit intent, and says what happens to outstanding
// proposals BEFORE it will run at all.
func TestAgents_Remove_DestroyNeedsIntentAndReportsProposals(t *testing.T) {
	fa := newAdmin()
	fa.add(&fakeBinding{id: "bind_photos", name: "photos", enabled: 1})
	db := agEnv(t, fa)

	_, errOut, code := runAG(t, db, "remove", "photos", "--destroy")
	if code != int(bmio.ExitUsage) {
		t.Fatalf("--destroy without --yes exit %d, want 2", code)
	}
	if len(fa.sawWrites()) != 0 {
		t.Fatalf("--destroy without --yes touched the server: %v", fa.sawWrites())
	}
	for _, want := range []string{"irreversible", "KEPT as audit", "--yes"} {
		if !strings.Contains(errOut, want) {
			t.Errorf("the confirmation prompt must contain %q, got %q", want, errOut)
		}
	}

	out, errOut, code := runAG(t, db, "remove", "photos", "--destroy", "--yes")
	if code != 0 {
		t.Fatalf("destroy exit %d: %s", code, errOut)
	}
	w := fa.sawWrites()
	if w[len(w)-1].method != "DELETE" {
		t.Fatalf("--destroy --yes must DELETE, saw %v", w)
	}
	if !strings.Contains(out, "destroyed") {
		t.Errorf("out = %q", out)
	}
	if !strings.Contains(errOut, "KEPT as audit") {
		t.Errorf("the proposal disposition must be reported on the way out, got %q", errOut)
	}
	if fa.find("bind_photos") != nil {
		t.Fatalf("the binding survived --destroy")
	}

	// --json carries the same disposition, not a bare ok.
	fa2 := newAdmin()
	fa2.add(&fakeBinding{id: "bind_y", name: "y", enabled: 1})
	db2 := agEnv(t, fa2)
	out, _, code = runAG(t, db2, "remove", "y", "--destroy", "--yes", "--json")
	if code != 0 {
		t.Fatalf("json destroy exit %d", code)
	}
	var v map[string]any
	_ = json.Unmarshal([]byte(strings.TrimSpace(out)), &v)
	props, _ := v["proposals"].(map[string]any)
	if props == nil || props["disposition"] != "kept" {
		t.Fatalf("--json must report the proposal disposition, got %v", v)
	}
}

// The server refuses a destroy while work is queued; the CLI surfaces that
// verbatim and points at the reversible verb rather than retrying.
func TestAgents_Remove_DestroyRefusedWhileQueued(t *testing.T) {
	fa := newAdmin()
	fa.add(&fakeBinding{id: "bind_photos", name: "photos", enabled: 1, queued: 4})
	db := agEnv(t, fa)

	_, errOut, code := runAG(t, db, "remove", "photos", "--destroy", "--yes")
	if code != int(bmio.ExitConflict) {
		t.Fatalf("exit %d, want 5 (conflict)", code)
	}
	if !strings.Contains(errOut, "would strand them") {
		t.Errorf("the server's refusal must survive verbatim, got %q", errOut)
	}
	if !strings.Contains(errOut, "agents remove photos") {
		t.Errorf("the refusal must point at the reversible verb, got %q", errOut)
	}
	if fa.find("bind_photos") == nil {
		t.Fatalf("the binding was destroyed despite the refusal")
	}
}

// ---- resolution + configuration -------------------------------------------

func TestAgents_Resolution(t *testing.T) {
	fa := newAdmin()
	fa.add(&fakeBinding{id: "bind_a", accountID: "a_one", name: "photos", enabled: 1})
	fa.add(&fakeBinding{id: "bind_b", accountID: "a_two", name: "photos", enabled: 1})
	db := agEnv(t, fa)

	// Ambiguous: a usage error naming the fix, never a silent pick.
	_, errOut, code := runAG(t, db, "show", "photos")
	if code != int(bmio.ExitUsage) {
		t.Fatalf("ambiguous exit %d, want 2", code)
	}
	if !strings.Contains(errOut, "--email") {
		t.Errorf("ambiguity must name the fix, got %q", errOut)
	}
	// The bare binding id disambiguates.
	if _, _, code = runAG(t, db, "show", "bind_a"); code != 0 {
		t.Fatalf("by-id exit %d", code)
	}
	// Missing is not-found, not a crash.
	if _, _, code = runAG(t, db, "show", "nope"); code != int(bmio.ExitNotFound) {
		t.Fatalf("missing exit %d, want 3", code)
	}
}

// `agents` is a CONTROL-PLANE command: a mirror with only a mail login must be
// told which credential is missing, not shown a 401 from a URL it never had.
func TestAgents_RequiresTheAdminCredential(t *testing.T) {
	db := seedAgentsMirror(t, forbiddenJMAP(t), "", "")
	_, errOut, code := runAG(t, db, "list")
	if code != int(bmio.ExitUsage) {
		t.Fatalf("exit %d, want 2", code)
	}
	if !strings.Contains(errOut, "admin init") {
		t.Errorf("got %q", errOut)
	}
}

func TestAgents_UsageSurface(t *testing.T) {
	db := seedAgentsMirror(t, forbiddenJMAP(t), "http://127.0.0.1:1", "admin-secret")
	if _, _, code := runAG(t, db); code != int(bmio.ExitUsage) {
		t.Fatalf("bare `agents` exit %d, want 2", code)
	}
	if _, errOut, code := runAG(t, db, "frobnicate"); code != int(bmio.ExitUsage) {
		t.Fatalf("unknown verb exit %d, want 2 (%s)", code, errOut)
	}
	// create without --kind is a usage error: a blank config_json editor cannot
	// express the shapes, which is why the kind is mandatory.
	if _, errOut, code := runAG(t, db, "create", "--email", "x@y.z"); code != int(bmio.ExitUsage) {
		t.Fatalf("create without --kind exit %d, want 2 (%s)", code, errOut)
	}
}
