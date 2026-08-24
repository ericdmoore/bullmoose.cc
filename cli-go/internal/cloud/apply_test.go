package cloud

// Apply's contract, asserted against a recording fake: the order IS the
// binding graph, ids come from the ACCOUNT (created or probed), never from
// the shipped configs, secrets land exactly where the manifest says, and
// the refusal/blocked gates stop apply before its first mutation — a gate
// that fires after one create is not a gate.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// mirrorFake publishes a complete two-worker stack version v1: manifest,
// configs, bundles, schema, migrations — checksums true, so the real
// Fetcher/FetchVerified path is what the tests exercise.
func mirrorFake(t *testing.T) *Fetcher {
	t.Helper()
	files := map[string]string{
		"workers/alpha/wrangler.jsonc": `{
			"name": "bullmoose-alpha",
			"compatibility_date": "2026-06-01",
			"routes": [
				{"pattern": "app.bullmoose.cc/api/*", "zone_name": "bullmoose.cc"},
				{"pattern": "dav.bullmoose.cc", "custom_domain": true}
			],
			"d1_databases": [{"binding": "DB", "database_name": "bullmoose-mail-shard0", "database_id": "built-account-id"}],
			"r2_buckets": [{"binding": "BLOBS", "bucket_name": "bullmoose-mail-blobs"}],
			"kv_namespaces": [{"binding": "ROUTES", "id": "built-account-id"}],
			"vars": {"RELAY": "ses"}
		}`,
		"workers/beta/wrangler.jsonc": `{
			"name": "bullmoose-beta",
			"compatibility_date": "2026-06-01",
			"services": [{"binding": "ALPHA", "service": "bullmoose-alpha"}],
			"durable_objects": {"bindings": [{"name": "DO", "class_name": "TestDO"}]},
			"migrations": [{"tag": "v1", "new_sqlite_classes": ["TestDO"]}]
		}`,
		"workers/alpha/index.js":   `export default { fetch() { return new Response("alpha") } }`,
		"workers/beta/index.js":    `export default { fetch() { return new Response("beta") } }`,
		"schema/control-plane.sql": "CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY);",
		"schema/data-plane.sql":    "CREATE TABLE IF NOT EXISTS emails (id TEXT PRIMARY KEY);",
		"migrations.json": `[{"id": "m1", "why": "w", "blocks": null,
			"check": "SELECT count(*) AS n FROM pragma_table_info('accounts') WHERE name='deleted_at'",
			"up": ["ALTER TABLE accounts ADD COLUMN deleted_at INTEGER"]}]`,
	}
	sums := map[string]string{}
	for path, body := range files {
		s := sha256.Sum256([]byte(body))
		sums[path] = hex.EncodeToString(s[:])
	}
	manifest := map[string]any{
		"manifestVersion": 1, "version": "v1",
		"deployOrder": []string{"alpha", "beta"},
		"workers": []map[string]string{
			{"name": "alpha", "bundle": "workers/alpha/index.js", "config": "workers/alpha/wrangler.jsonc"},
			{"name": "beta", "bundle": "workers/beta/index.js", "config": "workers/beta/wrangler.jsonc"},
		},
		"schema":     []string{"schema/control-plane.sql", "schema/data-plane.sql"},
		"migrations": map[string]any{"file": "migrations.json", "count": 1},
		"secrets": map[string]any{
			"generated": map[string]any{
				"VAULT_MASTER_KEY": map[string]any{"bytes": 32, "workers": []string{"beta"}},
				"ADMIN_TOKEN":      map[string]any{"bytes": 24, "workers": []string{"alpha"}},
			},
			"external": map[string]any{
				"SES_ACCESS_KEY_ID": map[string]any{"workers": []string{"alpha"}, "required": true, "note": ""},
			},
		},
		"webmail": "webmail.tar.gz",
		"files":   sums,
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/manifest.json", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(manifest)
	})
	for path, body := range files {
		b := body
		mux.HandleFunc("/v1/"+path, func(w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, b) })
	}
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return NewFetcher(srv.URL, nil)
}

