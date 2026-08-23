package cmd

// s46 T2 end-to-end: `cloud plan` against a fake dl.bullmoose.cc and a fake
// Cloudflare API. Everything here is read-only by construction — the CF
// fake serves only GETs, and a mutating request would 404, which is itself
// the assertion that plan never mutates.
//
// Deliberately NOT via runCmd: that helper appends --db to every argv, and
// `cloud` refusing --db is a feature under test, not an obstacle.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	bmio "github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
)

func runCloudCmd(t *testing.T, argv ...string) (out, errOut string, code int) {
	t.Helper()
	var o, e strings.Builder
	s := bmio.NewTo(&o, &e)
	code = runCloud(s, append([]string{"cloud"}, argv...))
	return o.String(), e.String(), code
}

// stackFake publishes a two-worker stack the way release-stack.yml would:
// manifest + configs, checksums true. Returns its base URL.
func stackFake(t *testing.T) string {
	t.Helper()
	configs := map[string]string{
		"alpha": `{
			"name": "bullmoose-alpha",
			"routes": [{"pattern": "app.bullmoose.cc/api/*", "zone_name": "bullmoose.cc"}],
			"d1_databases": [{"binding": "DB", "database_name": "bullmoose-mail-shard0"}],
			"r2_buckets": [{"binding": "BLOBS", "bucket_name": "bullmoose-mail-blobs"}]
		}`,
		"beta": `{"name": "bullmoose-beta", "services": [{"binding": "ALPHA", "service": "bullmoose-alpha"}]}`,
	}
	files := map[string]string{}
	for name, src := range configs {
		sum := sha256.Sum256([]byte(src))
		files["workers/"+name+"/wrangler.jsonc"] = hex.EncodeToString(sum[:])
	}
	manifest := map[string]any{
		"manifestVersion": 1, "version": "v9.9.9",
		"deployOrder": []string{"alpha", "beta"},
		"workers": []map[string]string{
			{"name": "alpha", "bundle": "workers/alpha/index.js", "config": "workers/alpha/wrangler.jsonc"},
			{"name": "beta", "bundle": "workers/beta/index.js", "config": "workers/beta/wrangler.jsonc"},
		},
		"schema":     []string{"schema/control-plane.sql", "schema/data-plane.sql"},
		"migrations": map[string]any{"file": "migrations.json", "count": 7},
		"secrets": map[string]any{
			"generated": map[string]any{"VAULT_MASTER_KEY": map[string]any{"bytes": 32, "workers": []string{"beta"}}},
			"external":  map[string]any{"SES_ACCESS_KEY_ID": map[string]any{"workers": []string{"alpha"}, "required": true, "note": "IAM: ses:SendRawEmail"}},
		},
		"webmail": "webmail.tar.gz",
		"files":   files,
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/latest.txt", func(w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, "v9.9.9") })
	mux.HandleFunc("/v9.9.9/manifest.json", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(manifest)
	})
	for name, src := range configs {
		body := src
		mux.HandleFunc("/v9.9.9/workers/"+name+"/wrangler.jsonc", func(w http.ResponseWriter, _ *http.Request) {
			fmt.Fprint(w, body)
		})
	}
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv.URL
}

// cfFake is a read-only Cloudflare API: the account is `state`; a surface
// listed in denied403 answers 403 the way a scoped-away token does.
type cfState struct {
	workers, d1, r2, kv, pages []string
	dns                        []map[string]string
	denied403                  map[string]bool // by path suffix
}

