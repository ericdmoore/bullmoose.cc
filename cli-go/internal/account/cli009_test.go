package account

import (
	"errors"
	"testing"
)

// Test_cli009_OneAccountResolutionRule is the up-front regression test for
// `.feedback/fromClaude/cli/009` — account resolution inconsistent across
// commands.
//
// The requirement, phrased to catch the original bug: a single resolver decides
// what a selector means, and a selector that matches more than one account is an
// error, NOT a silent pick-first. The original defect had `send`/`read`/
// `vacation` take matches[0] silently while `contacts`/`calendar` refused — so
// the same selector meant different things depending on the command typed. Pick
// is the one rule; the test pins its three outcomes.
//
// Expected to SKIP now (Pick returns ErrNotImplemented) and to enforce itself
// the instant T6 writes the resolver — no edit to this test.
func Test_cli009_OneAccountResolutionRule(t *testing.T) {
	// Two accounts that a loose selector matches BOTH — the shape that made
	// silent pick-first dangerous.
	accounts := []Account{
		{AccountID: "t_1__a_1", Address: "eric@bullmoose.cc", Name: "Eric"},
		{AccountID: "t_1__a_2", Address: "team@bullmoose.cc", Name: "Team"},
	}

	if _, err := Pick(accounts, "bullmoose.cc"); errors.Is(err, ErrNotImplemented) {
		t.Skipf("cli/009: native account resolution not implemented yet (s08 T6); "+
			"this flips to enforced the moment Pick refuses an ambiguous selector. got err=%v", err)
	}

	t.Run("ambiguous selector is refused, never silently resolved", func(t *testing.T) {
		got, err := Pick(accounts, "bullmoose.cc")
		if err == nil {
			t.Fatalf("cli/009: an ambiguous --account resolved to %+v — it must refuse; "+
				"silent pick-first is how `send` chose the wrong identity", got)
		}
		if !errors.Is(err, ErrAmbiguous) {
			t.Errorf("cli/009: ambiguous selector should be ErrAmbiguous (usage / exit 2), got %v", err)
		}
	})

	t.Run("no match is an error, not a fallback", func(t *testing.T) {
		got, err := Pick(accounts, "nope@elsewhere.example")
		if err == nil {
			t.Fatalf("cli/009: a selector matching nothing resolved to %+v — it must error", got)
		}
		if !errors.Is(err, ErrNoMatch) {
			t.Errorf("cli/009: no-match should be ErrNoMatch (not found / exit 3), got %v", err)
		}
	})

	t.Run("a unique match resolves", func(t *testing.T) {
		got, err := Pick(accounts, "eric@bullmoose.cc")
		if err != nil {
			t.Fatalf("cli/009: a unique selector should resolve, got error %v", err)
		}
		if got.AccountID != "t_1__a_1" {
			t.Errorf("cli/009: unique selector resolved to %q, want t_1__a_1", got.AccountID)
		}
	})
}
