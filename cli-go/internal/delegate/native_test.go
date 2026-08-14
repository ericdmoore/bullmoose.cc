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

// TestOwnedNativelyIsPerCommand pins the guard's per-command shape, and with it
// the property that makes the wave-2 port safe: `send` owns exactly the flags its
// native path reads, so anything else — above all `--expandMD`, the Markdown →
// MIME pipeline that is NOT ported — reaches Node instead of being silently
// dropped by a native path that cannot honour it.
func TestOwnedNativelyIsPerCommand(t *testing.T) {
	RegisterFlags("read", []string{"db", "account"}, []string{"json", "ids", "raw"}, nil)
	RegisterFlags("send",
		[]string{"db", "account", "from", "identity", "to", "cc", "bcc", "subject", "file", "body"},
		[]string{"json"}, nil)
	RegisterFlags("log", []string{"db", "account", "mailbox", "n"}, []string{"json", "ids"}, []string{"n"})
	RegisterFlags("watch", []string{"db", "account", "exec"},
		[]string{"json", "daemon", "status", "stop"}, nil)
	defer func() { owned = map[string]flagSet{} }()

	cases := []struct {
		argv []string
		want bool
		why  string
	}{
		{[]string{"read", "em_1", "--raw"}, true, "read owns --raw"},
		{[]string{"read", "--json", "--account", "work"}, true, "read owns --json/--account"},
		{[]string{"read", "--to", "a@b.com"}, false, "--to is send's, not read's"},
		{[]string{"send", "--to", "a@b.com", "--subject", "s", "--body", "b"}, true, "the plain-text send"},
		{[]string{"send", "--to", "a@b.com", "--file", "-", "--json"}, true, "--file/-/--json are send's"},
		{[]string{"send", "--to", "a@b.com", "--expandMD", "html"}, false,
			"the Markdown pipeline is NOT ported — this MUST delegate or the wrong message is sent"},
		{[]string{"send", "--to", "a@b.com", "--linkTTL", "7"}, false, "same pipeline, same rule"},
		{[]string{"send", "--to", "a@b.com", "--dry-run"}, false, "cmdSend does not read --dry-run"},
		{[]string{"send", "--to", "a@b.com", "--ids"}, false, "cmdSend does not read --ids"},
		{[]string{"send", "--help"}, false, "help is still Node's"},
		{[]string{"log", "-n", "5"}, true, "log owns the short -n"},
		{[]string{"read", "-n", "5"}, false, "read does not"},
		// The two directions that motivated per-command sets: too narrow and
		// `watch --exec` delegates forever (the port never runs); too wide and
		// `log --exec` runs natively, silently ignoring a flag Node rejects.
		{[]string{"watch", "--exec", "notify"}, true, "watch owns --exec"},
		{[]string{"log", "--exec", "rm -rf /"}, false, "log does NOT — Node must reject it"},
	}
	for _, c := range cases {
		if got := ownedNatively(c.argv); got != c.want {
			t.Errorf("ownedNatively(%q) = %v, want %v — %s", c.argv, got, c.want, c.why)
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
