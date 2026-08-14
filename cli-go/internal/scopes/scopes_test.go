package scopes

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestVocabularyMatchesTheConformanceVector is the cross-language check on a
// mirrored list. conformance/scopes.json is generated from the LIVE auth-core, so
// a scope added on the platform side and not here shows up as a red build rather
// than as a token that mints and then silently does nothing.
//
// ORDER is asserted, not just membership: the vocabulary is printed verbatim in
// every `--scopes` error ("valid scopes: …"), so a reordering is user-visible.
func TestVocabularyMatchesTheConformanceVector(t *testing.T) {
	var vector struct {
		Vocabulary struct {
			MailScopes        []string `json:"mailScopes"`
			RealmScopes       []string `json:"realmScopes"`
			SelfServiceScopes []string `json:"selfServiceScopes"`
		} `json:"vocabulary"`
	}
	raw, err := os.ReadFile(conformancePath(t, "scopes.json"))
	if err != nil {
		t.Fatalf("reading the conformance vector: %v", err)
	}
	if err := json.Unmarshal(raw, &vector); err != nil {
		t.Fatalf("conformance/scopes.json is not the expected shape: %v", err)
	}

	for _, c := range []struct {
		name       string
		got, want  []string
		consequent string
	}{
		{"MAIL_SCOPES", Mail, vector.Vocabulary.MailScopes,
			"`mail` is the bundle of exactly these, so a drift changes what the bundle means"},
		{"REALM_SCOPES", Realm, vector.Vocabulary.RealmScopes,
			"a realm missing here cannot be requested by `token create` at all"},
		{"SELF_SERVICE_SCOPES", SelfService, vector.Vocabulary.SelfServiceScopes,
			"this is the allow-list `login` and `token create` validate against"},
	} {
		if strings.Join(c.got, ",") != strings.Join(c.want, ",") {
			t.Errorf("%s has drifted from auth-core:\n  go   %v\n  live %v\n  why it matters: %s",
				c.name, c.got, c.want, c.consequent)
		}
	}
	if len(vector.Vocabulary.SelfServiceScopes) == 0 {
		t.Fatal("the vector's vocabulary is empty — this test would pass vacuously")
	}
}

// TestParseFlag covers the branches scopes.ts:61 distinguishes, with the absent /
// empty pair first because they are the pair a port collapses by accident.
func TestParseFlag(t *testing.T) {
	str := func(s string) *string { return &s }

	t.Run("absent and optional means the server default", func(t *testing.T) {
		got, err := ParseFlag(nil, SelfService, false)
		if err != nil || got != nil {
			t.Fatalf("got %v, %v — login must be able to run bare and take the server default", got, err)
		}
	})

	t.Run("absent and required is an error", func(t *testing.T) {
		_, err := ParseFlag(nil, SelfService, true)
		if err == nil {
			t.Fatal("an omitted --scopes must be refused when required (cli/007)")
		}
		if !strings.Contains(err.Error(), "--scopes is required.") {
			t.Errorf("message should say the flag is required, got %q", err)
		}
		if !strings.Contains(err.Error(), "valid scopes:") {
			t.Errorf("a refusal must name the vocabulary, or the user guesses; got %q", err)
		}
	})

	t.Run("explicitly empty is an error even when optional", func(t *testing.T) {
		for _, raw := range []string{"", ",", "  "} {
			if _, err := ParseFlag(str(raw), SelfService, false); err == nil {
				t.Errorf("--scopes %q was accepted; both 'server default' and 'a token that can "+
					"do nothing' are worse guesses than saying so", raw)
			}
		}
	})

	t.Run("unknown scopes are named once each", func(t *testing.T) {
		_, err := ParseFlag(str("read,nope,nope,admin"), SelfService, true)
		if err == nil {
			t.Fatal("unknown scopes must be refused")
		}
		if got := strings.Count(err.Error(), "nope"); got != 1 {
			t.Errorf("each offender listed once; %q mentions nope %d times", err, got)
		}
		if !strings.Contains(err.Error(), "admin") {
			t.Error("`admin` is not self-service and must be refused here, not by the server")
		}
	})

	t.Run("valid input is de-duplicated in order", func(t *testing.T) {
		got, err := ParseFlag(str(" read , draft ,read, mail "), SelfService, true)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if strings.Join(got, ",") != "read,draft,mail" {
			t.Errorf("got %v, want [read draft mail] — trimmed, de-duplicated, order preserved", got)
		}
	})
}

// TestHelpListsOnlyReachableSuggestions: `--scopes admin` cannot be suggested to a
// self-service caller, and a suggestion naming a scope outside the allowed set
// would be advice that fails when followed.
func TestHelpListsOnlyReachableSuggestions(t *testing.T) {
	help := Help([]string{"read", "move"})
	if !strings.Contains(help, "--scopes read,move") {
		t.Errorf("a reachable suggestion was dropped:\n%s", help)
	}
	if strings.Contains(help, "contacts") {
		t.Errorf("a suggestion naming an unavailable scope was offered:\n%s", help)
	}
	// The 24-column padding is scopes.ts:100's padEnd; the column is what makes
	// the block readable, and it is user-visible output.
	if !strings.Contains(Help(SelfService), "  --scopes read                     backup") {
		t.Errorf("suggestion column drifted:\n%s", Help(SelfService))
	}
}

func conformancePath(t *testing.T, name string) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		p := filepath.Join(dir, "conformance", name)
		if _, err := os.Stat(p); err == nil {
			return p
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatalf("conformance/%s not found above %s — regenerate with `npm run gen:conformance`", name, dir)
		}
		dir = parent
	}
}
