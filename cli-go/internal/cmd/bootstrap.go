package cmd

// Bootstrap bundles: anywhere the CLI takes a server URL, a `file://` URL is
// accepted instead (db.ts:9). The file is a JSON connection bundle an operator
// writes — typically alongside a freshly minted token — and carries to the
// device out of band:
//
//	{ "base": "https://mail.bullmoose.cc",   // or "url", for admin bundles
//	  "token": "bm_…",
//	  "accountId": "t_…__a_…" }              // optional
//
// Explicit CLI flags always win over file contents, which is why the callers
// test flag PRESENCE (args.HasToken and friends) rather than emptiness.

import (
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
)

type bootstrap struct {
	Base      string `json:"base"`
	URL       string `json:"url"`
	Token     string `json:"token"`
	AccountID string `json:"accountId"`
}

// isFileURL is db.ts:28 — a prefix test, not a parse, so a malformed `file:`
// still routes to loadBootstrap and gets a message about the file rather than
// being treated as an https base.
func isFileURL(value string) bool { return strings.HasPrefix(value, "file:") }

// loadBootstrap reads and parses one bundle, with db.ts:32's three refusals:
// an unusable URL and unparseable JSON are usage errors (exit 2), a missing file
// is not-found (exit 3).
func loadBootstrap(fileURL string) (bootstrap, error) {
	path, err := fileURLToPath(fileURL)
	if err != nil {
		return bootstrap{}, bmio.Fail("invalid file:// URL: "+fileURL, bmio.ExitUsage)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return bootstrap{}, bmio.NotFound("bootstrap file not found: " + path)
		}
		return bootstrap{}, bmio.Fail("bootstrap file unreadable: "+path+" ("+err.Error()+")", bmio.ExitUsage)
	}
	var b bootstrap
	if err := json.Unmarshal(raw, &b); err != nil {
		return bootstrap{}, bmio.Fail(
			"bootstrap file is not valid JSON: "+path+" ("+err.Error()+")", bmio.ExitUsage)
	}
	return b, nil
}

// fileURLToPath is node:url's fileURLToPath, which is stricter than url.Parse:
// the scheme must be `file`, and the only host it tolerates is an empty one or
// `localhost` (a real host would name a UNC share, which is not a local path).
func fileURLToPath(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return "", err
	}
	if u.Scheme != "file" || (u.Host != "" && u.Host != "localhost") {
		return "", errNotAFileURL
	}
	path := u.Path
	if path == "" {
		return "", errNotAFileURL
	}
	if runtime.GOOS == "windows" {
		// file:///C:/x → C:\x
		path = strings.TrimPrefix(path, "/")
		path = filepath.FromSlash(path)
	}
	return path, nil
}

var errNotAFileURL = &bmio.CliError{Msg: "not a file:// URL", Code: bmio.ExitUsage}
