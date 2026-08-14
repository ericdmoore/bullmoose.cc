// Package auth is a client for the jmap worker's SELF-SERVICE auth routes —
// services/jmap/src/authRoutes.ts:
//
//	POST   /auth/login        {email, loginKey, name?, scopes?} → a token, once
//	GET    /auth/tokens       list own tokens (no secrets)
//	POST   /auth/tokens       {name, scopes} mint another (⊆ own scopes)
//	DELETE /auth/tokens/{id}  revoke own
//
// It is the third plane this binary talks to and it deserves its own package for
// the same reason the other two do: internal/jmap speaks the JMAP envelope,
// internal/provision speaks the operator/control plane behind an ADMIN bearer,
// and these four routes are neither — they are password- or self-token-
// authenticated, and they are the only routes that ever see a credential.
//
// ── Two rules this package exists to keep ─────────────────────────────────
//
//  1. The raw password never enters this package. Login takes a DERIVED KEY
//     (internal/authkey), because the server never sees plaintext — arch.md §5.1
//     is explicit that this property, not any CPU budget, is why the derivation
//     is client-side. There is no field here that could hold a password.
//
//  2. A refusal is rendered, never dumped. `/auth/login` on a domain with no
//     bullmoose behind it answers with an HTML page, and packages/cli/src/
//     tokens.ts:77 interpolates the whole body into the error — which is how a
//     marketing page ends up pasted into a terminal. summarizeBody keeps a
//     server's JSON verbatim (it is the actual explanation) and reduces anything
//     else to its type and size.
package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
)

// Client talks to one server's /auth routes. Token is empty for `login` (which
// is authenticated by the derived key in the body) and set for `token` (which is
// authenticated by the credential the mirror already holds).
type Client struct {
	base  string
	token string
	http  *http.Client
}

func New(base, token string) *Client {
	return &Client{
		base:  strings.TrimRight(base, "/"),
		token: token,
		http:  &http.Client{Timeout: 60 * time.Second},
	}
}

// Account is one account the login can see — authRoutes.ts:129, in the server's
// key order so `--json` output is byte-identical to the Node CLI's, which
// re-emits the parsed object (tokens.ts:111).
type Account struct {
	AccountID string  `json:"accountId"`
	TenantID  string  `json:"tenantId"`
	Name      string  `json:"name"`
	Address   *string `json:"address"`
}

// LoginResult is the one and only time the minted secret is visible.
type LoginResult struct {
	Token    string    `json:"token"`
	TokenID  string    `json:"tokenId"`
	Username string    `json:"username"`
	Scopes   []string  `json:"scopes"`
	Accounts []Account `json:"accounts"`
}

// Login POSTs /auth/login. `loginKey` is the PBKDF2 output, hex — never a
// password. `scopes` nil means "say nothing", which is the ONLY way to take the
// server's default (tokens.ts:38: /auth/login is the one self-service route that
// can widen, because it is password-authenticated rather than token-scoped).
func (c *Client) Login(ctx context.Context, email, loginKey, name string, scopes []string) (*LoginResult, error) {
	body := map[string]any{"email": email, "loginKey": loginKey, "name": name}
	if scopes != nil {
		body["scopes"] = scopes
	}
	raw, err := c.do(ctx, http.MethodPost, "/auth/login", body, "login failed")
	if err != nil {
		return nil, err
	}
	var out LoginResult
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, malformed("login", err)
	}
	return &out, nil
}

// CreateResult is POST /auth/tokens — authRoutes.ts:190. `scopes` is what the
// SERVER decided, which is not always what was asked: an agent-marked token
// re-minting itself keeps the marker (authRoutes.ts:176), so the CLI prints the
// server's answer rather than its own request.
type CreateResult struct {
	Token   string   `json:"token"`
	TokenID string   `json:"tokenId"`
	Scopes  []string `json:"scopes"`
}

