package cmd

// The template reply loop (s43 step 4). The one table that matters pins the
// SEVEN-call choreography end to end; around it, each claim-contract clause
// gets its own corner: a lost race is a clean no-op, failure writes `failed`
// best-effort and the loop survives, narrowing is a skip not an error, and a
// foreign binding is not ours to claim.

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// serveConfig writes an agent.json and returns its path.
func serveConfig(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "agent.json")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

const mockAgentJSON = `{"binding":"hermes-responder","persona":"You are Hermes, terse and helpful.",` +
	`"model":{"provider":"mock"}}`

// withPendingInvocation seeds the fake with one pending invocation over one
// real context email.
func withPendingInvocation(f *mailFake) {
	f.invocationIDs = `["inv_1"]`
	f.invocationList = `[{"id":"inv_1","emailId":"em_7","bindingName":"hermes-responder","status":"pending","requires":null}]`
	f.addEmail("em_7", `{"id":"em_7","threadId":"th_7","from":[{"name":"Pat","email":"pat@ext.test"}],`+
		`"subject":"Lunch?","messageId":["<m7@ext.test>"],`+
		`"bodyValues":{"1":{"value":"Want to grab lunch Thursday?"}},`+
		`"textBody":[{"partId":"1","type":"text/plain"}]}`)
}

func TestAgentServe_TemplateLoopChoreography(t *testing.T) {
	f := newMailFake()
	withPendingInvocation(f)
	_, errOut, code := runCmd(t, runAgent, sendEnv(t, f),
		"agent", "serve", "--config", serveConfig(t, mockAgentJSON), "--once")
	if code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, errOut)
	}

	// The seven calls, in order — claim BEFORE any work, completion last.
	want := "AgentInvocation/query,AgentInvocation/get,AgentInvocation/set," +
		"Email/get,Mailbox/query,Email/set,AgentInvocation/set"
	if got := strings.Join(f.names(), ","); got != want {
		t.Fatalf("choreography:\n got %s\nwant %s", got, want)
	}

	// The CLAIM declares the claimant: isFree true, no capability vector in
	// --config mode, status → running.
	var claim struct {
		Claimant map[string]json.RawMessage `json:"claimant"`
		Update   map[string]struct {
			Status string `json:"status"`
		} `json:"update"`
	}
	_ = json.Unmarshal(f.calls[2].Args, &claim)
	if string(claim.Claimant["isFree"]) != "true" {
		t.Errorf("the claim must declare isFree: %s", f.calls[2].Args)
	}
	if _, declared := claim.Claimant["capabilities"]; declared {
		t.Error("--config mode declares no capability vector")
	}
	if claim.Update["inv_1"].Status != "running" {
		t.Errorf("claim = %s", f.calls[2].Args)
	}

	// The draft: a REAL reply — $agent provenance, Re: subject, threaded to
	// the sender, from the account's own address, mock body.
	var set struct {
		Create map[string]struct {
			MailboxIDs map[string]bool                   `json:"mailboxIds"`
			Keywords   map[string]bool                   `json:"keywords"`
			From       []map[string]string               `json:"from"`
			To         []map[string]string               `json:"to"`
			Subject    string                            `json:"subject"`
			InReplyTo  []string                          `json:"inReplyTo"`
			BodyValues map[string]struct{ Value string } `json:"bodyValues"`
		} `json:"create"`
	}
	_ = json.Unmarshal(f.calls[5].Args, &set)
	draft := set.Create["r"]
	if !draft.MailboxIDs["mb_drafts"] || !draft.Keywords["$draft"] || !draft.Keywords["$agent"] {
		t.Errorf("draft placement/provenance: %+v", draft)
	}
	if draft.Subject != "Re: Lunch?" || len(draft.To) != 1 || draft.To[0]["email"] != "pat@ext.test" ||
		draft.From[0]["email"] != "you@stub.test" {
		t.Errorf("draft addressing: %+v", draft)
	}
	if len(draft.InReplyTo) != 1 || draft.InReplyTo[0] != "<m7@ext.test>" {
		t.Errorf("threading: %+v", draft.InReplyTo)
	}
	if !strings.Contains(draft.BodyValues["b"].Value, `Thanks for your message about "Lunch?"`) ||
		!strings.Contains(draft.BodyValues["b"].Value, "mock provider") {
		t.Errorf("mock body: %q", draft.BodyValues["b"].Value)
	}

	// Completion: done, carrying the draft id the server minted.
	var done struct {
		Update map[string]struct {
			Status string `json:"status"`
			Result struct {
				DraftEmailID string `json:"draftEmailId"`
			} `json:"result"`
		} `json:"update"`
	}
	_ = json.Unmarshal(f.calls[6].Args, &done)
	if done.Update["inv_1"].Status != "done" || done.Update["inv_1"].Result.DraftEmailID == "" {
		t.Errorf("completion = %s", f.calls[6].Args)
	}

	// The chrome tells the story: served set, binding roster, drain count.
	for _, wantLine := range []string{
		"[agent:hermes-responder] you@stub.test: serving (own account)",
		"serving 1 binding(s) [hermes-responder] over 1 account(s)",
		"inv_1 → reply draft em_new_1",
		"startup drain: 1 invocation(s) handled",
	} {
		if !strings.Contains(errOut, wantLine) {
			t.Errorf("stderr missing %q\n%s", wantLine, errOut)
		}
	}
}

