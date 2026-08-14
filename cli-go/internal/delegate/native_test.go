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

// TestOwnedNativelyRefusesWhatParseArgsRefuses pins the third reason an
// invocation delegates: node:util's parseArgs itself rejects it.
//
// Found by diffing the two binaries on `mailbox create X --sort -1`. parseArgs
// answers "Option '--sort' argument is ambiguous." and main.ts turns that into a
// usage error plus the whole overview; the native parser had happily read "-1" as
// the value and answered with a different sentence. The class is not `mailbox`'s
// — `log -n -5` had it since wave 1 — so the guard, not one parser, is where it
// belongs. Delegating is the byte-identical answer: Node prints its own refusal.
func TestOwnedNativelyRefusesWhatParseArgsRefuses(t *testing.T) {
	RegisterFlags("mailbox", []string{"db", "account", "parent", "sort", "if-state"},
		[]string{"json", "ids", "dry-run", "force"}, nil)
	RegisterFlags("log", []string{"db", "account", "mailbox", "n"}, []string{"json", "ids"}, []string{"n"})
	defer func() { owned = map[string]flagSet{} }()

	cases := []struct {
		argv []string
		want bool
		why  string
	}{
		{[]string{"mailbox", "create", "X", "--sort", "3"}, true, "an ordinary value"},
		{[]string{"mailbox", "create", "X", "--sort=-1"}, true,
			"INLINE is unambiguous — parseArgs accepts it, and so must the native path"},
		{[]string{"mailbox", "move", "X", "--parent", "-"}, true,
			"a bare - is a legal value: it is how you say `top level`"},
		{[]string{"mailbox", "create", "X", "--sort", "-1"}, false,
			"parseArgs: \"Option '--sort' argument is ambiguous.\""},
		{[]string{"mailbox", "create", "X", "--sort"}, false,
			"parseArgs: \"Option '--sort <value>' argument missing\""},
		{[]string{"mailbox", "create", "X", "--sort", "--json"}, false,
			"a flag is not a value, however much it looks like one"},
		{[]string{"mailbox", "create", "X", "--json=x"}, false,
			"parseArgs: \"Option '--json' does not take an argument\""},
		{[]string{"log", "-n", "-5"}, false, "the same rule for the short option"},
		{[]string{"log", "-n"}, false, "…and for a missing short value"},
		{[]string{"log", "-n", "5"}, true, "the ordinary case still runs natively"},
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
