package cloud

// The webmail upload — the last step that needed a JavaScript toolchain.
//
// Until this, `cloud install` ended by printing `npx wrangler pages deploy`,
// and that single line was the only place in the whole install where a
// person learned this platform is built in TypeScript. Removing it by
// reimplementing Pages' own upload would have meant copying an
// undocumented, wrangler-internal protocol — BLAKE3 over base64-plus-
// extension, truncated to 32 hex, a JWT dance, four private endpoints —
// which Cloudflare can change under us at any time, silently.
//
// So the webmail moves to R2 behind a small worker (services/webhost), and
// this uploads it with the SAME documented API surface everything else in
// ApplyCore uses: an object PUT per file. No BLAKE3, no JWT, no private
// protocol, nothing to drift.
//
// The tarball is the one the stack already publishes (`webmail.tar.gz`,
// checksummed in the manifest like every other file), so the bytes a
// stranger serves are the bytes CI built and signed for.

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"fmt"
	"io"
	"net/http"
	"path"
	"strings"
)

// maxAssetBytes guards the one shape that would otherwise fail late and
// confusingly: a build that accidentally ships something enormous. R2 takes
// far larger objects; this is a sanity bound on a STATIC SITE's files.
const maxAssetBytes = 25 << 20 // 25 MiB

// Asset is one file of the built app, ready to PUT.
type Asset struct {
	Key  string // site-root-relative, no leading slash: "index.html"
	Body []byte
}

/**
 * Expand the published webmail tarball into the objects R2 should hold.
 *
 * Directory entries, symlinks and anything that escapes the archive root
 * are dropped rather than uploaded: a static site is a flat set of regular
 * files, and a `../` in an archive path is either a broken build or an
 * attempt — neither deserves a write.
 */
func webmailAssets(targz []byte) ([]Asset, error) {
	gz, err := gzip.NewReader(bytes.NewReader(targz))
	if err != nil {
		return nil, fmt.Errorf("webmail.tar.gz is not gzip: %w", err)
	}
	defer gz.Close()

	var assets []Asset
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("webmail.tar.gz is truncated or corrupt: %w", err)
		}
		if hdr.Typeflag != tar.TypeReg {
			continue // directories, symlinks — nothing to serve
		}
		key := path.Clean(strings.TrimPrefix(hdr.Name, "./"))
		if key == "." || strings.HasPrefix(key, "../") || path.IsAbs(key) {
			return nil, fmt.Errorf("webmail.tar.gz contains an out-of-tree path: %q", hdr.Name)
		}
		if hdr.Size > maxAssetBytes {
			return nil, fmt.Errorf("%s is %d bytes — larger than a static asset should ever be", key, hdr.Size)
		}
		body, err := io.ReadAll(io.LimitReader(tr, maxAssetBytes+1))
		if err != nil {
			return nil, fmt.Errorf("reading %s: %w", key, err)
		}
		assets = append(assets, Asset{Key: key, Body: body})
	}
	if len(assets) == 0 {
		return nil, fmt.Errorf("webmail.tar.gz contained no files")
	}
	// An app with no entry point is a deploy that will 404 at the root, and
	// the worker's SPA fallback would have nothing to fall back TO.
	hasIndex := false
	for _, a := range assets {
		if a.Key == "index.html" {
			hasIndex = true
			break
		}
	}
	if !hasIndex {
		return nil, fmt.Errorf("webmail.tar.gz has no index.html at its root — the app would have no entry point")
	}
	return assets, nil
}

// putR2Object writes one object with the CF API — the same Bearer token,
// the same account, as every other call in ApplyCore.
func (c *CF) putR2Object(acct, bucket, key string, body []byte, contentType string) error {
	req, err := http.NewRequest(
		http.MethodPut,
		c.Base+"/accounts/"+acct+"/r2/buckets/"+bucket+"/objects/"+pathEscape(key),
		bytes.NewReader(body),
	)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("Content-Type", contentType)
	res, err := c.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("PUT %s: %w", key, err)
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return fmt.Errorf("PUT %s: HTTP %d", key, res.StatusCode)
	}
	_, _ = io.Copy(io.Discard, res.Body)
	return nil
}

// pathEscape encodes a key for the URL path WITHOUT turning its slashes
// into %2F — R2 keys are hierarchical and `_astro/app.js` must stay two
// segments, or the object lands under a name the worker will never ask for.
func pathEscape(key string) string {
	parts := strings.Split(key, "/")
	for i, p := range parts {
		parts[i] = urlPathSegment(p)
	}
	return strings.Join(parts, "/")
}

func urlPathSegment(s string) string {
	var b strings.Builder
	for _, r := range []byte(s) {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') ||
			r == '-' || r == '_' || r == '.' || r == '~' {
			b.WriteByte(r)
			continue
		}
		fmt.Fprintf(&b, "%%%02X", r)
	}
	return b.String()
}

// contentTypeForAsset mirrors services/webhost's own table. The worker sets
// the header it serves; this sets what R2 stores, and the two agreeing
// means an operator poking at the bucket sees the same truth the browser
// does.
func contentTypeForAsset(key string) string {
	ext := ""
	if i := strings.LastIndex(key, "."); i >= 0 {
		ext = strings.ToLower(key[i+1:])
	}
	switch ext {
	case "html":
		return "text/html; charset=utf-8"
	case "js", "mjs":
		return "text/javascript; charset=utf-8"
	case "css":
		return "text/css; charset=utf-8"
	case "json", "map":
		return "application/json; charset=utf-8"
	case "svg":
		return "image/svg+xml"
	case "png":
		return "image/png"
	case "jpg", "jpeg":
		return "image/jpeg"
	case "webp":
		return "image/webp"
	case "avif":
		return "image/avif"
	case "ico":
		return "image/x-icon"
	case "woff2":
		return "font/woff2"
	case "woff":
		return "font/woff"
	case "ttf":
		return "font/ttf"
	case "txt":
		return "text/plain; charset=utf-8"
	case "webmanifest":
		return "application/manifest+json"
	case "xml":
		return "application/xml"
	default:
		return "application/octet-stream"
	}
}

// uploadWebmail expands the published tarball and writes every file to the
// site bucket. Returns how many objects landed.
func uploadWebmail(cf *CF, acct, bucket string, targz []byte, log func(string)) (int, error) {
	assets, err := webmailAssets(targz)
	if err != nil {
		return 0, err
	}
	for i, a := range assets {
		if err := cf.putR2Object(acct, bucket, a.Key, a.Body, contentTypeForAsset(a.Key)); err != nil {
			// Partial is honest here: the objects already written stay, and
			// a re-run overwrites them by key. Saying WHICH file stopped it
			// is what makes the retry informed.
			return i, fmt.Errorf("uploading %s (%d of %d): %w", a.Key, i+1, len(assets), err)
		}
	}
	log(fmt.Sprintf("webmail: %d files uploaded to r2://%s", len(assets), bucket))
	return len(assets), nil
}
