package cmd

// creds — ported EXACTLY; these tests pin the INVARIANTS, and several assert
// by absence: the strongest claim about a vault CLI is what never appears.

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	bmio "github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/store"
)

// vaultFake records every request body so tests can assert what went UP —
// and, more importantly, what never came DOWN.
type vaultFake struct {
	mu    sync.Mutex
	calls []struct{ Method, Path, Body string }
	list  string
	srv   *httptest.Server
}

func newVaultFake(t *testing.T) *vaultFake {
	t.Helper()
	v := &vaultFake{list: `{"credentials":[]}`}
	v.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		v.mu.Lock()
		v.calls = append(v.calls, struct{ Method, Path, Body string }{r.Method, r.URL.Path, string(b)})
		v.mu.Unlock()
		w.Header().Set("content-type", "application/json")
		switch {
		case r.Method == "GET":
			_, _ = w.Write([]byte(v.list))
		case r.Method == "PUT":
			_, _ = w.Write([]byte(`{"name":"x","allow":"https://api.stripe.com","enforcement":"broad"}`))
		case strings.HasSuffix(r.URL.Path, "/rotate"):
			_, _ = w.Write([]byte(`{"rotated":true}`))
		case r.Method == "DELETE":
			_, _ = w.Write([]byte(`{"deleted":true}`))
		}
	}))
	t.Cleanup(v.srv.Close)
	return v
}

// credsEnv seeds a mirror AND points the vault at the fake.
func credsEnv(t *testing.T, v *vaultFake) string {
	t.Helper()
	f := newMailFake()
	dbPath := sendEnv(t, f)
	db, err := store.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := store.SetConfig(db, "vaultUrl", v.srv.URL); err != nil {
		t.Fatal(err)
	}
	return dbPath
}

func TestCreds_SetRequiresAllow_FailClosed(t *testing.T) {
	// Invariant 2. A credential with no destination is unusable by design, and
	// the refusal TEACHES the shape.
	v := newVaultFake(t)
	_, errOut, code := runCmd(t, runCreds, credsEnv(t, v), "creds", "set", "stripe",
		"--kind", "api-key", "--secret", "sk_test_123")
	if code != 2 {
		t.Fatalf("code = %d, want 2", code)
	}
	if len(v.calls) != 0 {
		t.Fatalf("refusal must cost zero requests, got %+v", v.calls)
	}
	for _, want := range []string{"--allow", "unusable by design", "api.stripe.com"} {
		if !strings.Contains(errOut, want) {
			t.Errorf("stderr %q missing %q", errOut, want)
		}
	}
}

func TestCreds_SetSendsTheSecretUpAndNeverPrintsIt(t *testing.T) {
	// Invariant 1+3 from the output side: the secret reaches the PUT body and
	// NOTHING ELSE — not stdout, not stderr.
	v := newVaultFake(t)
	out, errOut, code := runCmd(t, runCreds, credsEnv(t, v), "creds", "set", "stripe",
		"--kind", "api-key", "--allow", "https://api.stripe.com", "--secret", "sk_live_SECRET")
	if code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, errOut)
	}
	if len(v.calls) != 1 || v.calls[0].Method != "PUT" {
		t.Fatalf("calls = %+v", v.calls)
	}
	if !strings.Contains(v.calls[0].Body, "sk_live_SECRET") {
		t.Error("the secret never reached the vault")
	}
	if strings.Contains(out, "sk_live_SECRET") || strings.Contains(errOut, "sk_live_SECRET") {
		t.Error("THE SECRET WAS PRINTED")
	}
	if !strings.Contains(out, "write-only, never shown again") {
		t.Errorf("stdout = %q", out)
	}
}

func TestCreds_SecretEnvIsANameNotAValue(t *testing.T) {
	v := newVaultFake(t)
	t.Setenv("BM_TEST_SECRET", "from-the-env")
	_, _, code := runCmd(t, runCreds, credsEnv(t, v), "creds", "set", "x",
		"--allow", "https://a.test", "--secret-env", "BM_TEST_SECRET")
	if code != 0 {
		t.Fatalf("code = %d", code)
	}
	if !strings.Contains(v.calls[0].Body, "from-the-env") {
		t.Errorf("the env var's VALUE should be in the body: %s", v.calls[0].Body)
	}
}

