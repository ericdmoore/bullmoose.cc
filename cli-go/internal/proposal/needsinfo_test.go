package proposal

// The needsInfo domain rules (s10 T3) — the port of
// webmail/src/lib/approvals/needsInfo.test.ts, held to the same two things: the
// question is required, and an `info-requested` row is a first-class status that
// waits on the AGENT rather than falling back into the human's queue.

import (
	"encoding/json"
	"testing"
)

func TestQuestionProblem(t *testing.T) {
	for _, blank := range []string{"", " ", "\t\n  ", " " + " "} {
		if QuestionProblem(blank) == "" {
			t.Errorf("QuestionProblem(%q) allowed a blank ask — an empty question is a decline in disguise", blank)
		}
	}
	for _, ok := range []string{"why?", "  why bob@?  "} {
		if p := QuestionProblem(ok); p != "" {
			t.Errorf("QuestionProblem(%q) = %q, want no problem", ok, p)
		}
	}
}

func TestNeedsInfoAvailable(t *testing.T) {
	if !NeedsInfoAvailable("pending") {
		t.Error("the verb must be offered on pending rows")
	}
	for _, s := range []string{"info-requested", "held", "approved", "rejected", "expired"} {
		if NeedsInfoAvailable(s) {
			t.Errorf("NeedsInfoAvailable(%q) = true — one round per human action", s)
		}
	}
}

// `info-requested` must survive Parse. An unknown status falls back to
// `pending`, so a missing entry in the vocabulary would silently put a paused
// row back in the decidable queue.
func TestParse_InfoRequestedStatusAndDialogue(t *testing.T) {
	raw := json.RawMessage(`{
      "id":"p1","agent":"photos","kind":"grant-request","tier":2,
      "status":"info-requested","rationale":"let me email bob@",
      "expiresAt":null,"question":"and why now?",
      "amendments":[
        {"question":"why bob@?","answer":"he is the vendor","askedAt":"2026-08-13T10:00:00.000Z",
         "answeredAt":"2026-08-13T10:05:00.000Z","askedBy":"eric@login.example"},
        {"question":"and why now?","answer":null,"askedAt":"2026-08-13T11:00:00.000Z",
         "answeredAt":null,"askedBy":"eric@login.example"}
      ]}`)
	p, ok := Parse(raw)
	if !ok {
		t.Fatal("Parse dropped an info-requested row")
	}
	if p.Status != "info-requested" {
		t.Errorf("status = %q, want info-requested (a paused row is not pending)", p.Status)
	}
	if p.Question != "and why now?" {
		t.Errorf("question = %q", p.Question)
	}
	if len(p.Amendments) != 2 {
		t.Fatalf("amendments = %d, want 2", len(p.Amendments))
	}
	if !p.Amendments[0].Answered() || p.Amendments[0].AnswerText() != "he is the vendor" {
		t.Errorf("round 1 should be answered, got %+v", p.Amendments[0])
	}
	if p.Amendments[1].Answered() {
		t.Error("round 2 is still owed — `answer: null` must not read as answered")
	}
	open := p.OpenQuestion()
	if open == nil || open.Question != "and why now?" {
		t.Errorf("OpenQuestion = %+v, want the last, unanswered round", open)
	}
	if got := p.AnsweredRounds(); len(got) != 1 || got[0].Question != "why bob@?" {
		t.Errorf("AnsweredRounds = %+v, want only the completed round", got)
	}

	// The clock is banked, not running: no expiry is computed for the row, in
	// either direction.
	if c := p.Clocks(1_700_000_000_000); c.ExpiresInMs != nil || c.HoldRemainingMs != nil {
		t.Errorf("an info-requested row must have no running clock, got %+v", c)
	}
}

// A fully answered dialogue owes nothing.
func TestOpenQuestion_NoneWhenAllAnswered(t *testing.T) {
	answer := "because X"
	p := &Proposal{Amendments: Amendments{{Question: "why?", Answer: &answer}}}
	if p.OpenQuestion() != nil {
		t.Error("an answered dialogue has no open question")
	}
	if len(p.AnsweredRounds()) != 1 {
		t.Error("the answered round is still part of the record")
	}
	if (&Proposal{}).OpenQuestion() != nil {
		t.Error("a proposal with no dialogue has no open question")
	}
}

// Malformed dialogue degrades to nothing rather than dropping a decidable
// proposal out of the queue — the server's own safeJsonArray discipline.
func TestParse_MalformedAmendmentsDegradeNotDrop(t *testing.T) {
	for _, amendments := range []string{`"not an array"`, `[null,7,{"answer":"no question"}]`, `{}`} {
		raw := json.RawMessage(`{"id":"p2","status":"pending","tier":1,"amendments":` + amendments + `}`)
		p, ok := Parse(raw)
		if !ok {
			t.Fatalf("amendments %s took the whole row down", amendments)
		}
		if len(p.Amendments) != 0 {
			t.Errorf("amendments %s parsed to %+v, want empty", amendments, p.Amendments)
		}
	}
}

// The queue order: decidable first, then waiting-on-the-agent (oldest ask
// first), then the hold tray, then history.
func TestOrderQueue_InfoRequestedRanksAfterPendingBeforeHeld(t *testing.T) {
	ps := []*Proposal{
		{ID: "hist", Status: "approved", DecidedAt: "2026-08-13T10:00:00.000Z"},
		{ID: "held", Status: "held", HoldUntil: "2026-08-13T12:00:00.000Z"},
		{ID: "ask-new", Status: "info-requested", CreatedAt: "2026-08-13T09:00:00.000Z"},
		{ID: "ask-old", Status: "info-requested", CreatedAt: "2026-08-13T08:00:00.000Z"},
		{ID: "pend", Status: "pending", CreatedAt: "2026-08-13T09:30:00.000Z"},
	}
	want := []string{"pend", "ask-old", "ask-new", "held", "hist"}
	got := OrderQueue(ps)
	for i, id := range want {
		if got[i].ID != id {
			t.Fatalf("OrderQueue = %s, want %v", ids(got), want)
		}
	}
}
