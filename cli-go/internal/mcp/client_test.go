package mcp

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// s44 slice 2 — the round-trip. What must hold: the INVOCATION's credential
// is what goes on the wire, an empty shelf is a real answer, and every
// refusal arrives as a sentence a status line can print.

func TestListTools_PresentsTheInvocationToken(t *testing.T) {
	var gotAuth, gotName, gotMethod string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("authorization")
		gotName = r.Header.Get("Mcp-Name")
		body, _ := io.ReadAll(r.Body)
		var req struct {
			Method string `json:"method"`
		}
		_ = json.Unmarshal(body, &req)
		gotMethod = req.Method
		_, _ = io.WriteString(w, `{"jsonrpc":"2.0","id":1,"result":{"tools":[
			{"name":"email_query","scope":"read","domain":"mail"},
			{"name":"contacts_search","scope":"read","domain":"contacts"}]}}`)
	}))
	defer srv.Close()

	c := &Client{Base: srv.URL, Token: "bmi_abc123", Name: "bullmoose"}
	tools, err := c.ListTools(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if gotAuth != "Bearer bmi_abc123" {
		t.Errorf("the invocation's own credential must be the bearer, got %q", gotAuth)
	}
	if gotName != "bullmoose" || gotMethod != "tools/list" {
		t.Errorf("name=%q method=%q", gotName, gotMethod)
	}
	if len(tools) != 2 || tools[0].Name != "email_query" || tools[0].Scope != "read" {
		t.Fatalf("shelf not parsed: %+v", tools)
	}
	// scope/domain ride along because they ARE the gate's vocabulary — a
	// client that prints them is printing the reason a tool is visible.
	if tools[1].Domain != "contacts" {
		t.Errorf("domain lost: %+v", tools[1])
	}
}

func TestListTools_NoTokenRefusesBeforeTheWire(t *testing.T) {
	// The tool surface refuses an agent-marked bearer outright; a client that
	// sent the runtime's token would earn a 403 and teach the wrong lesson.
	c := &Client{Base: "http://127.0.0.1:1", Name: "bullmoose"}
	_, err := c.ListTools(context.Background())
	if err == nil || !strings.Contains(err.Error(), "no invocation token") {
		t.Fatalf("want the no-token refusal, got %v", err)
	}
}

func TestListTools_EmptyShelfIsARealAnswer(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}`)
	}))
	defer srv.Close()
	tools, err := (&Client{Base: srv.URL, Token: "bmi_x"}).ListTools(context.Background())
	if err != nil {
		t.Fatalf("an empty shelf is not an error: %v", err)
	}
	if len(tools) != 0 {
		t.Fatalf("got %d", len(tools))
	}
}

func TestListTools_RpcErrorArrivesAsASentence(t *testing.T) {
	// The -32004 the server raises for an agent bearer without an invocation.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(403)
		_, _ = io.WriteString(w, `{"jsonrpc":"2.0","id":1,"error":{"code":-32004,"message":"an agent-marked token may not use the tool surface directly"}}`)
	}))
	defer srv.Close()
	_, err := (&Client{Base: srv.URL, Token: "bmi_x"}).ListTools(context.Background())
	if err == nil || !strings.Contains(err.Error(), "-32004") ||
		!strings.Contains(err.Error(), "may not use the tool surface") {
		t.Fatalf("want the server's own sentence, got %v", err)
	}
}

func TestListTools_NonJSONIsNotAnEmptyShelf(t *testing.T) {
	// A proxy error page must never read as "this invocation may call
	// nothing" — that mistake would silently disarm every future loop.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(502)
		_, _ = io.WriteString(w, "<html>bad gateway</html>")
	}))
	defer srv.Close()
	_, err := (&Client{Base: srv.URL, Token: "bmi_x"}).ListTools(context.Background())
	if err == nil || !strings.Contains(err.Error(), "unreadable reply") || !strings.Contains(err.Error(), "502") {
		t.Fatalf("want an unreadable-reply error naming the status, got %v", err)
	}
}

func TestCallTool_PassesTheModelsArgumentsThrough(t *testing.T) {
	// The harness does not repair a malformed call: a "fixed" one would be
	// calling something the model did not ask for. The server validates
	// against the tool's own schema and refuses in its own words.
	var gotName, gotArgs string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var req struct {
			Params struct {
				Name      string          `json:"name"`
				Arguments json.RawMessage `json:"arguments"`
			} `json:"params"`
		}
		_ = json.Unmarshal(body, &req)
		gotName, gotArgs = req.Params.Name, string(req.Params.Arguments)
		_, _ = io.WriteString(w, `{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"3 messages matched"}]}}`)
	}))
	defer srv.Close()

	text, err := (&Client{Base: srv.URL, Token: "bmi_x"}).CallTool(context.Background(), "email_query", `{"text":"venue"}`)
	if err != nil {
		t.Fatal(err)
	}
	if gotName != "email_query" || gotArgs != `{"text":"venue"}` {
		t.Fatalf("name=%q args=%q", gotName, gotArgs)
	}
	if text != "3 messages matched" {
		t.Fatalf("text = %q", text)
	}
}

func TestCallTool_EmptyArgumentsBecomeAnObject(t *testing.T) {
	var gotArgs string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var req struct {
			Params struct {
				Arguments json.RawMessage `json:"arguments"`
			} `json:"params"`
		}
		_ = json.Unmarshal(body, &req)
		gotArgs = string(req.Params.Arguments)
		_, _ = io.WriteString(w, `{"jsonrpc":"2.0","id":1,"result":{"content":[]}}`)
	}))
	defer srv.Close()
	if _, err := (&Client{Base: srv.URL, Token: "bmi_x"}).CallTool(context.Background(), "whoami", ""); err != nil {
		t.Fatal(err)
	}
	if gotArgs != "{}" {
		t.Fatalf("empty args must be an object, got %q", gotArgs)
	}
}

func TestCallTool_IsErrorCarriesTheServersWords(t *testing.T) {
	// A tool-level refusal must reach the model as a FACT it can answer
	// around ("unavailable: …"), so the server's sentence rides the error.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"jsonrpc":"2.0","id":1,"result":{"isError":true,"content":[{"type":"text","text":"forbidden: this token lacks calendar"}]}}`)
	}))
	defer srv.Close()
	_, err := (&Client{Base: srv.URL, Token: "bmi_x"}).CallTool(context.Background(), "calendar_list", "{}")
	if err == nil || !strings.Contains(err.Error(), "lacks calendar") {
		t.Fatalf("want the server's words, got %v", err)
	}
}
