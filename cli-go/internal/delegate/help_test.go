package delegate

import (
	"reflect"
	"testing"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/help"
)

// TestHelpRequest pins the routing table against main.ts:205-237. Every case is
// an invocation a user can type; the bytes each one prints are the artifact's
// problem, and this is the part that decides WHICH bytes.
func TestHelpRequest(t *testing.T) {
	overview := help.Request{Mode: help.Overview}
	cases := []struct {
		argv []string
		want help.Request
		ok   bool
		why  string
	}{
		// Help that was asked for: stdout, exit 0.
		{[]string{"help"}, overview, true, "the bare command"},
		{[]string{"--help"}, overview, true, "no command, --help"},
		{[]string{"-h"}, overview, true, "the short form"},
		{[]string{"help", "--help"}, overview, true,
			"`help --help` has no SECOND positional, so it carries no topic — main.ts:209"},
		{[]string{"help", ""}, overview, true, "an empty topic is falsy in main.ts, so it is the overview"},

		// Help printed because the invocation was wrong: stderr, exit 2.
		{nil, help.Request{Mode: help.OverviewUsage}, true, "no command at all"},
		{[]string{""}, help.Request{Mode: help.OverviewUsage}, true, "an empty command is falsy too"},

		// One command's page, by either route.
		{[]string{"help", "rm"}, help.Request{Mode: help.Topic, Topic: "rm"}, true, "help <cmd>"},
		{[]string{"rm", "--help"}, help.Request{Mode: help.Topic, Topic: "rm"}, true, "<cmd> --help"},
		{[]string{"log", "-h"}, help.Request{Mode: help.Topic, Topic: "log"}, true, "<cmd> -h"},
		{[]string{"help", "help"}, help.Request{Mode: help.Topic, Topic: "help"}, true,
			"`help` is a command with a page of its own (cli/010 item 3)"},
		{[]string{"help", "log", "extra"}, help.Request{Mode: help.Topic, Topic: "log"}, true,
			"positionals past the topic are ignored, as parseArgs leaves them"},
		{[]string{"help", "nosuchthing"}, help.Request{Mode: help.Topic, Topic: "nosuchthing"}, true,
			"an unknown topic is still a help request — the artifact renders the refusal"},
		{[]string{"--db", "/tmp/x.db", "help", "rm"}, help.Request{Mode: help.Topic, Topic: "rm"}, true,
			"a value flag consumes its token, so the topic is still the second positional"},

		// The machine-readable renderings, and their precedence over a topic.
		{[]string{"help", "--json"}, help.Request{Mode: help.JSON}, true, "the spec"},
		{[]string{"--json"}, help.Request{Mode: help.JSON}, true, "no command, --json: still the spec"},
		{[]string{"help", "--man"}, help.Request{Mode: help.Man}, true, "roff"},
		{[]string{"help", "--markdown"}, help.Request{Mode: help.Markdown}, true, "docs/cli.md"},
		{[]string{"log", "--help", "--json"}, help.Request{Mode: help.JSON}, true,
			"main.ts checks --json BEFORE the topic, so the spec wins over log's page"},
		{[]string{"help", "--json", "--man"}, help.Request{Mode: help.JSON}, true, "json first, then man"},

		// `--` ends option parsing.
		{[]string{"--", "help"}, overview, true, "`help` after -- is still the positional"},
		{[]string{"--", "--help"}, help.Request{}, false,
			"after --, `--help` is a POSITIONAL command name, not the help flag"},

		// Not help at all.
		{[]string{"log"}, help.Request{}, false, "an ordinary command"},
		{[]string{"log", "-n", "5"}, help.Request{}, false, "still ordinary"},
		{[]string{"nosuchcommand"}, help.Request{}, false, "unknown, but not a help request"},

		// parseArgs refuses these before main.ts's help block ever runs, and its
		// refusals are Node's own text — so they are not help requests here.
		{[]string{"help", "--no-such-flag"}, help.Request{}, false, "Unknown option"},
		{[]string{"--help", "--no-such-flag"}, help.Request{}, false, "unknown flag beats --help"},
		{[]string{"help", "--json=1"}, help.Request{}, false, "a boolean with a value"},
		{[]string{"--help", "--db"}, help.Request{}, false, "value flag with nothing to take"},
		{[]string{"--help", "--db", "--json"}, help.Request{}, false, "argument is ambiguous"},
		{[]string{"help", "-x"}, help.Request{}, false, "an undeclared short option"},
		{[]string{"help", "-nh"}, help.Request{}, false, "a short group this scanner does not model"},
	}
	for _, c := range cases {
		got, ok := helpRequest(c.argv)
		if ok != c.ok || (ok && !reflect.DeepEqual(got, c.want)) {
			t.Errorf("helpRequest(%q) = %+v,%v; want %+v,%v — %s", c.argv, got, ok, c.want, c.ok, c.why)
		}
	}
}

