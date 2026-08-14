package cmd

// `login` end to end against a fake /auth/login (the shared authFake in
// token_test.go).
//
// Three assertions carry this file, and each is a claim about a PROPERTY rather
// than about output:
//
//   - what leaves the process is the DERIVED KEY, and it is the exact key
//     conformance/login-key.json says the TypeScript derives. Not "some 64 hex
//     characters" — the vector's, because a Go CLI that stretches differently
//     gets a 401 and tells the user their password is wrong;
//   - the raw password appears in NO stored artifact and on NO stream. Asserted
//     by scanning the mirror's bytes, so it stays true when someone later adds a
//     debug line or a new config row;
//   - discovery failure produces a legible refusal, and `login` never reaches the
//     network with a base it has not confirmed.

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/authkey"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/discover"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/store"
)

// loginResponse is authRoutes.ts:124's body: the secret shown once, and every
// account this principal can see. Two accounts, so "which one is primary" is a
// real question rather than a foregone one.
const loginResponse = `{"token":"bm_device_secret","tokenId":"tk_dev","username":"eric@bullmoose.cc",` +
	`"scopes":["mail"],"accounts":[` +
	`{"accountId":"t_1__a_1","tenantId":"t_1","name":"Eric","address":"eric@bullmoose.cc"},` +
	`{"accountId":"t_1__a_2","tenantId":"t_1","name":"Team","address":"team@bullmoose.cc"}]}`

// vectorCase reads one case out of conformance/login-key.json. The test uses the
// SAME oracle the authkey unit test does, one layer up: this asserts the wiring
// (the command sends the derived key) rather than the derivation.
func vectorCase(t *testing.T, name string) (email, password, loginKey string) {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		raw, err := os.ReadFile(filepath.Join(dir, "conformance", "login-key.json"))
		if err == nil {
			var v struct {
				Vectors []struct {
					Name, Email, Password, LoginKey string
				} `json:"vectors"`
			}
			if err := json.Unmarshal(raw, &v); err != nil {
				t.Fatalf("conformance/login-key.json: %v", err)
			}
			for _, c := range v.Vectors {
				if c.Name == name {
					return c.Email, c.Password, c.LoginKey
				}
			}
			t.Fatalf("no %q case in conformance/login-key.json", name)
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("conformance/login-key.json not found — the derivation would be unchecked")
		}
		dir = parent
	}
}

// deriveForTest is the command's own derivation, used to say WHICH password a
// request carried. The derivation itself is checked against the vector in
// internal/authkey; this only distinguishes one password from another.
func deriveForTest(t *testing.T, email, password string) string {
	t.Helper()
	key, err := authkey.DeriveLoginKey(email, password)
	if err != nil {
		t.Fatal(err)
	}
	return key
}

// roundTripTo is a transport built from a function — the only way these tests
// reach "the network" is through one of these.
type roundTripTo func(*http.Request) (*http.Response, error)

func (f roundTripTo) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func runLoginCase(t *testing.T, deps loginDeps, args ...string) (out, errOut string, code int) {
	t.Helper()
	var o, e strings.Builder
	s := bmio.NewTo(&o, &e)
	code = runLoginWith(s, append([]string{"login"}, args...), deps)
	return o.String(), e.String(), code
}

// ---- the derived key -------------------------------------------------------

// TestLoginSendsTheConformanceDerivedKeyAndNoPassword is the wiring assertion.
func TestLoginSendsTheConformanceDerivedKeyAndNoPassword(t *testing.T) {
	email, password, wantKey := vectorCase(t, "basic")
	fake := newAuthFake()
	srv := fake.start(t)
	dbPath := filepath.Join(t.TempDir(), "mail.db")

	out, errOut, code := runLoginCase(t, loginDeps{}, email,
		"--base", srv.URL, "--password", password, "--name", "laptop", "--db", dbPath)
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}

	calls := fake.seen()
	if len(calls) != 1 || calls[0].path != "/auth/login" {
		t.Fatalf("calls = %+v, want one POST /auth/login", calls)
	}
	body := calls[0].body
	if got := body["loginKey"]; got != wantKey {
		t.Errorf("loginKey sent = %v\n            want %v\n"+
			"(the conformance vector's key — a mismatch is a 401 that looks like a wrong password)",
			got, wantKey)
	}
	if got := body["email"]; got != email {
		t.Errorf("email sent = %v, want %v (the address is NOT lower-cased on the wire; "+
			"only the salt lower-cases it)", got, email)
	}
	if got := body["name"]; got != "laptop" {
		t.Errorf("name sent = %v, want laptop", got)
	}
	// --scopes was absent, so the request must say nothing and take the server's
	// default (tokens.ts:73). A key present with a null value is not the same.
	if _, present := body["scopes"]; present {
		t.Errorf("scopes was sent (%v) although --scopes was absent; only silence takes the server default",
			body["scopes"])
	}
	// The whole point: no plaintext, under any key.
	raw, _ := json.Marshal(body)
	if strings.Contains(string(raw), password) {
		t.Errorf("the raw password reached the wire: %s", raw)
	}
	if strings.Contains(out+errOut, password) {
		t.Errorf("the raw password was printed:\n%s%s", out, errOut)
	}
}

