package cloud

// The expansion rules, each of which is a way a static deploy goes subtly
// wrong: a path that escapes the archive, a build with no entry point, a
// key whose slashes get eaten by URL encoding.

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func targz(files map[string]string, extra ...tar.Header) string {
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for name, body := range files {
		_ = tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(body)), Typeflag: tar.TypeReg})
		_, _ = tw.Write([]byte(body))
	}
	for _, h := range extra {
		hdr := h
		_ = tw.WriteHeader(&hdr)
	}
	_ = tw.Close()
	_ = gz.Close()
	return buf.String()
}

func TestWebmailAssets_ExpandsRegularFilesOnly(t *testing.T) {
	site := targz(
		map[string]string{"index.html": "<h1>hi</h1>", "./_astro/a.js": "1", "favicon.ico": "x"},
		tar.Header{Name: "_astro/", Typeflag: tar.TypeDir, Mode: 0o755},
		tar.Header{Name: "link.html", Typeflag: tar.TypeSymlink, Linkname: "index.html"},
	)
	assets, err := webmailAssets([]byte(site))
	if err != nil {
		t.Fatal(err)
	}
	keys := map[string]bool{}
	for _, a := range assets {
		keys[a.Key] = true
	}
	if len(assets) != 3 || !keys["index.html"] || !keys["_astro/a.js"] {
		// `./` is stripped — a key the worker asks for as `_astro/a.js`
		// must not be stored as `./_astro/a.js`.
		t.Fatalf("keys = %v", keys)
	}
	if keys["_astro/"] || keys["link.html"] {
		t.Error("a directory or symlink was uploaded as a file")
	}
}

func TestWebmailAssets_RefusesTheBrokenAndTheHostile(t *testing.T) {
	// A path that climbs out of the archive is a broken build or an
	// attempt; either way it must not become an object.
	_, err := webmailAssets([]byte(targz(map[string]string{"index.html": "x", "../escape.js": "bad"})))
	if err == nil || !strings.Contains(err.Error(), "out-of-tree") {
		t.Fatalf("err = %v", err)
	}
	// No entry point means the worker's SPA fallback has nothing to fall
	// back to — every route 404s and the cause is three layers away.
	_, err = webmailAssets([]byte(targz(map[string]string{"_astro/a.js": "1"})))
	if err == nil || !strings.Contains(err.Error(), "index.html") {
		t.Fatalf("err = %v", err)
	}
	if _, err := webmailAssets([]byte("not a gzip")); err == nil {
		t.Error("garbage must refuse")
	}
	if _, err := webmailAssets([]byte(targz(map[string]string{}))); err == nil {
		t.Error("an empty archive must refuse")
	}
}

func TestPathEscape_KeepsHierarchyAndEncodesTheRest(t *testing.T) {
	// The bug this prevents: %2F-ing the slashes stores `_astro/app.js` as
	// one flat key, and the worker then asks for an object nobody wrote.
	if got := pathEscape("_astro/app.abc123.js"); got != "_astro/app.abc123.js" {
		t.Errorf("hierarchy lost: %q", got)
	}
	if got := pathEscape("assets/a b.png"); got != "assets/a%20b.png" {
		t.Errorf("space not encoded: %q", got)
	}
	if got := pathEscape("i18n/café.html"); !strings.Contains(got, "%") || strings.Contains(got, "é") {
		t.Errorf("non-ascii not encoded: %q", got)
	}
}

func TestContentTypes_AgreeWithTheWorker(t *testing.T) {
	// The worker sets what it serves; this sets what R2 stores. They must
	// agree, or an operator reading the bucket sees a different truth than
	// the browser does.
	for key, want := range map[string]string{
		"index.html":    "text/html; charset=utf-8",
		"_astro/a.js":   "text/javascript; charset=utf-8",
		"style.css":     "text/css; charset=utf-8",
		"logo.svg":      "image/svg+xml",
		"font.woff2":    "font/woff2",
		"unknown.weird": "application/octet-stream",
		"noextension":   "application/octet-stream",
	} {
		if got := contentTypeForAsset(key); got != want {
			t.Errorf("%s → %q, want %q", key, got, want)
		}
	}
}

// ---- the directory front door (CI's) obeys the same rules as the tarball ----

