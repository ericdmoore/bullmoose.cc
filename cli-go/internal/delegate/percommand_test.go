package delegate

import "testing"

// TestPerCommandOwnedFlags is the guard on the guard.
//
// `watch` is the first PORTED command (one with a Node twin) whose flags are
// outside the wave-1 vocabulary. Two failure modes sit either side of this, and
// only a test distinguishes them:
//
//   - too narrow: `watch --exec …` delegates to Node forever, so the port is
//     "done" and never runs. Nothing else notices — the contract suite does not
//     exercise watch, and BULLMOOSE_TRACE just says `delegated`.
//   - too wide: `--exec` owned globally makes `log --exec rm -rf /` run natively
//     and IGNORE the flag, where Node exits 2. That is a byte-identity break on a
//     command nobody was porting.
func TestPerCommandOwnedFlags(t *testing.T) {
	RegisterOwnedFlags("watch", []string{"exec"}, []string{"daemon", "status", "stop"})
	t.Cleanup(func() {
		delete(perCommandValueFlags, "watch")
		delete(perCommandBoolFlags, "watch")
	})

	cases := []struct {
		argv []string
		want bool
		why  string
	}{
		{[]string{"watch"}, true, "the bare command"},
		{[]string{"watch", "--json"}, true, "a shared flag still works"},
		{[]string{"watch", "--exec", "notify-send x"}, true, "watch owns --exec"},
		{[]string{"watch", "--exec=notify-send x"}, true, "inline form too"},
		{[]string{"watch", "--daemon"}, true, "watch owns --daemon"},
		{[]string{"watch", "--status", "--json"}, true, "watch owns --status"},
		{[]string{"watch", "--stop"}, true, "watch owns --stop"},
		{[]string{"watch", "--db", "/tmp/x.db", "--exec", "true"}, true, "shared + own"},

		{[]string{"watch", "--help"}, false, "help stays with Node's help system"},
		{[]string{"watch", "-h"}, false, "so does -h"},
		{[]string{"watch", "--force"}, false, "a flag neither side of watch owns"},

		// The flags are watch's ALONE.
		{[]string{"log", "--exec", "true"}, false, "--exec is not log's; Node must reject it"},
		{[]string{"log", "--daemon"}, false, "--daemon is not log's"},
		{[]string{"mailboxes", "--stop"}, false, "--stop is not mailboxes'"},
	}
	for _, c := range cases {
		if got := ownedNatively(c.argv); got != c.want {
			t.Errorf("ownedNatively(%q) = %v, want %v — %s", c.argv, got, c.want, c.why)
		}
	}
}

// TestPerCommandFlagsAreOffByDefault: with nothing registered, the guard is
// exactly the wave-1 one. A future command that forgets to declare its flags
// therefore over-delegates (safe) rather than over-claiming (not).
func TestPerCommandFlagsAreOffByDefault(t *testing.T) {
	if ownedNatively([]string{"watch", "--exec", "true"}) {
		t.Error("watch owns --exec with nothing registered — the per-command set leaked into the shared one")
	}
}
