package proposal

import (
	"fmt"
	"math"
)

// s11 T9 — the `budget-overrun` proposal, in the terminal.
//
// The kind whose payload is ENTIRELY numbers: a binding is out of its monthly
// budget, N invocations are waiting on it, and the question is whether to
// approve a bounded overage. Nothing here is persuasion, so the one-line form
// LEADS WITH THE NUMBERS — count, spend against ceiling, cost to clear — before
// it names the binding. A port of webmail's `summarizeProposal` case
// (webmail/src/lib/approvals/rows.ts), field for field, because that projection
// is the contract both surfaces read.
//
// The one rule worth stating twice: an ABSENT estimate prints "cost unknown",
// never "$0.00". The sweep reports null when the binding has no paid cost
// history (packages/scheduling `bindingMedianCostMicros`), and a plausible
// dollar figure invented at the render edge would be the single lie that
// matters on a spend decision.

// BudgetOverrun is the payload of a `budget-overrun` proposal. Every money field
// is micro-USD (1 USD = 1,000,000), the unit the whole budget path speaks; the
// pointers are the fields that may honestly be absent.
type BudgetOverrun struct {
	BindingID    string
	BindingName  string
	WaitingCount *int64
	SpentMicros  *int64
	CapMicros    *int64
	// EstimateMicros is nil when the binding has NO paid cost history — the
	// honest "unknown", never a zero.
	EstimateMicros *int64
	// OverageMicros is the BOUND an approve applies: this binding, this period,
	// this many micro-USD. Editable before approval (`approvals edit`).
	OverageMicros *int64
	PeriodKey     string
}

// IsBudgetOverrun reports whether this kind carries the numeric budget payload.
func IsBudgetOverrun(kind string) bool { return kind == "budget-overrun" }

// ParseBudgetOverrun reads the payload defensively, in the same spots webmail's
// summarizer is: a missing or non-numeric field becomes "unknown" rather than
// dropping the row out of a queue that still needs deciding.
func ParseBudgetOverrun(payload map[string]any) BudgetOverrun {
	return BudgetOverrun{
		BindingID:      strField(payload, "bindingId"),
		BindingName:    strField(payload, "bindingName"),
		WaitingCount:   intField(payload, "waitingCount"),
		SpentMicros:    intField(payload, "monthSpentMicros"),
		CapMicros:      intField(payload, "capMicros"),
		EstimateMicros: intField(payload, "estimateMicros"),
		OverageMicros:  intField(payload, "overageMicros"),
		PeriodKey:      strField(payload, "periodKey"),
	}
}

// Summary is the one-line, numbers-first form — byte-identical in shape to
// webmail's, so a human moving between the two surfaces reads the same sentence.
func (b BudgetOverrun) Summary(subjectObjectID string) string {
	count := "?"
	if b.WaitingCount != nil {
		count = fmt.Sprintf("%d", *b.WaitingCount)
	}
	spend := "budget spent"
	if b.SpentMicros != nil && b.CapMicros != nil {
		spend = USD(*b.SpentMicros) + " of " + USD(*b.CapMicros) + " spent"
	}
	clear := "cost unknown"
	if b.EstimateMicros != nil {
		clear = "~" + USD(*b.EstimateMicros) + " to clear"
	}
	bound := "an"
	if b.OverageMicros != nil {
		bound = "a " + USD(*b.OverageMicros)
	}
	who := b.BindingName
	if who == "" {
		who = b.BindingID
	}
	if who == "" {
		who = subjectObjectID
	}
	return fmt.Sprintf("%s waiting · %s · %s — approve %s overage for %s", count, spend, clear, bound, who)
}

// RowSummary is what the `approvals list` table prints in its last column: the
// numbers-first line for a budget-overrun, and the rationale's first line for
// every other kind (unchanged — this is additive by construction).
func RowSummary(p *Proposal) string {
	if IsBudgetOverrun(p.Kind) {
		return ParseBudgetOverrun(p.Payload).Summary(p.Subject.ObjectID)
	}
	return firstLine(p.Rationale)
}

// USD renders micro-USD as "$1.23". Money stays integral until the render edge,
// here and in webmail alike.
func USD(micros int64) string {
	return fmt.Sprintf("$%.2f", float64(micros)/1_000_000)
}

// intField reads a JSON number as an integer, or nil when the field is absent,
// null or not a finite number. `encoding/json` decodes into float64 for `any`,
// so this is where micro-USD comes back to an integer.
func intField(payload map[string]any, key string) *int64 {
	v, ok := payload[key]
	if !ok {
		return nil
	}
	f, ok := v.(float64)
	if !ok || math.IsNaN(f) || math.IsInf(f, 0) {
		return nil
	}
	n := int64(f)
	return &n
}

// firstLine mirrors the cmd-side helper of the same name; duplicated rather than
// exported across the package boundary because `proposal` is the pure layer and
// must not import the shell.
func firstLine(s string) string {
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			return s[:i]
		}
	}
	return s
}
