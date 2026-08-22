package jmap

// Blob upload and share-link minting — the two REST endpoints the Markdown
// pipeline needs, and the ones `share` will need when it ports.
//
// Both hardcode their path on `base`, exactly as `ListBlobs` and `DeleteBlob`
// already do, and for the reason recorded there: RFC 8620 §2 defines a session
// template for DOWNLOAD only. There is nothing to resolve an upload, an
// enumeration or a share through, and inventing non-standard session members
// to create one would be worse than a hardcoded path.
//
// They are NOT built on RESTJSON: that helper sends no body and fixes the
// content type to application/json. An upload's content type IS the blob's
// media type — the server stores what it is told — so it has to be its own
// request.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	bmio "github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
)

// UploadResult is what `POST /api/upload/{accountId}` returns.
type UploadResult struct {
	BlobID string `json:"blobId"`
	Size   int64  `json:"size"`
}

// Upload stores bytes and returns the blob they became — jmap.ts:189.
//
// `contentType` is sent verbatim as the request's Content-Type and is what the
// blob is stored as. An empty one would make the server guess, and a guessed
// type on an inline image is the difference between a picture and a download
// prompt, so it is required rather than defaulted.
func (c *Client) Upload(ctx context.Context, accountID string, content []byte, contentType string) (*UploadResult, error) {
	if contentType == "" {
		return nil, &bmio.CliError{Msg: "upload: a content type is required", Code: bmio.ExitFail}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		c.base+"/api/upload/"+encodeURIComponent(accountID), bytes.NewReader(content))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", contentType)
	// Set explicitly: without it Go streams the reader chunked, and a chunked
	// upload to a Worker is a different request shape than the TypeScript's.
	req.ContentLength = int64(len(content))

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, &bmio.CliError{Msg: "upload failed: " + err.Error(), Code: bmio.ExitFail}
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, transportError(
			fmt.Sprintf("upload failed: HTTP %d %s", resp.StatusCode, string(raw)),
			resp.StatusCode, raw)
	}
	var out UploadResult
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, &bmio.CliError{Msg: "upload: unreadable response: " + err.Error(), Code: bmio.ExitFail}
	}
	return &out, nil
}

// ShareLinkOptions are the mint's arguments — jmap.ts:205.
type ShareLinkOptions struct {
	Name string `json:"name"`
	Type string `json:"type,omitempty"`
	// TTLSeconds omitted lets the SERVER pick the lifetime. That is deliberate:
	// how long a public link to your file lives is the server's policy, and a
	// client defaulting it would quietly set that policy from the outside.
	TTLSeconds int `json:"ttlSeconds,omitempty"`
}

// ShareLink is the minted link.
type ShareLink struct {
	URL       string `json:"url"`
	ExpiresAt string `json:"expiresAt"`
}

// CreateShareLink mints an EXPIRING PUBLIC link for a blob — jmap.ts:205.
//
// Public is the word to keep in view: the URL it returns needs no credential,
// which is the whole point for a big-file send and also the reason `expiresAt`
// comes back and should be shown to whoever asked for it.
func (c *Client) CreateShareLink(ctx context.Context, accountID, blobID string, opts ShareLinkOptions) (*ShareLink, error) {
	body, err := json.Marshal(opts)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		c.base+"/api/share/"+encodeURIComponent(accountID)+"/"+encodeURIComponent(blobID),
		bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")
	req.ContentLength = int64(len(body))

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, &bmio.CliError{Msg: "share link failed: " + err.Error(), Code: bmio.ExitFail}
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, transportError(
			fmt.Sprintf("share link failed: HTTP %d %s", resp.StatusCode, string(raw)),
			resp.StatusCode, raw)
	}
	var out ShareLink
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, &bmio.CliError{Msg: "share link: unreadable response: " + err.Error(), Code: bmio.ExitFail}
	}
	return &out, nil
}
