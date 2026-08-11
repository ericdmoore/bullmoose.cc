package account

import (
	"errors"
	"testing"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
)

// Test_Select mirrors the matchAccounts/selectAccounts fall-through in
// packages/cli/src/db.ts:169-204. Unlike Pick (cli/009), a loose selector that
// matches several accounts is a SET, not an error — these commands fan out.
func Test_Select(t *testing.T) {
	accts := []Account{
		{AccountID: "t_1__a_1", Address: "eric@bullmoose.cc", Name: "Eric"},
		{AccountID: "t_1__a_2", Address: "team@bullmoose.cc", Name: "Team"},
		{AccountID: "t_2__a_3", Name: "NoAddress"},
	}
	const def = "t_1__a_1"

	ids := func(got []Account) []string {
		out := make([]string, len(got))
		for i, a := range got {
			out[i] = a.AccountID
		}
		return out
	}
	eq := func(got []Account, want ...string) bool {
		if len(got) != len(want) {
			return false
		}
		for i := range want {
			if got[i].AccountID != want[i] {
				return false
			}
		}
		return true
	}

	t.Run("no selector returns all", func(t *testing.T) {
		got, err := Select(accts, def, "")
		if err != nil || !eq(got, "t_1__a_1", "t_1__a_2", "t_2__a_3") {
			t.Fatalf("got %v (err %v)", ids(got), err)
		}
	})
	t.Run("default resolves the default account", func(t *testing.T) {
		got, _ := Select(accts, def, "default")
		if !eq(got, "t_1__a_1") {
			t.Fatalf("got %v", ids(got))
		}
	})
	t.Run("exact address", func(t *testing.T) {
		got, _ := Select(accts, def, "team@bullmoose.cc")
		if !eq(got, "t_1__a_2") {
			t.Fatalf("got %v", ids(got))
		}
	})
	t.Run("domain suffix fans out", func(t *testing.T) {
		got, _ := Select(accts, def, "@bullmoose.cc")
		if !eq(got, "t_1__a_1", "t_1__a_2") {
			t.Fatalf("got %v", ids(got))
		}
	})
	t.Run("loose substring is a set, not an error", func(t *testing.T) {
		got, err := Select(accts, def, "bullmoose.cc")
		if err != nil || !eq(got, "t_1__a_1", "t_1__a_2") {
			t.Fatalf("got %v (err %v) — fan-out must not refuse ambiguity like Pick does", ids(got), err)
		}
	})
	t.Run("no match is NotFound (exit 3)", func(t *testing.T) {
		_, err := Select(accts, def, "nope@elsewhere.example")
		var ce *bmio.CliError
		if !errors.As(err, &ce) || ce.Code != bmio.ExitNotFound {
			t.Fatalf("want NotFound/exit 3, got %v", err)
		}
	})
}

// Test_Label pins accountLabel (db.ts:242): address, else name, else last 8 of id.
func Test_Label(t *testing.T) {
	cases := []struct {
		a    Account
		want string
	}{
		{Account{AccountID: "t_1__a_1", Address: "eric@bullmoose.cc", Name: "Eric"}, "eric@bullmoose.cc"},
		{Account{AccountID: "t_1__a_2", Name: "Team"}, "Team"},
		{Account{AccountID: "t_smoke__a_you"}, "e__a_you"}, // slice(-8) of a 14-char id
		{Account{AccountID: "short"}, "short"},
	}
	for _, c := range cases {
		if got := Label(c.a); got != c.want {
			t.Errorf("Label(%+v) = %q, want %q", c.a, got, c.want)
		}
	}
}
