package cmd

import (
	"sort"
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

// TestRegistryOwnsOnlyDeclaredFlags is the drift check in the other direction: a
// flag a command owns must be one the shared parser actually reads, or the native
// path silently ignores a flag the user typed — which on `send` means mail
// leaving under assumptions nobody made.
func TestRegistryOwnsOnlyDeclaredFlags(t *testing.T) {
	// The flags parse() understands (args.go). Kept here rather than derived,
	// because a reflective check would pass vacuously if parse lost a case.
	parsed := []string{
		"db", "account", "mailbox", "n", "json", "ids", "raw",
		"to", "cc", "bcc", "subject", "from", "identity", "file", "body",
	}
	sort.Strings(parsed)
	for name, s := range registry {
		if s.goNative {
			continue // owns its whole grammar in its own parser
		}
		for _, f := range append(append([]string{}, s.value...), s.boolean...) {
			if !contains(parsed, f) {
				t.Errorf("%s owns --%s but cmd.parse does not read it: the native path "+
					"would accept the flag and silently ignore it", name, f)
			}
		}
	}
}

func contains(haystack []string, needle string) bool {
	for _, s := range haystack {
		if s == needle {
			return true
		}
	}
	return false
}
