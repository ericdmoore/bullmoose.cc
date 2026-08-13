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
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/proposal"
)

// ---- fake JMAP server -----------------------------------------------------

const day = int64(24 * 60 * 60 * 1000)

type fakeProp struct {
	id, kind, agent, status, rationale         string
	tier                                       int
	payload, editedPayload, subject, decision  map[string]any
	evidence                                   []any
	createdAt, decidedAt, holdUntil, expiresAt int64 // ms; 0 == null
	// needsInfo (s10 T3): the open question, the append-only Q&A rounds, and the
	// banked remainder of the paused pre-decision clock. `expiresRemainingMs` is
	// -1 for the wire's null, because 0 is a real banked value (deadline reached).
	question           string
	amendments         []any
	expiresRemainingMs int64
}

type fakeServer struct {
	mu      sync.Mutex
	props   map[string]*fakeProp
	hasSend bool         // does the caller's token carry the send capability?
	sets    []setCapture // every update patch, for asserting what the CLI sent
	egress  int          // tier-3 relays performed
	// answer-info-request invocations enqueued — the costed round a needsInfo
	// creates (actionProposal.ts). Zero for every other verb.
	answerInvocations int
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
	if p.expiresRemainingMs == 0 {
		p.expiresRemainingMs = -1 // null: no round has paused this row's clock
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
	if status != "approved" && status != "rejected" && status != "info-requested" {
		return false, map[string]any{"type": "invalidProperties",
			"description": `status must be "approved", "rejected" or "info-requested"`}
	}

	// ---- needsInfo (s10 T3), mirroring actionProposal.ts's branch ----
	if status == "info-requested" {
		if _, has := patch["decision"]; has {
			return false, map[string]any{"type": "invalidProperties",
				"description": "needsInfo carries only a question — no decision (it is not a reject) and no editedPayload"}
		}
		if _, has := patch["editedPayload"]; has {
			return false, map[string]any{"type": "invalidProperties",
				"description": "needsInfo carries only a question — no decision (it is not a reject) and no editedPayload"}
		}
		q, _ := patch["question"].(string)
		q = strings.TrimSpace(q)
		if q == "" {
			return false, map[string]any{"type": "invalidProperties",
				"description": "needsInfo requires a non-empty human-authored question"}
		}
		now := time.Now().UnixMilli()
		p.status = "info-requested"
		p.question = q
		// PAUSE: bank the remaining window, null the deadline. The row cannot
		// lapse while the ball is in the agent's court.
		if p.expiresAt != 0 {
			p.expiresRemainingMs = max64(0, p.expiresAt-now)
		}
		p.expiresAt = 0
		// APPEND the open round — never over the originals.
		p.amendments = append(p.amendments, map[string]any{
			"question": q, "answer": nil,
			"askedAt": isoOrNull(now), "answeredAt": nil, "askedBy": "eric@login.example",
		})
		// The answer round is a NEW costed invocation; the CLI never sees it, but
		// counting it here proves the verb went down the needsInfo path and not
		// through a decision.
		fs.answerInvocations++
		return true, nil
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
					"description": "decision.reason must be wrongContent | wrongAction | unsafe"}
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

// toJMAP is proposalToJmap (actionProposal.ts:845) — every field the server
// projects, including the needsInfo pair, so `--json` is asserted against the
// shape the CLI will really meet.
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
		"dueAt":            nil,
		"question":         strOrNull(p.question),
		"amendments":       orEmptyArr(p.amendments),
		"invocationStatus": "done",
		"claimedAt":        nil,
	}
}

