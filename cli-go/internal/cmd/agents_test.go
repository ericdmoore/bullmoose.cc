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
	"sort"
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
	// governedBooks are the books whose write_policy is 'governed' — the only
	// books PATCH accepts as a target. Anything else is the 422 that stops a
	// re-point from silently unbinding the agent.
	governedBooks map[string]bool
	// noAccountFor makes POST /agent-bindings 404 the way the real worker does
	// when the address has no account.
	noAccountFor map[string]bool
	// unsupervised makes the create answer with the s10 T7 refusal shape:
	// the binding lands, but no owner could be established for it.
	unsupervised bool
}

// unsupervised makes POST /agent-bindings answer with the T7 refusal shape.
func newAdmin() *fakeAdmin {
	return &fakeAdmin{
		reportsBook:   true,
		noAccountFor:  map[string]bool{},
		governedBooks: map[string]bool{},
	}
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
		// s10 T7 — the provisioning response now always reports whether the
		// owner got a supervisory grant. `unsupervised` flips it to the refusal
		// shape (ambiguous ownership), which `create` must NOT hide.
		supervision := map[string]any{
			"granted": true, "created": true, "grantId": "g_" + id,
			"scopes": []string{"read", "draft", "send"},
			"owner":  map[string]any{"email": "eric@bullmoose.cc", "accountId": "a_eric"},
		}
		if fa.unsupervised {
			supervision = map[string]any{
				"granted": false,
				"reason":  "tenant t_bm has 2 human principals, so ownership is ambiguous",
			}
		}
		write(200, map[string]any{"ok": true, "bindingId": id, "accountId": "a_eric",
			"watchdog": hasSLA, "supervision": supervision})

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

	// PATCH /agent-bindings/{id} — the typed-core write surface (s10 T4). The
	// fake reproduces the parts of the contract this command depends on: the
	// typed core is the whole accepted body, an unknown key is a 400, a
	// non-governed target book is a 422, and the response reports what changed,
	// what was PRESERVED, and the provenance row a re-point appended.
	case r.Method == "PATCH" && strings.HasPrefix(r.URL.Path, "/agent-bindings/"):
		id := strings.TrimPrefix(r.URL.Path, "/agent-bindings/")
		b := fa.find(id)
		if b == nil {
			write(404, map[string]any{"error": "no agent binding " + id})
			return
		}
		for k := range body {
			switch k {
			case "enabled", "replyMode", "allowedSenders", "recipientsBookId":
			default:
				write(400, map[string]any{
					"error":    "unknown field(s): " + k + ". This route writes the TYPED CORE only",
					"rejected": []string{k},
				})
				return
			}
		}
		var updated []string
		var provenance any
		if v, ok := body["enabled"].(bool); ok {
			was := b.enabled == 1
			if was != v {
				updated = append(updated, "enabled")
			}
			if v {
				b.enabled = 1
			} else {
				b.enabled = 0
			}
		}
		if v, ok := body["replyMode"].(string); ok {
			if b.config == nil {
				b.config = map[string]any{}
			}
			if b.config["replyMode"] != v {
				updated = append(updated, "replyMode")
			}
			b.config["replyMode"] = v
		}
		if v, ok := body["allowedSenders"].([]any); ok {
			if b.config == nil {
				b.config = map[string]any{}
			}
			b.config["allowedSenders"] = v
			updated = append(updated, "allowedSenders")
		}
		if v, present := body["recipientsBookId"]; present {
			next, _ := v.(string)
			// The policy refusal, which is the whole reason a re-point is a
			// server decision: a non-governed book would silently unbind.
			if next != "" && !fa.governedBooks[next] {
				write(422, map[string]any{
					"error": "address book " + next + " has write_policy 'open' — the governing book " +
						"of a binding must be 'governed'",
					"writePolicy": "open", "required": "governed",
				})
				return
			}
			if next != b.bookID {
				updated = append(updated, "recipientsBookId")
				provenance = map[string]any{
					"record": "binding_lifecycle", "event": "recipients-book-changed",
					"from": nilIfEmpty(b.bookID), "to": nilIfEmpty(next),
					"actor": "admin", "viaProposalId": nil, "at": 1_700_000_000_000,
				}
				b.bookID = next
			}
		}
		var preserved []string
		for k := range b.config {
			if k != "replyMode" && k != "allowedSenders" {
				preserved = append(preserved, k)
			}
		}
		sort.Strings(preserved)
		outbound := map[string]any{
			"state": "book", "governingBookId": b.bookID, "failClosed": false,
			"note": "membership is resolved server-side on every send",
		}
		if b.bookID == "" {
			outbound = map[string]any{
				"state": "none", "governingBookId": nil, "failClosed": true,
				"note": "FAIL-CLOSED: with no governing book this binding CANNOT SEND",
			}
		}
		write(200, map[string]any{
			"ok": true, "bindingId": b.id, "accountId": b.accountID, "name": b.name,
			"changed": len(updated) > 0, "updated": updated,
			"enabled": b.enabled == 1, "replyMode": b.config["replyMode"],
			"allowedSenders": b.config["allowedSenders"],
			"outbound":       outbound, "preserved": preserved, "provenance": provenance,
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

// A real book id gets past the client-side invariant and is WRITTEN, through
// the one route that can write it. End-to-end: the request carries the typed
// core, the fake applies it, and the operator is told what changed — including
// the provenance row a re-point appended, which is the half of the s10 T2
// argument a config surface is most tempted to leave silent.
func TestAgents_Edit_RecipientsBookGoesThroughThePatchRoute(t *testing.T) {
	fa := newAdmin()
	fa.governedBooks["ab_next"] = true
	fa.add(&fakeBinding{id: "bind_photos", name: "photos", enabled: 1, bookID: "ab_invitees",
		config: map[string]any{"replyMode": "draft", "persona": "you are photos", "pipeline": "reply"}})
	db := agEnv(t, fa)

	out, errOut, code := runAG(t, db, "edit", "photos", "--recipients-book", "ab_next")
	if code != 0 {
		t.Fatalf("edit exit %d: %s", code, errOut)
	}
	w := fa.sawWrites()
	if len(w) != 1 || w[0].method != "PATCH" || w[0].path != "/agent-bindings/bind_photos" {
		t.Fatalf("the book write must be one PATCH, saw %v", w)
	}
	if got := w[0].body["recipientsBookId"]; got != "ab_next" {
		t.Fatalf("recipientsBookId = %v", got)
	}
	// The typed core and NOTHING else: a body carrying a blob key would be a
	// blind merge, which the route refuses and this command must never attempt.
	for k := range w[0].body {
		switch k {
		case "enabled", "replyMode", "allowedSenders", "recipientsBookId":
		default:
			t.Fatalf("edit sent a non-typed-core key %q: %v", k, w[0].body)
		}
	}
	if fa.find("bind_photos").bookID != "ab_next" {
		t.Fatalf("the server did not move the bound")
	}
	if !strings.Contains(out, "updated: recipientsBookId") {
		t.Errorf("out = %q", out)
	}
	// The provenance row is REPORTED, old→new both legible.
	if !strings.Contains(errOut, "provenance appended") ||
		!strings.Contains(errOut, "book:ab_invitees") || !strings.Contains(errOut, "book:ab_next") {
		t.Errorf("a re-point must report its provenance row with old→new, got %q", errOut)
	}
	// And the untouched blob is named, so "the remainder survived" is something
	// the operator can see rather than something they have to trust.
	if !strings.Contains(errOut, "persona") || !strings.Contains(errOut, "pipeline") {
		t.Errorf("the preserved remainder must be reported, got %q", errOut)
	}
}

// replyMode and allowedSenders take the same route, and the allowlist REPLACES
// rather than appends — an `edit` that appended could never remove an address.
func TestAgents_Edit_ReplyModeAndSendersGoThroughThePatchRoute(t *testing.T) {
	fa := newAdmin()
	fa.add(&fakeBinding{id: "bind_photos", name: "photos", enabled: 1, bookID: "ab_invitees",
		config: map[string]any{"replyMode": "draft", "allowedSenders": []any{"old@x.test"}, "persona": "p"}})
	db := agEnv(t, fa)

	out, errOut, code := runAG(t, db, "edit", "photos",
		"--reply-mode", "send", "--allow-sender", "bob@example.com,kid@school.test")
	if code != 0 {
		t.Fatalf("edit exit %d: %s", code, errOut)
	}
	w := fa.sawWrites()
	if len(w) != 1 || w[0].method != "PATCH" {
		t.Fatalf("saw %v", w)
	}
	if w[0].body["replyMode"] != "send" {
		t.Errorf("replyMode = %v", w[0].body["replyMode"])
	}
	senders, _ := w[0].body["allowedSenders"].([]any)
	if len(senders) != 2 || senders[0] != "bob@example.com" || senders[1] != "kid@school.test" {
		t.Fatalf("allowedSenders = %v — the list is REPLACED, comma-split and repeatable", senders)
	}
	if !strings.Contains(errOut, "REPLACED") {
		t.Errorf("the replace semantics must be said out loud, got %q", errOut)
	}
	if !strings.Contains(out, "replyMode") || !strings.Contains(out, "allowedSenders") {
		t.Errorf("out = %q", out)
	}
	// The remainder is still there afterwards: this command never merges a blob.
	if fa.find("bind_photos").config["persona"] != "p" {
		t.Fatalf("the remainder did not survive the edit: %v", fa.find("bind_photos").config)
	}
}

// The server's policy refusal reaches the operator verbatim, and nothing moved.
// This is the invariant the CLI cannot check itself: whether the named book is
// really `write_policy = 'governed'` is a question only the store can answer.
func TestAgents_Edit_NonGovernedBookIsRefusedByTheServer(t *testing.T) {
	fa := newAdmin()
	fa.add(&fakeBinding{id: "bind_photos", name: "photos", enabled: 1, bookID: "ab_invitees"})
	db := agEnv(t, fa)

	_, errOut, code := runAG(t, db, "edit", "photos", "--recipients-book", "ab_open")
	if code != int(bmio.ExitUsage) {
		t.Fatalf("exit %d, want %d (the 422 taxonomy) — %s", code, bmio.ExitUsage, errOut)
	}
	if !strings.Contains(errOut, "write_policy") || !strings.Contains(errOut, "governed") {
		t.Errorf("the server's policy sentence must survive verbatim, got %q", errOut)
	}
	if fa.find("bind_photos").bookID != "ab_invitees" {
		t.Fatalf("a refused re-point moved the bound anyway")
	}
}

// A combined edit is ONE call. Two calls could half-apply — the enable landing
// and the config write failing — and leave a binding in a state no operator
// asked for.
func TestAgents_Edit_CombinedFieldsAreOnePatch(t *testing.T) {
	fa := newAdmin()
	fa.add(&fakeBinding{id: "bind_photos", name: "photos", enabled: 0, bookID: "ab_invitees",
		config: map[string]any{"replyMode": "draft"}})
	db := agEnv(t, fa)

	if _, errOut, code := runAG(t, db, "edit", "photos", "--enabled", "true", "--reply-mode", "send"); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	w := fa.sawWrites()
	if len(w) != 1 || w[0].method != "PATCH" {
		t.Fatalf("a combined edit must be exactly one PATCH, saw %v", w)
	}
	if w[0].body["enabled"] != true || w[0].body["replyMode"] != "send" {
		t.Fatalf("body = %v", w[0].body)
	}
	if b := fa.find("bind_photos"); b.enabled != 1 || b.config["replyMode"] != "send" {
		t.Fatalf("both fields must land: %+v", b)
	}
}

// Fields the operator did not name are ABSENT from the body. Re-sending what
// the list last returned is how a stale view silently reverts another writer.
func TestAgents_Edit_SendsOnlyTheNamedFields(t *testing.T) {
	fa := newAdmin()
	fa.add(&fakeBinding{id: "bind_photos", name: "photos", enabled: 1, bookID: "ab_invitees",
		config: map[string]any{"replyMode": "draft", "allowedSenders": []any{"eric@bullmoose.cc"}}})
	db := agEnv(t, fa)

	if _, errOut, code := runAG(t, db, "edit", "photos", "--reply-mode", "send"); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	body := fa.sawWrites()[0].body
	if len(body) != 1 {
		t.Fatalf("only the named field may be sent, got %v", body)
	}
	for _, unasked := range []string{"enabled", "allowedSenders", "recipientsBookId"} {
		if _, present := body[unasked]; present {
			t.Errorf("edit re-sent %q it was not asked to change: %v", unasked, body)
		}
	}
}

// Nothing to edit is a usage error, not a no-op PATCH: an empty body is a
// request the server would (rightly) 400, and the CLI can say so for free.
func TestAgents_Edit_NothingToEditIsRefusedBeforeTheNetwork(t *testing.T) {
	fa := newAdmin()
	fa.add(&fakeBinding{id: "bind_photos", name: "photos", enabled: 1, bookID: "ab_invitees"})
	db := agEnv(t, fa)

	_, errOut, code := runAG(t, db, "edit", "photos")
	if code != int(bmio.ExitUsage) {
		t.Fatalf("exit %d, want 2", code)
	}
	if len(fa.sawWrites()) != 0 {
		t.Fatalf("an empty edit reached the server: %v", fa.sawWrites())
	}
	if !strings.Contains(errOut, "--recipients-book") || !strings.Contains(errOut, "--reply-mode") {
		t.Errorf("the usage line must name the fields that DO work, got %q", errOut)
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

// s10 T7 — `create` says whether the agent's owner can SEE what it proposes.
// A silent "supervision: none" is the whole bug: the agent runs, queues work,
// and nobody's /approvals shows it.
func TestAgents_Create_ReportsSupervision(t *testing.T) {
	fa := newAdmin()
	db := agEnv(t, fa)
	out, errOut, code := runAG(t, db, "create", "--kind", "photos", "--email", "photos@bullmoose.cc", "--json")
	if code != 0 {
		t.Fatalf("create exit %d: %s", code, errOut)
	}
	var got struct {
		Supervision struct {
			Granted bool     `json:"granted"`
			Owner   string   `json:"owner"`
			Scopes  []string `json:"scopes"`
		} `json:"supervision"`
	}
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("create --json: %v (%s)", err, out)
	}
	if !got.Supervision.Granted || got.Supervision.Owner != "eric@bullmoose.cc" {
		t.Errorf("--json must report who supervises the agent: %+v", got.Supervision)
	}
	if strings.Join(got.Supervision.Scopes, "+") != "read+draft+send" {
		t.Errorf("supervisory scopes = %v", got.Supervision.Scopes)
	}

	// The refusal shape: loud, with the fix, and never mistakeable for success.
	fa2 := newAdmin()
	fa2.unsupervised = true
	db2 := agEnv(t, fa2)
	_, errOut, code = runAG(t, db2, "create", "--kind", "photos", "--email", "photos@bullmoose.cc")
	if code != 0 {
		t.Fatalf("create exit %d: %s", code, errOut)
	}
	for _, want := range []string{"supervision:    NONE", "ambiguous", "/supervisor"} {
		if !strings.Contains(errOut, want) {
			t.Errorf("an unsupervised create must say %q:\n%s", want, errOut)
		}
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
