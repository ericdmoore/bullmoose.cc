package cmd

import (
	"testing"
)

// TestRegistryFlagsAreInstalled pins the wiring Install does, and the invariant
// that makes the cli/008 capability bit meaningful.
//
// A ported command's `--json` claim is only true if `--json` is ALSO in the flags
// the delegate guard lets it own: otherwise every `--json` invocation delegates,
// the claim is never exercised natively, and SupportsJSON reports a capability
// this binary does not actually serve. Same for `--db`, without which no test —
// and no `BULLMOOSE_DB`-less user — could route to the native path at all.
func TestRegistryFlagsAreInstalled(t *testing.T) {
	// Post-removal, the registry's flag lists feed Route's guard DIRECTLY
	// (unownedFlag) — there is no Install indirection left to observe, so the
	// guarantees are asserted against the registry itself. The stakes moved,
	// not the shape: an unlisted flag used to delegate; now it REFUSES, so a
	// missing --db or --json is a command refusing its own documented flags.
	for name, s := range registry {
		if s.goNative {
			// Route skips the flag guard for goNative commands (they answer
			// their own --help and self-govern their grammar); a flag list on
			// one would be dead config masquerading as a guard.
			if len(s.value)+len(s.boolean)+len(s.short) > 0 {
				t.Errorf("%s is goNative — Route never consults its flag lists; delete them or drop goNative", name)
			}
			continue
		}
		if !contains(s.value, "db") {
			t.Errorf("%s does not own --db; `--db <path>` would be refused on a documented global flag", name)
		}
		if s.json && !contains(s.boolean, "json") {
			t.Errorf("%s claims --json (cli/008) but does not own the flag, so every "+
				"--json invocation would be refused and the claim is untested", name)
		}
	}
}

// The drift check in the other direction — a flag a command owns must be one the
// parser actually reads, at the arity it is declared at — now lives in
// parsergrammar_test.go's TestRegistryFlagsAreTheParsersOwn, which reads the
// `switch name` out of args.go's AST instead of comparing against a copy of it
// kept here.
//
// The copy was the problem. It could only ever be as current as the last person
// to edit both, and it could not see arity at all: a flag that changed from
// `a.X = value()` to `a.X = true` in parse() left this list correct, this test
// green, and the value the user typed silently reinterpreted as a positional.
// It also covered neither the selfParses commands nor the goNative ones.

func contains(haystack []string, needle string) bool {
	for _, s := range haystack {
		if s == needle {
			return true
		}
	}
	return false
}