// applyFake records every mutation in order and answers with account-
// assigned ids. checkN is what D1 answers to migration CHECK queries.
type applyFake struct {
	t      *testing.T
	ops    []string
	bodies map[string]string // op → raw body
	checkN int
}

func (f *applyFake) server(t *testing.T) string {
	t.Helper()
	env := func(result any) []byte {
		b, _ := json.Marshal(map[string]any{"success": true, "errors": []any{}, "result": result})
		return b
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		op := r.Method + " " + r.URL.Path
		if r.Method != http.MethodGet {
			f.ops = append(f.ops, op)
			f.bodies[op] += "\n" + string(body) // accumulate: repeated paths (every /query) share one op key
		}
		switch {
		case strings.HasSuffix(r.URL.Path, "/storage/kv/namespaces") && r.Method == http.MethodPost:
			w.Write(env(map[string]string{"id": "kv-new-1", "title": "ROUTES"}))
		case strings.HasSuffix(r.URL.Path, "/r2/buckets") && r.Method == http.MethodPost:
			w.Write(env(map[string]string{}))
		case strings.HasSuffix(r.URL.Path, "/d1/database") && r.Method == http.MethodPost:
			w.Write(env(map[string]string{"name": "bullmoose-mail-shard0", "uuid": "d1-new-1"}))
		case strings.Contains(r.URL.Path, "/d1/database/") && strings.HasSuffix(r.URL.Path, "/query"):
			var q struct {
				SQL string `json:"sql"`
			}
			_ = json.Unmarshal(body, &q)
			n := f.checkN
			if strings.Contains(q.SQL, "sqlite_master") {
				n = 5 // the verify count
			}
			w.Write(env([]map[string]any{{"results": []map[string]int{{"n": n}}}}))
		case strings.Contains(r.URL.Path, "/workers/scripts/") && strings.HasSuffix(r.URL.Path, "/secrets"):
			w.Write(env(map[string]string{}))
		case strings.Contains(r.URL.Path, "/workers/scripts/"):
			w.Write(env(map[string]string{}))
		case strings.HasSuffix(r.URL.Path, "/workers/routes") && r.Method == http.MethodGet:
			w.Write(env([]any{}))
		case strings.HasSuffix(r.URL.Path, "/workers/routes"):
			w.Write(env(map[string]string{"id": "route-1"}))
		case strings.HasSuffix(r.URL.Path, "/workers/domains"):
			w.Write(env(map[string]string{"id": "domain-1"}))
		default:
			f.t.Errorf("unexpected: %s", op)
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

func newApplyFake(t *testing.T) (*applyFake, *CF) {
	f := &applyFake{t: t, bodies: map[string]string{}, checkN: 1}
	return f, NewCF(f.server(t), "test-token", nil)
}

func freshProbe() *ProbeResult {
	return &ProbeResult{Zone: &ZoneInfo{ID: "z1", Name: "tea.example", AccountID: "a1"}}
}

func fetchFixture(t *testing.T) *Stack {
	t.Helper()
	st, err := mirrorFake(t).Fetch("v1")
	if err != nil {
		t.Fatal(err)
	}
	return st
}

func opIndex(ops []string, substr string) int {
	for i, op := range ops {
		if strings.Contains(op, substr) {
			return i
		}
	}
	return -1
}

func TestApply_FreshAccount(t *testing.T) {
	st := fetchFixture(t)
	probe := freshProbe()
	fake, cf := newApplyFake(t)
	plan := BuildPlan(st, probe, "tea.example")
	applied, err := ApplyCore(cf, st, probe, plan, ApplyOpts{
		Zone:     "tea.example",
		External: map[string]string{"SES_ACCESS_KEY_ID": "AKIATEST"},
	})
	if err != nil {
		t.Fatalf("%v\nops: %v", err, fake.ops)
	}

	// The order is the binding graph: storage → schema → alpha → beta → routes.
	kv := opIndex(fake.ops, "kv/namespaces")
	schema := opIndex(fake.ops, "/query")
	alpha := opIndex(fake.ops, "scripts/bullmoose-alpha")
	beta := opIndex(fake.ops, "scripts/bullmoose-beta")
	route := opIndex(fake.ops, "workers/routes")
	if !(kv < schema && schema < alpha && alpha < beta && beta < route) {
		t.Errorf("order broke the binding graph: kv=%d schema=%d alpha=%d beta=%d route=%d\n%v",
			kv, schema, alpha, beta, route, fake.ops)
	}

	// Ids are the ACCOUNT's, never the shipped config's.
	alphaBody := fake.bodies["PUT /accounts/a1/workers/scripts/bullmoose-alpha"]
	if !strings.Contains(alphaBody, `"namespace_id":"kv-new-1"`) || !strings.Contains(alphaBody, `"id":"d1-new-1"`) {
		t.Errorf("alpha metadata must carry learned ids:\n%s", alphaBody)
	}
	if strings.Contains(alphaBody, "built-account-id") {
		t.Error("the built account's id leaked into an upload")
	}
	if !strings.Contains(alphaBody, `"name":"RELAY","text":"ses","type":"plain_text"`) {
		t.Errorf("vars must ride as plain_text:\n%s", alphaBody)
	}

	// DO migrations ride the CREATE of the declaring script.
	betaBody := fake.bodies["PUT /accounts/a1/workers/scripts/bullmoose-beta"]
	if !strings.Contains(betaBody, `"new_sqlite_classes":["TestDO"]`) || !strings.Contains(betaBody, `"new_tag":"v1"`) {
		t.Errorf("beta create must send its DO migration:\n%s", betaBody)
	}

	// workers.dev mirrors wrangler: enabled iff no routes. alpha has routes
	// (disabled); beta has none (enabled) — beta is the provision shape,
	// the `admin init` door that MUST be reachable.
	if !strings.Contains(fake.bodies["POST /accounts/a1/workers/scripts/bullmoose-alpha/subdomain"], `"enabled":false`) {
		t.Error("alpha has routes — workers.dev must be disabled")
	}
	if !strings.Contains(fake.bodies["POST /accounts/a1/workers/scripts/bullmoose-beta/subdomain"], `"enabled":true`) {
		t.Error("beta has no routes — workers.dev must be enabled (the admin-plane door)")
	}

	// Secrets land where the manifest says, and nowhere else.
	alphaSecrets := fake.bodies["PUT /accounts/a1/workers/scripts/bullmoose-alpha/secrets"]
	if !strings.Contains(alphaSecrets, "ADMIN_TOKEN") && !strings.Contains(alphaSecrets, "SES_ACCESS_KEY_ID") {
		t.Errorf("alpha secrets: %s", alphaSecrets)
	}
	if len(applied.Minted["VAULT_MASTER_KEY"]) != 64 { // 32 bytes hex
		t.Errorf("minted VAULT_MASTER_KEY = %q — 32 random bytes as hex, the bootstrap.mjs shape", applied.Minted["VAULT_MASTER_KEY"])
	}
	if len(applied.MissingExternal) != 0 {
		t.Errorf("SES was supplied; missing = %v", applied.MissingExternal)
	}

	// Custom domain and route both landed, on the TARGET zone.
	if _, ok := fake.bodies["PUT /accounts/a1/workers/domains"]; !ok {
		t.Error("no custom domain call")
	} else if !strings.Contains(fake.bodies["PUT /accounts/a1/workers/domains"], "dav.tea.example") {
		t.Errorf("custom domain not rewritten: %s", fake.bodies["PUT /accounts/a1/workers/domains"])
	}
	if !strings.Contains(fake.bodies["POST /zones/z1/workers/routes"], "app.tea.example/api/*") {
		t.Errorf("route not rewritten: %s", fake.bodies["POST /zones/z1/workers/routes"])
	}
}

func TestApply_GatesFireBeforeAnyMutation(t *testing.T) {
	st := fetchFixture(t)
	fake, cf := newApplyFake(t)

	refusing := &Plan{Refusals: []Item{{Kind: "dns", Name: "app.tea.example", Action: Refuse}}}
	if _, err := ApplyCore(cf, st, freshProbe(), refusing, ApplyOpts{Zone: "tea.example"}); err == nil {
		t.Fatal("a refusal must stop apply")
	}
	blocked := &Plan{Blocked: []Denial{{Surface: "Workers scripts", Scope: "Account > Workers Scripts > Edit"}}}
	if _, err := ApplyCore(cf, st, freshProbe(), blocked, ApplyOpts{Zone: "tea.example"}); err == nil {
		t.Fatal("a blocked surface must stop apply")
	}
	if len(fake.ops) != 0 {
		t.Errorf("the gates fired AFTER mutations: %v", fake.ops)
	}
}

func TestApply_ReuseBindsProbedIdsAndSkipsDOMigration(t *testing.T) {
	st := fetchFixture(t)
	probe := freshProbe()
	probe.Workers = []string{"bullmoose-alpha", "bullmoose-beta"}
	probe.D1 = []D1Database{{Name: "bullmoose-mail-shard0", UUID: "d1-probed-7"}}
	probe.KV = []KVNamespace{{Title: "ROUTES", ID: "kv-probed-7"}}
	probe.R2 = []string{"bullmoose-mail-blobs"}
	fake, cf := newApplyFake(t)
	plan := BuildPlan(st, probe, "tea.example")
	if _, err := ApplyCore(cf, st, probe, plan, ApplyOpts{Zone: "tea.example", External: map[string]string{"SES_ACCESS_KEY_ID": "x"}}); err != nil {
		t.Fatalf("%v\nops: %v", err, fake.ops)
	}
	for _, op := range fake.ops {
		if strings.HasPrefix(op, "POST") && (strings.Contains(op, "kv/namespaces") || strings.Contains(op, "/d1/database") && !strings.Contains(op, "query") || strings.Contains(op, "r2/buckets")) {
			t.Errorf("reuse must not create: %s", op)
		}
	}
	alphaBody := fake.bodies["PUT /accounts/a1/workers/scripts/bullmoose-alpha"]
	if !strings.Contains(alphaBody, "kv-probed-7") || !strings.Contains(alphaBody, "d1-probed-7") {
		t.Errorf("reuse must bind the PROBED ids:\n%s", alphaBody)
	}
	betaBody := fake.bodies["PUT /accounts/a1/workers/scripts/bullmoose-beta"]
	if strings.Contains(betaBody, "new_sqlite_classes") {
		t.Error("an existing script has its DO tag — re-sending the migration is an error")
	}
}

func TestApply_MigrationRunsWhenCheckSaysMissing(t *testing.T) {
	st := fetchFixture(t)
	probe := freshProbe()
	fake, cf := newApplyFake(t)
	fake.checkN = 0 // every CHECK answers "missing"
	plan := BuildPlan(st, probe, "tea.example")
	if _, err := ApplyCore(cf, st, probe, plan, ApplyOpts{Zone: "tea.example", External: map[string]string{"SES_ACCESS_KEY_ID": "x"}}); err != nil {
		t.Fatal(err)
	}
	found := false
	for op, body := range fake.bodies {
		if strings.Contains(op, "/query") && strings.Contains(body, "ADD COLUMN deleted_at") {
			found = true
		}
	}
	if !found {
		t.Error("check said missing but the up statement never ran")
	}
}

func TestApply_MissingRequiredExternalIsNamedNotFatal(t *testing.T) {
	st := fetchFixture(t)
	probe := freshProbe()
	_, cf := newApplyFake(t)
	applied, err := ApplyCore(cf, st, probe, BuildPlan(st, probe, "tea.example"), ApplyOpts{Zone: "tea.example"})
	if err != nil {
		t.Fatal(err)
	}
	if len(applied.MissingExternal) != 1 || applied.MissingExternal[0] != "SES_ACCESS_KEY_ID" {
		t.Errorf("missing = %v — the required external secret must be NAMED", applied.MissingExternal)
	}
}