// TestLoginStoresNoPasswordAnywhere scans every byte the command wrote. It is
// deliberately blunt: a future config row, log file or debug line that carried the
// password would fail this without anyone having to think of it.
func TestLoginStoresNoPasswordAnywhere(t *testing.T) {
	email, password, _ := vectorCase(t, "basic")
	fake := newAuthFake()
	srv := fake.start(t)
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "sub", "mail.db")

	if _, errOut, code := runLoginCase(t, loginDeps{}, email,
		"--base", srv.URL, "--password", password, "--db", dbPath); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}

	found := 0
	err := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return err
		}
		found++
		content, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if strings.Contains(string(content), password) {
			t.Errorf("%s contains the raw password", path)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if found == 0 {
		t.Fatal("no files were written — this scan proved nothing")
	}

	// And the token that WAS stored is the derived credential, not a password.
	db, err := store.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if got := store.GetConfig(db, "token"); got != "bm_device_secret" {
		t.Errorf("stored token = %q, want the minted secret", got)
	}
}

// ---- where the password comes from ----------------------------------------

// TestLoginPasswordSources pins tokens.ts:62's order and, more importantly, its
// nullish-ness: an empty --password is a password, not an absence.
func TestLoginPasswordSources(t *testing.T) {
	email := "eric@bullmoose.cc"

	t.Run("--password wins over the environment", func(t *testing.T) {
		t.Setenv("BULLMOOSE_PASSWORD", "from-env")
		fake := newAuthFake()
		srv := fake.start(t)
		prompted := false
		_, _, code := runLoginCase(t, loginDeps{prompt: func(string) (string, error) {
			prompted = true
			return "prompted", nil
		}}, email, "--base", srv.URL, "--password", "from-flag",
			"--db", filepath.Join(t.TempDir(), "mail.db"))
		if code != 0 {
			t.Fatal(code)
		}
		if prompted {
			t.Error("prompted although --password was given")
		}
		assertKeyFor(t, fake, email, "from-flag")
	})

	t.Run("$BULLMOOSE_PASSWORD when the flag is absent", func(t *testing.T) {
		t.Setenv("BULLMOOSE_PASSWORD", "from-env")
		fake := newAuthFake()
		srv := fake.start(t)
		_, _, code := runLoginCase(t, loginDeps{prompt: func(string) (string, error) {
			t.Error("prompted although $BULLMOOSE_PASSWORD was set")
			return "", nil
		}}, email, "--base", srv.URL, "--db", filepath.Join(t.TempDir(), "mail.db"))
		if code != 0 {
			t.Fatal(code)
		}
		assertKeyFor(t, fake, email, "from-env")
	})

	t.Run("the prompt is the last resort", func(t *testing.T) {
		t.Setenv("BULLMOOSE_PASSWORD", "")
		_ = os.Unsetenv("BULLMOOSE_PASSWORD")
		fake := newAuthFake()
		srv := fake.start(t)
		var message string
		_, _, code := runLoginCase(t, loginDeps{prompt: func(m string) (string, error) {
			message = m
			return "typed", nil
		}}, email, "--base", srv.URL, "--db", filepath.Join(t.TempDir(), "mail.db"))
		if code != 0 {
			t.Fatal(code)
		}
		if message != "password: " {
			t.Errorf("prompt = %q, want %q", message, "password: ")
		}
		assertKeyFor(t, fake, email, "typed")
	})

	t.Run("an empty --password is a password, not an absence", func(t *testing.T) {
		t.Setenv("BULLMOOSE_PASSWORD", "from-env")
		fake := newAuthFake()
		srv := fake.start(t)
		_, _, code := runLoginCase(t, loginDeps{prompt: func(string) (string, error) {
			t.Error("prompted although --password \"\" was given")
			return "", nil
		}}, email, "--base", srv.URL, "--password", "",
			"--db", filepath.Join(t.TempDir(), "mail.db"))
		if code != 0 {
			t.Fatal(code)
		}
		// conformance/login-key.json's `empty-password` case is exactly this.
		assertKeyFor(t, fake, email, "")
	})
}

