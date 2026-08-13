package proposal

// Reading a reason the write path no longer accepts — the port of the
// `describeReason` cases in webmail/src/lib/approvals/rows.test.ts. The rule
// under test is the legacy-tolerance one: retiring `notNow` narrowed what may
// be WRITTEN, and history was NOT migrated, so a read must survive it.

import "testing"

func TestReasonLabel(t *testing.T) {
	// The live enum prints as itself — the terminal's register is the enum
	// spelling, so `reason=wrongContent` stays greppable.
	for _, live := range []string{"wrongContent", "wrongAction", "unsafe"} {
		if got := ReasonLabel(live); got != live {
			t.Errorf("ReasonLabel(%q) = %q, want it unchanged", live, got)
		}
	}

	// A retired reason prints as ITSELF, marked. Not remapped: "notNow"
	// appearing as "wrongAction" would attribute a judgment the human never
	// made. Not dropped: that erases why the proposal was declined.
	if got := ReasonLabel("notNow"); got != "notNow (retired)" {
		t.Errorf("ReasonLabel(\"notNow\") = %q, want \"notNow (retired)\"", got)
	}

	// Anything else is carried through verbatim rather than refused. A reader
	// that failed on a value it did not recognise would make every future
	// taxonomy revision break every older client.
	for _, unknown := range []string{"someFutureReason", "", "  ", "needsInfo"} {
		if got := ReasonLabel(unknown); got != unknown {
			t.Errorf("ReasonLabel(%q) = %q, want it verbatim", unknown, got)
		}
	}
}