// TestUnknownCommand pins the other thing rendered out of the help spec. The
// rule is narrow on purpose: only a command the Node CLI does not have, only when
// parseArgs would have got far enough to reach the switch.
func TestUnknownCommand(t *testing.T) {
	Register("approvals", func([]string) int { return 0 })
	RegisterNativeOnly("approvals")
	defer func() {
		delete(native, "approvals")
		delete(nativeOnly, "approvals")
	}()

	cases := []struct {
		argv []string
		want string
		ok   bool
		why  string
	}{
		{[]string{"nosuchcommand"}, "nosuchcommand", true, "the switch default"},
		{[]string{"logg", "-n", "5"}, "logg", true, "a typo with legal flags"},
		{[]string{"--json", "nope"}, "nope", true, "flags before the command"},
		{[]string{"log"}, "", false, "a real command"},
		{[]string{"admin"}, "", false, "a real command with subcommands"},
		{[]string{"help"}, "", false, "help is not the switch's business"},
		{nil, "", false, "no command is the overview, not an unknown command"},
		{[]string{"approvals"}, "", false,
			"Go-native-only: Node not having it is the point, not an error"},
		{[]string{"nope", "--no-such-flag"}, "", false,
			"parseArgs refuses first, and that message is Node's"},
		{[]string{"nope", "--db"}, "", false, "argument missing — also parseArgs's"},
	}
	for _, c := range cases {
		got, ok := unknownCommand(c.argv)
		if got != c.want || ok != c.ok {
			t.Errorf("unknownCommand(%q) = %q,%v; want %q,%v — %s", c.argv, got, ok, c.want, c.ok, c.why)
		}
	}
}

// TestParseGlobalAgreesWithCommand keeps the two argv scanners from drifting.
// Command() names the subcommand for routing and tracing; parseGlobal recovers
// the whole positional list for the help block. They read the same flag tables,
// so they must agree about where the command is — if they ever did not, an
// invocation would be traced as one command and helped as another.
func TestParseGlobalAgreesWithCommand(t *testing.T) {
	corpus := [][]string{
		nil, {}, {"log"}, {"help"}, {"help", "rm"}, {"--json", "log"},
		{"--db", "/tmp/x.db", "mailboxes"}, {"--db=/tmp/x.db", "mailboxes"},
		{"-n", "5", "log"}, {"-h", "log"}, {"--", "log"}, {"--"},
		{"contacts", "import", "-"}, {"mailbox", "rename", "A", "B"},
		{"calendar", "event", "create", "--title", "Standup"},
	}
	for _, argv := range corpus {
		p := parseGlobal(argv)
		if !p.ok {
			t.Errorf("parseGlobal(%q) refused an argv the Node CLI accepts", argv)
			continue
		}
		first := ""
		if len(p.positionals) > 0 {
			first = p.positionals[0]
		}
		if want := Command(argv); first != want {
			t.Errorf("parseGlobal(%q) positionals[0] = %q, but Command says %q", argv, first, want)
		}
	}
}

// TestParseGlobalRefusesWhatParseArgsRefuses is the sibling of
// TestOwnedNativelyRefusesWhatParseArgsRefuses: the help router may only answer
// an argv node:util's parseArgs would have ACCEPTED, because main.ts parses
// before it looks at help. Getting this wrong prints the overview where Node
// prints a usage error.
func TestParseGlobalRefusesWhatParseArgsRefuses(t *testing.T) {
	for _, c := range []struct {
		argv []string
		ok   bool
		why  string
	}{
		{[]string{"log", "--json"}, true, "a declared boolean"},
		{[]string{"log", "--account", "work"}, true, "a declared value flag"},
		{[]string{"log", "--account=work"}, true, "inline value"},
		{[]string{"mailbox", "move", "X", "--parent", "-"}, true, "a bare - IS a legal value"},
		{[]string{"send", "--to", "a@b.com", "--expandMD", "html"}, true,
			"declared globally even though `send`'s native path does not own it"},
		{[]string{"log", "--no-such-flag"}, false, "Unknown option"},
		{[]string{"log", "--json=x"}, false, "does not take an argument"},
		{[]string{"mailbox", "create", "X", "--sort"}, false, "argument missing"},
		{[]string{"mailbox", "create", "X", "--sort", "-1"}, false, "argument is ambiguous"},
		{[]string{"log", "-n", "-5"}, false, "ambiguous, short form"},
		{[]string{"log", "-z"}, false, "an undeclared short option"},
	} {
		if got := parseGlobal(c.argv).ok; got != c.ok {
			t.Errorf("parseGlobal(%q).ok = %v, want %v — %s", c.argv, got, c.ok, c.why)
		}
	}
}
