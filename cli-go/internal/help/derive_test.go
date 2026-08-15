package help

import (
	"reflect"
	"testing"
)

// TestParseFlagEntry pins the flag notation, case by case. Every input here is
// a real string from the spec — the corpus IS the grammar, and a case that
// nothing in the spec writes is a case this parser should not be guessing at.
func TestParseFlagEntry(t *testing.T) {
	for _, c := range []struct {
		entry string
		want  []Option
	}{
		{"--json", []Option{{Name: "json"}}},
		{"--db <path>", []Option{{Name: "db", TakesValue: true, Value: "path"}}},
		{"-n <count>", []Option{{Name: "n", TakesValue: true, Value: "count"}}},
		{"-h, --help", []Option{{Name: "help", Short: []string{"h"}}}},
		{"--man / --markdown", []Option{{Name: "man"}, {Name: "markdown"}}},

		// The one entry where a placeholder written once belongs to three flags.
		// Reading it as "two booleans and a value flag" is the mistake this test
		// exists to prevent, and internal/cmd's drift check proves the answer
		// against parse()'s AST independently.
		{"--to / --cc / --bcc <addr>", []Option{
			{Name: "to", TakesValue: true, Value: "addr"},
			{Name: "cc", TakesValue: true, Value: "addr"},
			{Name: "bcc", TakesValue: true, Value: "addr"},
		}},
		{"--file <path> / --body <text>", []Option{
			{Name: "file", TakesValue: true, Value: "path"},
			{Name: "body", TakesValue: true, Value: "text"},
		}},
		{"--daemon / --status / --stop", []Option{{Name: "daemon"}, {Name: "status"}, {Name: "stop"}}},

		// A placeholder need not be angle-bracketed.
		{"--secret <s> / --secret-env VAR", []Option{
			{Name: "secret", TakesValue: true, Value: "s"},
			{Name: "secret-env", TakesValue: true, Value: "VAR"},
		}},
		{"--scope actor", []Option{{Name: "scope", TakesValue: true, Value: "actor"}}},

		// Closed sets, and only where the notation states one.
		{"--expandMD html|no", []Option{
			{Name: "expandMD", TakesValue: true, Value: "html|no", Choices: []string{"html", "no"}},
		}},
		{"--kind api-key|oauth-refresh|aws-sigv4|hmac-key", []Option{
			{Name: "kind", TakesValue: true, Value: "api-key|oauth-refresh|aws-sigv4|hmac-key",
				Choices: []string{"api-key", "oauth-refresh", "aws-sigv4", "hmac-key"}},
		}},
		// `file` is a placeholder and `-` is a literal, so this is NOT a set.
		{"--text <file|->", []Option{{Name: "text", TakesValue: true, Value: "file|-"}}},

		// Comma-separated values, which an MCP schema would model as an array.
		{"--scopes <a,b,c>", []Option{{Name: "scopes", TakesValue: true, Value: "a,b,c", List: true}}},
		{"--meta k=v,…", []Option{{Name: "meta", TakesValue: true, Value: "k=v,…", List: true}}},

		// A quoted placeholder keeps its spaces.
		{`--header "Name: …{}…"`, []Option{{Name: "header", TakesValue: true, Value: "Name: …{}…"}}},
	} {
		got := parseFlagEntry(c.entry)
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("%q\n got %+v\nwant %+v", c.entry, got, c.want)
		}
	}
}

