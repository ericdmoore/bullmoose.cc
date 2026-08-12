package cmd

// `approvals` is GO-NATIVE with no Node twin, so it gets its OWN Go tests against
// a FAKE JMAP server — not a Node-parity check. The fake reproduces the relevant
// slice of ActionProposal/{query,get,set} (services/jmap/src/methods/actionProposal.ts)
// including the tier logic, so every honesty rule is exercised end to end
// (store → jmap → server) without a live server.

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
	"time"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
)

// ---- fake JMAP server -----------------------------------------------------

const day = int64(24 * 60 * 60 * 1000)

type fakeProp struct {
	id, kind, agent, status, rationale         string
	tier                                       int
	payload, editedPayload, subject, decision  map[string]any
	evidence                                   []any
	createdAt, decidedAt, holdUntil, expiresAt int64 // ms; 0 == null
}

type fakeServer struct {
	mu      sync.Mutex
	props   map[string]*fakeProp
	hasSend bool         // does the caller's token carry the send capability?
	sets    []setCapture // every update patch, for asserting what the CLI sent
	egress  int          // tier-3 relays performed
}

type setCapture struct {
	id    string
	patch map[string]any
}

func newFake(hasSend bool) *fakeServer {
	return &fakeServer{props: map[string]*fakeProp{}, hasSend: hasSend}
}

func (fs *fakeServer) start(t *testing.T) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(fs.handle))
	t.Cleanup(srv.Close)
	return srv
}

func (fs *fakeServer) add(p *fakeProp) {
	if p.status == "" {
		p.status = "pending"
	}
	if p.agent == "" {
		p.agent = "emily"
	}
	if p.createdAt == 0 {
		p.createdAt = time.Now().UnixMilli() - 60_000
	}
	fs.props[p.id] = p
}

func (fs *fakeServer) handle(w http.ResponseWriter, r *http.Request) {
	if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
		http.Error(w, `{"type":"unauthorized"}`, 401)
		return
	}
	// methodCalls is [name, args, callId]; decode loosely.
	var raw struct {
		MethodCalls [][]json.RawMessage `json:"methodCalls"`
	}
	_ = json.NewDecoder(r.Body).Decode(&raw)

	fs.mu.Lock()
	defer fs.mu.Unlock()

	// prior maps callId → result args, for resolving `#ids` back-references.
	prior := map[string]map[string]any{}
	out := make([]any, 0, len(raw.MethodCalls))

	for _, mc := range raw.MethodCalls {
		var name, callID string
		var args map[string]any
		_ = json.Unmarshal(mc[0], &name)
		_ = json.Unmarshal(mc[1], &args)
		_ = json.Unmarshal(mc[2], &callID)

		var result map[string]any
		switch name {
		case "ActionProposal/query":
			result = fs.query(args)
		case "ActionProposal/get":
			result = fs.get(args, prior)
		case "ActionProposal/set":
			result = fs.set(args)
		default:
			result = map[string]any{"error": "unknownMethod"}
		}
		prior[callID] = result
		out = append(out, []any{name, result, callID})
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"methodResponses": out})
}

func (fs *fakeServer) query(args map[string]any) map[string]any {
	want := ""
	if f, ok := args["filter"].(map[string]any); ok {
		want, _ = f["status"].(string)
	}
	var ids []string
	// Newest-first by createdAt, as actionProposal.ts:156.
	for _, p := range fs.sortedByCreatedDesc() {
		if want == "" || p.status == want {
			ids = append(ids, p.id)
		}
	}
	return map[string]any{"ids": ids, "queryState": "s1", "position": 0, "canCalculateChanges": false}
}

// get resolves ids either explicitly (args.ids) or from a `#ids` back-reference
// against a prior response's /ids — the same resolution dispatch.ts does.
func (fs *fakeServer) get(args map[string]any, prior map[string]map[string]any) map[string]any {
	var ids []string
	if ref, ok := args["#ids"].(map[string]any); ok {
		resultOf, _ := ref["resultOf"].(string)
		if src, ok := prior[resultOf]; ok {
			if arr, ok := src["ids"].([]string); ok {
				ids = arr
			}
		}
	} else if arr, ok := args["ids"].([]any); ok {
		for _, v := range arr {
			if s, ok := v.(string); ok {
				ids = append(ids, s)
			}
		}
	}
	var list, notFound []any
	for _, id := range ids {
		if p, ok := fs.props[id]; ok {
			list = append(list, p.toJMAP())
		} else {
			notFound = append(notFound, id)
		}
	}
	return map[string]any{"accountId": args["accountId"], "state": "s1", "list": list, "notFound": notFound}
}