func TestAgentServe_LostRaceIsACleanNoOp(t *testing.T) {
	// The invocation was somebody else's; no work happens, no failure is
	// recorded, the drain reports zero and exits clean.
	f := newMailFake()
	withPendingInvocation(f)
	f.invocationClaimLost = true
	_, errOut, code := runCmd(t, runAgent, sendEnv(t, f),
		"agent", "serve", "--config", serveConfig(t, mockAgentJSON), "--once")
	if code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, errOut)
	}
	want := "AgentInvocation/query,AgentInvocation/get,AgentInvocation/set"
	if got := strings.Join(f.names(), ","); got != want {
		t.Fatalf("a lost race must stop at the claim:\n got %s", got)
	}
	if !strings.Contains(errOut, "startup drain: 0 invocation(s) handled") {
		t.Errorf("stderr = %q", errOut)
	}
	if strings.Contains(errOut, "FAILED") {
		t.Errorf("a lost race is not a failure: %q", errOut)
	}
}

func TestAgentServe_FailureWritesFailedAndTheLoopSurvives(t *testing.T) {
	// Mid-pipeline failure (no drafts mailbox): the invocation completes as
	// FAILED with the error in result, the loop finishes cleanly.
	f := newMailFake()
	withPendingInvocation(f)
	f.noDraftsMailbox = true
	_, errOut, code := runCmd(t, runAgent, sendEnv(t, f),
		"agent", "serve", "--config", serveConfig(t, mockAgentJSON), "--once")
	if code != 0 {
		t.Fatalf("the loop must survive one bad invocation: %d", code)
	}
	last := f.calls[len(f.calls)-1]
	if last.Name != "AgentInvocation/set" {
		t.Fatalf("last call = %s", last.Name)
	}
	var fail struct {
		Update map[string]struct {
			Status string `json:"status"`
			Result struct {
				Error string `json:"error"`
			} `json:"result"`
		} `json:"update"`
	}
	_ = json.Unmarshal(last.Args, &fail)
	if fail.Update["inv_1"].Status != "failed" || !strings.Contains(fail.Update["inv_1"].Result.Error, "no drafts mailbox") {
		t.Errorf("failure record = %s", last.Args)
	}
	if !strings.Contains(errOut, "inv_1 FAILED: no drafts mailbox") ||
		!strings.Contains(errOut, "startup drain: 0 invocation(s) handled") {
		t.Errorf("stderr = %q", errOut)
	}
}

func TestAgentServe_ForeignBindingIsNotOursToClaim(t *testing.T) {
	// The invocation names a binding this host does not run: NO claim is
	// burned — another runtime's work is left exactly as found.
	f := newMailFake()
	withPendingInvocation(f)
	f.invocationList = strings.Replace(f.invocationList, "hermes-responder", "allen-analyst", 1)
	_, errOut, code := runCmd(t, runAgent, sendEnv(t, f),
		"agent", "serve", "--config", serveConfig(t, mockAgentJSON), "--once")
	if code != 0 {
		t.Fatal(code)
	}
	want := "AgentInvocation/query,AgentInvocation/get"
	if got := strings.Join(f.names(), ","); got != want {
		t.Fatalf("foreign work must not be claimed:\n got %s", got)
	}
	if !strings.Contains(errOut, "startup drain: 0 invocation(s) handled") {
		t.Errorf("stderr = %q", errOut)
	}
}

