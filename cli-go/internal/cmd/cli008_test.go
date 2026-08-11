package cmd

import "testing"

// cli008AdvertisedJSON is the regression set from `.feedback/fromClaude/cli/008`:
// the eight commands on which --json was advertised (it is a GLOBAL flag) yet
// silently ignored. Quoted from the finding verbatim, NOT derived from the spec,
// so it cannot drift out from under the requirement. `token list` is absent on
// purpose — it already honoured --json and was the fix's reference
// implementation.
var cli008AdvertisedJSON = []string{
	"init", "discover", "sync", "accounts",
	"send", "vacation", "token create", "token revoke",
}

// Test_cli008_AdvertisedJSONIsHonoured is the up-front regression test for
// `.feedback/fromClaude/cli/008` — `--json` a silent no-op on eight commands.
//
// The requirement: a command that advertises --json must actually honour it. A
// silently-ignored flag is worse than an error for an agent-first CLI — the
// agent gets human text where it asked for JSON, with no signal. The TypeScript
// fix implemented --json everywhere (login/token create first, since they emit
// once-only secrets people script). The registry is where the native port
// records that capability honestly (registry[cmd].json), so this test asserts
// every command in the regression set that is served natively also claims JSON.
//
// Expected to SKIP now (registry empty) and to tighten command-by-command as T6
// makes each native: an implemented command that fails to honour --json fails
// this test immediately; the rest keep it skipping until all eight are native.
func Test_cli008_AdvertisedJSONIsHonoured(t *testing.T) {
	var pending, failing []string
	for _, name := range cli008AdvertisedJSON {
		jsonOK, implemented := SupportsJSON(name)
		switch {
		case !implemented:
			pending = append(pending, name)
		case !jsonOK:
			failing = append(failing, name)
		}
	}

	if len(failing) > 0 {
		t.Fatalf("cli/008: served natively but --json is a silent no-op on %v — "+
			"--json is a global flag; a command that advertises it must emit JSON", failing)
	}
	if len(pending) > 0 {
		t.Skipf("cli/008: %d command(s) not yet native (s08 T6): %v — "+
			"each honouring --json flips it from skipped to enforced; the last one makes this test fully green", len(pending), pending)
	}
}