func (fs *fakeServer) set(args map[string]any) map[string]any {
	updated := map[string]any{}
	notUpdated := map[string]any{}
	update, _ := args["update"].(map[string]any)
	for id, raw := range update {
		patch, _ := raw.(map[string]any)
		fs.sets = append(fs.sets, setCapture{id: id, patch: patch})
		if ok, se := fs.applySet(id, patch); ok {
			updated[id] = nil
		} else {
			notUpdated[id] = se
		}
	}
	return map[string]any{
		"accountId": args["accountId"], "oldState": "s1", "newState": "s2",
		"created": map[string]any{}, "notCreated": map[string]any{},
		"updated": updated, "notUpdated": notUpdated,
		"destroyed": []any{}, "notDestroyed": map[string]any{},
	}
}

// applySet mirrors the tier logic of actionProposal.ts's set (approve/reject).
func (fs *fakeServer) applySet(id string, patch map[string]any) (bool, map[string]any) {
	p, ok := fs.props[id]
	if !ok {
		return false, map[string]any{"type": "notFound"}
	}
	if p.status != "pending" {
		return false, map[string]any{"type": "invalidProperties",
			"description": "proposal is " + p.status + ", not pending"}
	}
	status, _ := patch["status"].(string)
	if status != "approved" && status != "rejected" {
		return false, map[string]any{"type": "invalidProperties",
			"description": `status must be "approved" or "rejected"`}
	}

	var edited map[string]any
	if ep, present := patch["editedPayload"]; present {
		m, ok := ep.(map[string]any)
		if !ok {
			return false, map[string]any{"type": "invalidProperties", "description": "editedPayload must be an object"}
		}
		edited = m
	}

	decision := map[string]any{"by": "eric@login.example"}
	if d, present := patch["decision"]; present {
		dm, _ := d.(map[string]any)
		if r, ok := dm["reason"]; ok {
			rs, _ := r.(string)
			if !rejectReasons[rs] {
				return false, map[string]any{"type": "invalidProperties",
					"description": "decision.reason must be wrongContent | wrongAction | notNow"}
			}
			decision["reason"] = rs
		}
		if n, ok := dm["note"]; ok {
			decision["note"] = n
		}
	}

	now := time.Now().UnixMilli()
	if status == "rejected" {
		p.status = "rejected"
		p.decidedAt = now
		p.decision = decision
		if edited != nil {
			p.editedPayload = edited
		}
		return true, nil
	}

	// approve
	if p.tier == 3 && !fs.hasSend {
		// THE CAPABILITY WALL (actionProposal.ts:252-266): an agent/insufficient
		// token cannot auto-commit irreversible egress.
		return false, map[string]any{"type": "forbidden",
			"description": "approving a tier-3 proposal requires the send capability (a human action); " +
				"an agent token cannot auto-commit irreversible egress"}
	}
	if edited != nil {
		p.editedPayload = edited
	}
	p.decision = decision
	p.decidedAt = now
	if p.tier == 2 {
		p.status = "held"
		p.holdUntil = now + 5*60_000
		return true, nil // nothing egresses — the hold tray (s03.D T2)
	}
	p.status = "approved"
	if p.tier == 3 && (p.kind == "reply-draft" || p.kind == "start-thread") {
		fs.egress++
	}
	if p.tier == 1 {
		decision["undo"] = map[string]any{"action": "destroy-contact"}
	}
	return true, nil
}

func (fs *fakeServer) sortedByCreatedDesc() []*fakeProp {
	out := make([]*fakeProp, 0, len(fs.props))
	for _, p := range fs.props {
		out = append(out, p)
	}
	for i := 0; i < len(out); i++ {
		for j := i + 1; j < len(out); j++ {
			if out[j].createdAt > out[i].createdAt {
				out[i], out[j] = out[j], out[i]
			}
		}
	}
	return out
}

func (p *fakeProp) toJMAP() map[string]any {
	return map[string]any{
		"id": p.id, "agent": p.agent, "kind": p.kind, "tier": p.tier,
		"subject": orEmptyMap(p.subject), "payload": orEmptyMap(p.payload),
		"editedPayload":    nilableMap(p.editedPayload),
		"rationale":        p.rationale,
		"evidence":         orEmptyArr(p.evidence),
		"status":           p.status,
		"decision":         nilableMap(p.decision),
		"createdAt":        isoOrNull(p.createdAt),
		"decidedAt":        isoOrNull(p.decidedAt),
		"holdUntil":        isoOrNull(p.holdUntil),
		"expiresAt":        isoOrNull(p.expiresAt),
		"invocationStatus": "done",
		"claimedAt":        nil,
	}
}