// assertKeyFor checks the request carried the key that password derives — via the
// same authkey the command uses, so this asserts WHICH password was used, and the
// conformance test asserts the derivation itself.
func assertKeyFor(t *testing.T, fake *authFake, email, password string) {
	t.Helper()
	calls := fake.seen()
	if len(calls) != 1 {
		t.Fatalf("calls = %+v", calls)
	}
	want := deriveForTest(t, email, password)
	if got := calls[0].body["loginKey"]; got != want {
		t.Errorf("loginKey = %v, want the key for %q", got, password)
	}
}

// ---- scopes ---------------------------------------------------------------

// TestLoginScopesAreOptionalButValidated: `login` is the bootstrap, so an omitted
// --scopes is legal (tokens.ts:52) — and a wrong one is refused before the
// password is even read.
func TestLoginScopesAreOptionalButValidated(t *testing.T) {
	fake := newAuthFake()
	srv := fake.start(t)

	_, _, code := runLoginCase(t, loginDeps{}, "eric@bullmoose.cc", "--base", srv.URL,
		"--password", "x", "--scopes", "read,send", "--db", filepath.Join(t.TempDir(), "mail.db"))
	if code != 0 {
		t.Fatal(code)
	}
	sent, _ := json.Marshal(fake.seen()[0].body["scopes"])
	if string(sent) != `["read","send"]` {
		t.Errorf("scopes sent = %s", sent)
	}

	bad := newAuthFake()
	badSrv := bad.start(t)
	_, errOut, code := runLoginCase(t, loginDeps{prompt: func(string) (string, error) {
		t.Error("a bad --scopes must be refused BEFORE the password is asked for")
		return "", nil
	}}, "eric@bullmoose.cc", "--base", badSrv.URL, "--scopes", "reed",
		"--db", filepath.Join(t.TempDir(), "mail.db"))
	if code != int(bmio.ExitUsage) {
		t.Errorf("exit = %d, want 2", code)
	}
	if len(bad.seen()) != 0 {
		t.Errorf("a bad --scopes reached the server: %v", bad.seen())
	}
	if !strings.Contains(errOut, "(omit --scopes to take the server default)") {
		t.Errorf("the refusal should say the flag is optional here:\n%s", errOut)
	}
}

// ---- discovery -------------------------------------------------------------

// stubResolver stands in for autodiscovery. The ladder itself is tested in
// internal/discover; what login owes is to USE the answer, announce it, and not
// invent a base of its own.
type stubResolver struct {
	result discover.Result
	err    error
	asked  []string
}

func (s *stubResolver) Resolve(_ context.Context, email string) (discover.Result, error) {
	s.asked = append(s.asked, email)
	return s.result, s.err
}

// TestLoginDiscoversWhenNoBaseIsGiven: the address is enough (RFC 8620 §2.2), and
// the discovered base is ANNOUNCED — a surprising server should be visible.
func TestLoginDiscoversWhenNoBaseIsGiven(t *testing.T) {
	fake := newAuthFake()
	srv := fake.start(t)
	resolver := &stubResolver{result: discover.Result{
		Base: srv.URL, Via: "fallback", Domain: "bullmoose.cc"}}
	out, errOut, code := runLoginCase(t, loginDeps{resolver: resolver}, "eric@bullmoose.cc",
		"--password", "x", "--db", filepath.Join(t.TempDir(), "mail.db"))
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	if len(resolver.asked) != 1 || resolver.asked[0] != "eric@bullmoose.cc" {
		t.Errorf("the resolver was asked %v, want the login address once", resolver.asked)
	}
	if !strings.Contains(errOut, "discovered "+srv.URL+" (via fallback)") {
		t.Errorf("the discovered base belongs on stderr as progress:\n%s", errOut)
	}
	if !strings.Contains(out, "logged in as eric@bullmoose.cc") {
		t.Errorf("stdout = %q", out)
	}
	if len(fake.seen()) != 1 {
		t.Errorf("expected exactly one /auth/login after discovery, got %+v", fake.seen())
	}
}

