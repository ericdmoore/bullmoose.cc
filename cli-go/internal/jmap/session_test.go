package jmap

import (
	"encoding/json"
	"testing"
)

// s10 T7 — the session's account map is how `approvals` learns what it can
// reach and what it may decide there. The subtlety worth pinning is the
// ABSENT-vs-false distinction: a server that predates T7 reports neither flag,
// and hiding verbs it would have honoured is its own dishonesty. Absent ⇒
// permitted, and the server stays the gate.
func TestAgentAccounts_ReachAndAuthority(t *testing.T) {
	raw := `{
	  "apiUrl": "/api/jmap",
	  "accounts": {
	    "a_emily": {"name": "editor@bullmoose.cc", "isPersonal": false, "isReadOnly": false,
	      "accountCapabilities": {"urn:bullmoose:params:jmap:agent": {"mayDecide": true, "mayApproveIrreversible": false}}},
	    "a_eric": {"name": "eric@bullmoose.cc", "isPersonal": true, "isReadOnly": false,
	      "accountCapabilities": {"urn:bullmoose:params:jmap:agent": {"mayDecide": true, "mayApproveIrreversible": true}}},
	    "a_allen": {"name": "analyst@bullmoose.cc", "isPersonal": false, "isReadOnly": true,
	      "accountCapabilities": {"urn:bullmoose:params:jmap:agent": {"mayDecide": false, "mayApproveIrreversible": false}}},
	    "a_legacy": {"name": "old@bullmoose.cc", "isPersonal": false,
	      "accountCapabilities": {"urn:bullmoose:params:jmap:agent": {}}},
	    "a_mailonly": {"name": "shared@bullmoose.cc", "isPersonal": false,
	      "accountCapabilities": {"urn:ietf:params:jmap:contacts": {}}}
	  }
	}`
	var s Session
	if err := json.Unmarshal([]byte(raw), &s); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	got := s.AgentAccounts()

	// Owned first, then by name — a stable order, never map iteration order.
	wantIDs := []string{"a_eric", "a_allen", "a_emily", "a_legacy"}
	if len(got) != len(wantIDs) {
		t.Fatalf("AgentAccounts() = %d accounts, want %d (%v)", len(got), len(wantIDs), got)
	}
	for i, want := range wantIDs {
		if got[i].AccountID != want {
			t.Errorf("account %d = %s, want %s", i, got[i].AccountID, want)
		}
	}

	by := map[string]AgentAccount{}
	for _, a := range got {
		by[a.AccountID] = a
	}
	if !by["a_emily"].MayDecide || by["a_emily"].MayApproveIrreversible {
		t.Errorf("a narrowed grant decides but does not send: %+v", by["a_emily"])
	}
	if by["a_allen"].MayDecide {
		t.Errorf("a watch-only account must not report MayDecide: %+v", by["a_allen"])
	}
	if !by["a_legacy"].MayDecide || !by["a_legacy"].MayApproveIrreversible {
		t.Errorf("unreported authority must read as permitted: %+v", by["a_legacy"])
	}
	// An account without the agent capability is not part of the queue at all.
	if _, ok := by["a_mailonly"]; ok {
		t.Errorf("an account with no agent capability leaked into the queue's reach")
	}
}
