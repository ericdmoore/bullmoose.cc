// Package mcp is the agent runtime's client for the platform's own tool
// surface (s44 slice 2) — the read side of the `bmi_` round-trip.
//
// ## Why hand-rolled, and why it is small
//
// The server is STATELESS MCP (SEP-2575): one JSON-RPC request per POST, no
// session, no negotiation to hold. A full SDK would bring session lifecycle,
// transports and capability negotiation this server does not have — the same
// argument that made `internal/ws` a hand-rolled RFC 6455 client rather than
// a dependency. What remains is a POST with a bearer and a typed reply.
//
// ## The credential is the INVOCATION's, never the runtime's
//
// The claim mints a `bmi_` token and hands it back once (AgentInvocation/set,
// `updated[id].invocationToken`). That token — not the daemon's own bearer —
// is what this client presents, and the server insists on exactly that: an
// agent-marked bearer may not touch the tool surface at all (mcp.ts's -32004
// refusal). So the shelf a run sees is scoped to THAT invocation on THAT
// account, live-resolved against the binding's envelope on every call.
package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Client speaks stateless JSON-RPC to one MCP endpoint with one invocation's
// credential. It holds no session because the server has none.
type Client struct {
	Base  string // e.g. https://mcp.bullmoose.cc/mcp
	Token string // the bmi_ invocation token, never the runtime's bearer
	HTTP  *http.Client
	// Name is the Mcp-Name header the server matches against the body's
	// method family; absent, the request is refused before any gate runs.
	Name string
}

// Tool is one entry of tools/list — the shelf as the SERVER describes it.
// `Scope` and `Domain` ride along because they are the gate's own vocabulary:
// a tool is visible only where the principal holds the scope AND the envelope
// allows the tool, so a client that prints them is printing the reason.
type Tool struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"inputSchema"`
	Scope       string          `json:"scope"`
	Domain      string          `json:"domain"`
	Accountless bool            `json:"accountless"`
}

type rpcReq struct {
	JSONRPC string `json:"jsonrpc"`
	ID      int    `json:"id"`
	Method  string `json:"method"`
	Params  any    `json:"params,omitempty"`
}

type rpcErr struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e rpcErr) Error() string { return fmt.Sprintf("mcp error %d: %s", e.Code, e.Message) }

type rpcResp struct {
	Result json.RawMessage `json:"result"`
	Error  *rpcErr         `json:"error"`
}

// call is the whole transport: one POST, one reply. A -32004 (the agent-token
// refusal) and a 403 arrive as an rpcErr the caller can name in a status line
// rather than as an opaque failure.
func (c *Client) call(ctx context.Context, method string, params any, out any) error {
	if c.Token == "" {
		return errors.New("no invocation token — the tool surface refuses an agent bearer")
	}
	body, err := json.Marshal(rpcReq{JSONRPC: "2.0", ID: 1, Method: method, Params: params})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.Base, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("authorization", "Bearer "+c.Token)
	if c.Name != "" {
		req.Header.Set("Mcp-Name", c.Name)
	}
	hc := c.HTTP
	if hc == nil {
		hc = &http.Client{Timeout: 30 * time.Second}
	}
	res, err := hc.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = res.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return err
	}
	var parsed rpcResp
	if err := json.Unmarshal(raw, &parsed); err != nil {
		// A non-JSON body (a proxy error page, an auth redirect) must not read
		// as an empty shelf: say what came back, truncated.
		return fmt.Errorf("mcp %s: unreadable reply (HTTP %d): %s", method, res.StatusCode, snippet(raw))
	}
	if parsed.Error != nil {
		return *parsed.Error
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(parsed.Result, out)
}

// ListTools asks the server what THIS invocation may reach. The answer is the
// envelope made concrete: `visibleTools` filters by the principal's scopes and
// the live-resolved envelope, so an empty list is a real answer ("nothing
// this invocation may call"), never a transport shrug — errors return err.
func (c *Client) ListTools(ctx context.Context) ([]Tool, error) {
	var out struct {
		Tools []Tool `json:"tools"`
	}
	if err := c.call(ctx, "tools/list", map[string]any{}, &out); err != nil {
		return nil, err
	}
	return out.Tools, nil
}

// CallTool runs one tool and returns its text content. The arguments come
// from the MODEL and are passed through as the model wrote them: this client
// does not repair or reshape them, because a harness that "fixed" a malformed
// call would be calling something the model did not ask for. The server
// validates against the tool's own inputSchema and refuses in its own words.
//
// The gates that matter all live server-side and run per call: the scope
// check (authorizeAccount) and THEN the envelope (mcp.ts's order is the
// invariant). Nothing here decides authority; it only carries the
// invocation's credential and hands back what came out.
func (c *Client) CallTool(ctx context.Context, name, arguments string) (string, error) {
	args := json.RawMessage("{}")
	if strings.TrimSpace(arguments) != "" {
		args = json.RawMessage(arguments)
	}
	var out struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
		IsError bool `json:"isError"`
	}
	if err := c.call(ctx, "tools/call", map[string]any{"name": name, "arguments": args}, &out); err != nil {
		return "", err
	}
	parts := make([]string, 0, len(out.Content))
	for _, p := range out.Content {
		if p.Text != "" {
			parts = append(parts, p.Text)
		}
	}
	text := strings.Join(parts, "\n")
	if out.IsError {
		// A tool-level error is still an ANSWER the caller must be able to
		// hand the model as a fact ("unavailable: …"), so it returns as an
		// error carrying the server's words rather than as empty content.
		if text == "" {
			text = "the tool reported an error with no message"
		}
		return "", errors.New(text)
	}
	return text, nil
}

func snippet(b []byte) string {
	s := strings.TrimSpace(string(b))
	if len(s) > 160 {
		s = s[:160] + "…"
	}
	if s == "" {
		s = "(empty)"
	}
	return s
}
