package cmd

import (
	"reflect"
	"testing"
)

// TestParse pins the narrow argv reader native commands use. Dispatch only routes
// owned invocations here, so parse never sees an unknown flag or help.
func TestParse(t *testing.T) {
	cases := []struct {
		name string
		argv []string
		want args
	}{
		{"bare command", []string{"mailboxes"},
			args{N: "20", Positionals: []string{"mailboxes"}}},
		{"json+ids booleans", []string{"mailboxes", "--json", "--ids"},
			args{N: "20", JSON: true, IDs: true, Positionals: []string{"mailboxes"}}},
		{"search query is positionals[1:]", []string{"search", "invoice", "for", "pipes"},
			args{N: "20", Positionals: []string{"search", "invoice", "for", "pipes"}}},
		{"-n value", []string{"log", "-n", "100"},
			args{N: "100", Positionals: []string{"log"}}},
		{"--n value", []string{"log", "--n", "5"},
			args{N: "5", Positionals: []string{"log"}}},
		{"--account value not swallowed as positional", []string{"search", "--account", "team", "invoice"},
			args{N: "20", Account: "team", Positionals: []string{"search", "invoice"}}},
		{"--db=inline", []string{"log", "--db=/tmp/x.db"},
			args{N: "20", DB: "/tmp/x.db", Positionals: []string{"log"}}},
		{"-- ends options", []string{"search", "--", "--json"},
			args{N: "20", Positionals: []string{"search", "--json"}}},
		{"--mailbox", []string{"log", "--mailbox", "inbox"},
			args{N: "20", Mailbox: "inbox", Positionals: []string{"log"}}},
	}
	for _, c := range cases {
		if got := parse(c.argv); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: parse(%q) = %+v, want %+v", c.name, c.argv, got, c.want)
		}
	}
}

// TestLimitFromN pins `Number(opts.n) || 20` (main.ts:1020).
func TestLimitFromN(t *testing.T) {
	cases := map[string]int64{
		"20": 20, "100": 100, "5": 5, "1": 1,
		"0":   20, // 0 is falsy → 20
		"abc": 20, // NaN → 20
		"":    20,
	}
	for in, want := range cases {
		if got := limitFromN(in); got != want {
			t.Errorf("limitFromN(%q) = %d, want %d", in, got, want)
		}
	}
}
