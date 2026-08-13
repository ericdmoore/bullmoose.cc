// Package proposal is the pure, server-faithful domain for `bullmoose approvals`
// (s03.D T1). It is Go-NATIVE and has no Node counterpart: it mirrors the webmail
// read-model layer field for field, because that projection IS the contract.
//
//	types.go     the ActionProposal read model — mirrors
//	             webmail/src/lib/approvals/types.ts, itself a mirror of
//	             proposalToJmap (services/jmap/src/methods/actionProposal.ts:560-581).
//	clocks.go    the two-clock arithmetic + queue order —
//	             webmail/src/lib/approvals/clocks.ts.
//	edit.go      the edit / no-op-diff logic — webmail/src/lib/approvals/edit.ts.
//	needsinfo.go the needsInfo verb's pure rules + the Q&A dialogue —
//	             webmail/src/lib/approvals/needsInfo.ts.
//
// Nothing here does I/O; every function is pure and table-tested, so the two-clock
// rule and the "a no-op edit sends nothing" rule are checked without a server
// (the s03.C split: logic in tested code, effects in the shell).
//
// ⚠️ Two timestamps here are DIFFERENT CLOCKS and must never be conflated (s07
// devPlan §T0, actionProposal.ts:55-61):
//
//	expiresAt   the PRE-decision deadline — how long the human has to decide.
//	holdUntil   the tier-2 POST-approval retraction window.
//
// clocks.go keeps them apart, sourcing each from its own field gated on status.
package proposal

import "encoding/json"

// Subject is what a proposal acts on (types.ts:43).
type Subject struct {
	Realm    string `json:"realm"`
	ObjectID string `json:"objectId"`
}

// Evidence is what the agent looked at — rendered next to the rationale (types.ts:49).
type Evidence struct {
	Realm    string `json:"realm"`
	ObjectID string `json:"objectId"`
	Note     string `json:"note,omitempty"`
}

// Decision is the no-thanks signal plus, for a tier-1 approve, the undo handle
// (types.ts:58). `by` + reason enum + optional free text (arch.md §3).
type Decision struct {
	By     string         `json:"by"`
	Reason string         `json:"reason,omitempty"`
	Note   string         `json:"note,omitempty"`
	Undo   map[string]any `json:"undo,omitempty"`
}

// Amendment is one needsInfo Q&A round (types.ts:85, actionProposal.ts's
// `amendments_json`). The list is APPEND-ONLY: the human's needsInfo pushes an
// open round (`answer: null`), the agent's answer fills THAT round — the
// proposal's original rationale/evidence are never rewritten (the editedPayload
// discipline). Answer is a pointer so the wire's `null` ("still owed") stays
// distinguishable from an empty answer.
type Amendment struct {
	Question   string  `json:"question"`
	Answer     *string `json:"answer"`
	AskedAt    string  `json:"askedAt"`
	AnsweredAt string  `json:"answeredAt"`
	AskedBy    string  `json:"askedBy"`
}

// Answered reports whether the agent has supplied this round's answer.
func (a Amendment) Answered() bool { return a.Answer != nil }

// AnswerText is the answer, or "" while the round is still open.
func (a Amendment) AnswerText() string {
	if a.Answer == nil {
		return ""
	}
	return *a.Answer
}

// Amendments is the dialogue. It decodes DEFENSIVELY, the same spots the server
// (`safeJsonArray`) and webmail (`parseProposal`'s filter) are: a malformed
// entry — or a malformed list — degrades to nothing rather than dropping the
// whole proposal out of a queue that still needs deciding.
type Amendments []Amendment

func (as *Amendments) UnmarshalJSON(b []byte) error {
	var rows []json.RawMessage
	if err := json.Unmarshal(b, &rows); err != nil {
		*as = nil
		return nil
	}
	out := make(Amendments, 0, len(rows))
	for _, r := range rows {
		var a Amendment
		if err := json.Unmarshal(r, &a); err != nil || a.Question == "" {
			continue // webmail keeps only rounds with a string `question`
		}
		out = append(out, a)
	}
	*as = out
	return nil
}

// Proposal is the ActionProposal read model as the server projects it
// (proposalToJmap, actionProposal.ts:560-581). String timestamps are ISO-8601
// (the wire form `new Date(ms).toISOString()`); an empty string is the wire
// `null`. Payload is the AGENT's version, the retained source of truth;
// EditedPayload is the HUMAN's edit and NEVER overwrites Payload (actionProposal.ts:222-228).
type Proposal struct {
	ID            string         `json:"id"`
	Agent         string         `json:"agent"` // binding name, read from the invocation (§8.5)
	Kind          string         `json:"kind"`
	Tier          int            `json:"tier"`
	Subject       Subject        `json:"subject"`
	Payload       map[string]any `json:"payload"`
	EditedPayload map[string]any `json:"editedPayload"`
	Rationale     string         `json:"rationale"`
	Evidence      []Evidence     `json:"evidence"`
	Status        string         `json:"status"`
	Decision      *Decision      `json:"decision"`
	CreatedAt     string         `json:"createdAt"`
	DecidedAt     string         `json:"decidedAt"`
	HoldUntil     string         `json:"holdUntil"`
	// ExpiresAt is NULL (empty) while a needsInfo round is open — the server
	// banks the remainder in `expires_remaining_ms` and nulls the deadline, so
	// nothing can lapse while the ball is in the agent's court (s10 T3).
	ExpiresAt string `json:"expiresAt"`
	// Question is the human's OPEN needsInfo question; empty when no round is
	// open (the answer path NULLs it, services/agent/src/proposals.ts:252).
	Question string `json:"question"`
	// Amendments is the append-only Q&A dialogue — every round, answered or open.
	Amendments       Amendments `json:"amendments"`
	InvocationStatus string     `json:"invocationStatus"`
	ClaimedAt        string     `json:"claimedAt"`

	// Raw is the exact bytes the server sent for this row. `approvals --json`
	// emits Raw verbatim (the "raw proposal") rather than a reshaped struct, so
	// no field the server serves is dropped or invented (the s03.E lesson).
	Raw json.RawMessage `json:"-"`
}

// The status vocabulary (types.ts ProposalStatus). `info-requested` is the
// needsInfo waiting state (s10 T3): the row left the human's queue and is
// waiting on the AGENT, with the decision clock paused. It must be listed here
// — an unknown status falls back to `pending`, and rendering a paused row as
// decidable would put a proposal back in a queue it is not in.
var statuses = map[string]bool{
	"pending": true, "info-requested": true, "approved": true,
	"rejected": true, "held": true, "expired": true,
}

// Parse coerces one ActionProposal/get list entry — mirrors parseProposal
// (types.ts:103), defensive in the same spots the server's own safeJson is
// (actionProposal.ts:590-606). A row with no id is not decidable and is dropped
// (ok == false).
func Parse(raw json.RawMessage) (*Proposal, bool) {
	var p Proposal
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, false
	}
	if p.ID == "" {
		return nil, false
	}
	// An out-of-range tier reads as 3: when reversibility is unknown, the only
	// honest assumption is "irreversible" — fail closed (types.ts:110-113).
	if p.Tier != 1 && p.Tier != 2 {
		p.Tier = 3
	}
	if !statuses[p.Status] {
		p.Status = "pending"
	}
	p.Raw = raw
	return &p, true
}

// IsEgressKind reports whether approving this kind sends something outward — the
// reply-shaped kinds whose tier-3 application relays MIME (actionProposal.ts:424-479).
// Used only to word an outcome honestly, never to decide policy.
func IsEgressKind(kind string) bool {
	return kind == "reply-draft" || kind == "start-thread"
}