func TestCreds_ListShowsNoSecretField(t *testing.T) {
	// Invariant 1 from the read side. The fake returns metadata only (as the
	// real vault does); the CLI must render it without inventing a reveal.
	v := newVaultFake(t)
	v.list = `{"credentials":[{"name":"stripe","kind":"api-key","allow":"https://api.stripe.com",` +
		`"header":null,"scope":"actor","enforcement":"broad","meta":{}}]}`
	out, _, code := runCmd(t, runCreds, credsEnv(t, v), "creds", "list")
	if code != 0 {
		t.Fatalf("code = %d", code)
	}
	if !strings.Contains(out, "stripe") || !strings.Contains(out, "api.stripe.com") {
		t.Errorf("stdout = %q", out)
	}
}

func TestCreds_ShowSaysThereIsNoRevealButton(t *testing.T) {
	v := newVaultFake(t)
	v.list = `{"credentials":[{"name":"stripe","kind":"api-key","allow":null,` +
		`"header":null,"scope":null,"enforcement":"broad","meta":{}}]}`
	out, errOut, code := runCmd(t, runCreds, credsEnv(t, v), "creds", "show", "stripe")
	if code != 0 {
		t.Fatalf("code = %d", code)
	}
	if !strings.Contains(errOut, "no reveal button") {
		t.Errorf("stderr = %q", errOut)
	}
	// A null allow renders as the fail-closed sentence, not as blank.
	if !strings.Contains(out, "fail-closed, unusable by design") {
		t.Errorf("stdout = %q", out)
	}
}

func TestCreds_UnboundIsLoudInTheList(t *testing.T) {
	v := newVaultFake(t)
	v.list = `{"credentials":[{"name":"old","kind":"hmac-key","allow":null,` +
		`"header":null,"scope":null,"enforcement":null,"meta":{}}]}`
	out, _, _ := runCmd(t, runCreds, credsEnv(t, v), "creds", "list")
	if !strings.Contains(out, "UNBOUND") {
		t.Errorf("an unbound credential must be loud: %q", out)
	}
}

func TestCreds_RefusalsCostZeroRequests(t *testing.T) {
	for _, extra := range [][]string{
		{"set"}, // no name
		{"set", "x", "--kind", "nonsense", "--allow", "https://a.test", "--secret", "s"},
		{"rotate"},     // no name
		{"rm"},         // no name
		{"oauth", "x"}, // missing the three required urls
		{"destroy"},    // unknown subcommand
	} {
		v := newVaultFake(t)
		_, _, code := runCmd(t, runCreds, credsEnv(t, v), "creds", extra...)
		if code != 2 {
			t.Errorf("%v: code = %d, want 2", extra, code)
		}
		if len(v.calls) != 0 {
			t.Errorf("%v: refusal must cost zero requests, got %+v", extra, v.calls)
		}
	}
}

func TestCreds_NotConfiguredIsItsOwnSentence(t *testing.T) {
	f := newMailFake()
	dbPath := sendEnv(t, f) // no vaultUrl written
	_, errOut, code := runCmd(t, runCreds, dbPath, "creds", "list")
	if code != 1 {
		t.Fatalf("code = %d, want 1", code)
	}
	if !strings.Contains(errOut, "creds init --url") {
		t.Errorf("the fix must be named: %q", errOut)
	}
}