// TestFromSynopsis pins the positional notation and the requiredness rules —
// the half of the spec that had no machine-readable representation at all.
func TestFromSynopsis(t *testing.T) {
	for _, c := range []struct {
		name     string
		prefix   []string
		synopsis string
		args     []Argument
		opts     []Option
	}{
		{
			name:     "required and optional positionals",
			prefix:   []string{"bullmoose", "login"},
			synopsis: "bullmoose login <email> [--base <url>] [--name <device-name>]",
			args:     []Argument{{Name: "email", Required: true}},
			opts: []Option{
				{Name: "base", TakesValue: true, Value: "url"},
				{Name: "name", TakesValue: true, Value: "device-name"},
			},
		},
		{
			name:     "an optional positional needs no angle brackets",
			prefix:   []string{"bullmoose", "read"},
			synopsis: "bullmoose read [emailId] [--raw] [--json]",
			args:     []Argument{{Name: "emailId"}},
			opts:     []Option{{Name: "raw"}, {Name: "json"}},
		},
		{
			name:     "the repeatable id list every triage verb takes",
			prefix:   []string{"bullmoose", "flag"},
			synopsis: "bullmoose flag <id…> --add <keyword> [--remove <keyword>]",
			args:     []Argument{{Name: "id", Required: true, Repeatable: true}},
			opts: []Option{
				{Name: "add", TakesValue: true, Value: "keyword", Required: true},
				{Name: "remove", TakesValue: true, Value: "keyword"},
			},
		},
		{
			name:     "an unbracketed flag in a single-form synopsis is required",
			prefix:   []string{"bullmoose", "init"},
			synopsis: "bullmoose init --base <url> --token <token> [--account <id>] [--offline]",
			opts: []Option{
				{Name: "base", TakesValue: true, Value: "url", Required: true},
				{Name: "token", TakesValue: true, Value: "token", Required: true},
				{Name: "account", TakesValue: true, Value: "id"},
				{Name: "offline"},
			},
		},
		{
			name:     "alternation withdraws the requiredness claim but keeps both flags",
			prefix:   []string{"bullmoose", "rm"},
			synopsis: "bullmoose rm <id…> --force  |  --dry-run",
			args:     []Argument{{Name: "id", Required: true, Repeatable: true}},
			opts:     []Option{{Name: "force"}, {Name: "dry-run"}},
		},
		{
			name:     "an alternation packed against a flag with no spaces",
			prefix:   []string{"agent", "serve"},
			synopsis: "agent serve --config <agent.json>|--fleet <fleet.json> [--once]",
			opts: []Option{
				{Name: "config", TakesValue: true, Value: "agent.json"},
				{Name: "fleet", TakesValue: true, Value: "fleet.json"},
				{Name: "once"},
			},
		},
		{
			name:     "two spellings of one output flag are both accepted",
			prefix:   []string{"contacts", "list"},
			synopsis: "contacts list [--book <name-or-id>] [-n <count>] [--json|--ids]",
			opts: []Option{
				{Name: "book", TakesValue: true, Value: "name-or-id"},
				{Name: "n", TakesValue: true, Value: "count"},
				{Name: "json"},
				{Name: "ids"},
			},
		},
		{
			name:     "a literal alternation is a closed set of positional values",
			prefix:   []string{"bullmoose", "vacation"},
			synopsis: "bullmoose vacation on|off|status [--subject <s>]",
			args: []Argument{{Name: "on|off|status", Required: true,
				Choices: []string{"on", "off", "status"}}},
			opts: []Option{{Name: "subject", TakesValue: true, Value: "s"}},
		},
		{
			name:     "a nested verb alternation yields the verbs, and the flags they take",
			prefix:   []string{"contacts", "books"},
			synopsis: "contacts books list | create <name> | rename <name-or-id> <new> | rm <name-or-id> [--force]",
			args: []Argument{{Name: "subcommand", Required: true,
				Choices: []string{"list", "create", "rename", "rm"}}},
			opts: []Option{{Name: "force"}},
		},
		{
			name:     "a `|` inside a placeholder is not an alternation",
			prefix:   []string{"mailbox", "move"},
			synopsis: "mailbox move <box> --parent <box|->",
			args:     []Argument{{Name: "box", Required: true}},
			opts:     []Option{{Name: "parent", TakesValue: true, Value: "box|-", Required: true}},
		},
		{
			name:     "a positional after the flags is still a positional",
			prefix:   []string{"calendar", "event", "edit"},
			synopsis: "calendar event edit <id> [--title …] [--start …] [<patch.json>|-] [--if-state <s>]",
			args:     []Argument{{Name: "id", Required: true}, {Name: "patch.json"}},
			opts: []Option{
				{Name: "title", TakesValue: true},
				{Name: "start", TakesValue: true},
				{Name: "if-state", TakesValue: true, Value: "s"},
			},
		},
	} {
		t.Run(c.name, func(t *testing.T) {
			args, opts := fromSynopsis(c.prefix, c.synopsis)
			if !reflect.DeepEqual(args, c.args) {
				t.Errorf("arguments\n got %+v\nwant %+v", args, c.args)
			}
			if !reflect.DeepEqual(opts, c.opts) {
				t.Errorf("options\n got %+v\nwant %+v", opts, c.opts)
			}
		})
	}
}

// TestDerivedShapeIsUsableAsAToolSchema is the acceptance test for the whole
// point of this file: can a caller build an MCP tool definition from the spec
// without reading English? It walks the REAL spec and asserts the properties
// such a generator depends on, rather than asserting one hand-picked command.
func TestDerivedShapeIsUsableAsAToolSchema(t *testing.T) {
	spec, ok := Structured()
	if !ok {
		t.Fatalf("no derived spec\n    fix: %s", Regenerate)
	}

	seen := 0
	for _, c := range spec.Commands {
		for _, o := range append(append([]Option{}, spec.Options...), c.Options...) {
			seen++
			if o.Name == "" {
				t.Errorf("%s: an option with no name cannot become a schema property", c.Name)
			}
			if strings := o.Name; strings[0] == '-' {
				t.Errorf("%s: option %q keeps its dashes; the name must be bare", c.Name, o.Name)
			}
			if !o.TakesValue && (o.Value != "" || len(o.Choices) > 0 || o.List) {
				t.Errorf("%s --%s: a boolean cannot have a value, a set or a list", c.Name, o.Name)
			}
			for _, ch := range o.Choices {
				if ch == "" {
					t.Errorf("%s --%s: an empty string in choices", c.Name, o.Name)
				}
			}
		}
		for i, a := range c.Arguments {
			if a.Name == "" {
				t.Errorf("%s: argument %d has no name", c.Name, i)
			}
			if a.Repeatable && i != len(c.Arguments)-1 {
				t.Errorf("%s: %q repeats but is not the last argument, so no invocation could "+
					"be built from this list unambiguously", c.Name, a.Name)
			}
		}
		// A command with subcommands must say so in a way argv can be built from.
		if len(c.Subcommands) > 0 {
			if len(c.Arguments) != 1 || c.Arguments[0].Name != "subcommand" ||
				len(c.Arguments[0].Choices) != len(c.Subcommands) {
				t.Errorf("%s has %d subcommands but its arguments do not name them: %+v",
					c.Name, len(c.Subcommands), c.Arguments)
			}
		}
	}
	if seen < 100 {
		t.Errorf("only %d options across the whole spec — the derivation is not running", seen)
	}
}