func strOrNull(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func max64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

// round builds one Q&A amendment as the server stores it; answer "" is the open
// (still owed) round.
func round(question, answer, askedBy string, askedAt, answeredAt int64) map[string]any {
	m := map[string]any{
		"question": question, "answer": nil,
		"askedAt": isoOrNull(askedAt), "answeredAt": nil, "askedBy": askedBy,
	}
	if answer != "" {
		m["answer"] = answer
		m["answeredAt"] = isoOrNull(answeredAt)
	}
	return m
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

// ---- needsInfo (s10 T3) ---------------------------------------------------
//
// The third verb is an ACTION, not a reject (decline-taxonomy.md). These tests
// hold the two halves of that sentence: what it SENDS (a question and nothing
// else — no decision, so no rejection record a learning pipeline could read as
// negative feedback), and what it never becomes (a `--reason`).

// The happy path: the exact request body, the paused clock, and the outcome
// worded as a question rather than a verdict.
func TestApprovals_NeedsInfo_HappyPath(t *testing.T) {
	now := time.Now().UnixMilli()
	fs := newFake(true)
	fs.add(&fakeProp{id: "g1", kind: "grant-request", tier: 2, rationale: "let me email bob@",
		expiresAt: now + 2*day})
	db := newEnv(t, fs, true)

	out, errOut, code := runAP(t, db, "needs-info", "g1", "--question", "  why does bob@ need this?  ")
	if code != 0 {
		t.Fatalf("needs-info exit %d (stderr=%s)", code, errOut)
	}

	// ---- what went over the wire: status + question, and NOTHING else ----
	if len(fs.sets) != 1 {
		t.Fatalf("needs-info must be exactly one /set, got %d", len(fs.sets))
	}
	patch := fs.sets[0].patch
	if patch["status"] != "info-requested" {
		t.Errorf("status = %v, want info-requested", patch["status"])
	}
	if patch["question"] != "why does bob@ need this?" {
		t.Errorf("question = %q, want the trimmed question", patch["question"])
	}
	for _, forbidden := range []string{"decision", "editedPayload", "reason", "note"} {
		if _, present := patch[forbidden]; present {
			t.Errorf("needsInfo must not carry %q — it is not a decline (patch=%v)", forbidden, patch)
		}
	}
	if len(patch) != 2 {
		t.Errorf("needsInfo patch must be exactly {status, question}, got %v", patch)
	}

	// ---- what the server recorded: a question, a paused clock, no verdict ----
	p := fs.props["g1"]
	if p.status != "info-requested" || p.question != "why does bob@ need this?" {
		t.Errorf("row = status %s question %q", p.status, p.question)
	}
	if p.decision != nil {
		t.Error("needsInfo must never write a decision — the taxonomy's invariant")
	}
	if p.expiresAt != 0 || p.expiresRemainingMs <= 0 {
		t.Errorf("the clock must be PAUSED: expiresAt=%d banked=%d", p.expiresAt, p.expiresRemainingMs)
	}
	if len(p.amendments) != 1 {
		t.Fatalf("one open round must be appended, got %d", len(p.amendments))
	}
	if fs.answerInvocations != 1 {
		t.Errorf("the costed answer round must be enqueued once, got %d", fs.answerInvocations)
	}

	// ---- what the human was told: a question sent, no verdict, no clock ----
	if !strings.Contains(out, "question sent") || !strings.Contains(out, "waiting on the agent") {
		t.Errorf("needs-info output = %q", out)
	}
	if !strings.Contains(out, "Not a decline") {
		t.Errorf("the outcome must say it is not a decline: %q", out)
	}
	for _, lie := range []string{"declined", "rejected", "expire", "OVERDUE"} {
		if strings.Contains(out, lie) {
			t.Errorf("needs-info output must not contain %q: %q", lie, out)
		}
	}
	if !strings.Contains(errOut, "why does bob@ need this?") {
		t.Errorf("the question should be echoed as chrome, stderr=%q", errOut)
	}
}

// The question is REQUIRED. Missing, empty or whitespace-only is a usage error
// that never reaches the server — an empty ask is "a decline in disguise".
func TestApprovals_NeedsInfo_QuestionRequired(t *testing.T) {
	cases := []struct {
		name string
		argv []string
	}{
		{"absent", []string{"needs-info", "q1"}},
		{"empty", []string{"needs-info", "q1", "--question", ""}},
		{"inline empty", []string{"needs-info", "q1", "--question="}},
		{"whitespace", []string{"needs-info", "q1", "--question", "   \t \n "}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			fs := newFake(true)
			fs.add(&fakeProp{id: "q1", kind: "grant-request", tier: 2})
			db := newEnv(t, fs, true)

			out, errOut, code := runAP(t, db, c.argv...)
			if code != int(bmio.ExitUsage) {
				t.Fatalf("exit = %d, want %d (usage); stdout=%q stderr=%q", code, bmio.ExitUsage, out, errOut)
			}
			if len(fs.sets) != 0 {
				t.Errorf("a blank question must NOT reach the server, sets=%v", fs.sets)
			}
			if fs.props["q1"].status != "pending" {
				t.Errorf("the row must stay pending, got %s", fs.props["q1"].status)
			}
			if !strings.Contains(errOut, "a question is required") {
				t.Errorf("stderr must say why: %q", errOut)
			}
			if !strings.Contains(errOut, "--question") {
				t.Errorf("stderr must show the usage line: %q", errOut)
			}
		})
	}

	// No id at all is the same class of refusal.
	fs := newFake(true)
	db := newEnv(t, fs, true)
	_, errOut, code := runAP(t, db, "needs-info", "--question", "why?")
	if code != int(bmio.ExitUsage) || len(fs.sets) != 0 {
		t.Errorf("needs-info with no id: exit %d sets %d, want 2/0 (%s)", code, len(fs.sets), errOut)
	}
}

// needs-info is not a decline, so it takes no --reason and no --note. Silently
// dropping them would let a human believe they had recorded something.
func TestApprovals_NeedsInfo_TakesNoDeclineFlags(t *testing.T) {
	for _, extra := range [][]string{{"--reason", "wrongContent"}, {"--note", "some thoughts"}} {
		fs := newFake(true)
		fs.add(&fakeProp{id: "n2", kind: "reply-draft", tier: 2})
		db := newEnv(t, fs, true)

		argv := append([]string{"needs-info", "n2", "--question", "why?"}, extra...)
		_, errOut, code := runAP(t, db, argv...)
		if code != int(bmio.ExitUsage) {
			t.Errorf("needs-info %v exit = %d, want usage", extra, code)
		}
		if len(fs.sets) != 0 {
			t.Errorf("needs-info %v must not reach the server", extra)
		}
		if !strings.Contains(errOut, "only --question") {
			t.Errorf("stderr must explain, got %q", errOut)
		}
	}
}

// `--question` on any other verb is refused rather than dropped: a human who
// typed it asked the agent something, and silence would let them believe it.
func TestApprovals_QuestionBelongsToNeedsInfoAlone(t *testing.T) {
	for _, argv := range [][]string{
		{"decline", "n3", "--question", "why?"},
		{"approve", "n3", "--question", "why?"},
		{"edit", "n3", "--body", "x", "--question", "why?"},
		{"list", "--question", "why?"},
	} {
		fs := newFake(true)
		fs.add(&fakeProp{id: "n3", kind: "reply-draft", tier: 2})
		db := newEnv(t, fs, true)

		_, errOut, code := runAP(t, db, argv...)
		if code != int(bmio.ExitUsage) {
			t.Errorf("%v exit = %d, want usage", argv, code)
		}
		if len(fs.sets) != 0 {
			t.Errorf("%v must not reach the server", argv)
		}
		if !strings.Contains(errOut, "needs-info") {
			t.Errorf("%v must point at the verb, stderr=%q", argv, errOut)
		}
	}
}

// A server-side refusal surfaces verbatim with its own exit code — the CLI
// never invents an outcome for a row the server would not move.
func TestApprovals_NeedsInfo_ServerRefusalSurfaces(t *testing.T) {
	fs := newFake(true)
	fs.add(&fakeProp{id: "h1", kind: "reply-draft", tier: 2, status: "held", holdUntil: time.Now().UnixMilli() + 60_000})
	db := newEnv(t, fs, true)

	out, errOut, code := runAP(t, db, "needs-info", "h1", "--question", "why?")
	if code == 0 {
		t.Fatalf("a refused needs-info must not exit 0 (stdout=%q)", out)
	}
	if !strings.Contains(errOut, "needs-info h1 refused") || !strings.Contains(errOut, "not pending") {
		t.Errorf("the server's sentence must surface, stderr=%q", errOut)
	}
	if fs.props["h1"].status != "held" || fs.answerInvocations != 0 {
		t.Errorf("a refused needs-info must change nothing: status=%s rounds=%d",
			fs.props["h1"].status, fs.answerInvocations)
	}
}

// `--reason needsInfo` is the one move the taxonomy forbids: it would write the
// action into a rejection record. Refused client-side, pointing at the verb.
func TestApprovals_Decline_NeedsInfoIsNotAReason(t *testing.T) {
	for _, spelling := range []string{"needsInfo", "needsinfo", "needs-info", "NEEDSINFO", "info-requested"} {
		fs := newFake(true)
		fs.add(&fakeProp{id: "d9", kind: "grant-request", tier: 2})
		db := newEnv(t, fs, true)

		out, errOut, code := runAP(t, db, "decline", "d9", "--reason", spelling)
		if code != int(bmio.ExitUsage) {
			t.Errorf("--reason %s exit = %d, want %d (usage)", spelling, code, bmio.ExitUsage)
		}
		if len(fs.sets) != 0 {
			t.Errorf("--reason %s must never reach the server", spelling)
		}
		if fs.props["d9"].status != "pending" || fs.props["d9"].decision != nil {
			t.Errorf("--reason %s must record nothing, row=%v", spelling, fs.props["d9"])
		}
		// The refusal has to teach the verb, with the id already filled in.
		if !strings.Contains(errOut, "approvals needs-info d9 --question") {
			t.Errorf("--reason %s must point at the verb, stderr=%q stdout=%q", spelling, errOut, out)
		}
		if !strings.Contains(errOut, "not a reject reason") {
			t.Errorf("--reason %s must say why, stderr=%q", spelling, errOut)
		}
	}
}

// The enum itself. This is the invariant's home: `needsInfo` in this set would
// let the action be recorded as a rejection, which is the one thing the
// taxonomy says must be impossible.
func TestRejectReasons_NeedsInfoIsNeverAReason(t *testing.T) {
	if rejectReasons["needsInfo"] {
		t.Error("needsInfo is an ACTION, not a reject reason — it must never enter rejectReasons " +
			"(decline-taxonomy.md: the rule a learning pipeline must not break)")
	}
	// Mirrors REJECT_REASONS in services/jmap/src/methods/actionProposal.ts —
	// the revised set of decline-taxonomy.md, `unsafe` in and `notNow` retired.
	// The two sides now AGREE, and this is what pins the agreement: if either
	// moves alone, this fails and they move together.
	want := map[string]bool{"wrongContent": true, "wrongAction": true, "unsafe": true}
	if len(rejectReasons) != len(want) {
		t.Errorf("rejectReasons has %d entries, want %d: %v", len(rejectReasons), len(want), rejectReasons)
	}
	for r := range want {
		if !rejectReasons[r] {
			t.Errorf("rejectReasons is missing %q, which the server accepts", r)
		}
	}
	for r := range rejectReasons {
		if !want[r] {
			t.Errorf("rejectReasons has %q, which the server's enum does not", r)
		}
	}
	// The message a human sees must name the same set.
	for r := range want {
		if !strings.Contains(rejectReasonList, r) {
			t.Errorf("the usage text %q does not name %q", rejectReasonList, r)
		}
	}
	if strings.Contains(rejectReasonList, "needsInfo") {
		t.Errorf("the usage text offers needsInfo as a reason: %q", rejectReasonList)
	}
	// The retirement, both halves. `notNow` may not be OFFERED any more…
	if rejectReasons["notNow"] {
		t.Error("notNow is retired (decline-taxonomy.md) and must not be offered as a reject reason")
	}
	if strings.Contains(rejectReasonList, "notNow") {
		t.Errorf("the usage text still offers the retired notNow: %q", rejectReasonList)
	}
	// …and must still be READABLE, marked, wherever a recorded decision prints.
	// Retiring narrows the write path only; history is never migrated.
	if got := proposal.ReasonLabel("notNow"); got != "notNow (retired)" {
		t.Errorf("a retired reason must render as itself and marked, got %q", got)
	}
}

// A decline typed with the retired reason is refused CLIENT-SIDE, before any
// round trip, and the refusal names the three that are left. The set is the
// contract; a stale spelling costs a keystroke, not a request.
func TestApprovals_Decline_RetiredReasonIsRefusedLocally(t *testing.T) {
	fs := newFake(true)
	fs.add(&fakeProp{id: "r1", kind: "reply-draft", tier: 2, rationale: "why", createdAt: time.Now().UnixMilli()})
	db := newEnv(t, fs, true)

	_, errOut, code := runAP(t, db, "decline", "r1", "--reason", "notNow")
	if code != int(bmio.ExitUsage) {
		t.Errorf("a retired reason must exit %d, got %d", bmio.ExitUsage, code)
	}
	if !strings.Contains(errOut, "wrongContent, wrongAction, unsafe") {
		t.Errorf("the refusal must name the reasons that are left, stderr=%q", errOut)
	}
	if len(fs.sets) != 0 {
		t.Error("a retired reason must never reach the server")
	}
	if fs.props["r1"].status != "pending" || fs.props["r1"].decision != nil {
		t.Errorf("a refused decline must record nothing, row=%v", fs.props["r1"])
	}
}

// `unsafe` is the hard negative, and it has to be typeable: a reason that cannot
// be recorded is one nothing can ever weight (decline-taxonomy.md).
func TestApprovals_Decline_UnsafeIsAccepted(t *testing.T) {
	fs := newFake(true)
	fs.add(&fakeProp{id: "u1", kind: "reply-draft", tier: 3, rationale: "why", createdAt: time.Now().UnixMilli()})
	db := newEnv(t, fs, true)

	out, errOut, code := runAP(t, db, "decline", "u1", "--reason", "unsafe", "--note", "quoted the contract")
	if code != 0 {
		t.Fatalf("declining unsafe must succeed, code=%d stderr=%q", code, errOut)
	}
	if !strings.Contains(out, "declined") || !strings.Contains(out, "unsafe") {
		t.Errorf("the echo must name the recorded reason, stdout=%q", out)
	}
	d := fs.props["u1"].decision
	if fs.props["u1"].status != "rejected" || d["reason"] != "unsafe" || d["note"] != "quoted the contract" {
		t.Errorf("unsafe must land verbatim in the decision record, row=%v", fs.props["u1"])
	}
}

// A row decided BEFORE the taxonomy was revised still shows, with its reason
// intact and marked retired. Nothing migrated it, so the CLI must read it —
// throwing, hiding it, or printing a reason the human never chose would each be
// a different way of losing the record.
func TestApprovals_Show_LegacyReasonStillReads(t *testing.T) {
	now := time.Now().UnixMilli()
	fs := newFake(true)
	fs.add(&fakeProp{
		id: "old1", kind: "start-thread", tier: 3, status: "rejected", rationale: "the quote expires Friday",
		createdAt: now - 30*day, decidedAt: now - 29*day,
		decision: map[string]any{"by": "eric@login.example", "reason": "notNow", "note": "I'll ring them instead."},
	})
	db := newEnv(t, fs, true)

	out, errOut, code := runAP(t, db, "show", "old1")
	if code != 0 {
		t.Fatalf("a legacy row must still read, code=%d stderr=%q", code, errOut)
	}
	if !strings.Contains(out, "reason=notNow (retired)") {
		t.Errorf("a retired reason must print as itself and marked, stdout=%q", out)
	}
	if !strings.Contains(out, "I'll ring them instead.") {
		t.Errorf("the note recorded with it must survive too, stdout=%q", out)
	}
	// The reason must not be laundered into one of the live three.
	for _, live := range []string{"wrongContent", "wrongAction", "unsafe"} {
		if strings.Contains(out, live) {
			t.Errorf("a legacy reason was remapped to %q, stdout=%q", live, out)
		}
	}
}

// An `info-requested` row is watchable, not decidable: it renders as waiting on
// the AGENT, with NO deadline in either direction — the server banked the
// remaining window and nulled `expiresAt`, so a countdown would be invented and
// "OVERDUE" would be a lie.
func TestApprovals_List_InfoRequestedIsWaitingOnAgent(t *testing.T) {
	now := time.Now().UnixMilli()
	fs := newFake(true)
	fs.add(&fakeProp{id: "pend", kind: "create-contact", tier: 1, rationale: "p", createdAt: now - 60_000, expiresAt: now + day})
	fs.add(&fakeProp{id: "asked", kind: "grant-request", tier: 2, status: "info-requested", rationale: "why bob",
		createdAt: now - 120_000, expiresRemainingMs: 3 * 60 * 60_000, question: "why bob@?",
		amendments: []any{round("why bob@?", "", "eric@login.example", now-90_000, 0)}})
	fs.add(&fakeProp{id: "onhold", kind: "reply-draft", tier: 2, status: "held", createdAt: now - 180_000,
		decidedAt: now - 60_000, holdUntil: now + 4*60_000})
	db := newEnv(t, fs, true)

	out, errOut, code := runAP(t, db, "list", "--status", "all")
	if code != 0 {
		t.Fatalf("list exit %d", code)
	}
	var askedLine string
	for _, ln := range strings.Split(strings.TrimRight(out, "\n"), "\n") {
		if strings.Contains(ln, "asked") {
			askedLine = ln
		}
	}
	if askedLine == "" {
		t.Fatalf("the info-requested row is missing from:\n%s", out)
	}
	if !strings.HasPrefix(askedLine, "info-requested") {
		t.Errorf("the row must carry the server's status token: %q", askedLine)
	}
	if !strings.Contains(askedLine, "waiting:agent") {
		t.Errorf("an info-requested row must read as waiting on the agent: %q", askedLine)
	}
	for _, clock := range []string{"exp:", "hold:", "OVERDUE", "no deadline"} {
		if strings.Contains(askedLine, clock) {
			t.Errorf("an info-requested row must show NO deadline, found %q in %q", clock, askedLine)
		}
	}
	if !strings.Contains(errOut, "decision clock is paused") {
		t.Errorf("the legend must explain the missing clock, stderr=%q", errOut)
	}

	// Queue order: decidable first, then waiting-on-agent, then the hold tray.
	ids, _, code := runAP(t, db, "list", "--status", "all", "--ids")
	if code != 0 {
		t.Fatalf("list --ids exit %d", code)
	}
	if got := strings.Fields(ids); len(got) != 3 || got[0] != "pend" || got[1] != "asked" || got[2] != "onhold" {
		t.Errorf("queue order = %v, want [pend asked onhold]", got)
	}

	// `info-requested` is a filter value too — the vocabulary is one word in
	// both directions.
	ids, _, code = runAP(t, db, "list", "--status", "info-requested", "--ids")
	if code != 0 || strings.TrimSpace(ids) != "asked" {
		t.Errorf("--status info-requested = %q (exit %d), want asked", ids, code)
	}
}

// `show` renders the whole dialogue in order, each round attributed: the human
// who asked, the agent that answered, and the open round marked as still owed.
func TestApprovals_Show_RendersDialogue(t *testing.T) {
	now := time.Now().UnixMilli()
	fs := newFake(true)
	fs.add(&fakeProp{id: "dlg", kind: "grant-request", tier: 2, agent: "photos", status: "info-requested",
		rationale: "let me email bob@", createdAt: now - 10*60_000,
		question:           "and why now?",
		expiresRemainingMs: 90 * 60_000,
		amendments: []any{
			round("why bob@?", "he is the vendor on the invoice thread", "eric@login.example", now-9*60_000, now-8*60_000),
			round("and why now?", "", "eric@login.example", now-60_000, 0),
		}})
	db := newEnv(t, fs, true)

	out, _, code := runAP(t, db, "show", "dlg")
	if code != 0 {
		t.Fatalf("show exit %d", code)
	}
	// In order, and attributed on both sides.
	wantOrder := []string{
		"dialogue:",
		`1. eric@login.example asked`,
		"why bob@?",
		"photos answered",
		"he is the vendor on the invoice thread",
		`2. eric@login.example asked`,
		"and why now?",
		"(unanswered",
	}
	at := 0
	for _, want := range wantOrder {
		i := strings.Index(out[at:], want)
		if i < 0 {
			t.Fatalf("show output missing %q (or out of order) after offset %d:\n%s", want, at, out)
		}
		at += i + len(want)
	}
	// Waiting, not expiring.
	if !strings.Contains(out, "waiting:   "+proposal.WaitingOnAgentNote) {
		t.Errorf("show must say the clock is paused:\n%s", out)
	}
	if strings.Contains(out, "expires:") {
		t.Errorf("an info-requested row has no deadline to print:\n%s", out)
	}
}

// The --json shapes, pinned. `show --json` is the server's own bytes (so the
// dialogue passes through faithfully), and the decision outcome is a stable
// object a script can branch on.
func TestApprovals_NeedsInfo_JSONShapes(t *testing.T) {
	// Fixed instants: a golden is only a golden if it does not move.
	const created = int64(1_700_000_000_000)
	fs := newFake(true)
	fs.add(&fakeProp{id: "j9", kind: "grant-request", tier: 2, agent: "photos", status: "info-requested",
		rationale: "let me email bob@", createdAt: created, question: "why bob@?",
		expiresRemainingMs: 60_000,
		payload:            map[string]any{"address": "bob@x.z"},
		amendments: []any{
			round("why bob@?", "he is the vendor", "eric@login.example", created+1_000, created+2_000),
			round("and why now?", "", "eric@login.example", created+3_000, 0),
		}})
	db := newEnv(t, fs, true)

	out, _, code := runAP(t, db, "show", "j9", "--json")
	if code != 0 {
		t.Fatalf("show --json exit %d", code)
	}
	const wantShow = `{"agent":"photos","amendments":[{"answer":"he is the vendor","answeredAt":"2023-11-14T22:13:22.000Z","askedAt":"2023-11-14T22:13:21.000Z","askedBy":"eric@login.example","question":"why bob@?"},{"answer":null,"answeredAt":null,"askedAt":"2023-11-14T22:13:23.000Z","askedBy":"eric@login.example","question":"and why now?"}],"claimedAt":null,"createdAt":"2023-11-14T22:13:20.000Z","decidedAt":null,"decision":null,"dueAt":null,"editedPayload":null,"evidence":[],"expiresAt":null,"holdUntil":null,"id":"j9","invocationStatus":"done","kind":"grant-request","payload":{"address":"bob@x.z"},"question":"why bob@?","rationale":"let me email bob@","status":"info-requested","subject":{},"tier":2}`
	if got := strings.TrimSpace(out); got != wantShow {
		t.Errorf("show --json drifted.\n got: %s\nwant: %s", got, wantShow)
	}

	// The decision outcome: `question` rides along while the round is open, and
	// nothing claims a verdict.
	fs2 := newFake(true)
	fs2.add(&fakeProp{id: "j8", kind: "reply-draft", tier: 2, createdAt: created})
	db2 := newEnv(t, fs2, true)

	out, _, code = runAP(t, db2, "needs-info", "j8", "--question", "why this recipient?", "--json")
	if code != 0 {
		t.Fatalf("needs-info --json exit %d", code)
	}
	const wantOutcome = `{"id":"j8","verb":"needs-info","status":"info-requested","tier":2,` +
		`"kind":"reply-draft","edited":false,"held":false,"egressed":false,"question":"why this recipient?"}`
	if got := strings.TrimSpace(out); got != wantOutcome {
		t.Errorf("needs-info --json drifted.\n got: %s\nwant: %s", got, wantOutcome)
	}

	// And the pre-existing outcome shape is unchanged for a verb with no
	// question: `question` is absent, not null.
	fs3 := newFake(true)
	fs3.add(&fakeProp{id: "j7", kind: "reply-draft", tier: 2, createdAt: created})
	db3 := newEnv(t, fs3, true)

	out, _, code = runAP(t, db3, "decline", "j7", "--reason", "wrongContent", "--json")
	if code != 0 {
		t.Fatalf("decline --json exit %d", code)
	}
	const wantDecline = `{"id":"j7","verb":"decline","status":"rejected","tier":2,` +
		`"kind":"reply-draft","edited":false,"held":false,"egressed":false}`
	if got := strings.TrimSpace(out); got != wantDecline {
		t.Errorf("decline --json drifted.\n got: %s\nwant: %s", got, wantDecline)
	}
}
