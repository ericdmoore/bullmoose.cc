package cloud

import (
	"encoding/json"
	"strings"
	"testing"
)

// The planner's rules of evidence, which are the section's design (the
// same discipline as the Settings reconcile view): fresh account = all
// create; already-bullmoose = reuse, because a half-applied install is a
// RESUMABLE state; foreign DNS = refuse above everything; a denied probe
// surface = blocked-naming-the-scope, never a confident "create".

func fixtureStack(t *testing.T) *Stack {
	t.Helper()
	manifest := `{
		"manifestVersion": 1, "version": "v9.9.9",
		"deployOrder": ["alpha", "beta"],
		"workers": [
			{"name": "alpha", "bundle": "workers/alpha/index.js", "config": "workers/alpha/wrangler.jsonc"},
			{"name": "beta",  "bundle": "workers/beta/index.js",  "config": "workers/beta/wrangler.jsonc"}
		],
		"schema": ["schema/control-plane.sql", "schema/data-plane.sql"],
		"migrations": {"file": "migrations.json", "count": 7},
		"secrets": {
			"generated": {"VAULT_MASTER_KEY": {"bytes": 32, "workers": ["beta"]}},
			"external": {"SES_ACCESS_KEY_ID": {"workers": ["alpha"], "required": true, "note": "IAM: ses:SendRawEmail"}}
		},
		"webmail": "webmail.tar.gz",
		"files": {}
	}`
	var m Manifest
	if err := json.Unmarshal([]byte(manifest), &m); err != nil {
		t.Fatal(err)
	}
	alpha, err := ParseConfig([]byte(`{
		"name": "bullmoose-alpha",
		"routes": [
			{"pattern": "app.bullmoose.cc/api/*", "zone_name": "bullmoose.cc"},
			{"pattern": "dav.bullmoose.cc", "custom_domain": true}
		],
		"d1_databases": [{"binding": "DB", "database_name": "bullmoose-mail-shard0", "database_id": "built-account-id"}],
		"r2_buckets": [{"binding": "BLOBS", "bucket_name": "bullmoose-mail-blobs"}],
		"kv_namespaces": [{"binding": "ROUTES", "id": "built-account-id"}]
	}`))
	if err != nil {
		t.Fatal(err)
	}
	beta, err := ParseConfig([]byte(`{
		"name": "bullmoose-beta",
		"services": [{"binding": "ALPHA", "service": "bullmoose-alpha"}]
	}`))
	if err != nil {
		t.Fatal(err)
	}
	return &Stack{Manifest: m, Configs: map[string]*WorkerConfig{"alpha": alpha, "beta": beta}}
}

func itemsBy(p *Plan, kind string) map[string]Item {
	out := map[string]Item{}
	for _, it := range p.Items {
		if it.Kind == kind {
			out[it.Name] = it
		}
	}
	return out
}

func TestPlan_FreshAccountCreatesEverything(t *testing.T) {
	p := BuildPlan(fixtureStack(t), &ProbeResult{Zone: &ZoneInfo{ID: "z", Name: "tea.example", AccountID: "a"}}, "tea.example")
	if len(p.Refusals) != 0 || len(p.Blocked) != 0 {
		t.Fatalf("fresh account must plan clean: refusals=%v blocked=%v", p.Refusals, p.Blocked)
	}
	workers := itemsBy(p, "worker")
	if workers["bullmoose-alpha"].Action != Create || workers["bullmoose-beta"].Action != Create {
		t.Errorf("workers = %v", workers)
	}
	// The zone rewrite: routes and DNS follow the TARGET zone; the built
	// zone's name appears nowhere in the plan.
	if !strings.Contains(workers["bullmoose-alpha"].Detail, "app.tea.example/api/*") {
		t.Errorf("route not rewritten: %s", workers["bullmoose-alpha"].Detail)
	}
	dns := itemsBy(p, "dns")
	for _, want := range []string{"app.tea.example", "dav.tea.example"} {
		if dns[want].Action != Create {
			t.Errorf("dns %s = %+v", want, dns[want])
		}
	}
	for _, it := range p.Items {
		if strings.Contains(it.Name, "bullmoose.cc") || strings.Contains(it.Detail, "bullmoose.cc") {
			t.Errorf("the built zone leaked into the plan: %+v", it)
		}
	}
	// Schema + migration counts ride into the d1 item's detail.
	d1 := itemsBy(p, "d1")["bullmoose-mail-shard0"]
	if d1.Action != Create || !strings.Contains(d1.Detail, "7 migrations") {
		t.Errorf("d1 = %+v", d1)
	}
	// Secrets: minted vs supplied, notes attached.
	secrets := itemsBy(p, "secret")
	if secrets["VAULT_MASTER_KEY"].Action != Mint || !strings.Contains(secrets["VAULT_MASTER_KEY"].Detail, "32 random bytes") {
		t.Errorf("mint = %+v", secrets["VAULT_MASTER_KEY"])
	}
	if secrets["SES_ACCESS_KEY_ID"].Action != Supply || !strings.Contains(secrets["SES_ACCESS_KEY_ID"].Detail, "ses:SendRawEmail") {
		t.Errorf("supply = %+v", secrets["SES_ACCESS_KEY_ID"])
	}
}

