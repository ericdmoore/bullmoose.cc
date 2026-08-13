// Package jmap is a minimal JMAP-over-HTTP client — the FIRST Go code that talks
// to the live bullmoose server rather than the local mirror (internal/store).
// `approvals` needs it because ActionProposal is a SERVER-side collection, not in
// the mirror; it is structured for reuse, since every future non-mirror command
// (send, writes) needs exactly this.
//
// The wire contract is a straight port of packages/cli/src/jmap.ts: POST a
// `{using, methodCalls}` request, read `methodResponses`, and map a method-level
// `["error", {type,description}]` (jmap.ts:143-151) and a non-2xx transport
// refusal (jmap.ts:76-87) onto the vocabulary internal/io (bmio) turns into an
// exit code — so a `forbidden` is exit 4 and a `stateMismatch` is exit 5 without
// re-parsing a human sentence.
//
// It deliberately does NOT fetch the session (`.well-known/jmap`) first: the
// mirror already holds the base, and session.ts:85 defines apiUrl as
// `${origin}/api/jmap`, so the endpoint is computable without a round trip.
package jmap

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

// Capability URNs — packages/jmap-core/src/capabilities.ts:3,14. The server
// validates `using` against SUPPORTED_CAPS (services/jmap/src/index.ts:162) and
// gates ActionProposal behind AgentCap (actionProposal.test.ts:351).
const (
	CoreCap  = "urn:ietf:params:jmap:core"
	AgentCap = "urn:bullmoose:params:jmap:agent"
)

// AgentUsing is the capability list every ActionProposal/* call sends.
var AgentUsing = []string{CoreCap, AgentCap}

// Mail capability URNs — packages/jmap-core/src/capabilities.ts:4,5.
const (
	MailCap       = "urn:ietf:params:jmap:mail"
	SubmissionCap = "urn:ietf:params:jmap:submission"
)

// MailUsing is the capability list packages/cli/src/jmap.ts:60 sends on every
// call — Email/*, Mailbox/* and the submission methods share one `using`, so the
// sync engine (internal/mirror) speaks the same request the Node CLI does.
var MailUsing = []string{CoreCap, MailCap, SubmissionCap}

// Invocation is one method call to SEND — the RFC 8620 §3.2 triple
// [name, args, callId]. It marshals to that JSON array.
type Invocation struct {
	Name   string
	Args   map[string]any
	CallID string
}

// MarshalJSON renders the triple. A nil Args becomes `{}` so the server never
// sees a null where an object is expected.
func (inv Invocation) MarshalJSON() ([]byte, error) {
	args := inv.Args
	if args == nil {
		args = map[string]any{}
	}
	return json.Marshal([]any{inv.Name, args, inv.CallID})
}

// Response is one method response RECEIVED. Args stays raw so a caller can decode
// it into a typed shape AND `--json` can re-emit exactly what the server sent.
type Response struct {
	Name   string
	Args   json.RawMessage
	CallID string
}

// UnmarshalJSON reads the [name, args, callId] triple, keeping args verbatim.
func (r *Response) UnmarshalJSON(b []byte) error {
	var tuple []json.RawMessage
	if err := json.Unmarshal(b, &tuple); err != nil {
		return err
	}
	if len(tuple) != 3 {
		return fmt.Errorf("jmap: malformed method response (want 3 elements, got %d)", len(tuple))
	}
	if err := json.Unmarshal(tuple[0], &r.Name); err != nil {
		return err
	}
	r.Args = tuple[1]
	return json.Unmarshal(tuple[2], &r.CallID)
}

// Ref builds a back-reference (RFC 8620 §3.7) the server resolves in dispatch
// (packages/jmap-core/src/dispatch.ts:63-89): put `Ref(...)` under a `#name` key
// and the arg is filled from a prior response's JSON pointer path. `approvals
// list` uses it to get-after-query in one round trip.
func Ref(resultOf, name, path string) map[string]any {
	return map[string]any{"resultOf": resultOf, "name": name, "path": path}
}