func cfFake(t *testing.T, state *cfState) string {
	t.Helper()
	env := func(result any) []byte {
		b, _ := json.Marshal(map[string]any{"success": true, "errors": []any{}, "result": result})
		return b
	}
	named := func(key string, names []string) []map[string]string {
		out := make([]map[string]string, 0, len(names))
		for _, n := range names {
			out = append(out, map[string]string{key: n, "id": n, "name": n, "title": n})
		}
		return out
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("plan sent a %s to %s — plan is read-only", r.Method, r.URL.Path)
			http.NotFound(w, r)
			return
		}
		if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
			t.Errorf("no bearer header on %s", r.URL.Path)
		}
		if strings.Contains(r.URL.RawQuery, "token") {
			t.Errorf("token leaked into a URL: %s", r.URL.String())
		}
		for suffix := range state.denied403 {
			if strings.HasSuffix(r.URL.Path, suffix) {
				w.WriteHeader(http.StatusForbidden)
				return
			}
		}
		switch {
		case r.URL.Path == "/user/tokens/verify":
			w.Write(env(map[string]string{"status": "active"}))
		case r.URL.Path == "/zones":
			if r.URL.Query().Get("name") != "tea.example" {
				w.Write(env([]any{}))
				return
			}
			w.Write(env([]map[string]any{{"id": "z1", "name": "tea.example", "account": map[string]string{"id": "a1"}}}))
		case strings.HasSuffix(r.URL.Path, "/workers/scripts"):
			w.Write(env(named("id", state.workers)))
		case strings.HasSuffix(r.URL.Path, "/d1/database"):
			w.Write(env(named("name", state.d1)))
		case strings.HasSuffix(r.URL.Path, "/r2/buckets"):
			w.Write(env(map[string]any{"buckets": named("name", state.r2)}))
		case strings.HasSuffix(r.URL.Path, "/storage/kv/namespaces"):
			w.Write(env(named("title", state.kv)))
		case strings.HasSuffix(r.URL.Path, "/pages/projects"):
			w.Write(env(named("name", state.pages)))
		case strings.HasSuffix(r.URL.Path, "/dns_records"):
			w.Write(env(state.dns))
		default:
			t.Errorf("unexpected CF call: %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

func cloudEnv(t *testing.T, stackURL, cfURL string) {
	t.Helper()
	t.Setenv("CLOUDFLARE_API_TOKEN", "test-token-not-a-secret")
	t.Setenv("CLOUDFLARE_API_BASE_URL", cfURL)
}

func TestCloudPlan_FreshAccount(t *testing.T) {
	stack, cf := stackFake(t), cfFake(t, &cfState{})
	cloudEnv(t, stack, cf)
	out, errOut, code := runCloudCmd(t, "plan", "--zone", "tea.example", "--stack-base", stack)
	if code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, errOut)
	}
	for _, want := range []string{
		"plan: stack v9.9.9 onto tea.example",
		"+ worker bullmoose-alpha (create)",
		"route app.tea.example/api/*",
		"+ d1 bullmoose-mail-shard0 (create)",
		"7 migrations",
		"⚿ secret VAULT_MASTER_KEY (mint)",
		"→ secret SES_ACCESS_KEY_ID (supply)",
		"read-only: nothing above has happened",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("plan lacks %q\n%s", want, out)
		}
	}
	if strings.Contains(out, "REFUSALS") || strings.Contains(out, "BLOCKED") {
		t.Errorf("a fresh account plans clean:\n%s", out)
	}
}

func TestCloudPlan_ResumableAndLatest(t *testing.T) {
	// No --stack-version: latest.txt resolves it. Existing bullmoose
	// resources plan as reuse — a half-applied install is resumable.
	stack, cf := stackFake(t), cfFake(t, &cfState{workers: []string{"bullmoose-alpha"}})
	cloudEnv(t, stack, cf)
	out, _, code := runCloudCmd(t, "plan", "--zone", "tea.example", "--stack-base", stack)
	if code != 0 {
		t.Fatalf("code = %d", code)
	}
	if !strings.Contains(out, "= worker bullmoose-alpha (reuse)") || !strings.Contains(out, "+ worker bullmoose-beta (create)") {
		t.Errorf("resume rendering:\n%s", out)
	}
}

func TestCloudPlan_ForeignDNSRefusesAboveEverything(t *testing.T) {
	stack, cf := stackFake(t), cfFake(t, &cfState{
		dns: []map[string]string{{"name": "app.tea.example", "type": "A", "content": "203.0.113.7"}},
	})
	cloudEnv(t, stack, cf)
	out, _, code := runCloudCmd(t, "plan", "--zone", "tea.example", "--stack-base", stack)
	if code != 1 {
		t.Fatalf("refusals must exit 1, got %d", code)
	}
	refusalAt := strings.Index(out, "REFUSALS")
	firstItem := strings.Index(out, "+ worker")
	if refusalAt == -1 || (firstItem != -1 && refusalAt > firstItem) {
		t.Errorf("refusals must render ABOVE the inventory:\n%s", out)
	}
	if !strings.Contains(out, "never overwrites a resource it did not make") {
		t.Errorf("the refusal must state the rule:\n%s", out)
	}
}

