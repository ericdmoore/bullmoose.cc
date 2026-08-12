package proposal

import (
	"fmt"
	"math"
	"sort"
	"time"
)

// The queue's two clocks and its order — a straight port of
// webmail/src/lib/approvals/clocks.ts, kept pure so the two-clock rule is a unit
// test rather than a rendering accident.
//
// Every pending row carries TWO OPPOSED marks (s07 devPlan §T0):
//
//	waited for   how long this has sat on the HUMAN. Starts at zero and GROWS.
//	expires in   `expiresAt − now`, the pre-decision deadline. SHRINKS.
//
// And `holdUntil` is NEITHER: the tier-2 post-approval retraction window. This
// module never lets the two meet — `expiresIn` sources from `expiresAt` alone,
// `holdRemaining` from `holdUntil` alone, each gated on status.

// NearExpiry — under an hour left to decide renders urgent (clocks.ts:24).
const NearExpiry = time.Hour

// RowClocks is what a row's clock strip shows; a nil pointer means "does not
// apply" (clocks.ts:27, the RowClocks interface).
type RowClocks struct {
	// WaitedMs grows while undecided; frozen at decidedAt once decided.
	WaitedMs int64
	// ExpiresInMs is set only for a pending row. Negative = past the deadline.
	ExpiresInMs *int64
	// HoldRemainingMs is set only for a held row. Negative = window closed.
	HoldRemainingMs *int64
}

// parseMs is Date.parse: milliseconds since the epoch, ok=false for an empty
// (wire `null`) or unparseable timestamp.
func parseMs(iso string) (int64, bool) {
	if iso == "" {
		return 0, false
	}
	t, err := time.Parse(time.RFC3339, iso)
	if err != nil {
		return 0, false
	}
	return t.UnixMilli(), true
}

// WaitedForMs is how long the proposal has sat on the human — clocks.ts:43. For
// a decided row the clock froze at decidedAt; an expired row (no decidedAt, per
// the sweep) freezes at expiresAt; otherwise it is still accruing, so `now`.
func (p *Proposal) WaitedForMs(now int64) int64 {
	created, ok := parseMs(p.CreatedAt)
	if !ok {
		return 0
	}
	frozenAt := now
	switch {
	case p.DecidedAt != "":
		// decidedAt present wins even if unparseable (→ now), matching the JS
		// ternary that checks `decidedAt !== null` before the expired branch.
		if d, ok := parseMs(p.DecidedAt); ok {
			frozenAt = d
		}
	case p.Status == "expired" && p.ExpiresAt != "":
		if e, ok := parseMs(p.ExpiresAt); ok {
			frozenAt = e
		}
	}
	if frozenAt < created {
		return 0 // Math.max(0, …)
	}
	return frozenAt - created
}

// Clocks computes the two opposed marks, gated on status so they can never be
// conflated — clocks.ts:58 rowClocks.
func (p *Proposal) Clocks(now int64) RowClocks {
	rc := RowClocks{WaitedMs: p.WaitedForMs(now)}
	if p.Status == "pending" {
		if e, ok := parseMs(p.ExpiresAt); ok {
			v := e - now
			rc.ExpiresInMs = &v
		}
	}
	if p.Status == "held" {
		if h, ok := parseMs(p.HoldUntil); ok {
			v := h - now
			rc.HoldRemainingMs = &v
		}
	}
	return rc
}

// IsNearExpiry — clocks.ts:71.
func (c RowClocks) IsNearExpiry() bool {
	return c.ExpiresInMs != nil && *c.ExpiresInMs < NearExpiry.Milliseconds()
}

// FormatDuration is the compact duration for the clock strip — clocks.ts:81.
// Coarse when there is slack, seconds when short enough to watch move.
func FormatDuration(ms int64) string {
	if ms < 0 {
		ms = -ms
	}
	total := ms / 1000
	d := total / 86_400
	h := (total % 86_400) / 3600
	m := (total % 3600) / 60
	s := total % 60
	switch {
	case d > 0:
		return fmt.Sprintf("%dd %dh", d, h)
	case h > 0:
		return fmt.Sprintf("%dh %dm", h, m)
	case m >= 10:
		return fmt.Sprintf("%dm", m)
	case m > 0:
		return fmt.Sprintf("%dm %ds", m, s)
	default:
		return fmt.Sprintf("%ds", s)
	}
}

// WaitedLabel is the growing mark, present tense while it still sits (clocks.ts:95).
func WaitedLabel(status string, c RowClocks) string {
	if status == "pending" {
		return "waiting on you " + FormatDuration(c.WaitedMs)
	}
	return "sat with you " + FormatDuration(c.WaitedMs)
}

// ExpiryLabel is the shrinking mark; nil in, honest "no deadline" out, never
// invented (clocks.ts:102).
func ExpiryLabel(expiresInMs *int64) string {
	if expiresInMs == nil {
		return "no deadline"
	}
	if *expiresInMs <= 0 {
		return "decision window passed " + FormatDuration(-*expiresInMs) + " ago"
	}
	return "expires in " + FormatDuration(*expiresInMs)
}

// HoldLabel is the tier-2 retraction window, worded so it cannot be read as
// egress: nothing has been sent while it runs, and committing out of the tray is
// s03.D T2 and is not built (clocks.ts:118, actionProposal.ts:41-42, 268-271).
func HoldLabel(holdRemainingMs *int64) string {
	if holdRemainingMs == nil {
		return ""
	}
	if *holdRemainingMs <= 0 {
		return "retraction window lapsed — still not sent; committing out of the hold tray is not built yet (s03.D T2)"
	}
	return "retraction window ends in " + FormatDuration(*holdRemainingMs) + " — nothing has been sent"
}

// OrderQueue is the queue order — "ordered by urgency, pending first" (s07 §T4,
// clocks.ts:138). Pending soonest-deadline-first (no deadline last) then
// longest-waiting; held soonest-closing-window-first; history newest-decision
// first. Stable, so callers never re-sort in the renderer.
//
// The server's ActionProposal/query only orders newest-first by created_at
// (actionProposal.ts:156); urgency is a CLIENT ordering, exactly as webmail's
// api.ts:23 notes — so the CLI re-orders here rather than expecting it from the
// wire.
func OrderQueue(ps []*Proposal) []*Proposal {
	out := make([]*Proposal, len(ps))
	copy(out, ps)

	rank := func(p *Proposal) int {
		switch p.Status {
		case "pending":
			return 0
		case "held":
			return 1
		default:
			return 2
		}
	}
	timeOf := func(iso string, absent int64) int64 {
		if t, ok := parseMs(iso); ok {
			return t
		}
		return absent
	}
	const never = int64(math.MaxInt64) // JS Infinity: "no deadline sorts last"

	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if ra, rb := rank(a), rank(b); ra != rb {
			return ra < rb
		}
		switch a.Status {
		case "pending":
			if ad, bd := timeOf(a.ExpiresAt, never), timeOf(b.ExpiresAt, never); ad != bd {
				return ad < bd
			}
			if aa, ba := timeOf(a.CreatedAt, 0), timeOf(b.CreatedAt, 0); aa != ba {
				return aa < ba
			}
		case "held":
			if aw, bw := timeOf(a.HoldUntil, never), timeOf(b.HoldUntil, never); aw != bw {
				return aw < bw
			}
		default:
			if ad, bd := timeOf(a.DecidedAt, 0), timeOf(b.DecidedAt, 0); ad != bd {
				return ad > bd // newest decision first
			}
		}
		return a.ID < b.ID
	})
	return out
}