// Client is a bearer-authenticated JMAP client over one base URL.
type Client struct {
	base  string
	token string
	http  *http.Client
}

// NewClient reads its base + token from the same place the mirror config holds
// them (store.Settings.Base / .Token, from packages/cli/src/db.ts's `config`
// row). There is no second source of truth for the endpoint.
func NewClient(base, token string) *Client {
	return &Client{
		base:  strings.TrimRight(base, "/"),
		token: token,
		http:  &http.Client{Timeout: 30 * time.Second},
	}
}

// Call posts a batch of method calls and returns the raw responses. Multiple
// calls in one request is what makes a back-referenced get-after-query
// (Ref) one round trip.
func (c *Client) Call(ctx context.Context, using []string, calls []Invocation) ([]Response, error) {
	body, err := json.Marshal(map[string]any{"using": using, "methodCalls": calls})
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+"/api/jmap", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		// A transport failure (DNS, refused, timeout) the caller can do nothing
		// about → generic failure, exit 1 (io.ts's default).
		return nil, &bmio.CliError{Msg: "jmap request failed: " + err.Error(), Code: bmio.ExitFail}
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, transportError(
			fmt.Sprintf("JMAP request failed: HTTP %d %s", resp.StatusCode, strings.TrimSpace(string(raw))),
			resp.StatusCode, raw)
	}
	var parsed struct {
		MethodResponses []Response `json:"methodResponses"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, &bmio.CliError{Msg: "jmap: malformed response body: " + err.Error(), Code: bmio.ExitFail}
	}
	return parsed.MethodResponses, nil
}

// One is a single method call — jmap.ts:136 `client.one`. It returns the result
// args (raw), or a *bmio.ServerError carrying the method-level error type so the
// exit code is the server's judgement, not a generic 1.
func (c *Client) One(ctx context.Context, method string, args map[string]any, using []string) (json.RawMessage, error) {
	resps, err := c.Call(ctx, using, []Invocation{{Name: method, Args: args, CallID: "c0"}})
	if err != nil {
		return nil, err
	}
	if len(resps) == 0 {
		return nil, &bmio.CliError{Msg: "no response for " + method, Code: bmio.ExitFail}
	}
	return resps[0].Result(method)
}

// Find returns the response with the given callId — for reading one call out of
// a batch (e.g. the get in a query+get back-reference request).
func Find(resps []Response, callID string) (*Response, bool) {
	for i := range resps {
		if resps[i].CallID == callID {
			return &resps[i], true
		}
	}
	return nil, false
}

// Result decodes a response into its args, or a ServerError when the server
// answered `["error", {type, description}]` — jmap.ts:143-151.
func (r *Response) Result(method string) (json.RawMessage, error) {
	if r.Name == "error" {
		var detail struct {
			Type        string `json:"type"`
			Description string `json:"description"`
		}
		_ = json.Unmarshal(r.Args, &detail)
		typ := detail.Type
		if typ == "" {
			typ = "error"
		}
		msg := method + " → " + typ
		if detail.Description != "" {
			msg += ": " + detail.Description
		}
		return nil, &bmio.ServerError{Msg: msg, JMAPType: detail.Type}
	}
	return r.Args, nil
}

// transportError lifts the machine-readable half of a non-JMAP-envelope refusal
// (jmap.ts:76): the HTTP status always, plus a `type`/`error` from the body when
// there is one — the server's problem+json is `{type,status,detail}`
// (services/jmap/src/index.ts:546).
func transportError(msg string, status int, body []byte) error {
	e := &bmio.ServerError{Msg: msg, HTTPStatus: status}
	var parsed struct {
		Type  string `json:"type"`
		Error string `json:"error"`
	}
	if json.Unmarshal(body, &parsed) == nil {
		if parsed.Type != "" {
			e.JMAPType = parsed.Type
		} else if parsed.Error != "" {
			e.JMAPType = parsed.Error
		}
	}
	return e
}