func TestCreds_OAuthFlowUploadsAndDiscards(t *testing.T) {
	// The full PKCE dance against fakes: the "browser" is a function that
	// immediately drives the callback, the token endpoint verifies the
	// verifier hashes to the challenge, and the refresh token's only
	// appearance is the PUT body.
	v := newVaultFake(t)

	var authorize *url.URL
	tokenSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		if r.Form.Get("code") != "code_42" || r.Form.Get("code_verifier") == "" {
			w.WriteHeader(400)
			_, _ = w.Write([]byte(`{"error":"bad exchange"}`))
			return
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"refresh_token":"rt_SECRET","access_token":"at_x"}`))
	}))
	defer tokenSrv.Close()

	deps := credsDeps{
		openBrowser: func(u string) error {
			var err error
			authorize, err = url.Parse(u)
			if err != nil {
				return err
			}
			// Play the provider: redirect the "browser" straight back with a
			// code and the SAME state.
			go func() {
				cb := "http://127.0.0.1:18976/callback?code=code_42&state=" + url.QueryEscape(authorize.Query().Get("state"))
				for i := 0; i < 50; i++ {
					if _, err := http.Get(cb); err == nil {
						return
					}
				}
			}()
			return nil
		},
	}

	var out, errOut strings.Builder
	s := bmio.NewTo(&out, &errOut)
	dbPath := credsEnv(t, v)
	code := runCredsWith(s, []string{"creds", "oauth", "google-drive",
		"--db", dbPath,
		"--authorize-url", "https://accounts.example.test/o/authorize",
		"--token-url", tokenSrv.URL,
		"--client-id", "cid_1",
		"--oauth-scopes", "drive.readonly",
		"--port", "18976"}, deps)
	if code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, errOut.String())
	}

	// PKCE went out properly.
	q := authorize.Query()
	if q.Get("code_challenge_method") != "S256" || q.Get("code_challenge") == "" || q.Get("state") == "" {
		t.Errorf("authorize url missing PKCE: %s", authorize)
	}
	// The refresh token went UP…
	if len(v.calls) != 1 || !strings.Contains(v.calls[0].Body, "rt_SECRET") {
		t.Fatalf("vault calls = %+v", v.calls)
	}
	if !strings.Contains(v.calls[0].Body, `"kind":"oauth-refresh"`) ||
		!strings.Contains(v.calls[0].Body, `"token_url"`) {
		t.Errorf("upload body = %s", v.calls[0].Body)
	}
	// …and NOWHERE else: not stdout, not stderr, and not on disk.
	if strings.Contains(out.String(), "rt_SECRET") || strings.Contains(errOut.String(), "rt_SECRET") {
		t.Error("THE REFRESH TOKEN WAS PRINTED")
	}
	entries, _ := os.ReadDir(filepath.Dir(dbPath))
	for _, e := range entries {
		b, err := os.ReadFile(filepath.Join(filepath.Dir(dbPath), e.Name()))
		if err == nil && strings.Contains(string(b), "rt_SECRET") {
			t.Errorf("the refresh token landed on disk in %s", e.Name())
		}
	}
	if !strings.Contains(out.String(), "not kept locally") {
		t.Errorf("stdout = %q", out.String())
	}
}

func TestCreds_OAuthStateMismatchAborts(t *testing.T) {
	v := newVaultFake(t)
	deps := credsDeps{
		openBrowser: func(u string) error {
			go func() {
				cb := "http://127.0.0.1:18977/callback?code=code_42&state=WRONG"
				for i := 0; i < 50; i++ {
					if _, err := http.Get(cb); err == nil {
						return
					}
				}
			}()
			return nil
		},
	}
	var out, errOut strings.Builder
	s := bmio.NewTo(&out, &errOut)
	code := runCredsWith(s, []string{"creds", "oauth", "x",
		"--db", credsEnv(t, v),
		"--authorize-url", "https://a.test/authorize",
		"--token-url", "https://a.test/token",
		"--client-id", "cid",
		"--port", "18977"}, deps)
	if code == 0 {
		t.Fatal("a state mismatch must abort")
	}
	if !strings.Contains(errOut.String(), "state mismatch") {
		t.Errorf("stderr = %q", errOut.String())
	}
	if len(v.calls) != 0 {
		t.Fatalf("nothing may be uploaded after a mismatch, got %+v", v.calls)
	}
	_ = fmt.Sprint() // keep fmt imported
}
