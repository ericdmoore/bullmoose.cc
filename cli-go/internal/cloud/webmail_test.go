package cloud

// The expansion rules, each of which is a way a static deploy goes subtly
// wrong: a path that escapes the archive, a build with no entry point, a
// key whose slashes get eaten by URL encoding.

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
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