func TestPlan_ExistingBullmooseIsResumable(t *testing.T) {
	probe := &ProbeResult{
		Zone:    &ZoneInfo{ID: "z", Name: "tea.example", AccountID: "a"},
		Workers: []string{"bullmoose-alpha"},
		D1:      []D1Database{{Name: "bullmoose-mail-shard0", UUID: "d1-uuid-1"}},
	}
	p := BuildPlan(fixtureStack(t), probe, "tea.example")
	if len(p.Refusals) != 0 {
		t.Fatalf("an existing bullmoose resource is a resumable install, not a refusal: %v", p.Refusals)
	}
	if got := itemsBy(p, "worker")["bullmoose-alpha"].Action; got != Reuse {
		t.Errorf("alpha = %s, want reuse", got)
	}
	if got := itemsBy(p, "worker")["bullmoose-beta"].Action; got != Create {
		t.Errorf("beta = %s, want create", got)
	}
	if got := itemsBy(p, "d1")["bullmoose-mail-shard0"].Action; got != Reuse {
		t.Errorf("d1 = %s, want reuse", got)
	}
}

func TestPlan_ForeignDNSRefuses(t *testing.T) {
	probe := &ProbeResult{
		Zone: &ZoneInfo{ID: "z", Name: "tea.example", AccountID: "a"},
		DNS:  []DNSRecord{{Name: "app.tea.example", Type: "A", Content: "203.0.113.7"}},
	}
	p := BuildPlan(fixtureStack(t), probe, "tea.example")
	if len(p.Refusals) != 1 || p.Refusals[0].Name != "app.tea.example" {
		t.Fatalf("refusals = %v", p.Refusals)
	}
	if !strings.Contains(p.Refusals[0].Detail, "never overwrites") {
		t.Errorf("the refusal must state the rule: %s", p.Refusals[0].Detail)
	}
}

func TestPlan_DeniedSurfaceIsBlockedNotCreate(t *testing.T) {
	probe := &ProbeResult{
		Zone:   &ZoneInfo{ID: "z", Name: "tea.example", AccountID: "a"},
		Denied: []Denial{{Surface: "Workers scripts", Scope: "Account > Workers Scripts > Edit"}},
	}
	p := BuildPlan(fixtureStack(t), probe, "tea.example")
	if len(p.Blocked) != 1 || p.Blocked[0].Scope != "Account > Workers Scripts > Edit" {
		t.Fatalf("blocked = %v — the scope must ride by NAME", p.Blocked)
	}
	// "Unknowable" must not masquerade as "create" — the confidently-wrong
	// rendering the reconcile view's rule bans, same rule here.
	if got := itemsBy(p, "worker")["bullmoose-alpha"].Action; got != Blocked {
		t.Errorf("alpha = %s, want blocked", got)
	}
}

func TestPlanHost(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{"app.bullmoose.cc", "app.tea.example"},
		{"bullmoose.cc", "tea.example"},
		{"deep.sub.bullmoose.cc", "deep.sub.tea.example"},
		{"unrelated.dev", "unrelated.dev"},
		{"notbullmoose.cc", "notbullmoose.cc"}, // suffix, not substring
	} {
		if got := planHost(c.in, "tea.example"); got != c.want {
			t.Errorf("planHost(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
