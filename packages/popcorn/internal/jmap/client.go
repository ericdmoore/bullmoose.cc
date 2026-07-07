// Package jmap is the minimal JMAP client behind popcorn: session fetch
// with Basic auth (app-password tokens), one batched inbox listing with a
// back-reference, blob download, and an archive move for DELE.
package jmap

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type Client struct {
	http      *http.Client
	email     string
	password  string // app-password token (bm_…); never the login password
	apiURL    string
	dlTmpl    string
	AccountID string
}

type Msg struct {
	ID     string
	BlobID string
	Size   int
}

// Discover resolves the JMAP base URL for an email's domain via the
// _jmap._tcp SRV record (RFC 8620 §2.2). override wins when set.
func Discover(email, override string) (string, error) {
	if override != "" {
		return strings.TrimRight(override, "/"), nil
	}
	at := strings.LastIndex(email, "@")
	if at < 0 {
		return "", fmt.Errorf("not an email address: %q", email)
	}
	domain := email[at+1:]
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, srvs, err := net.DefaultResolver.LookupSRV(ctx, "jmap", "tcp", domain)
	if err != nil || len(srvs) == 0 {
		return "", fmt.Errorf("no _jmap._tcp SRV for %s (set POPCORN_JMAP_BASE): %w", domain, err)
	}
	target := strings.TrimSuffix(srvs[0].Target, ".")
	if srvs[0].Port != 443 && srvs[0].Port != 0 {
		return fmt.Sprintf("https://%s:%d", target, srvs[0].Port), nil
	}
	return "https://" + target, nil
}

// Login fetches the session resource and resolves the mail account.
func Login(base, email, password string) (*Client, error) {
	c := &Client{
		http:     &http.Client{Timeout: 30 * time.Second},
		email:    email,
		password: password,
	}
	req, err := http.NewRequest("GET", base+"/.well-known/jmap", nil)
	if err != nil {
		return nil, err
	}
	req.SetBasicAuth(email, password)
	res, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil, fmt.Errorf("session fetch: HTTP %d", res.StatusCode)
	}
	var session struct {
		APIURL          string            `json:"apiUrl"`
		DownloadURL     string            `json:"downloadUrl"`
		PrimaryAccounts map[string]string `json:"primaryAccounts"`
		Accounts        map[string]any    `json:"accounts"`
	}
	if err := json.NewDecoder(res.Body).Decode(&session); err != nil {
		return nil, fmt.Errorf("session parse: %w", err)
	}
	c.apiURL = session.APIURL
	c.dlTmpl = session.DownloadURL
	c.AccountID = session.PrimaryAccounts["urn:ietf:params:jmap:mail"]
	if c.AccountID == "" { // fall back to the only account
		for id := range session.Accounts {
			c.AccountID = id
			break
		}
	}
	if c.APIURL() == "" || c.AccountID == "" {
		return nil, fmt.Errorf("session missing apiUrl or account")
	}
	return c, nil
}

func (c *Client) APIURL() string { return c.apiURL }

type methodCall [3]any

func (c *Client) call(using []string, calls []methodCall) ([]json.RawMessage, error) {
	body, err := json.Marshal(map[string]any{"using": using, "methodCalls": calls})
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequest("POST", c.apiURL, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.SetBasicAuth(c.email, c.password)
	req.Header.Set("Content-Type", "application/json")
	res, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		b, _ := io.ReadAll(io.LimitReader(res.Body, 512))
		return nil, fmt.Errorf("jmap: HTTP %d: %s", res.StatusCode, b)
	}
	var envelope struct {
		MethodResponses []json.RawMessage `json:"methodResponses"`
	}
	if err := json.NewDecoder(res.Body).Decode(&envelope); err != nil {
		return nil, err
	}
	return envelope.MethodResponses, nil
}

// respArgs unwraps ["Name", {args}, "tag"] and errors on "error" responses.
func respArgs(raw json.RawMessage, want string) (json.RawMessage, error) {
	var tuple [3]json.RawMessage
	if err := json.Unmarshal(raw, &tuple); err != nil {
		return nil, err
	}
	var name string
	_ = json.Unmarshal(tuple[0], &name)
	if name == "error" {
		return nil, fmt.Errorf("jmap method error: %s", tuple[1])
	}
	if name != want {
		return nil, fmt.Errorf("expected %s, got %s", want, name)
	}
	return tuple[1], nil
}

