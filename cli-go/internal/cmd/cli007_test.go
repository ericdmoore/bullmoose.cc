package cmd

import (
	"errors"
	"testing"
)

// Test_cli007_TokenCreateRequiresExplicitScopes is the up-front regression test
// for `.feedback/fromClaude/cli/007` — `token create` defaulting to the widest
// scope.
//
// The requirement, phrased to catch the original bug rather than the fix: with
// no --scopes, `token create` must FAIL with a usage error; it must never
// substitute a scope, least of all "mail" (the widest). An explicit --scopes is
// honoured verbatim.
//
// Expected to SKIP now (TokenCreateScopes returns ErrNotImplemented) and to
// enforce itself the instant T6 implements the seam — no edit to this test.
func Test_cli007_TokenCreateRequiresExplicitScopes(t *testing.T) {
	got, err := TokenCreateScopes(nil)
	if errors.Is(err, ErrNotImplemented) {
		t.Skipf("cli/007: native `token create` not implemented yet (s08 T6); "+
			"this flips to enforced the moment TokenCreateScopes requires the flag. got err=%v", err)
	}

	// The load-bearing assertion: an omitted flag is a usage error, not a
	// default.
	if err == nil {
		t.Fatalf("cli/007: `token create` with no --scopes returned %v with no error — "+
			"it must require --scopes, never default (the original bug defaulted to the widest scope)", got)
	}
	// Belt and braces: whatever a future implementation does on the absent
	// path, it must not hand back the widest credential. "mail" is the exact
	// regression.
	for _, s := range got {
		if s == "mail" {
			t.Fatalf("cli/007: `token create` produced %q with no explicit --scopes — the exact regression", s)
		}
	}

	// The positive path: an explicit, narrow set is accepted and returned.
	explicit := "read,draft"
	scopes, err := TokenCreateScopes(&explicit)
	if err != nil {
		t.Fatalf("cli/007: explicit --scopes %q was rejected: %v", explicit, err)
	}
	if !equalUnordered(scopes, []string{"read", "draft"}) {
		t.Errorf("cli/007: explicit --scopes %q resolved to %v, want [read draft]", explicit, scopes)
	}
}

func equalUnordered(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	seen := map[string]int{}
	for _, x := range a {
		seen[x]++
	}
	for _, x := range b {
		seen[x]--
	}
	for _, n := range seen {
		if n != 0 {
			return false
		}
	}
	return true
}
