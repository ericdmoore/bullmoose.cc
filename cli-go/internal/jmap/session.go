package jmap

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
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
// packages/cli/src/jmap.ts Session, plus the account map `approvals` needs
// (s10 T7).
type Session struct {
	APIURL      string                    `json:"apiUrl"`
	DownloadURL string                    `json:"downloadUrl"`
	Username    string                    `json:"username"`
	Accounts    map[string]SessionAccount `json:"accounts"`
}

// SessionAccount is one entry of the RFC 8620 §2 `accounts` map. The CLI reads
// it because a human's agents are separate PRINCIPALS on separate ACCOUNTS
// (s10 T7): the mirror's account list is what this login synced mail for, and
// the agent accounts a supervisory grant opens are not in it. The session is
// the only live answer to "what can I reach right now" — it is recomputed from
// grants on every request, so a revoked grant drops out of it immediately.
type SessionAccount struct {
	Name       string `json:"name"`
	IsPersonal bool   `json:"isPersonal"`
	IsReadOnly bool   `json:"isReadOnly"`
	// Capability URN → its per-account object. Kept raw: this package parses
	// only the agent capability, and re-marshalling the rest would invent a
	// schema for capabilities the CLI does not read.
	AccountCapabilities map[string]json.RawMessage `json:"accountCapabilities"`
}

// AgentAccount is one account the approvals queue spans, with the authority the
// SERVER reported for it.
type AgentAccount struct {
	AccountID  string
	Name       string
	IsPersonal bool
	// MayDecide gates ActionProposal/set (the `draft` scope); MayApproveIrreversible
	// gates a tier-3 approve (the `send` scope — the capability wall).
	MayDecide              bool
	MayApproveIrreversible bool
}

// agentCapability is the per-account object session.ts publishes under AgentCap.
// Pointers, so ABSENT and false are distinguishable: a server that predates T7
// reports neither, and the honest default there is "let the server decide"
// (true) — the client's flags are a courtesy, the server is the gate.
type agentCapability struct {
	MayDecide              *bool `json:"mayDecide"`
	MayApproveIrreversible *bool `json:"mayApproveIrreversible"`
}

// AgentAccounts is every account in the session that advertises the agent
// capability — owned first, then grant-reached, each sorted by name so the
// queue's order does not depend on map iteration.
func (s *Session) AgentAccounts() []AgentAccount {
	out := make([]AgentAccount, 0, len(s.Accounts))
	for id, acc := range s.Accounts {
		raw, ok := acc.AccountCapabilities[AgentCap] // client.go
		if !ok {
			continue
		}
		cap := agentCapability{}
		_ = json.Unmarshal(raw, &cap)
		name := acc.Name
		if name == "" {
			name = id
		}
		out = append(out, AgentAccount{
			AccountID:              id,
			Name:                   name,
			IsPersonal:             acc.IsPersonal,
			MayDecide:              boolOrTrue(cap.MayDecide),
			MayApproveIrreversible: boolOrTrue(cap.MayApproveIrreversible),
		})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].IsPersonal != out[j].IsPersonal {
			return out[i].IsPersonal // yours before your agents'
		}
		if out[i].Name != out[j].Name {
			return out[i].Name < out[j].Name
		}
		return out[i].AccountID < out[j].AccountID
	})
	return out
}

func boolOrTrue(v *bool) bool {
	if v == nil {
		return true
	}
	return *v
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
