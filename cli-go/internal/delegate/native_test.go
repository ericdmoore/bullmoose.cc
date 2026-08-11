package delegate

import "testing"

// TestOwnedNatively pins the guard that decides whether an invocation stays with
// a native command or falls through to Node. The rule: native owns it iff every
// flag is one the wave-1 commands consume. Help and unowned/unknown flags must
// delegate, so those paths stay byte-identical to the TypeScript CLI.
func TestOwnedNatively(t *testing.T) {
	cases := []struct {
		argv []string
		want bool
	}{
		// Owned: the wave-1 flag set, in every shape.
		{[]string{"mailboxes"}, true},
		{[]string{"mailboxes", "--json"}, true},
		{[]string{"mailboxes", "--ids"}, true},
		{[]string{"search", "invoice", "--ids"}, true},
		{[]string{"search", "zzzzz-no-such-term"}, true}, // hyphen positional, not a flag
		{[]string{"log", "-n", "100"}, true},
		{[]string{"log", "--n", "5", "--json"}, true},
		{[]string{"log", "--account", "default"}, true},
		{[]string{"log", "--account=default"}, true},
		{[]string{"log", "--db", "/tmp/x.db", "--json"}, true},
		{[]string{"log", "--mailbox", "inbox"}, true},
		{[]string{"search", "--", "--json"}, true},  // -- ends options
		{[]string{"contacts", "import", "-"}, true}, // bare - is a positional

		// Not owned → delegate to Node.
		{[]string{"log", "--help"}, false},
		{[]string{"log", "-h"}, false},
		{[]string{"log", "--no-such-flag"}, false},
		{[]string{"mailboxes", "--force"}, false}, // known to Node, not to us
		{[]string{"log", "--man"}, false},
		{[]string{"accounts", "--markdown"}, false},
	}
	for _, c := range cases {
		if got := ownedNatively(c.argv); got != c.want {
			t.Errorf("ownedNatively(%q) = %v, want %v", c.argv, got, c.want)
		}
	}
}

// TestRegisterPopulatesNative guards the wiring Register does for cmd.Install.
func TestRegisterPopulatesNative(t *testing.T) {
	before := len(native)
	Register("__test_cmd__", func([]string) int { return 7 })
	defer delete(native, "__test_cmd__")
	if len(native) != before+1 {
		t.Fatalf("Register did not add to native map")
	}
	if native["__test_cmd__"](nil) != 7 {
		t.Errorf("registered handler not callable")
	}
}