func TestCloudPlan_DeniedSurfaceNamesTheScope(t *testing.T) {
	stack, cf := stackFake(t), cfFake(t, &cfState{denied403: map[string]bool{"/workers/scripts": true}})
	cloudEnv(t, stack, cf)
	out, _, code := runCloudCmd(t, "plan", "--zone", "tea.example", "--stack-base", stack)
	if code != 1 {
		t.Fatalf("blocked surfaces must exit 1, got %d", code)
	}
	if !strings.Contains(out, "Account > Workers Scripts > Edit") {
		t.Errorf("the scope must ride by name, not HTTP code:\n%s", out)
	}
	if !strings.Contains(out, "? worker bullmoose-alpha (blocked)") {
		t.Errorf("unknowable must not masquerade as create:\n%s", out)
	}
}

func TestCloudPlan_JSON(t *testing.T) {
	stack, cf := stackFake(t), cfFake(t, &cfState{})
	cloudEnv(t, stack, cf)
	out, _, code := runCloudCmd(t, "plan", "--zone", "tea.example", "--stack-base", stack, "--json")
	if code != 0 {
		t.Fatalf("code = %d", code)
	}
	var plan struct {
		Version string `json:"version"`
		Items   []any  `json:"items"`
	}
	if err := json.Unmarshal([]byte(out), &plan); err != nil {
		t.Fatalf("not JSON: %v\n%s", err, out)
	}
	if plan.Version != "v9.9.9" || len(plan.Items) == 0 {
		t.Errorf("plan = %+v", plan)
	}
}

func TestCloudPlan_ChecksumMismatchDies(t *testing.T) {
	// A mirror serving bytes that do not match the manifest's sha256 is a
	// torn upload or tampering; the plan must die, not proceed on them.
	mux := http.NewServeMux()
	cfgBody := `{"name": "bullmoose-alpha"}`
	mux.HandleFunc("/v1/manifest.json", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"manifestVersion": 1, "version": "v1", "deployOrder": []string{"alpha"},
			"workers": []map[string]string{{"name": "alpha", "bundle": "workers/alpha/index.js", "config": "workers/alpha/wrangler.jsonc"}},
			"files":   map[string]string{"workers/alpha/wrangler.jsonc": strings.Repeat("0", 64)},
		})
	})
	mux.HandleFunc("/v1/workers/alpha/wrangler.jsonc", func(w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, cfgBody) })
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	cloudEnv(t, srv.URL, cfFake(t, &cfState{}))
	_, errOut, code := runCloudCmd(t, "plan", "--zone", "tea.example", "--stack-base", srv.URL, "--stack-version", "v1")
	if code == 0 || !strings.Contains(errOut, "sha256 mismatch") {
		t.Fatalf("code = %d, stderr = %s", code, errOut)
	}
}

func TestCloudPlan_Usage(t *testing.T) {
	t.Setenv("CLOUDFLARE_API_TOKEN", "x")
	if _, errOut, code := runCloudCmd(t, "plan"); code != 2 || !strings.Contains(errOut, "--zone") {
		t.Errorf("missing zone: code=%d err=%s", code, errOut)
	}
	t.Setenv("CLOUDFLARE_API_TOKEN", "")
	if _, errOut, code := runCloudCmd(t, "plan", "--zone", "x.dev"); code != 2 || !strings.Contains(errOut, "CLOUDFLARE_API_TOKEN") {
		t.Errorf("missing token: code=%d err=%s", code, errOut)
	}
	if _, errOut, code := runCloudCmd(t); code != 2 || !strings.Contains(errOut, "cloud plan --zone") {
		t.Errorf("no verb: code=%d err=%s", code, errOut)
	}
	if _, errOut, code := runCloudCmd(t, "teleport"); code != 2 || !strings.Contains(errOut, "teleport") {
		t.Errorf("unknown verb: code=%d err=%s", code, errOut)
	}
	if _, errOut, code := runCloudCmd(t, "plan", "--db", "/tmp/x"); code != 2 || !strings.Contains(errOut, "--db") {
		t.Errorf("unowned flag: code=%d err=%s", code, errOut)
	}
}
