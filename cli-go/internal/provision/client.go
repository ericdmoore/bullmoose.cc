// Package provision is a minimal client for the PROVISION worker's admin API —
// the control-plane surface `services/provision/src/index.ts` serves behind a
// single `Authorization: Bearer <ADMIN_TOKEN>` gate.
//
// It exists because `agent_bindings` lives in the control plane, not in the mail
// account: there is no `AgentBinding/*` JMAP collection and no `/console/*`
// route served today, so the ONLY server surface that can read or write a
// binding is this worker. `bullmoose agents` (s10 T4) is therefore a client of
// this API in exactly the way `approvals` is a client of internal/jmap — same
// discipline, different plane:
//
//   - every write goes through a route that already exists, with the gate it
//     already has (the admin bearer). This package mints no authority: it
//     cannot reach D1, and there is no code path here that writes anything the
//     worker does not already expose as a route;
//   - a non-2xx refusal is surfaced VERBATIM and carries its HTTP status, so
//     bmio.ExitCodeFor turns the server's judgement into the exit code
//     (404 → 3, 409 → 5, 401/403 → 4) rather than a generic 1.
//
// The worker answers `{"error": "<sentence>"}` on failure (json() in
// index.ts). That sentence is a human explanation, NOT a JMAP error type, so it
// is only ever used as message text — setting it as a ServerError.JMAPType
// would let an unlisted word silently outrank a perfectly good status.
package provision

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
)

// Client is a bearer-authenticated client for one provision worker.
type Client struct {
	base  string
	token string
	http  *http.Client
}

// NewClient reads its base + token from the mirror's admin config
// (store.RequireAdmin). There is no second source of truth for the endpoint.
func NewClient(base, token string) *Client {
	return &Client{
		base:  strings.TrimRight(base, "/"),
		token: token,
		http:  &http.Client{Timeout: 30 * time.Second},
	}
}

// Call performs one admin API request and returns the raw JSON body. `body` is
// marshalled when non-nil; a nil body sends no request entity, matching
// admin.ts's `...(body ? { body: … } : {})`.
func (c *Client) Call(ctx context.Context, method, path string, body any) (json.RawMessage, error) {
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
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		// A transport failure (DNS, refused, timeout) the caller can do nothing
		// about → generic failure, exit 1 (io.ts's default).
		return nil, &bmio.CliError{
			Msg:  "provision request failed: " + err.Error(),
			Code: bmio.ExitFail,
		}
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, &bmio.ServerError{
			Msg:        "admin API " + method + " " + path + " → " + errorSentence(resp.StatusCode, raw),
			HTTPStatus: resp.StatusCode,
		}
	}
	return raw, nil
}

// errorSentence renders the worker's `{"error": …}` when there is one, and
// falls back to the status + raw body when there is not. The operator sees what
// the server said, not a re-worded approximation.
func errorSentence(status int, raw []byte) string {
	var parsed struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(raw, &parsed) == nil && parsed.Error != "" {
		return "HTTP " + strconv.Itoa(status) + ": " + parsed.Error
	}
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return "HTTP " + strconv.Itoa(status)
	}
	return "HTTP " + strconv.Itoa(status) + ": " + trimmed
}

// Query builds a `?email=…` filter the way admin.ts's accountQuery does —
// encoded, and absent entirely when there is no selector, because
// `?email=` with an empty value is a filter for the address "" rather than no
// filter at all.
func Query(email string) string {
	if email == "" {
		return ""
	}
	return "?email=" + url.QueryEscape(email)
}
