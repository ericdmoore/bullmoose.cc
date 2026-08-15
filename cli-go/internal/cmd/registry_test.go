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
	type installed struct {
		value, boolean, short []string
	}
	got := map[string]installed{}
	nativeOnly := map[string]bool{}
	Install(
		func(string, func([]string) int) {},
		func(command string) { nativeOnly[command] = true },
		func(command string, value, boolean, short []string) {
			got[command] = installed{value, boolean, short}
		},
	)

	for name, s := range registry {
		if s.goNative {
			if !nativeOnly[name] {
				t.Errorf("%s is goNative but was not registered as native-only", name)
			}
			if _, ok := got[name]; ok {
				t.Errorf("%s is goNative — it has no Node twin, so it needs no byte-identity guard", name)
			}
			continue
		}
		flags, ok := got[name]
		if !ok {
			t.Errorf("%s has a Node twin but no flag set was installed — every invocation would delegate", name)
			continue
		}
		if !contains(flags.value, "db") {
			t.Errorf("%s does not own --db; the mirror path could never be chosen natively", name)
		}
		if s.json && !contains(flags.boolean, "json") {
			t.Errorf("%s claims --json (cli/008) but does not own the flag, so every "+
				"--json invocation delegates and the claim is untested", name)
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
