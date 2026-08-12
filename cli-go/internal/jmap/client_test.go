package jmap

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
)

// TestOne_HappyPath: a normal method call posts {using, methodCalls} to
// <base>/api/jmap with a bearer token, and returns the result args.
func TestOne_HappyPath(t *testing.T) {
	var gotAuth, gotPath string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotPath = r.URL.Path
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &gotBody)
		_, _ = w.Write([]byte(`{"methodResponses":[["Foo/get",{"list":[{"id":"x"}]},"c0"]]}`))
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "tok_123")
	raw, err := c.One(context.Background(), "Foo/get", map[string]any{"accountId": "a1"}, AgentUsing)
	if err != nil {
		t.Fatalf("One: %v", err)
	}
	var res struct {
		List []map[string]string `json:"list"`
	}
	if json.Unmarshal(raw, &res); res.List[0]["id"] != "x" {
		t.Errorf("result = %s", raw)
	}
	if gotAuth != "Bearer tok_123" {
		t.Errorf("Authorization = %q", gotAuth)
	}
	if gotPath != "/api/jmap" {
		t.Errorf("path = %q, want /api/jmap (session.ts:85)", gotPath)
	}
	// The using list must carry both core and the agent capability.
	using, _ := gotBody["using"].([]any)
	if len(using) != 2 || using[0] != CoreCap || using[1] != AgentCap {
		t.Errorf("using = %v, want [%s %s]", using, CoreCap, AgentCap)
	}
}

// TestOne_MethodError: a method-level ["error", {type,…}] becomes a ServerError
// carrying the type, so bmio.ExitCodeFor maps it (forbidden → 4, stateMismatch → 5).
func TestOne_MethodError(t *testing.T) {
	cases := []struct {
		typ  string
		want bmio.ExitCode
	}{
		{"forbidden", bmio.ExitAuth},
		{"stateMismatch", bmio.ExitConflict},
		{"invalidProperties", bmio.ExitUsage},
	}
	for _, tc := range cases {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(`{"methodResponses":[["error",{"type":"` + tc.typ + `","description":"nope"},"c0"]]}`))
		}))
		c := NewClient(srv.URL, "t")
		_, err := c.One(context.Background(), "X/set", nil, AgentUsing)
		srv.Close()
		if err == nil {
			t.Fatalf("%s: expected error", tc.typ)
		}
		var se *bmio.ServerError
		if !errors.As(err, &se) || se.JMAPType != tc.typ {
			t.Fatalf("%s: got %v (type %q)", tc.typ, err, se.JMAPType)
		}
		if code := bmio.ExitCodeFor(err); code != tc.want {
			t.Errorf("%s: exit %d, want %d", tc.typ, code, tc.want)
		}
	}
}

// TestOne_TransportError: a non-2xx HTTP refusal carries the HTTP status (and any
// body `type`) so the exit code is the transport's, not a generic 1.
func TestOne_TransportError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(403)
		_, _ = w.Write([]byte(`{"type":"forbidden","status":403}`))
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "t")
	_, err := c.One(context.Background(), "X/get", nil, AgentUsing)
	var se *bmio.ServerError
	if !errors.As(err, &se) || se.HTTPStatus != 403 {
		t.Fatalf("got %v (status %d)", err, se.HTTPStatus)
	}
	if code := bmio.ExitCodeFor(err); code != bmio.ExitAuth {
		t.Errorf("403 → exit %d, want %d (auth)", code, bmio.ExitAuth)
	}
}

// TestCall_BackReference: a query+get batch sends a `#ids` back-reference, and
// Find/Result read the second call out of the batch. Proves the plumbing a
// get-after-query needs (dispatch.ts resolves it server-side).
func TestCall_BackReference(t *testing.T) {
	var methodCalls []any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &body)
		methodCalls, _ = body["methodCalls"].([]any)
		_, _ = w.Write([]byte(`{"methodResponses":[` +
			`["ActionProposal/query",{"ids":["p1","p2"]},"q0"],` +
			`["ActionProposal/get",{"list":[{"id":"p1"},{"id":"p2"}]},"g0"]]}`))
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "t")
	resps, err := c.Call(context.Background(), AgentUsing, []Invocation{
		{Name: "ActionProposal/query", Args: map[string]any{"accountId": "a"}, CallID: "q0"},
		{Name: "ActionProposal/get", Args: map[string]any{
			"accountId": "a",
			"#ids":      Ref("q0", "ActionProposal/query", "/ids"),
		}, CallID: "g0"},
	})
	if err != nil {
		t.Fatalf("Call: %v", err)
	}

	// The wire carried the back-reference verbatim.
	get := methodCalls[1].([]any)
	args := get[1].(map[string]any)
	ref, ok := args["#ids"].(map[string]any)
	if !ok || ref["resultOf"] != "q0" || ref["path"] != "/ids" {
		t.Fatalf("#ids back-reference not sent: %v", args)
	}

	g, ok := Find(resps, "g0")
	if !ok {
		t.Fatal("no g0 response")
	}
	gr, err := g.Result("ActionProposal/get")
	if err != nil {
		t.Fatalf("g0 result: %v", err)
	}
	var got struct {
		List []map[string]string `json:"list"`
	}
	_ = json.Unmarshal(gr, &got)
	if len(got.List) != 2 || got.List[0]["id"] != "p1" {
		t.Errorf("get list = %s", gr)
	}
}
