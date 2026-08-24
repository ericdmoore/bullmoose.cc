package cmd

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/store"
)

// The admin plane connects itself: a URL nobody types is a URL nobody
// mistypes, and a token you minted is a token you should not ask a human to
// copy out of scrollback.

func subdomainFake(t *testing.T, sub string, ok bool) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/workers/subdomain") {
			http.NotFound(w, r)
			return
		}
		if !ok {
			w.WriteHeader(500)
			_, _ = w.Write([]byte(`{"success":false,"errors":[{"message":"nope"}]}`))
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"success": true, "result": map[string]string{"subdomain": sub},
		})
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

func TestProvisionURLFor_DerivesFromTheAccountsSubdomain(t *testing.T) {
	t.Setenv("CLOUDFLARE_API_TOKEN", "test-token-not-a-secret")
	t.Setenv("CLOUDFLARE_API_BASE_URL", subdomainFake(t, "tea-industries", true))
	got, err := provisionURLFor("acct_1")
	if err != nil {
		t.Fatal(err)
	}
	if got != "https://bullmoose-provision.tea-industries.workers.dev" {
		t.Fatalf("got %q", got)
	}
}

func TestProvisionURLFor_NoSubdomainIsNamed(t *testing.T) {
	// The admin plane is workers.dev-only by design, so an account without a
	// subdomain has nowhere to host it — say that, do not invent a host.
	t.Setenv("CLOUDFLARE_API_TOKEN", "test-token-not-a-secret")
	t.Setenv("CLOUDFLARE_API_BASE_URL", subdomainFake(t, "", true))
	_, err := provisionURLFor("acct_1")
	if err == nil || !strings.Contains(err.Error(), "no workers.dev subdomain") {
		t.Fatalf("want the named absence, got %v", err)
	}
}

func TestConnectAdminPlane_WritesWhatAdminInitWouldHave(t *testing.T) {
	dbPath := t.TempDir() + "/mail.db"
	if err := connectAdminPlane(dbPath, "https://p.example.workers.dev/", "adm_tok"); err != nil {
		t.Fatal(err)
	}
	db, err := store.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	// Trailing slash trimmed — the same normalization admin init applies, so
	// a connected device and an init'd one are byte-identical afterwards.
	if got := store.GetConfig(db, "adminUrl"); got != "https://p.example.workers.dev" {
		t.Errorf("adminUrl = %q", got)
	}
	if got := store.GetConfig(db, "adminToken"); got != "adm_tok" {
		t.Errorf("adminToken = %q", got)
	}
}

func TestAdminInit_InfersTheURLWhenOmitted(t *testing.T) {
	dbPath := initMirror(t)
	t.Setenv("CLOUDFLARE_API_TOKEN", "test-token-not-a-secret")
	t.Setenv("CLOUDFLARE_ACCOUNT_ID", "acct_1")
	t.Setenv("CLOUDFLARE_API_BASE_URL", subdomainFake(t, "tea-industries", true))

	out, errOut, code := runCmd(t, runAdmin, dbPath, "admin", "init", "--token", "adm_tok")
	if code != 0 {
		t.Fatalf("code %d: %s", code, errOut)
	}
	if !strings.Contains(out+errOut, "bullmoose-provision.tea-industries.workers.dev") {
		t.Fatalf("did not derive:\n%s\n%s", out, errOut)
	}
	if !strings.Contains(errOut, "derived from your Cloudflare account") {
		t.Errorf("inference must say it inferred:\n%s", errOut)
	}
}

func TestAdminInit_ExplicitURLAlwaysWins(t *testing.T) {
	// Inference is a convenience, never an override.
	dbPath := initMirror(t)
	t.Setenv("CLOUDFLARE_API_TOKEN", "test-token-not-a-secret")
	t.Setenv("CLOUDFLARE_ACCOUNT_ID", "acct_1")
	t.Setenv("CLOUDFLARE_API_BASE_URL", subdomainFake(t, "tea-industries", true))

	out, _, code := runCmd(t, runAdmin, dbPath, "admin", "init", "--url", "https://mine.example", "--token", "t")
	if code != 0 || !strings.Contains(out, "https://mine.example") {
		t.Fatalf("explicit --url must win: %d %q", code, out)
	}
	if strings.Contains(out, "tea-industries") {
		t.Errorf("inference overrode an explicit flag: %q", out)
	}
}

func TestAdminInit_WithoutCloudflareCredsStillExplainsItself(t *testing.T) {
	dbPath := initMirror(t)
	t.Setenv("CLOUDFLARE_API_TOKEN", "")
	_, errOut, code := runCmd(t, runAdmin, dbPath, "admin", "init", "--token", "adm_tok")
	if code != 2 {
		t.Fatalf("code = %d", code)
	}
	if !strings.Contains(errOut, "--url is derived") {
		t.Errorf("the usage must name the inference path:\n%s", errOut)
	}
}

// initMirror is a device mirror with its schema, the state a machine is in
// after `login` or `cloud install` — `admin init` opens, it does not create.
func initMirror(t *testing.T) string {
	t.Helper()
	path := t.TempDir() + "/mail.db"
	db, err := store.Init(path)
	if err != nil {
		t.Fatal(err)
	}
	_ = db.Close()
	return path
}