// TestLoginDiscoveryFailureIsLegible — the failure Eric actually hit: no server,
// and the old CLI answered with a page of HTML from the eventual POST.
func TestLoginDiscoveryFailureIsLegible(t *testing.T) {
	// The REAL resolver here, because the message under test is its own — with
	// every effect stubbed so nothing leaves the process.
	resolver := &discover.Resolver{
		LookupSRV: func(context.Context, string, string, string) (string, []*net.SRV, error) {
			return "", nil, &net.DNSError{Err: "no such host", IsNotFound: true}
		},
		HTTP: &http.Client{Transport: roundTripTo(func(*http.Request) (*http.Response, error) {
			return nil, &net.DNSError{Err: "no such host", IsNotFound: true}
		})},
	}
	out, errOut, code := runLoginCase(t, loginDeps{
		resolver: resolver,
		prompt: func(string) (string, error) {
			t.Error("a password must not be asked for before the server is known to exist")
			return "", nil
		},
	}, "eric@nowhere.example", "--db", filepath.Join(t.TempDir(), "mail.db"))

	if code != int(bmio.ExitNotFound) {
		t.Errorf("exit = %d, want 3", code)
	}
	if out != "" {
		t.Errorf("stdout must stay empty: %q", out)
	}
	for _, want := range []string{"no JMAP server found for nowhere.example", "--base"} {
		if !strings.Contains(errOut, want) {
			t.Errorf("the refusal should contain %q:\n%s", want, errOut)
		}
	}
	if strings.Contains(errOut, "<html") {
		t.Errorf("markup leaked into the error:\n%s", errOut)
	}
}

// ---- what gets stored, and who can read it --------------------------------

// TestLoginWritesAMirrorTheReadCommandsCanRead is the standalone claim: after a
// login on a machine that never had Node, `accounts` works. Before this wave the
// mirror did not exist at all unless the Node CLI made it.
func TestLoginWritesAMirrorTheReadCommandsCanRead(t *testing.T) {
	fake := newAuthFake()
	srv := fake.start(t)
	dbPath := filepath.Join(t.TempDir(), "mail.db")

	out, errOut, code := runLoginCase(t, loginDeps{}, "eric@bullmoose.cc",
		"--base", srv.URL, "--password", "x", "--db", dbPath)
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	// tokens.ts:124: the summary, then one line per account with the default
	// starred. The starred one is the account whose ADDRESS is the login address,
	// not merely the first (tokens.ts:86).
	wantOut := "logged in as eric@bullmoose.cc (token tk_dev, this device only)\n" +
		"  ★ eric@bullmoose.cc  (Eric)\n" +
		"    team@bullmoose.cc  (Team)\n"
	if out != wantOut {
		t.Errorf("stdout =\n%q\nwant\n%q", out, wantOut)
	}

	db, err := store.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	settings, err := store.RequireSettings(db)
	if err != nil {
		t.Fatalf("the mirror login wrote is not configured: %v", err)
	}
	if settings.Base != srv.URL || settings.AccountID != "t_1__a_1" || len(settings.Accounts) != 2 {
		t.Errorf("settings = %+v", settings)
	}
	if settings.Accounts[1].Address != "team@bullmoose.cc" {
		t.Errorf("the accounts blob lost a field: %+v", settings.Accounts)
	}
	_ = db.Close()

	// And the wave-1 read command serves it — same file, same schema.
	var o, e strings.Builder
	if code := runAccounts(bmio.NewTo(&o, &e), []string{"accounts", "--db", dbPath}); code != 0 {
		t.Fatalf("`accounts` on a login-created mirror exited %d: %s", code, e.String())
	}
	if !strings.Contains(o.String(), "eric@bullmoose.cc") || !strings.Contains(o.String(), "★") {
		t.Errorf("`accounts` output:\n%s", o.String())
	}
}

