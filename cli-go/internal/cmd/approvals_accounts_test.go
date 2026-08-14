package cmd

// s10 T7 — `bullmoose approvals` across EVERY account the human can reach.
//
// The bug, from the terminal's side: `approvals list` resolved ONE account
// from the mirror and asked only that one. A human's agents are separate
// principals on separate accounts, reachable through the supervisory grant
// provisioning mints — so the CLI showed "(no pending proposals)" while
// EditorEmily's reply-draft sat one account away.
//
// The fake server here serves a real session (`/.well-known/jmap`) with an
// account map, and scopes its queues per account, so these drive the whole
// path: session → reach → per-account query/get in ONE batch → merged rows.

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

const (
	acctEric  = "a_eric"
	acctEmily = "a_emily"
	acctAllen = "a_allen"
)

// multiAccountFake is the household: the human's own account, Emily (fully
// supervised) and Allen (watch-only — visible, not decidable).
func multiAccountFake(t *testing.T) (*fakeServer, string) {
	t.Helper()
	now := time.Now().UnixMilli()
	fs := newFake(true)
	fs.accounts = []fakeAccount{
		{id: acctEric, name: "eric@bullmoose.cc", personal: true, mayDecide: true, mayApproveIrreversible: true},
		{id: acctEmily, name: "editor@bullmoose.cc", mayDecide: true, mayApproveIrreversible: true},
		{id: acctAllen, name: "analyst@bullmoose.cc", mayDecide: false},
	}
	fs.add(&fakeProp{id: "mine", account: acctEric, agent: "self-note", kind: "create-contact",
		tier: 1, rationale: "my own", createdAt: now - 3*60_000, expiresAt: now + 2*day})
	fs.add(&fakeProp{id: "emilys", account: acctEmily, agent: "editor-emily", kind: "reply-draft",
		tier: 3, rationale: "reply to Grace", createdAt: now - 2*60_000, expiresAt: now + 1*day,
		payload: map[string]any{"to": "grace@example.test", "text": "Monday works"}})
	fs.add(&fakeProp{id: "allens", account: acctAllen, agent: "allen-analyst", kind: "create-contact",
		tier: 1, rationale: "file the vendor", createdAt: now - 60_000, expiresAt: now + 3*day})
	return fs, newEnv(t, fs, true)
}

// THE REGRESSION. Every agent's pending work is in one queue, and each row says
// which agent and which account it came from.
func TestApprovals_List_SpansEveryReachableAccount(t *testing.T) {
	fs, db := multiAccountFake(t)

	out, _, code := runAP(t, db, "list", "--ids")
	if code != 0 {
		t.Fatalf("list --ids exit %d", code)
	}
	got := strings.Fields(out)
	if len(got) != 3 {
		t.Fatalf("list --ids = %v, want three rows (one per account)", got)
	}
	for _, want := range []string{"mine", "emilys", "allens"} {
		if !strings.Contains(out, want) {
			t.Errorf("%s missing from the merged queue: %v", want, got)
		}
	}

	// ONE round trip for the whole queue: 2 invocations per account, batched.
	// (The session fetch is a separate GET and is cached for the process.)
	if fs.batches != 1 {
		t.Errorf("queue took %d JMAP batches, want 1", fs.batches)
	}

	// The table names the ACCOUNT beside the agent — telling Emily's ask from
	// Allen's is the whole point of merging.
	out, errOut, code := runAP(t, db, "list")
	if code != 0 {
		t.Fatalf("list exit %d", code)
	}
	if !strings.Contains(errOut, "ACCOUNT") {
		t.Errorf("header must carry an ACCOUNT column:\n%s", errOut)
	}
	for _, want := range []string{"editor@bullmoose.cc", "eric@bullmoose.cc"} {
		if !strings.Contains(out, want) {
			t.Errorf("row is not labelled with its account %q:\n%s", want, out)
		}
	}
	// A watch-only account is MARKED — and the mark survives the column width
	// even when the name has to be elided — and it is explained on screen.
	if !strings.Contains(out, roMark+" analyst@") {
		t.Errorf("the watch-only account must be marked %q:\n%s", roMark, out)
	}
	if !strings.Contains(errOut, "NOT decidable") {
		t.Errorf("the [ro] mark must be explained when it is on screen:\n%s", errOut)
	}
}

// --json stays one raw server line per proposal — and each line names its
// account, which is what keeps a merged queue machine-readable.
func TestApprovals_List_JSONCarriesTheAccount(t *testing.T) {
	_, db := multiAccountFake(t)

	out, _, code := runAP(t, db, "list", "--json")
	if code != 0 {
		t.Fatalf("list --json exit %d", code)
	}
	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
	if len(lines) != 3 {
		t.Fatalf("list --json lines = %d, want 3", len(lines))
	}
	seen := map[string]string{}
	for _, ln := range lines {
		var row map[string]any
		if err := json.Unmarshal([]byte(ln), &row); err != nil {
			t.Fatalf("row is not JSON: %v (%s)", err, ln)
		}
		id, _ := row["id"].(string)
		account, _ := row["accountId"].(string)
		if account == "" {
			t.Errorf("row %q carries no accountId: %s", id, ln)
		}
		seen[id] = account
	}
	if seen["emilys"] != acctEmily || seen["allens"] != acctAllen || seen["mine"] != acctEric {
		t.Errorf("rows are attributed to the wrong accounts: %v", seen)
	}
}