func orEmptyMap(m map[string]any) map[string]any {
	if m == nil {
		return map[string]any{}
	}
	return m
}
func nilableMap(m map[string]any) any {
	if m == nil {
		return nil
	}
	return m
}
func orEmptyArr(a []any) []any {
	if a == nil {
		return []any{}
	}
	return a
}
func isoOrNull(ms int64) any {
	if ms == 0 {
		return nil
	}
	return time.UnixMilli(ms).UTC().Format("2006-01-02T15:04:05.000Z07:00")
}

// ---- mirror seed + runner -------------------------------------------------

func seedMirror(t *testing.T, base, token, accountID string) string {
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
		if _, err := db.Exec(`INSERT INTO config(key,value) VALUES(?,?)`, k, v); err != nil {
			t.Fatalf("insert %s: %v", k, err)
		}
	}
	ins("base", base)
	ins("token", token)
	ins("accountId", accountID)
	ins("accounts", fmt.Sprintf(`[{"accountId":%q,"address":"eric@bullmoose.cc","name":"Eric"}]`, accountID))
	return path
}

// runAP invokes the command with captured streams and an appended --db.
func runAP(t *testing.T, dbPath string, args ...string) (out, errOut string, code int) {
	t.Helper()
	var o, e strings.Builder
	s := bmio.NewTo(&o, &e)
	argv := append([]string{"approvals"}, args...)
	argv = append(argv, "--db", dbPath)
	code = runApprovals(s, argv)
	return o.String(), e.String(), code
}

func newEnv(t *testing.T, fs *fakeServer, hasSendToken bool) string {
	srv := fs.start(t)
	tok := "bm_agent"
	if hasSendToken {
		tok = "bm_human"
	}
	return seedMirror(t, srv.URL, tok, "a_eric")
}

// ---- tests ----------------------------------------------------------------

// list renders the pending queue ordered by urgency, and keeps the two clocks
// distinct in the table (exp for pending, hold for held).
func TestApprovals_List(t *testing.T) {
	now := time.Now().UnixMilli()
	fs := newFake(true)
	fs.add(&fakeProp{id: "later", kind: "reply-draft", tier: 2, rationale: "second", createdAt: now - 2*60_000, expiresAt: now + 2*day})
	fs.add(&fakeProp{id: "soon", kind: "create-contact", tier: 1, rationale: "first", createdAt: now - 1*60_000, expiresAt: now + 1*day})
	fs.add(&fakeProp{id: "aheld", kind: "reply-draft", tier: 2, status: "held", createdAt: now - 3*60_000, decidedAt: now - 60_000, holdUntil: now + 4*60_000, expiresAt: now + 2*day})
	db := newEnv(t, fs, true)

	// default (pending only), --ids → urgency order: soon before later.
	out, _, code := runAP(t, db, "list", "--ids")
	if code != 0 {
		t.Fatalf("list --ids exit %d", code)
	}
	if got := strings.Fields(out); len(got) != 2 || got[0] != "soon" || got[1] != "later" {
		t.Fatalf("pending --ids = %v, want [soon later]", got)
	}

	// --status all shows the held row too; the table must show hold:/exp: distinctly.
	out, _, code = runAP(t, db, "list", "--status", "all")
	if code != 0 {
		t.Fatalf("list all exit %d", code)
	}
	var heldLine, pendLine string
	for _, ln := range strings.Split(strings.TrimRight(out, "\n"), "\n") {
		if strings.HasPrefix(ln, "held") {
			heldLine = ln
		}
		if strings.HasPrefix(ln, "pending") && strings.Contains(ln, "soon") {
			pendLine = ln
		}
	}
	if !strings.Contains(heldLine, "hold:") || strings.Contains(heldLine, "exp:") {
		t.Errorf("held row must show hold: and not exp:, got %q", heldLine)
	}
	if !strings.Contains(pendLine, "exp:") || strings.Contains(pendLine, "hold:") {
		t.Errorf("pending row must show exp: and not hold:, got %q", pendLine)
	}

	// --json emits the raw proposals.
	out, _, code = runAP(t, db, "list", "--json")
	if code != 0 {
		t.Fatalf("list --json exit %d", code)
	}
	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
	if len(lines) != 2 {
		t.Fatalf("list --json lines = %d, want 2", len(lines))
	}
	var first map[string]any
	_ = json.Unmarshal([]byte(lines[0]), &first)
	if first["id"] != "soon" || first["tier"].(float64) != 1 {
		t.Errorf("first json row = %s", lines[0])
	}
}

