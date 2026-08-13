package proposal

// Reading a decline reason that the enum no longer writes — pure rules only,
// the same split as clocks.go / edit.go / needsinfo.go, and the Go half of
// webmail's `describeReason` (lib/approvals/rows.ts).
//
// The taxonomy is revised in place over time: `.plans/s03.D-coexistence/
// decline-taxonomy.md` retired `notNow` (a grab-bag of "I'll do it myself",
// "not due yet" and "meh, later") and added `unsafe`. Retiring a reason narrows
// what may be WRITTEN — cmd/approvals.go `rejectReasons`, and the server's enum
// behind it — and nothing else. Recorded decisions are NOT migrated: a human's
// decision is a fact, and rewriting one to fit a later taxonomy would be the
// same audit hole this codebase refuses everywhere else.
//
// So every read path has to tolerate a reason this build would not accept. It
// renders as ITSELF, marked retired. Not remapped — "notNow" quietly printing
// as "wrongAction" would put a judgment in the human's mouth they never made —
// and not dropped, which would erase why a proposal was declined.

// RetiredReasons are reasons the server once accepted and no longer does. Kept
// here rather than beside `rejectReasons` because this is a READ concern: the
// write path only needs to know what is valid now.
var RetiredReasons = map[string]bool{"notNow": true}

// ReasonLabel is how a RECORDED reason prints. Tolerant by construction: it
// never errors and never substitutes.
//
//	a live reason   → itself ("wrongContent") — the terminal's register is the
//	                  enum spelling, unlike webmail, which shows the panel's prose
//	a retired one   → "notNow (retired)"
//	anything else   → itself, verbatim
func ReasonLabel(reason string) string {
	if RetiredReasons[reason] {
		return reason + " (retired)"
	}
	return reason
}
