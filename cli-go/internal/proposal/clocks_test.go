package proposal

import (
	"testing"
	"time"
)

// iso renders an epoch-ms as the wire timestamp (Date.prototype.toISOString).
func iso(ms int64) string {
	return time.UnixMilli(ms).UTC().Format("2006-01-02T15:04:05.000Z07:00")
}

const day = int64(24 * 60 * 60 * 1000)

func TestFormatDuration(t *testing.T) {
	cases := []struct {
		ms   int64
		want string
	}{
		{0, "0s"},
		{5_000, "5s"},
		{-5_000, "5s"}, // abs
		{90_000, "1m 30s"},
		{9 * 60_000, "9m 0s"},
		{10 * 60_000, "10m"},
		{65 * 60_000, "1h 5m"},
		{(26*3600 + 5*60) * 1000, "1d 2h"},
	}
	for _, c := range cases {
		if got := FormatDuration(c.ms); got != c.want {
			t.Errorf("FormatDuration(%d) = %q, want %q", c.ms, got, c.want)
		}
	}
}

// TestClocksStayDistinct is the load-bearing two-clock test (s07 §T0): a row that
// carries BOTH expiresAt and holdUntil must never render them as one number. A
// pending row shows expiresIn (from expiresAt) and no hold; a held row shows
// holdRemaining (from holdUntil) and no expiry — each sourced from its own field,
// gated on status. Mirrors clocks.test.ts's "row carrying both".
func TestClocksStayDistinct(t *testing.T) {
	now := time.Now().UnixMilli()

	pending := &Proposal{
		Status:    "pending",
		CreatedAt: iso(now - 2*day),
		ExpiresAt: iso(now + 3*day), // decision deadline
		HoldUntil: iso(now + 1*day), // present but MUST be ignored while pending
	}
	pc := pending.Clocks(now)
	if pc.ExpiresInMs == nil {
		t.Fatal("pending: expiresIn must be set from expiresAt")
	}
	if pc.HoldRemainingMs != nil {
		t.Error("pending: holdRemaining must be nil — holdUntil is not this row's clock")
	}
	if got := *pc.ExpiresInMs; got < 2*day || got > 3*day {
		t.Errorf("pending: expiresIn = %d, want ~3d", got)
	}

	held := &Proposal{
		Status:    "held",
		CreatedAt: iso(now - 2*day),
		DecidedAt: iso(now - 1*day),
		ExpiresAt: iso(now + 3*day), // present but MUST be ignored while held
		HoldUntil: iso(now + 4*60_000),
	}
	hc := held.Clocks(now)
	if hc.HoldRemainingMs == nil {
		t.Fatal("held: holdRemaining must be set from holdUntil")
	}
	if hc.ExpiresInMs != nil {
		t.Error("held: expiresIn must be nil — the deadline is moot once held")
	}
	if got := *hc.HoldRemainingMs; got <= 0 || got > 5*60_000 {
		t.Errorf("held: holdRemaining = %d, want ~4m", got)
	}
}

func TestWaitedForMs_FreezesOnDecision(t *testing.T) {
	now := time.Now().UnixMilli()

	// Pending: still accruing → now - created.
	p := &Proposal{Status: "pending", CreatedAt: iso(now - 3*day)}
	if got := p.WaitedForMs(now); got < 3*day-1000 || got > 3*day+1000 {
		t.Errorf("pending waited = %d, want ~3d", got)
	}
	// Decided: frozen at decidedAt (history must not keep accruing shame).
	d := &Proposal{Status: "approved", CreatedAt: iso(now - 3*day), DecidedAt: iso(now - 1*day)}
	if got := d.WaitedForMs(now); got != 2*day {
		t.Errorf("decided waited = %d, want exactly 2d", got)
	}
	// Expired: no decidedAt, freezes at expiresAt (the sweep writes no decidedAt).
	e := &Proposal{Status: "expired", CreatedAt: iso(now - 3*day), ExpiresAt: iso(now - 1*day)}
	if got := e.WaitedForMs(now); got != 2*day {
		t.Errorf("expired waited = %d, want exactly 2d", got)
	}
}

func TestLabels(t *testing.T) {
	overdue := int64(-90_000)
	future := int64(2 * 60 * 60 * 1000)
	var none *int64
	holdFuture := int64(3 * 60_000)
	holdLapsed := int64(-1)

	if got := ExpiryLabel(&future); got != "expires in 2h 0m" {
		t.Errorf("ExpiryLabel(future) = %q", got)
	}
	if got := ExpiryLabel(&overdue); got != "decision window passed 1m 30s ago" {
		t.Errorf("ExpiryLabel(overdue) = %q", got)
	}
	if got := ExpiryLabel(none); got != "no deadline" {
		t.Errorf("ExpiryLabel(nil) = %q", got)
	}
	// The hold label must never read as egress.
	if got := HoldLabel(&holdFuture); got != "retraction window ends in 3m 0s — nothing has been sent" {
		t.Errorf("HoldLabel(future) = %q", got)
	}
	if got := HoldLabel(&holdLapsed); got == "" || !contains(got, "still not sent") {
		t.Errorf("HoldLabel(lapsed) = %q, must say still-not-sent", got)
	}
	if got := HoldLabel(nil); got != "" {
		t.Errorf("HoldLabel(nil) = %q, want empty", got)
	}
	pendingWaited := WaitedLabel("pending", RowClocks{WaitedMs: 5000})
	if pendingWaited != "waiting on you 5s" {
		t.Errorf("WaitedLabel(pending) = %q", pendingWaited)
	}
	if got := WaitedLabel("approved", RowClocks{WaitedMs: 5000}); got != "sat with you 5s" {
		t.Errorf("WaitedLabel(decided) = %q", got)
	}
}

// TestOrderQueue pins the urgency order: pending soonest-deadline-first (no
// deadline last), then held, then history newest-first (clocks.ts:138).
func TestOrderQueue(t *testing.T) {
	now := time.Now().UnixMilli()
	// Deliberately NOT in order, so a caller that forgot to sort fails.
	in := []*Proposal{
		{ID: "history", Status: "approved", DecidedAt: iso(now - 10*day), CreatedAt: iso(now - 11*day)},
		{ID: "no-deadline", Status: "pending", CreatedAt: iso(now - 3*day)},
		{ID: "held", Status: "held", HoldUntil: iso(now + 60_000), CreatedAt: iso(now - 5*day)},
		{ID: "later", Status: "pending", ExpiresAt: iso(now + 2*day), CreatedAt: iso(now - 1*day)},
		{ID: "soon", Status: "pending", ExpiresAt: iso(now + 1*day), CreatedAt: iso(now - 1*day)},
	}
	got := OrderQueue(in)
	want := []string{"soon", "later", "no-deadline", "held", "history"}
	for i, w := range want {
		if got[i].ID != w {
			t.Fatalf("OrderQueue position %d = %q, want %q (full: %s)", i, got[i].ID, w, ids(got))
		}
	}
}

func ids(ps []*Proposal) string {
	out := ""
	for i, p := range ps {
		if i > 0 {
			out += ","
		}
		out += p.ID
	}
	return out
}

func contains(s, sub string) bool {
	return len(sub) == 0 || (len(s) >= len(sub) && indexOf(s, sub) >= 0)
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