func TestAgentServe_ConfigRefusalsCostZero(t *testing.T) {
	// A config naming an unrunnable pipeline is refused at LOAD — before any
	// claim is burned — as are the shape errors. Exit 1, matching Node's
	// note + process.exit(1).
	for _, tc := range []struct {
		name, config, want string
	}{
		{"no binding", `{"persona":"p","model":{"provider":"mock"}}`,
			"agent config needs: binding"},
		{"no provider", `{"binding":"b","persona":"p","model":{}}`,
			"agent config needs: model.provider"},
		{"no persona for reply", `{"binding":"b","model":{"provider":"mock"}}`,
			"agent config needs: persona"},
		{"unrunnable pipeline", `{"binding":"b","persona":"p","model":{"provider":"mock"},"pipeline":"summarize"}`,
			`pipeline "summarize" is not one this runtime can run (reply | extract)`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newMailFake()
			_, errOut, code := runCmd(t, runAgent, sendEnv(t, f),
				"agent", "serve", "--config", serveConfig(t, tc.config), "--once")
			if code != 1 {
				t.Fatalf("code = %d, stderr = %s", code, errOut)
			}
			if !strings.Contains(errOut, tc.want) {
				t.Errorf("stderr = %q, want %q", errOut, tc.want)
			}
			if n := f.names(); len(n) != 0 {
				t.Errorf("a refused config burned requests: %v", n)
			}
		})
	}
	t.Run("config XOR fleet", func(t *testing.T) {
		f := newMailFake()
		_, errOut, code := runCmd(t, runAgent, sendEnv(t, f), "agent", "serve")
		if code != 2 || !strings.Contains(errOut, "requires --config") {
			t.Errorf("code %d stderr %q", code, errOut)
		}
		_, errOut2, code2 := runCmd(t, runAgent, sendEnv(t, newMailFake()),
			"agent", "serve", "--config", "a.json", "--fleet", "f.json")
		if code2 != 2 || !strings.Contains(errOut2, "--config OR --fleet, not both") {
			t.Errorf("code %d stderr %q", code2, errOut2)
		}
	})
}