const mailCap = "urn:ietf:params:jmap:mail"
const coreCap = "urn:ietf:params:jmap:core"

// Mailboxes returns roleName → mailboxId.
func (c *Client) Mailboxes() (map[string]string, error) {
	resps, err := c.call([]string{coreCap, mailCap}, []methodCall{
		{"Mailbox/get", map[string]any{"accountId": c.AccountID}, "m"},
	})
	if err != nil {
		return nil, err
	}
	args, err := respArgs(resps[0], "Mailbox/get")
	if err != nil {
		return nil, err
	}
	var parsed struct {
		List []struct {
			ID   string `json:"id"`
			Role string `json:"role"`
		} `json:"list"`
	}
	if err := json.Unmarshal(args, &parsed); err != nil {
		return nil, err
	}
	roles := map[string]string{}
	for _, m := range parsed.List {
		if m.Role != "" {
			roles[m.Role] = m.ID
		}
	}
	return roles, nil
}

// ListMailbox snapshots the maildrop: newest `limit` messages, returned
// oldest-first (POP3 message numbers count up from the oldest).
func (c *Client) ListMailbox(mailboxID string, limit int) ([]Msg, error) {
	resps, err := c.call([]string{coreCap, mailCap}, []methodCall{
		{"Email/query", map[string]any{
			"accountId": c.AccountID,
			"filter":    map[string]any{"inMailbox": mailboxID},
			"sort":      []map[string]any{{"property": "receivedAt", "isAscending": false}},
			"limit":     limit,
		}, "q"},
		{"Email/get", map[string]any{
			"accountId":  c.AccountID,
			"#ids":       map[string]any{"resultOf": "q", "name": "Email/query", "path": "/ids"},
			"properties": []string{"id", "blobId", "size"},
		}, "g"},
	})
	if err != nil {
		return nil, err
	}
	if len(resps) < 2 {
		return nil, fmt.Errorf("short jmap response")
	}
	args, err := respArgs(resps[1], "Email/get")
	if err != nil {
		return nil, err
	}
	var parsed struct {
		List []struct {
			ID     string `json:"id"`
			BlobID string `json:"blobId"`
			Size   int    `json:"size"`
		} `json:"list"`
	}
	if err := json.Unmarshal(args, &parsed); err != nil {
		return nil, err
	}
	msgs := make([]Msg, 0, len(parsed.List))
	for i := len(parsed.List) - 1; i >= 0; i-- { // newest-first → oldest-first
		m := parsed.List[i]
		msgs = append(msgs, Msg{ID: m.ID, BlobID: m.BlobID, Size: m.Size})
	}
	return msgs, nil
}

// Download streams a message's raw RFC 5322 bytes.
func (c *Client) Download(blobID string) (io.ReadCloser, error) {
	u := c.dlTmpl
	for k, v := range map[string]string{
		"{accountId}": url.PathEscape(c.AccountID),
		"{blobId}":    url.PathEscape(blobID),
		"{name}":      "msg.eml",
		"{type}":      url.QueryEscape("message/rfc822"),
	} {
		u = strings.ReplaceAll(u, k, v)
	}
	req, err := http.NewRequest("GET", u, nil)
	if err != nil {
		return nil, err
	}
	req.SetBasicAuth(c.email, c.password)
	res, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	if res.StatusCode != 200 {
		res.Body.Close()
		return nil, fmt.Errorf("download: HTTP %d", res.StatusCode)
	}
	return res.Body, nil
}

// Archive moves messages out of the listed mailbox (popcorn's DELE:
// "delivered and detached" — the server keeps the mail, forever).
func (c *Client) Archive(ids []string, archiveID string) error {
	update := map[string]any{}
	for _, id := range ids {
		update[id] = map[string]any{"mailboxIds": map[string]bool{archiveID: true}}
	}
	resps, err := c.call([]string{coreCap, mailCap}, []methodCall{
		{"Email/set", map[string]any{"accountId": c.AccountID, "update": update}, "s"},
	})
	if err != nil {
		return err
	}
	args, err := respArgs(resps[0], "Email/set")
	if err != nil {
		return err
	}
	var parsed struct {
		NotUpdated map[string]any `json:"notUpdated"`
	}
	_ = json.Unmarshal(args, &parsed)
	if len(parsed.NotUpdated) > 0 {
		return fmt.Errorf("archive failed for %d message(s)", len(parsed.NotUpdated))
	}
	return nil
}
