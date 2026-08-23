package cloud

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// The JSONC reader's whole risk is the false positive: a "//" inside a URL
// string read as a comment silently truncates a config mid-line, and the
// plan built from the truncation looks plausible. So the string-awareness
// cases are the test, and the real shipped configs are the integration.

func TestStripJSONC(t *testing.T) {
	cases := []struct {
		name, in, want string
	}{
		{"line comment", "{\n// gone\n\"a\": 1}", "{\n\n\"a\": 1}"},
		{"block comment", `{/* gone */"a": 1}`, `{"a": 1}`},
		{"slashes inside a string survive", `{"url": "https://x.dev/y"}`, `{"url": "https://x.dev/y"}`},
		{"escaped quote does not end the string", `{"a": "say \"//hi\" now"}`, `{"a": "say \"//hi\" now"}`},
		{"trailing comma in object", "{\"a\": 1,\n}", "{\"a\": 1\n}"},
		{"trailing comma in array", `{"a": [1, 2,]}`, `{"a": [1, 2]}`},
		{"comma then comment then closer", "{\"a\": 1, // note\n}", "{\"a\": 1 \n}"},
		{"comma between elements stays", `{"a": 1, "b": 2}`, `{"a": 1, "b": 2}`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := string(StripJSONC([]byte(c.in)))
			if got != c.want {
				t.Errorf("got %q, want %q", got, c.want)
			}
			if !json.Valid([]byte(got)) && json.Valid([]byte(c.want)) {
				t.Errorf("output is not valid JSON: %q", got)
			}
		})
	}
}

func TestParseConfig_RouteSpellings(t *testing.T) {
	cfg, err := ParseConfig([]byte(`{
		"name": "w",
		// both wire spellings, one reading — like normalizeModels
		"routes": ["plain.example.com/x/*", { "pattern": "dav.example.com", "custom_domain": true }],
	}`))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Routes[0].Pattern != "plain.example.com/x/*" || cfg.Routes[0].CustomDomain {
		t.Errorf("string route: %+v", cfg.Routes[0])
	}
	if cfg.Routes[1].Pattern != "dav.example.com" || !cfg.Routes[1].CustomDomain {
		t.Errorf("object route: %+v", cfg.Routes[1])
	}
}

func TestParseConfig_RefusesTheNameless(t *testing.T) {
	if _, err := ParseConfig([]byte(`{"main": "src/index.ts"}`)); err == nil {
		t.Fatal("a config with no `name` must refuse — every plan decision keys on it")
	}
}

// The integration: every REAL shipped config parses, and the parse sees the
// bindings the deploy workflow's comments promise. If a wrangler dialect
// feature lands in services/ that this reader cannot see, the failure
// belongs here — before a release ships a config the installer misreads.
func TestParseConfig_RealConfigs(t *testing.T) {
	root := filepath.Join("..", "..", "..")
	services, err := os.ReadDir(filepath.Join(root, "services"))
	if err != nil {
		t.Skipf("services/ not reachable from the test dir: %v", err)
	}
	parsed := 0
	for _, e := range services {
		path := filepath.Join(root, "services", e.Name(), "wrangler.jsonc")
		src, err := os.ReadFile(path)
		if err != nil {
			continue // README.md etc.
		}
		cfg, err := ParseConfig(src)
		if err != nil {
			t.Errorf("%s: %v", path, err)
			continue
		}
		parsed++
		if e.Name() == "jmap" {
			if len(cfg.Routes) == 0 || len(cfg.D1) == 0 || len(cfg.KV) == 0 {
				t.Errorf("jmap parse dropped bindings: routes=%d d1=%d kv=%d", len(cfg.Routes), len(cfg.D1), len(cfg.KV))
			}
		}
		if e.Name() == "ingest" && len(cfg.Services) == 0 {
			t.Error("ingest parse dropped its service bindings (the deploy-order edge)")
		}
	}
	if parsed < 8 {
		t.Errorf("only %d configs parsed — the sweep should cover every service", parsed)
	}
}