func (c *Client) CreateToken(ctx context.Context, name string, scopes []string) (*CreateResult, error) {
	raw, err := c.do(ctx, http.MethodPost, "/auth/tokens",
		map[string]any{"name": name, "scopes": scopes}, "token create failed")
	if err != nil {
		return nil, err
	}
	var out CreateResult
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, malformed("token create", err)
	}
	return &out, nil
}

// ListTokens returns the rows as RAW JSON, deliberately. `token list --json`
// re-emits each row verbatim (tokens.ts:201 emitNdjson(body.tokens)), so decoding
// into a struct here would silently DROP any field the server grew — `expires_at`
// is already one the server selects and the CLI's own type never named. The
// human renderer decodes the four fields it prints, and nothing else.
func (c *Client) ListTokens(ctx context.Context) ([]json.RawMessage, error) {
	raw, err := c.do(ctx, http.MethodGet, "/auth/tokens", nil, "token list failed")
	if err != nil {
		return nil, err
	}
	var out struct {
		Tokens []json.RawMessage `json:"tokens"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, malformed("token list", err)
	}
	return out.Tokens, nil
}

// RevokeToken deletes one token — authRoutes.ts:199. `revoked: false` is not an
// error: it means the id was not this principal's, which the CLI reports as a
// note rather than a failure.
func (c *Client) RevokeToken(ctx context.Context, id string) (bool, error) {
	raw, err := c.do(ctx, http.MethodDelete, "/auth/tokens/"+id, nil, "revoke failed")
	if err != nil {
		return false, err
	}
	var out struct {
		Revoked bool `json:"revoked"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return false, malformed("revoke", err)
	}
	return out.Revoked, nil
}

// do performs one request and maps a refusal to an exit code the way
// tokens.ts does: exitCodeForHttpStatus on the status, with the server's own
// words in the message (401/403 → 4, 404 → 3, 409 → 5, other 4xx → 2, else 1).
func (c *Client) do(ctx context.Context, method, path string, body any, what string) (json.RawMessage, error) {
	var reader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, reader)
	if err != nil {
		// A base that will not parse is a typo'd --base, not a server fault.
		return nil, bmio.Usage(what + ": " + c.base + path + " is not a usable URL")
	}
	req.Header.Set("content-type", "application/json")
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		// DNS, refused, timeout: nothing the caller can retype, so exit 1
		// (io.ts's default), and the reason rather than a stack fragment.
		return nil, &bmio.CliError{Msg: what + ": " + transportDetail(err), Code: bmio.ExitFail}
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, &bmio.CliError{
			Msg: fmt.Sprintf("%s: HTTP %d %s", what, resp.StatusCode,
				summarizeBody(resp.Header.Get("content-type"), raw)),
			Code: bmio.ExitCodeForHTTPStatus(resp.StatusCode),
		}
	}
	return raw, nil
}

// summarizeBody renders a refusal body for a human.
//
// JSON passes through verbatim — `{"error":"invalid credentials"}` IS the
// explanation, and the Node CLI prints exactly that. Anything else is described
// rather than printed: the case that matters is a 404 HTML page from a domain
// that has no bullmoose on it, where interpolating the body pastes a whole web
// page into the terminal (the failure that motivated the probe in
// internal/discover).
func summarizeBody(contentType string, raw []byte) string {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return ""
	}
	if strings.Contains(contentType, "json") || strings.HasPrefix(trimmed, "{") || strings.HasPrefix(trimmed, "[") {
		return trimmed
	}
	kind := contentType
	if i := strings.Index(kind, ";"); i >= 0 {
		kind = kind[:i]
	}
	if kind = strings.TrimSpace(kind); kind == "" {
		kind = "untyped"
	}
	return fmt.Sprintf("(%d bytes of %s — not a server message; is this really a bullmoose server?)",
		len(raw), kind)
}

func transportDetail(err error) string {
	msg := err.Error()
	if i := strings.LastIndex(msg, ": "); i >= 0 && i+2 < len(msg) {
		msg = msg[i+2:]
	}
	return msg
}

func malformed(what string, err error) error {
	return &bmio.CliError{Msg: what + ": the server's answer was not the expected JSON (" + err.Error() + ")",
		Code: bmio.ExitFail}
}
