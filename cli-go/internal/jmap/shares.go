package jmap

// The share lifecycle — list and revoke. REST, like the blob endpoints above
// them and for the same recorded reason: RFC 8620 defines no session template
// for any of this, so the paths hardcode on `base`.

import (
	"context"
	"encoding/json"
	"net/http"
)

// ShareEntry is one minted link, as /api/shares returns it.
type ShareEntry struct {
	ShareID   string `json:"shareId"`
	Name      string `json:"name"`
	Live      bool   `json:"live"`
	CreatedAt string `json:"createdAt"`
	ExpiresAt string `json:"expiresAt"`
	RevokedAt string `json:"revokedAt,omitempty"`
}

// ShareListing is GET /api/shares/{accountId}.
type ShareListing struct {
	AccountID string       `json:"accountId"`
	Shares    []ShareEntry `json:"shares"`
}

// RevokeResult is the revoke's answer. `Note` carries the eventual-consistency
// sentence the server wants shown — the records live in KV, so a revoke can
// take ~60s to reach every edge, and a human who reloads instantly must learn
// that is expected rather than concluding the revoke failed.
type RevokeResult struct {
	ShareID        string `json:"shareId"`
	AlreadyRevoked bool   `json:"alreadyRevoked"`
	Note           string `json:"note"`
}

// ListShares is jmap.ts:246.
func (c *Client) ListShares(ctx context.Context, accountID string) (*ShareListing, error) {
	raw, err := c.RESTJSON(ctx, http.MethodGet,
		"/api/shares/"+encodeURIComponent(accountID), "share list")
	if err != nil {
		return nil, err
	}
	var out ShareListing
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// RevokeShare is jmap.ts:251.
func (c *Client) RevokeShare(ctx context.Context, accountID, shareID string) (*RevokeResult, error) {
	raw, err := c.RESTJSON(ctx, http.MethodPost,
		"/api/shares/"+encodeURIComponent(accountID)+"/"+encodeURIComponent(shareID)+"/revoke", "share revoke")
	if err != nil {
		return nil, err
	}
	var out RevokeResult
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
