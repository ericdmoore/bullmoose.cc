package proposal

import "testing"

// s11 T9 — the numbers-first summary, and the one thing it may never do:
// invent a dollar figure it does not have.

func budgetPayload(over map[string]any) map[string]any {
	p := map[string]any{
		"bindingId":        "bind_photos",
		"bindingName":      "photos",
		"waitingCount":     float64(12),
		"monthSpentMicros": float64(5_000_000),
		"capMicros":        float64(5_000_000),
		"estimateMicros":   float64(1_800_000),
		"overageMicros":    float64(2_250_000),
		"periodKey":        "2026-08",
	}
	for k, v := range over {
		if v == nil {
			delete(p, k)
			continue
		}
		p[k] = v
	}
	return p
}

func TestBudgetOverrun_SummaryLeadsWithTheNumbers(t *testing.T) {
	b := ParseBudgetOverrun(budgetPayload(nil))
	got := b.Summary("bind_photos")
	want := "12 waiting · $5.00 of $5.00 spent · ~$1.80 to clear — approve a $2.25 overage for photos"
	if got != want {
		t.Fatalf("summary = %q, want %q", got, want)
	}
	// The count is the FIRST token: the list column truncates, and truncation
	// must never eat the number the decision turns on.
	if got[:2] != "12" {
		t.Fatalf("summary does not lead with the count: %q", got)
	}
}

func TestBudgetOverrun_UnknownCostIsNeverPrintedAsZero(t *testing.T) {
	// No paid history → the sweep sends estimateMicros: null. A "$0.00 to clear"
	// on a spend decision would be the one lie that matters.
	for name, payload := range map[string]map[string]any{
		"null":   budgetPayload(map[string]any{"estimateMicros": nil}),
		"absent": budgetPayload(map[string]any{"estimateMicros": nil}),
	} {
		b := ParseBudgetOverrun(payload)
		if b.EstimateMicros != nil {
			t.Fatalf("%s: estimate should be unknown, got %d", name, *b.EstimateMicros)
		}
		got := b.Summary("bind_photos")
		want := "12 waiting · $5.00 of $5.00 spent · cost unknown — approve a $2.25 overage for photos"
		if got != want {
			t.Fatalf("%s: summary = %q, want %q", name, got, want)
		}
	}
}

func TestBudgetOverrun_DegradesRatherThanInventing(t *testing.T) {
	b := ParseBudgetOverrun(map[string]any{})
	got := b.Summary("bind_photos")
	want := "? waiting · budget spent · cost unknown — approve an overage for bind_photos"
	if got != want {
		t.Fatalf("summary = %q, want %q", got, want)
	}
	// A string where a number belongs is unknown, not zero.
	if ParseBudgetOverrun(map[string]any{"capMicros": "5"}).CapMicros != nil {
		t.Fatal("a string cap should read as unknown")
	}
}

func TestRowSummary_OnlyBudgetOverrunDivertsFromTheRationale(t *testing.T) {
	budget := &Proposal{
		Kind:      "budget-overrun",
		Rationale: "photos has spent...\nsecond line",
		Payload:   budgetPayload(nil),
		Subject:   Subject{Realm: "AgentBinding", ObjectID: "bind_photos"},
	}
	if got := RowSummary(budget); got[:2] != "12" {
		t.Fatalf("budget-overrun row should lead with the count, got %q", got)
	}
	// Every other kind is untouched: first line of the rationale, as before.
	reply := &Proposal{Kind: "reply-draft", Rationale: "Drafted a reply\nmore"}
	if got := RowSummary(reply); got != "Drafted a reply" {
		t.Fatalf("reply-draft row summary = %q, want the rationale's first line", got)
	}
}

func TestUSD_MicroDollarsRenderAtTheEdgeOnly(t *testing.T) {
	for _, c := range []struct {
		micros int64
		want   string
	}{{0, "$0.00"}, {1, "$0.00"}, {10_000, "$0.01"}, {1_000_000, "$1.00"}, {1_234_567, "$1.23"}} {
		if got := USD(c.micros); got != c.want {
			t.Fatalf("USD(%d) = %q, want %q", c.micros, got, c.want)
		}
	}
}

func TestIsBudgetOverrun(t *testing.T) {
	if !IsBudgetOverrun("budget-overrun") {
		t.Fatal("budget-overrun should be recognised")
	}
	for _, k := range []string{"reply-draft", "grant-request", "", "budget"} {
		if IsBudgetOverrun(k) {
			t.Fatalf("%q should not be a budget-overrun", k)
		}
	}
}