// approving a tier-1 marks it approved and applied.
func TestApprovals_ApproveTier1(t *testing.T) {
	fs := newFake(true)
	fs.add(&fakeProp{id: "c1", kind: "create-contact", tier: 1, payload: map[string]any{"card": map[string]any{"name": "x"}}})
	db := newEnv(t, fs, true)

	out, _, code := runAP(t, db, "approve", "c1")
	if code != 0 {
		t.Fatalf("approve exit %d (%s)", code, out)
	}
	if !strings.Contains(out, "approved and applied") {
		t.Errorf("tier-1 approve output = %q", out)
	}
	if fs.props["c1"].status != "approved" {
		t.Errorf("status = %s, want approved", fs.props["c1"].status)
	}
}

// approving a tier-2 reports HELD and never claims egress.
func TestApprovals_ApproveTier2_Held(t *testing.T) {
	fs := newFake(true)
	fs.add(&fakeProp{id: "r2", kind: "reply-draft", tier: 2, payload: map[string]any{"to": "x@y.z"}})
	db := newEnv(t, fs, true)

	out, _, code := runAP(t, db, "approve", "r2")
	if code != 0 {
		t.Fatalf("approve exit %d", code)
	}
	if !strings.Contains(out, "HELD") || !strings.Contains(out, "nothing was sent") {
		t.Errorf("tier-2 approve must report HELD + nothing sent, got %q", out)
	}
	for _, forbidden := range []string{"RELAYED", "and applied", " sent "} {
		if strings.Contains(out, forbidden) {
			t.Errorf("tier-2 output must not imply egress, contains %q: %q", forbidden, out)
		}
	}
	if fs.props["r2"].status != "held" || fs.egress != 0 {
		t.Errorf("tier-2: status=%s egress=%d, want held/0", fs.props["r2"].status, fs.egress)
	}
}

// a tier-3 approve with an insufficient token surfaces the server's `forbidden`
// verbatim and exits 4; with the send capability it relays and marks approved.
func TestApprovals_ApproveTier3_CapabilityWall(t *testing.T) {
	// insufficient (agent) token → forbidden, exit 4, nothing relayed.
	fsNo := newFake(false)
	fsNo.add(&fakeProp{id: "e3", kind: "reply-draft", tier: 3, payload: map[string]any{"to": "out@x.z", "self": "me@b.cc", "blobId": "b1"}})
	dbNo := newEnv(t, fsNo, false)

	out, errOut, code := runAP(t, dbNo, "approve", "e3")
	if code != int(bmio.ExitAuth) {
		t.Fatalf("tier-3 refusal exit = %d, want %d (auth)", code, bmio.ExitAuth)
	}
	if !strings.Contains(errOut, "forbidden") || !strings.Contains(errOut, "send capability") {
		t.Errorf("must surface the server's forbidden sentence, got stderr=%q stdout=%q", errOut, out)
	}
	if fsNo.egress != 0 || fsNo.props["e3"].status != "pending" {
		t.Errorf("refused tier-3 must not egress; status=%s egress=%d", fsNo.props["e3"].status, fsNo.egress)
	}

	// human token (send scope) → relays once, approved.
	fsYes := newFake(true)
	fsYes.add(&fakeProp{id: "e3", kind: "reply-draft", tier: 3, payload: map[string]any{"to": "out@x.z", "self": "me@b.cc", "blobId": "b1"}})
	dbYes := newEnv(t, fsYes, true)

	out, _, code = runAP(t, dbYes, "approve", "e3")
	if code != 0 {
		t.Fatalf("human tier-3 approve exit %d", code)
	}
	if !strings.Contains(out, "RELAYED") {
		t.Errorf("human tier-3 approve = %q, want RELAYED", out)
	}
	if fsYes.egress != 1 || fsYes.props["e3"].status != "approved" {
		t.Errorf("human tier-3: status=%s egress=%d, want approved/1", fsYes.props["e3"].status, fsYes.egress)
	}
}

