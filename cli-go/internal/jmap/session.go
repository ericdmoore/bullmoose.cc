package jmap

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
)

// The RFC 8620 §2 session resource, and the clients that resolve their endpoints
// through it.
//
// ⚠️ Why this exists when client.go's header says the port "deliberately does NOT
// fetch the session": that decision is right for `approvals`, which is Go-native
// and only ever talks to the real server, where session.ts:85 fixes apiUrl at
// `${origin}/api/jmap`. It is WRONG for the ported mail commands, for two
// independent reasons:
//
//   - `read --raw` needs `downloadUrl`, an RFC 8620 §2 URI TEMPLATE the server
//     owns. There is nothing to hardcode; packages/cli/src/jmap.ts:downloadBlob
//     expands it, so the port must too.
//   - `read`/`send` have TypeScript twins, so they are held to byte-identity, and
//     the contract suite's own stub (packages/cli/smoke/server.mjs) advertises
//     `apiUrl` as `/api` — NOT `/api/jmap`. A hardcoded path answers a 404 there
//     where Node answers the real refusal, which is exactly the class of silent
//     divergence the suite exists to catch.
//
// So the endpoint is resolved the way the RFC says and the way the TypeScript
// client already does: fetch the session once, cache it for the process.

// Mail capability URNs live in client.go (MailCap/SubmissionCap/MailUsing).

// Session is the slice of the session resource the CLI reads —
// packages/cli/src/jmap.ts Session.
type Session struct {
	APIURL      string `json:"apiUrl"`
	DownloadURL string `json:"downloadUrl"`
	Username    string `json:"username"`
	// PrimaryAccounts maps a capability URN to the account that serves it;
	// `init` reads the mail URN to pick a default account (main.ts:476).
	PrimaryAccounts map[string]string `json:"primaryAccounts"`
	// RawAccounts is kept as raw JSON because ORDER MATTERS: main.ts:483 walks
	// Object.entries(session.accounts), and a Go map would reorder them on every
	// run — turning `init`'s stored account list, and the `--json` record, into
	// something that differs between two identical invocations.
	RawAccounts json.RawMessage `json:"accounts"`
}

// SessionAccount is one entry of the session's `accounts` object, in the order
// the server sent it.
type SessionAccount struct {
	ID   string
	Name string
}

// Accounts decodes RawAccounts preserving key order (see the field's note).
func (s *Session) Accounts() ([]SessionAccount, error) {
	if len(s.RawAccounts) == 0 {
		return nil, nil
	}
	dec := json.NewDecoder(bytes.NewReader(s.RawAccounts))
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	if delim, ok := tok.(json.Delim); !ok || delim != '{' {
		return nil, &bmio.CliError{Msg: "jmap: session accounts is not an object", Code: bmio.ExitFail}
	}
	var out []SessionAccount
	for dec.More() {
		key, err := dec.Token()
		if err != nil {
			return nil, err
		}
		id, _ := key.(string)
		var value struct {
			Name string `json:"name"`
		}
		if err := dec.Decode(&value); err != nil {
			return nil, err
		}
		out = append(out, SessionAccount{ID: id, Name: value.Name})
	}
	return out, nil
}

// HasAccount reports whether the session serves this account — the check
// main.ts:477 makes before storing an accountId it was handed.
func (s *Session) HasAccount(id string) bool {
	accounts, err := s.Accounts()
	if err != nil {
		return false
	}
	for _, a := range accounts {
		if a.ID == id {
			return true
		}
	}
	return false
}

// NewSessionClient builds a client that resolves its endpoints from the session
// resource, as packages/cli/src/jmap.ts does for every call. Use it for the
// PORTED commands; NewClient's computed path stays the Go-native default.
func NewSessionClient(base, token string) *Client {
	c := NewClient(base, token)
	c.viaSession = true
	return c
}

// Session fetches (and caches) `/.well-known/jmap`. One fetch per process, like
// jmap.ts's sessionCache — `send` makes four method calls and must not re-fetch
// four times.
func (c *Client) Session(ctx context.Context) (*Session, error) {
	if c.session != nil {
		return c.session, nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+"/.well-known/jmap", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, &bmio.CliError{Msg: "session fetch failed: " + err.Error(), Code: bmio.ExitFail}
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		// jmap.ts:session — the message and the status both, so a 401 here exits
		// 4 rather than a generic 1.
		return nil, transportError(
			fmt.Sprintf("session fetch failed: HTTP %d %s", resp.StatusCode, string(raw)),
			resp.StatusCode, raw)
	}
	var s Session
	if err := json.Unmarshal(raw, &s); err != nil {
		return nil, &bmio.CliError{Msg: "jmap: malformed session resource: " + err.Error(), Code: bmio.ExitFail}
	}
	c.session = &s
	return c.session, nil
}

// endpoint is the URL Call posts to: the session's apiUrl for a session client,
// else the computed path (client.go's note).
func (c *Client) endpoint(ctx context.Context) (string, error) {
	if !c.viaSession {
		return c.base + "/api/jmap", nil
	}
	s, err := c.Session(ctx)
	if err != nil {
		return "", err
	}
	return s.APIURL, nil
}

// DownloadBlob fetches raw blob bytes through the session's downloadUrl template
// — jmap.ts:downloadBlob, including the four substitutions and their encoding.
// `read --raw` is the only caller.
func (c *Client) DownloadBlob(ctx context.Context, accountID, blobID string) ([]byte, error) {
	s, err := c.Session(ctx)
	if err != nil {
		return nil, err
	}
	url := s.DownloadURL
	url = strings.ReplaceAll(url, "{accountId}", encodeURIComponent(accountID))
	url = strings.ReplaceAll(url, "{blobId}", encodeURIComponent(blobID))
	url = strings.ReplaceAll(url, "{name}", "blob")
	url = strings.ReplaceAll(url, "{type}", encodeURIComponent("application/octet-stream"))

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, &bmio.CliError{Msg: "blob download failed: " + err.Error(), Code: bmio.ExitFail}
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		// jmap.ts passes an EMPTY body here, so no `type` is lifted and the
		// status alone decides the code. Kept identical.
		return nil, transportError(
			fmt.Sprintf("blob download failed: HTTP %d", resp.StatusCode), resp.StatusCode, nil)
	}
	return io.ReadAll(resp.Body)
}

// encodeURIComponent is JavaScript's, not Go's: net/url's escapers differ from
// encodeURIComponent in both directions (QueryEscape turns a space into `+`;
// PathEscape leaves `/` alone, and `{type}` expands to a media type that MUST
// come out as `application%2Foctet-stream`). The unreserved set is ECMA-262
// §19.2.6.5: A-Z a-z 0-9 - _ . ! ~ * ' ( )
func encodeURIComponent(s string) string {
	const hex = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		ch := s[i]
		switch {
		case ch >= 'A' && ch <= 'Z', ch >= 'a' && ch <= 'z', ch >= '0' && ch <= '9',
			ch == '-', ch == '_', ch == '.', ch == '!', ch == '~', ch == '*', ch == '\'',
			ch == '(', ch == ')':
			b.WriteByte(ch)
		default:
			b.WriteByte('%')
			b.WriteByte(hex[ch>>4])
			b.WriteByte(hex[ch&0x0f])
		}
	}
	return b.String()
}