func TestLoginJSONAndIDs(t *testing.T) {
	fake := newAuthFake()
	srv := fake.start(t)

	out, _, code := runLoginCase(t, loginDeps{}, "eric@bullmoose.cc", "--base", srv.URL,
		"--password", "x", "--json", "--db", filepath.Join(t.TempDir(), "mail.db"))
	if code != 0 {
		t.Fatal(code)
	}
	// cli/008: --json used to be accepted and ignored here. Key order is
	// tokens.ts:111's, and `address` survives as the server sent it.
	var rec map[string]any
	if err := json.Unmarshal([]byte(strings.TrimRight(out, "\n")), &rec); err != nil {
		t.Fatalf("--json is not one JSON value per line: %v (%q)", err, out)
	}
	for _, key := range []string{"username", "tokenId", "accountId", "base", "accounts"} {
		if _, ok := rec[key]; !ok {
			t.Errorf("--json record is missing %q: %s", key, out)
		}
	}
	if !strings.HasPrefix(strings.TrimSpace(out), `{"username":"eric@bullmoose.cc","tokenId":"tk_dev"`) {
		t.Errorf("key order drifted from tokens.ts:111: %s", out)
	}

	out, _, code = runLoginCase(t, loginDeps{}, "eric@bullmoose.cc", "--base", srv.URL,
		"--password", "x", "--ids", "--db", filepath.Join(t.TempDir(), "mail.db"))
	if code != 0 {
		t.Fatal(code)
	}
	if out != "t_1__a_1\nt_1__a_2\n" {
		t.Errorf("--ids = %q, want bare account ids", out)
	}
}

// TestLoginWithNoAccountsIsNotFound: authenticated, but nothing provisioned. The
// mirror must not be left claiming a login it cannot use.
func TestLoginWithNoAccountsIsNotFound(t *testing.T) {
	fake := newAuthFake()
	fake.status = 200
	fake.body = `{"token":"bm_x","tokenId":"tk_x","username":"eric@bullmoose.cc","accounts":[]}`
	srv := fake.start(t)
	dbPath := filepath.Join(t.TempDir(), "mail.db")

	_, errOut, code := runLoginCase(t, loginDeps{}, "eric@bullmoose.cc",
		"--base", srv.URL, "--password", "x", "--db", dbPath)
	if code != int(bmio.ExitNotFound) {
		t.Errorf("exit = %d, want 3", code)
	}
	if !strings.Contains(errOut, "has no accounts — provision one first") {
		t.Errorf("stderr = %q", errOut)
	}
	if _, err := os.Stat(dbPath); err == nil {
		db, _ := store.Open(dbPath)
		defer db.Close()
		if got := store.GetConfig(db, "token"); got != "" {
			t.Errorf("a token was stored for a login with no usable account: %q", got)
		}
	}
}

// TestLoginRefusalsMapToExitCodes — a wrong password is exit 4, and the server's
// own sentence survives.
func TestLoginRefusalsMapToExitCodes(t *testing.T) {
	fake := newAuthFake()
	fake.status, fake.body = 401, `{"error":"invalid credentials"}`
	srv := fake.start(t)

	_, errOut, code := runLoginCase(t, loginDeps{}, "eric@bullmoose.cc", "--base", srv.URL,
		"--password", "wrong", "--db", filepath.Join(t.TempDir(), "mail.db"))
	if code != int(bmio.ExitAuth) {
		t.Errorf("exit = %d, want 4", code)
	}
	if !strings.Contains(errOut, "login failed: HTTP 401") || !strings.Contains(errOut, "invalid credentials") {
		t.Errorf("stderr = %q", errOut)
	}
}

func TestLoginWithoutAnEmailIsUsage(t *testing.T) {
	_, errOut, code := runLoginCase(t, loginDeps{}, "--db", filepath.Join(t.TempDir(), "mail.db"))
	if code != int(bmio.ExitUsage) {
		t.Errorf("exit = %d, want 2", code)
	}
	if !strings.Contains(errOut, "usage: bullmoose login <email>") {
		t.Errorf("stderr = %q", errOut)
	}
}

// TestLoginBootstrapBundleSuppliesTheBase — a file:// base is a connection
// bundle; login still goes over the network, because it exists to MINT
// (tokens.ts:44).
func TestLoginBootstrapBundleSuppliesTheBase(t *testing.T) {
	fake := newAuthFake()
	srv := fake.start(t)
	bundle := filepath.Join(t.TempDir(), "bundle.json")
	if err := os.WriteFile(bundle, []byte(`{"base":"`+srv.URL+`"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	_, errOut, code := runLoginCase(t, loginDeps{}, "eric@bullmoose.cc",
		"--base", "file://"+bundle, "--password", "x", "--db", filepath.Join(t.TempDir(), "mail.db"))
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	if len(fake.seen()) != 1 {
		t.Errorf("the bundle's base was not used: %+v", fake.seen())
	}
}