// edit sends editedPayload for a real change and NONE for a no-op.
func TestApprovals_Edit_DiffAndNoOp(t *testing.T) {
	// real edit
	fs := newFake(true)
	fs.add(&fakeProp{id: "d1", kind: "reply-draft", tier: 2,
		payload: map[string]any{"to": "x@y.z", "subject": "Re: t", "text": "agent draft", "blobId": "b1"}})
	db := newEnv(t, fs, true)

	out, _, code := runAP(t, db, "edit", "d1", "--body", "a human rewrite")
	if code != 0 {
		t.Fatalf("edit exit %d", code)
	}
	if !strings.Contains(out, "HELD") || !strings.Contains(out, "after edit") {
		t.Errorf("edited tier-2 approve = %q, want HELD (after edit)", out)
	}
	last := fs.sets[len(fs.sets)-1]
	ep, present := last.patch["editedPayload"].(map[string]any)
	if !present {
		t.Fatalf("a real edit must send editedPayload, patch=%v", last.patch)
	}
	if ep["text"] != "a human rewrite" || ep["blobId"] != "b1" {
		t.Errorf("editedPayload must carry the new text and preserve blobId, got %v", ep)
	}
	if _, wrote := last.patch["payload"]; wrote {
		t.Error("edit must NEVER send payload — the server retains the original")
	}

	// no-op edit: same text, no --subject → NO editedPayload.
	fs2 := newFake(true)
	fs2.add(&fakeProp{id: "d2", kind: "reply-draft", tier: 2,
		payload: map[string]any{"to": "x@y.z", "subject": "Re: t", "text": "agent draft", "blobId": "b1"}})
	db2 := newEnv(t, fs2, true)

	out, errOut, code := runAP(t, db2, "edit", "d2", "--body", "agent draft")
	if code != 0 {
		t.Fatalf("no-op edit exit %d", code)
	}
	if _, present := fs2.sets[len(fs2.sets)-1].patch["editedPayload"]; present {
		t.Error("a no-op edit must NOT send editedPayload — 'approved clean' is not 'approved after edit'")
	}
	if !strings.Contains(errOut, "no changes") {
		t.Errorf("no-op edit should note 'no changes', stderr=%q", errOut)
	}
	if strings.Contains(out, "after edit") {
		t.Errorf("no-op edit must not say 'after edit', got %q", out)
	}
}

// declining records the reason enum and note.
func TestApprovals_Decline(t *testing.T) {
	fs := newFake(true)
	fs.add(&fakeProp{id: "j1", kind: "reply-draft", tier: 2})
	db := newEnv(t, fs, true)

	out, _, code := runAP(t, db, "decline", "j1", "--reason", "wrongContent", "--note", "off tone")
	if code != 0 {
		t.Fatalf("decline exit %d", code)
	}
	if !strings.Contains(out, "declined") || !strings.Contains(out, "wrongContent") {
		t.Errorf("decline output = %q", out)
	}
	d := fs.props["j1"].decision
	if fs.props["j1"].status != "rejected" || d["reason"] != "wrongContent" || d["note"] != "off tone" {
		t.Errorf("decline record = status %s decision %v", fs.props["j1"].status, d)
	}

	// a bad reason is a client-side usage error (exit 2), no round trip.
	fs2 := newFake(true)
	fs2.add(&fakeProp{id: "j2", kind: "reply-draft", tier: 2})
	db2 := newEnv(t, fs2, true)
	_, _, code = runAP(t, db2, "decline", "j2", "--reason", "meh")
	if code != int(bmio.ExitUsage) {
		t.Errorf("bad --reason exit = %d, want %d (usage)", code, bmio.ExitUsage)
	}
	if len(fs2.sets) != 0 {
		t.Error("a client-side usage error must not reach the server")
	}
}

// show prints the full proposal; --json is the raw object.
func TestApprovals_Show(t *testing.T) {
	fs := newFake(true)
	fs.add(&fakeProp{id: "s1", kind: "reply-draft", tier: 2, rationale: "drafted a reply",
		subject:  map[string]any{"realm": "Email", "objectId": "e_1"},
		evidence: []any{map[string]any{"realm": "Email", "objectId": "e_1", "note": "the thread"}},
		payload:  map[string]any{"to": "x@y.z", "text": "hi"}})
	db := newEnv(t, fs, true)

	out, _, code := runAP(t, db, "show", "s1")
	if code != 0 {
		t.Fatalf("show exit %d", code)
	}
	for _, want := range []string{"drafted a reply", "evidence:", "tier 2", "reply-draft"} {
		if !strings.Contains(out, want) {
			t.Errorf("show output missing %q:\n%s", want, out)
		}
	}

	out, _, code = runAP(t, db, "show", "s1", "--json")
	if code != 0 {
		t.Fatalf("show --json exit %d", code)
	}
	var raw map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(out)), &raw); err != nil {
		t.Fatalf("show --json not a single object: %v", err)
	}
	if raw["id"] != "s1" || raw["rationale"] != "drafted a reply" {
		t.Errorf("show --json = %s", out)
	}

	// a missing id is NotFound (exit 3).
	_, _, code = runAP(t, db, "show", "nope")
	if code != int(bmio.ExitNotFound) {
		t.Errorf("show missing exit = %d, want %d", code, bmio.ExitNotFound)
	}
}