func TestFitsRequirements(t *testing.T) {
	caps := json.RawMessage(`{"vision":false,"contextTokens":32000,"tools":false}`)
	for _, tc := range []struct {
		name     string
		caps     json.RawMessage
		requires json.RawMessage
		want     bool
	}{
		// The DefaultCase rule: an unfaceted invocation behaves as before.
		{"null requires claims", caps, json.RawMessage(`null`), true},
		{"absent requires claims", caps, nil, true},
		{"no declared vector claims everything", nil, json.RawMessage(`{"vision":true}`), true},
		{"vision beyond this host", caps, json.RawMessage(`{"vision":true}`), false},
		{"tools beyond this host", caps, json.RawMessage(`{"tools":true}`), false},
		{"context within budget", caps, json.RawMessage(`{"contextTokens":16000}`), true},
		{"context beyond budget", caps, json.RawMessage(`{"contextTokens":64000}`), false},
		{"unstated context means no known limit", json.RawMessage(`{"vision":true}`),
			json.RawMessage(`{"contextTokens":1000000}`), true},
	} {
		if got := fitsRequirements(tc.caps, tc.requires); got != tc.want {
			t.Errorf("%s: fits = %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestL0IsTheNodeSources(t *testing.T) {
	// The injection pin is a WIRE FORMAT — the model sees it — so the port
	// carries Node's bytes, pinned against the source the way internal/help
	// pins its artifact. When Node is deleted, this test retires with it and
	// the Go constant becomes the source of truth.
	src, err := os.ReadFile(filepath.Join("..", "..", "..", "packages", "cli", "src", "agent.ts"))
	if err != nil {
		t.Fatalf("read agent.ts: %v", err)
	}
	_, after, found := strings.Cut(string(src), "const L0 = `")
	if !found {
		t.Fatal("agent.ts no longer declares L0 where this test looks — repoint it")
	}
	nodeL0, _, found := strings.Cut(after, "`")
	if !found {
		t.Fatal("unterminated L0 template literal?")
	}
	if agentL0 != nodeL0 {
		t.Errorf("L0 drifted from the Node source:\n go: %q\nnode: %q", agentL0, nodeL0)
	}
}

func TestCallModel_Adapters(t *testing.T) {
	ctx := context.Background()

	t.Run("mock is deterministic with pseudo-usage", func(t *testing.T) {
		r, err := callModel(ctx, serveModelConfig{Provider: "mock"}, "sys", "From: A <a@b>\nSubject: Hi\n\nbody")
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(r.Output, `about "Hi"`) || r.Model != "mock" {
			t.Errorf("result = %+v", r)
		}
		if r.Usage == nil || r.Usage.TokensOut != int64(len(r.Output)) {
			t.Errorf("pseudo-usage: %+v", r.Usage)
		}
	})

	t.Run("keyless openai-compatible sends NO Authorization", func(t *testing.T) {
		// The @local shape: Ollama/vLLM/llama.cpp accept no key, and sending
		// an empty bearer would be a different request.
		var gotAuth *string
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			h := r.Header.Get("Authorization")
			gotAuth = &h
			_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":3,"completion_tokens":1}}`))
		}))
		defer srv.Close()
		r, err := callModel(ctx, serveModelConfig{Provider: "openai-compatible", BaseURL: srv.URL, Model: "qwen3"}, "s", "u")
		if err != nil || r.Output != "ok" {
			t.Fatalf("result = %+v (%v)", r, err)
		}
		if gotAuth == nil || *gotAuth != "" {
			t.Errorf("Authorization = %v, want absent", gotAuth)
		}
		if r.Usage == nil || r.Usage.TokensIn != 3 || r.Usage.TokensOut != 1 {
			t.Errorf("usage = %+v", r.Usage)
		}
	})

	t.Run("absent usage stays nil — NULL cost, never zero", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"}}]}`))
		}))
		defer srv.Close()
		r, err := callModel(ctx, serveModelConfig{Provider: "openai-compatible", BaseURL: srv.URL}, "s", "u")
		if err != nil {
			t.Fatal(err)
		}
		if r.Usage != nil {
			t.Errorf("unreported usage must stay nil, got %+v", r.Usage)
		}
	})

	t.Run("a NAMED env that is unset refuses before any request", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			t.Error("no request may leave with a missing key")
		}))
		defer srv.Close()
		t.Setenv("BM_TEST_ABSENT_KEY", "")
		_, err := callModel(ctx, serveModelConfig{Provider: "openai-compatible", BaseURL: srv.URL,
			APIKeyEnv: "BM_TEST_ABSENT_KEY"}, "s", "u")
		if err == nil || !strings.Contains(err.Error(), "missing API key (env BM_TEST_ABSENT_KEY)") {
			t.Errorf("err = %v", err)
		}
	})

	t.Run("anthropic speaks its own dialect", func(t *testing.T) {
		var gotPath, gotKey, gotVersion string
		var gotBody []byte
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			gotPath, gotKey, gotVersion = r.URL.Path, r.Header.Get("x-api-key"), r.Header.Get("anthropic-version")
			gotBody, _ = readAll(r)
			_, _ = w.Write([]byte(`{"content":[{"type":"text","text":"drafted"}],` +
				`"usage":{"input_tokens":10,"output_tokens":2}}`))
		}))
		defer srv.Close()
		t.Setenv("BM_TEST_ANTHROPIC_KEY", "sk-ant-test")
		r, err := callModel(ctx, serveModelConfig{Provider: "anthropic", BaseURL: srv.URL,
			APIKeyEnv: "BM_TEST_ANTHROPIC_KEY"}, "SYS", "USER")
		if err != nil || r.Output != "drafted" {
			t.Fatalf("result = %+v (%v)", r, err)
		}
		if gotPath != "/v1/messages" || gotKey != "sk-ant-test" || gotVersion != "2023-06-01" {
			t.Errorf("dialect: path %s key %s version %s", gotPath, gotKey, gotVersion)
		}
		// system rides its own field, not a message.
		var body struct {
			System   string              `json:"system"`
			Messages []map[string]string `json:"messages"`
		}
		_ = json.Unmarshal(gotBody, &body)
		if body.System != "SYS" || len(body.Messages) != 1 || body.Messages[0]["role"] != "user" {
			t.Errorf("body = %s", gotBody)
		}
		if r.Model != "claude-sonnet-5" {
			t.Errorf("default model = %q", r.Model)
		}
		if r.Usage == nil || r.Usage.TokensIn != 10 {
			t.Errorf("usage = %+v", r.Usage)
		}
	})
}

func readAll(r *http.Request) ([]byte, error) {
	defer r.Body.Close()
	return io.ReadAll(r.Body)
}
