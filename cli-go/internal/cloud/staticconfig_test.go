package cloud

// Pages' own file formats, kept as the interface. The tests that matter are
// the REFUSALS: a redirect that silently does not exist looks exactly like one
// that works, right up until someone follows the old link.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseRedirects_TheSubsetAStaticSiteActuallyUses(t *testing.T) {
	rs, err := ParseRedirects(`
# a comment
/old            /new
/legacy         /current            301
/guides/*       /docs/:splat        301
/wellknown      https://app.example.com/x  302
/dead           /                   410
`)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(rs) != 5 {
		t.Fatalf("want 5 rules, got %d (%+v)", len(rs), rs)
	}
	by := map[string]Redirect{}
	for _, r := range rs {
		by[r.From] = r
	}
	if by["/old"].Status != 302 {
		t.Errorf("a rule with no status should default to 302, got %d", by["/old"].Status)
	}
	if !by["/guides"].Splat || by["/guides"].To != "/docs/:splat" {
		t.Errorf("trailing wildcard not compiled: %+v", by["/guides"])
	}
	if by["/dead"].Status != 410 {
		t.Errorf("410 should be allowed, got %d", by["/dead"].Status)
	}
}

func TestParseRedirects_RefusesWhatItCannotDo(t *testing.T) {
	cases := []struct{ name, body, wants string }{
		{"placeholder capture", "/blog/:year/:slug  /posts/:slug", ":placeholder"},
		{"mid-path wildcard", "/a/*/b  /c", "trailing"},
		{"status 200 rewrite", "/app/*  /index.html  200", "REWRITE"},
		{"unknown status", "/a  /b  418", "not one this supports"},
		{"source without a slash", "example.com/a  /b", "must start with /"},
		{"splat destination with no splat source", "/a  /b/:splat", "no trailing"},
		{"too many fields", "/a  /b  301  extra", "fields"},
		{"only one field", "/a", "at least a source"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := ParseRedirects(c.body)
			if err == nil {
				t.Fatalf("%q must be refused, not silently dropped", c.body)
			}
			if !strings.Contains(err.Error(), c.wants) {
				t.Errorf("refusal should explain %q; got %v", c.wants, err)
			}
			// Every refusal names the line, or a 400-line file is a hunt.
			if !strings.Contains(err.Error(), "line ") {
				t.Errorf("refusal must name the line: %v", err)
			}
		})
	}
}

func TestParseRedirects_TheStatus200RefusalPointsAtTheRealMechanism(t *testing.T) {
	// The most likely thing someone copies in from a Pages SPA config. Telling
	// them "unsupported" would leave them stuck; the host does this natively.
	_, err := ParseRedirects("/*  /index.html  200")
	if err == nil || !strings.Contains(err.Error(), "spa") {
		t.Fatalf("the 200 refusal should name the SPA setting that replaces it, got %v", err)
	}
}

func TestParseHeaders_BlocksAndRemovals(t *testing.T) {
	hs, err := ParseHeaders(`
/build/*
  Cache-Control: public, max-age=31536000, immutable
/admin
  X-Frame-Options: DENY
  ! X-Powered-By
`)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(hs) != 2 {
		t.Fatalf("want 2 blocks, got %d", len(hs))
	}
	var admin HeaderRule
	for _, h := range hs {
		if h.Path == "/admin" {
			admin = h
		}
	}
	if admin.Set["x-frame-options"] != "DENY" {
		t.Errorf("header not captured (names lower-cased): %+v", admin.Set)
	}
	if len(admin.Unset) != 1 || admin.Unset[0] != "x-powered-by" {
		t.Errorf("`!` removal not captured: %+v", admin.Unset)
	}
}

func TestParseHeaders_RefusesTheShapesThatWouldSilentlyDoNothing(t *testing.T) {
	cases := []struct{ name, body, wants string }{
		// The classic: forgetting to indent means the header reads as a path.
		{"unindented header", "/a\nX-Frame-Options: DENY", "not indented"},
		{"header before any path", "  X-Frame-Options: DENY", "no path precedes"},
		{"path without slash", "admin\n  X: y", "should be a path"},
		{"not a name: value", "/a\n  nonsense", "Name: value"},
		{"bare removal", "/a\n  !", "name of a header"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := ParseHeaders(c.body)
			if err == nil {
				t.Fatalf("%q must be refused", c.body)
			}
			if !strings.Contains(err.Error(), c.wants) {
				t.Errorf("want %q in refusal, got %v", c.wants, err)
			}
		})
	}
}

func TestCompileRouting_ConsumesTheFilesAndOrdersBySpecificity(t *testing.T) {
	assets := []Asset{
		{Key: "index.html", Body: []byte("<h1>hi</h1>")},
		{Key: "_redirects", Body: []byte("/a/*  /x/:splat  301\n/a/deep/*  /y/:splat  301\n")},
		{Key: "_headers", Body: []byte("/*\n  X-A: 1\n/deep/*\n  X-B: 2\n")},
	}
	kept, cfg, err := compileRouting(assets)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	for _, a := range kept {
		if a.Key == "_redirects" || a.Key == "_headers" {
			t.Fatalf("%s was uploaded — it is configuration and must never be served", a.Key)
		}
	}
	if len(kept) != 1 {
		t.Fatalf("only index.html should remain, got %+v", kept)
	}
	// Longest source first, so the specific rule cannot be shadowed by the
	// general one just because of where it sat in the file.
	if cfg.Redirects[0].From != "/a/deep" {
		t.Errorf("redirects should be most-specific-first, got %+v", cfg.Redirects)
	}
	// Headers go the other way: general first, so specific blocks override.
	if cfg.Headers[0].Path != "" {
		t.Errorf("header rules should be least-specific-first, got %+v", cfg.Headers)
	}
}

// The CLI writes this key; the workers read it. If they ever disagree the
// push succeeds, the deploy succeeds, and every redirect silently stops
// existing — the exact failure this file's refusals exist to prevent, arrived
// at from the other side.
func TestRoutingKey_MatchesTheWorkersConstant(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("..", "..", "..", "services", "webhost", "src", "serve.ts"))
	if err != nil {
		t.Fatalf("read serve.ts: %v", err)
	}
	want := `export const ROUTING_KEY = "` + RoutingKey + `"`
	if !strings.Contains(string(src), want) {
		t.Fatalf("services/webhost/src/serve.ts does not declare ROUTING_KEY as %q — "+
			"the CLI would write rules the worker never reads", RoutingKey)
	}
}
