package jmap

// Upload and share-link minting. Driven against a real http server, so the
// REQUEST shape is asserted rather than assumed — which is the half that
// matters here: both endpoints are REST rather than JMAP, so nothing else in
// the client validates them.

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestUploadSendsTheBytesAndTheType(t *testing.T) {
	var gotPath, gotType, gotAuth, gotBody string
	var gotLen int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotType = r.RequestURI, r.Header.Get("Content-Type")
		gotAuth, gotLen = r.Header.Get("Authorization"), r.ContentLength
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		_, _ = w.Write([]byte(`{"blobId":"blob_1","size":5}`))
	}))
	defer srv.Close()

	c := &Client{base: srv.URL, token: "bm_tok", http: srv.Client()}
	got, err := c.Upload(context.Background(), "a b/c", []byte("hello"), "image/png")
	if err != nil {
		t.Fatalf("Upload: %v", err)
	}

	if got.BlobID != "blob_1" || got.Size != 5 {
		t.Errorf("result = %+v", got)
	}
	// Asserted on RequestURI, the RAW wire path: r.URL.Path is already decoded
	// by the server, so it would show `a b/c` and pass whether or not the
	// client encoded anything. The property is that a slash in an id cannot
	// climb the path.
	if gotPath != "/api/upload/a%20b%2Fc" {
		t.Errorf("path = %q, want the id percent-encoded whole", gotPath)
	}
	// The blob is stored AS the type given; a guessed type turns an inline
	// image into a download prompt.
	if gotType != "image/png" {
		t.Errorf("content-type = %q, want image/png", gotType)
	}
	if gotAuth != "Bearer bm_tok" {
		t.Errorf("authorization = %q", gotAuth)
	}
	if gotBody != "hello" {
		t.Errorf("body = %q", gotBody)
	}
	// Explicit length, not chunked: a chunked upload is a different request
	// shape than the TypeScript sends.
	if gotLen != 5 {
		t.Errorf("content-length = %d, want 5", gotLen)
	}
}

func TestUploadRequiresAContentType(t *testing.T) {
	// Refused BEFORE any request — the server would otherwise have to guess,
	// and it would guess on every attachment forever.
	c := &Client{base: "http://unused.invalid", token: "t", http: http.DefaultClient}
	if _, err := c.Upload(context.Background(), "a", []byte("x"), ""); err == nil {
		t.Fatal("an empty content type must be refused")
	}
}

func TestUploadSurfacesTheServersRefusal(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusRequestEntityTooLarge)
		_, _ = w.Write([]byte(`{"error":"too big"}`))
	}))
	defer srv.Close()
	c := &Client{base: srv.URL, token: "t", http: srv.Client()}
	_, err := c.Upload(context.Background(), "a", []byte("x"), "text/plain")
	if err == nil {
		t.Fatal("a 413 must be an error")
	}
	// The server's own words, verbatim — never re-worded into a guess.
	if !strings.Contains(err.Error(), "413") || !strings.Contains(err.Error(), "too big") {
		t.Errorf("error should carry the status and the body: %v", err)
	}
}

func TestCreateShareLink(t *testing.T) {
	var gotPath, gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.RequestURI
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		_, _ = w.Write([]byte(`{"url":"https://x.test/s/abc","expiresAt":"2026-09-01T00:00:00Z"}`))
	}))
	defer srv.Close()

	c := &Client{base: srv.URL, token: "t", http: srv.Client()}
	got, err := c.CreateShareLink(context.Background(), "acct", "blob/1", ShareLinkOptions{Name: "notes.pdf"})
	if err != nil {
		t.Fatalf("CreateShareLink: %v", err)
	}
	if got.URL == "" || got.ExpiresAt == "" {
		t.Errorf("result = %+v — expiresAt matters: the link is PUBLIC and the caller must be able to say when it dies", got)
	}
	if gotPath != "/api/share/acct/blob%2F1" {
		t.Errorf("path = %q, want the blob id percent-encoded", gotPath)
	}
	// ttlSeconds is OMITTED when unset, so the server picks the lifetime. A
	// client-side default would set that policy from the outside.
	if strings.Contains(gotBody, "ttlSeconds") {
		t.Errorf("body = %q, want no ttlSeconds when the caller did not ask", gotBody)
	}
	if !strings.Contains(gotBody, `"name":"notes.pdf"`) {
		t.Errorf("body = %q", gotBody)
	}
}