func TestWebmailAssetsFromDir_WalksAndKeepsHierarchy(t *testing.T) {
	dir := t.TempDir()
	mustWrite(t, dir, "index.html", "<!doctype html>")
	mustWrite(t, dir, "_astro/app.js", "console.log(1)")
	mustWrite(t, dir, "settings/index.html", "<p>settings</p>")

	assets, err := siteAssetsFromDir(dir)
	if err != nil {
		t.Fatalf("expand: %v", err)
	}
	got := map[string]string{}
	for _, a := range assets {
		got[a.Key] = string(a.Body)
	}
	// Slash-separated keys, not the platform separator: an R2 key is a URL
	// path, and a Windows build writing `_astro\app.js` would store a key the
	// worker never asks for.
	for _, want := range []string{"index.html", "_astro/app.js", "settings/index.html"} {
		if _, ok := got[want]; !ok {
			t.Errorf("missing key %q (got %v)", want, keysOf(got))
		}
	}
	if got["_astro/app.js"] != "console.log(1)" {
		t.Errorf("body not carried through: %q", got["_astro/app.js"])
	}
}

func TestWebmailAssetsFromDir_RefusesABuildWithNoEntryPoint(t *testing.T) {
	dir := t.TempDir()
	mustWrite(t, dir, "_astro/app.js", "console.log(1)")

	_, err := siteAssetsFromDir(dir)
	if err == nil || !strings.Contains(err.Error(), "index.html") {
		t.Fatalf("a build with no index.html must be refused by name, got %v", err)
	}
}

func TestWebmailAssetsFromDir_RefusesAnEmptyDirWithABuildHint(t *testing.T) {
	_, err := siteAssetsFromDir(t.TempDir())
	// "contained no files" alone reads like a bug in the uploader; the
	// overwhelmingly likely cause is that nobody ran the build.
	if err == nil || !strings.Contains(err.Error(), "build") {
		t.Fatalf("empty dir should point at the build step, got %v", err)
	}
}

// The uploader writes to this bucket; the worker reads from it. If they ever
// disagree the deploy SUCCEEDS and serves nothing, which is the most
// expensive shape of wrong available here.
func TestWebmailBucket_MatchesTheWorkersOwnBinding(t *testing.T) {
	cfg, err := os.ReadFile(filepath.Join("..", "..", "..", "services", "webhost", "wrangler.jsonc"))
	if err != nil {
		t.Fatalf("read webhost config: %v", err)
	}
	if !strings.Contains(string(cfg), `"bucket_name": "`+WebmailBucket+`"`) {
		t.Fatalf("services/webhost/wrangler.jsonc does not bind SITE to %q — the uploader would write where the worker never reads", WebmailBucket)
	}
}

func mustWrite(t *testing.T, dir, rel, body string) {
	t.Helper()
	p := filepath.Join(dir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func keysOf(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// ---- prefixes: one bucket, many builds ----

func TestPrune_RefusesAnEmptyPrefixWithoutCallingAnything(t *testing.T) {
	// The dangerous shape: a workflow computes `--prefix pr-$PR` and $PR is
	// unset. An empty prefix matches every key, so "prune the closed PR"
	// would become "delete the site". It must refuse BEFORE any request.
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	cf := NewCF(srv.URL, "t", srv.Client())

	for _, prefix := range []string{"", "   "} {
		n, err := PruneSitePrefix(cf, "acct", "bucket", prefix, func(string) {})
		if err == nil {
			t.Fatalf("prefix %q must be refused", prefix)
		}
		if n != 0 {
			t.Errorf("refused prune reported %d deletions", n)
		}
		if !strings.Contains(err.Error(), "every object") {
			t.Errorf("the refusal should say what it would have destroyed, got %v", err)
		}
	}
	if called {
		t.Error("an empty-prefix prune reached the network — it must refuse before that")
	}
}

func TestUploadSiteDir_PutsEveryKeyUnderThePrefix(t *testing.T) {
	dir := t.TempDir()
	mustWrite(t, dir, "index.html", "<!doctype html>")
	mustWrite(t, dir, "_astro/app.js", "console.log(1)")

	var got []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = append(got, r.URL.Path)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	cf := NewCF(srv.URL, "t", srv.Client())

	// "pr-7" without the trailing slash is the shape a workflow writes, and
	// the one that silently produces `pr-7index.html` if nobody normalizes.
	if _, err := UploadSiteDir(cf, "acct", "bucket", dir, "pr-7", func(string) {}); err != nil {
		t.Fatalf("upload: %v", err)
	}
	joined := strings.Join(got, "\n")
	for _, want := range []string{"/objects/pr-7/index.html", "/objects/pr-7/_astro/app.js"} {
		if !strings.Contains(joined, want) {
			t.Errorf("missing %s in:\n%s", want, joined)
		}
	}
	if strings.Contains(joined, "pr-7index.html") {
		t.Error("prefix was concatenated without a separator — the worker would never find these")
	}
}