// --account narrows to one, keeping cli/009 semantics.
func TestApprovals_List_AccountSelectorNarrows(t *testing.T) {
	_, db := multiAccountFake(t)

	out, _, code := runAP(t, db, "list", "--ids", "--account", "editor@bullmoose.cc")
	if code != 0 {
		t.Fatalf("list --account exit %d", code)
	}
	if got := strings.Fields(out); len(got) != 1 || got[0] != "emilys" {
		t.Fatalf("--account editor = %v, want [emilys]", got)
	}

	// A selector that matches nothing is NOT FOUND (exit 3) — never a silent
	// fall-back to the default account.
	_, _, code = runAP(t, db, "list", "--account", "nobody@nowhere.test")
	if code != 3 {
		t.Errorf("unmatched --account exit %d, want 3", code)
	}
}

// A decision finds its own account: the human types an id, not an account.
func TestApprovals_Decide_FindsTheProposalsOwnAccount(t *testing.T) {
	fs, db := multiAccountFake(t)

	out, _, code := runAP(t, db, "approve", "emilys")
	if code != 0 {
		t.Fatalf("approve exit %d (%s)", code, out)
	}
	if fs.props["emilys"].status != "approved" {
		t.Errorf("emilys status = %s, want approved", fs.props["emilys"].status)
	}
	// It was decided ON Emily's account, not on the session default.
	if fs.lastSetAccount != acctEmily {
		t.Errorf("decision went to account %q, want %q", fs.lastSetAccount, acctEmily)
	}

	// `show` locates it too, and says which account it belongs to.
	out, errOut, code := runAP(t, db, "show", "allens")
	if code != 0 {
		t.Fatalf("show exit %d (%s)", code, out)
	}
	if !strings.Contains(out, "allen-analyst") {
		t.Errorf("show did not find the proposal on the granted account:\n%s", out)
	}
	if !strings.Contains(errOut, "analyst@bullmoose.cc") {
		t.Errorf("show must name the account the row came from:\n%s", errOut)
	}
}

// The honesty rule at the CLI's version of a button: a watch-only account is
// refused BEFORE the round trip, with the reason the server cannot phrase.
func TestApprovals_Decide_RefusedOnAWatchOnlyAccount(t *testing.T) {
	fs, db := multiAccountFake(t)

	for _, argv := range [][]string{
		{"approve", "allens"},
		{"decline", "allens", "--reason", "wrongAction"},
		{"needs-info", "allens", "--question", "why?"},
	} {
		out, errOut, code := runAP(t, db, argv...)
		if code != 4 { // forbidden
			t.Errorf("%v exit %d, want 4 (forbidden); out=%q err=%q", argv, code, out, errOut)
		}
		if !strings.Contains(errOut, "watch-only") {
			t.Errorf("%v refusal must name the reason:\n%s", argv, errOut)
		}
	}
	// Nothing was attempted and nothing moved.
	if len(fs.sets) != 0 {
		t.Errorf("a refused verb still sent %d /set patches", len(fs.sets))
	}
	if fs.props["allens"].status != "pending" {
		t.Errorf("allens status = %s, want pending", fs.props["allens"].status)
	}
}

// A revoked grant mid-session: the account drops out of the SESSION, so its
// rows leave the queue on the next command. No restart, no cache.
func TestApprovals_List_RevokedGrantDropsTheAccount(t *testing.T) {
	fs, db := multiAccountFake(t)

	out, _, _ := runAP(t, db, "list", "--ids")
	if !strings.Contains(out, "emilys") {
		t.Fatalf("fixture bug: emilys should be in the queue:\n%s", out)
	}

	// The server stops resolving the grant (verifyBearer filters revoked_at).
	fs.mu.Lock()
	fs.accounts = fs.accounts[:1] // eric only
	fs.mu.Unlock()

	out, _, code := runAP(t, db, "list", "--ids")
	if code != 0 {
		t.Fatalf("list exit %d", code)
	}
	if strings.Contains(out, "emilys") {
		t.Errorf("a revoked grant must remove the row immediately:\n%s", out)
	}
	if !strings.Contains(out, "mine") {
		t.Errorf("revocation must be surgical — the human's own row survives:\n%s", out)
	}
}

// A server that serves no account map (pre-T7, and the contract stub) still
// works: the CLI falls back to the mirror's single account.
func TestApprovals_List_FallsBackWhenTheSessionListsNoAccounts(t *testing.T) {
	now := time.Now().UnixMilli()
	fs := newFake(true)
	fs.add(&fakeProp{id: "solo", kind: "create-contact", tier: 1, rationale: "only one",
		createdAt: now - 60_000, expiresAt: now + day})
	db := newEnv(t, fs, true)

	out, _, code := runAP(t, db, "list", "--ids")
	if code != 0 {
		t.Fatalf("list exit %d", code)
	}
	if got := strings.Fields(out); len(got) != 1 || got[0] != "solo" {
		t.Fatalf("fallback list = %v, want [solo]", got)
	}
	// And the verbs still land — an unreported authority is not "no authority".
	if _, _, code := runAP(t, db, "approve", "solo"); code != 0 {
		t.Errorf("approve on the fallback account exit %d, want 0", code)
	}
}
