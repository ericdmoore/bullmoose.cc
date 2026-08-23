package cmd

// The extract mirror (s43 step 5). Two kinds of test: the DRIFT test chaining
// every mirrored constant to the cloud source (the reason the mirror can be
// trusted at all), and the gate choreography — each gate observed by which
// calls happen and which never do.

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestExtractMirrorsTheCloudSource is Node's extract.test.ts mirror-guard,
// rebuilt: services/agent/src/extract.ts is the source of truth, and every
// constant this file carries must appear there VERBATIM. Three copies exist
// until the Node CLI is deleted (cloud, Node, here); both mirrors pin the
// same file, so all three stay chained to one source. The failure mode this
// exists for was real once: the prompt asked for `event` and `contact`, the
// allow-list didn't know them, and the pass silently found "nothing concrete"
// on messages full of dates.
func TestExtractMirrorsTheCloudSource(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("..", "..", "..", "services", "agent", "src", "extract.ts"))
	if err != nil {
		t.Fatalf("read the cloud source: %v", err)
	}
	cloud := string(src)

	if !strings.Contains(cloud, extractSystem) {
		t.Error("EXTRACT_SYSTEM drifted from the cloud prompt")
	}
	for name, pattern := range map[string]string{
		"COMMITMENT_CUES": commitmentCues,
		"EVENT_CUES":      eventCues,
		"CONTACT_CUES":    contactCues,
	} {
		if !strings.Contains(cloud, pattern) {
			t.Errorf("%s drifted from the cloud pre-filter", name)
		}
	}
	if !strings.Contains(cloud, "MAX_PER_MESSAGE = 8") || maxPerMessage != 8 {
		t.Error("MAX_PER_MESSAGE drifted")
	}
	if !strings.Contains(cloud, "SCAN = 4000") || extractScan != 4000 {
		t.Error("SCAN drifted")
	}
	// The allow-list, as the cloud's own Set literal.
	classLiteral := `new Set(["commitment", "decision", "task", "event", "contact"])`
	if !strings.Contains(cloud, classLiteral) {
		t.Error("CLASS_TYPES drifted — update extractClassTypes AND this literal together")
	}
	for cls := range extractClassTypes {
		if !strings.Contains(classLiteral, `"`+cls+`"`) {
			t.Errorf("extractClassTypes carries %q, absent from the cloud literal", cls)
		}
	}
	// The skip/result notes are the cloud's exact strings — a downstream
	// reader greps for them.
	for _, note := range []string{
		"skipped: List-Unsubscribe (bulk mail) — no model call",
		"no extraction cues — skipped, no model call",
		"already extracted (retry) — no duplicates",
		"no commitments/decisions/tasks found",
	} {
		if !strings.Contains(cloud, note) {
			t.Errorf("result note %q is not the cloud's", note)
		}
	}
}

func TestParseExtraction(t *testing.T) {
	t.Run("fenced and chatty output still parses", func(t *testing.T) {
		items := parseExtraction("Sure! Here you go:\n```json\n" +
			`[{"class":"commitment","body":" I'll send it Friday ","confidence":0.8}]` + "\n```\nHope that helps!")
		if len(items) != 1 || items[0].Class != "commitment" || items[0].Body != "I'll send it Friday" {
			t.Errorf("items = %+v", items)
		}
	})
	t.Run("unknown classes and empty bodies drop", func(t *testing.T) {
		items := parseExtraction(`[{"class":"vibe","body":"x"},{"class":"task","body":""},{"class":"task","body":"file taxes"}]`)
		if len(items) != 1 || items[0].Class != "task" {
			t.Errorf("items = %+v", items)
		}
	})
	t.Run("confidence clamps; null is 0; absent is null", func(t *testing.T) {
		items := parseExtraction(`[{"class":"task","body":"a","confidence":7},` +
			`{"class":"task","body":"b","confidence":null},{"class":"task","body":"c"}]`)
		if len(items) != 3 {
			t.Fatalf("items = %+v", items)
		}
		if items[0].Confidence == nil || *items[0].Confidence != 1 {
			t.Errorf("clamp: %+v", items[0])
		}
		// Number(null) is 0 in JS — the mirror carries the coercion, kept by
		// jsobj.JSNumberOf.
		if items[1].Confidence == nil || *items[1].Confidence != 0 {
			t.Errorf("null: %+v", items[1])
		}
		if items[2].Confidence != nil {
			t.Errorf("absent: %+v", items[2])
		}
	})
	t.Run("garbage never errors", func(t *testing.T) {
		for _, bad := range []string{"", "no array here", "[not json", `{"an":"object"}`} {
			if items := parseExtraction(bad); items != nil {
				t.Errorf("%q → %+v", bad, items)
			}
		}
	})
}

func TestChooseArm(t *testing.T) {
	menu := []serveModelConfig{{Model: "a"}, {Model: "b"}, {Model: "c"}}
	t.Run("deterministic per seed — a retry explores identically", func(t *testing.T) {
		o1, a1 := chooseArm(menu, "inv_42", 0.5)
		o2, a2 := chooseArm(menu, "inv_42", 0.5)
		if a1 != a2 || len(o1) != len(o2) {
			t.Fatal("assignment must be a fact about the invocation")
		}
		for i := range o1 {
			if o1[i].Model != o2[i].Model {
				t.Fatal("reorder differs across retries")
			}
		}
	})
	t.Run("exploration reorders, never shrinks", func(t *testing.T) {
		// Rate 1.0: every seed explores; the set must survive intact.
		ordered, arm := chooseArm(menu, "inv_1", 1.0)
		if arm != "explore" {
			t.Fatalf("rate 1.0 must explore, got %s", arm)
		}
		got := map[string]bool{}
		for _, m := range ordered {
			got[m.Model] = true
		}
		if len(ordered) != 3 || !got["a"] || !got["b"] || !got["c"] {
			t.Errorf("menu shrank or duplicated: %+v", ordered)
		}
		if ordered[0].Model == "a" {
			t.Error("explore must promote an alternate over the primary")
		}
	})
	t.Run("degenerate menus exploit", func(t *testing.T) {
		if _, arm := chooseArm(menu[:1], "s", 1.0); arm != "exploit" {
			t.Error("one candidate cannot explore")
		}
		if _, arm := chooseArm(menu, "s", 0); arm != "exploit" {
			t.Error("rate 0 must exploit")
		}
	})
}

func TestCostHonesty(t *testing.T) {
	// 0 is EARNED (mock, keyless @local, declared free); everything else is
	// NULL — the CLI ships no pricing map and never guesses dollars.
	for _, tc := range []struct {
		name string
		spec serveModelConfig
		free bool
	}{
		{"mock", serveModelConfig{Provider: "mock"}, true},
		{"keyless openai-compatible", serveModelConfig{Provider: "openai-compatible"}, true},
		{"keyed openai-compatible", serveModelConfig{Provider: "openai-compatible", APIKeyEnv: "K"}, false},
		{"anthropic", serveModelConfig{Provider: "anthropic", APIKeyEnv: "K"}, false},
		{"keyed but declared free", serveModelConfig{Provider: "openai-compatible", APIKeyEnv: "K", Free: true}, true},
	} {
		cost := invocationCostOf(tc.spec, "m", nil)
		if tc.free && (cost.CostMicros == nil || *cost.CostMicros != 0) {
			t.Errorf("%s: want 0, got %v", tc.name, cost.CostMicros)
		}
		if !tc.free && cost.CostMicros != nil {
			t.Errorf("%s: want null, got %d", tc.name, *cost.CostMicros)
		}
		if cost.TokensIn != nil || cost.TokensOut != nil {
			t.Errorf("%s: absent usage must be null tokens", tc.name)
		}
	}
}

func TestHasListUnsubscribe(t *testing.T) {
	folded := "From: a@b\r\nList-Unsubscribe:\r\n <mailto:u@x>, <https://x/u>\r\n\r\nbody"
	if !hasListUnsubscribe([]byte(folded)) {
		t.Error("a folded header must still match")
	}
	inBody := "From: a@b\r\nSubject: hi\r\n\r\nList-Unsubscribe: not a header down here"
	if hasListUnsubscribe([]byte(inBody)) {
		t.Error("a body mention is not a header")
	}
	if hasListUnsubscribe([]byte("From: a@b\r\n\r\nplain")) {
		t.Error("absent header must not match")
	}
}

// ── the gates, observed through the serve loop ──────────────────────────────

const extractAgentJSON = `{"binding":"extractor","model":{"provider":"mock"},"pipeline":"extract"}`

func extractServeEnv(t *testing.T, f *mailFake, emailJSON string) string {
	t.Helper()
	f.invocationIDs = `["inv_9"]`
	f.invocationList = `[{"id":"inv_9","emailId":"em_x","bindingName":"extractor","status":"pending","requires":null}]`
	f.addEmail("em_x", emailJSON)
	return sendEnv(t, f)
}

const cueyEmail = `{"id":"em_x","blobId":"b_x","from":[{"name":"Coach","email":"coach@club.test"}],` +
	`"subject":"Tournament Saturday","preview":"",` +
	`"bodyValues":{"1":{"value":"Practice at 7:30 am. I'll send the schedule Friday."}},` +
	`"textBody":[{"partId":"1","type":"text/plain"}]}`

func TestAgentExtract_HappyPathChoreography(t *testing.T) {
	f := newMailFake()
	dbPath := extractServeEnv(t, f, cueyEmail)
	_, errOut, code := runCmd(t, runAgent, dbPath,
		"agent", "serve", "--config", serveConfig(t, extractAgentJSON), "--once")
	if code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, errOut)
	}
	// query → get → claim → Email/get → (blob gate via /dl/) → 3× Annotation/query
	// → Annotation/set → done. No Mailbox/query, no Email/set: extract writes
	// annotations, never drafts.
	want := "AgentInvocation/query,AgentInvocation/get,AgentInvocation/set,Email/get," +
		"Annotation/query,Annotation/query,Annotation/query,Annotation/set,AgentInvocation/set"
	if got := strings.Join(f.names(), ","); got != want {
		t.Fatalf("choreography:\n got %s\nwant %s", got, want)
	}
	if len(f.downloads) != 1 || !strings.Contains(f.downloads[0], "b_x") {
		t.Errorf("the header gate must read the raw blob: %v", f.downloads)
	}

	// The annotation row: anchored to the email, sourceRef citing it, the
	// mock's canned commitment.
	var set struct {
		Create map[string]struct {
			Anchor struct {
				Realm    string `json:"realm"`
				ObjectID string `json:"objectId"`
			} `json:"anchor"`
			Class      string  `json:"class"`
			Body       string  `json:"body"`
			Confidence float64 `json:"confidence"`
			SourceRef  string  `json:"sourceRef"`
		} `json:"create"`
	}
	_ = json.Unmarshal([]byte(f.argsOf("Annotation/set")), &set)
	row := set.Create["c0"]
	if row.Anchor.Realm != "Email" || row.Anchor.ObjectID != "em_x" || row.SourceRef != "em_x" {
		t.Errorf("anchoring = %+v", row)
	}
	if row.Class != "commitment" || !strings.Contains(row.Body, "Tournament Saturday") || row.Confidence != 0.9 {
		t.Errorf("row = %+v", row)
	}

	// Completion: done with count/model/arm and an HONEST cost (mock = 0).
	last := f.calls[len(f.calls)-1]
	var done struct {
		Update map[string]struct {
			Status string `json:"status"`
			Result struct {
				Note  string `json:"note"`
				Count int    `json:"count"`
				Model string `json:"model"`
				Arm   string `json:"arm"`
				Cost  struct {
					CostMicros *int64 `json:"costMicros"`
				} `json:"cost"`
			} `json:"result"`
		} `json:"update"`
	}
	_ = json.Unmarshal(last.Args, &done)
	r := done.Update["inv_9"]
	if r.Status != "done" || r.Result.Note != "extracted 1" || r.Result.Count != 1 ||
		r.Result.Model != "mock/mock" || r.Result.Arm != "exploit" {
		t.Errorf("completion = %s", last.Args)
	}
	if r.Result.Cost.CostMicros == nil || *r.Result.Cost.CostMicros != 0 {
		t.Errorf("mock cost must be an earned 0: %s", last.Args)
	}
	if !strings.Contains(errOut, "inv_9 extract → done: extracted 1") {
		t.Errorf("stderr = %q", errOut)
	}
}

func TestAgentExtract_BulkMailSkipsBeforeTheModel(t *testing.T) {
	f := newMailFake()
	f.blobRaw = "From: promo@shop.test\r\nList-Unsubscribe: <mailto:u@shop.test>\r\n\r\nOrder by Friday!"
	dbPath := extractServeEnv(t, f, cueyEmail)
	_, errOut, code := runCmd(t, runAgent, dbPath,
		"agent", "serve", "--config", serveConfig(t, extractAgentJSON), "--once")
	if code != 0 {
		t.Fatal(code)
	}
	// The gate closes the pass as DONE — a skip is a completed decision, not
	// an error — and nothing downstream runs: no Annotation calls at all.
	for _, name := range f.names() {
		if strings.HasPrefix(name, "Annotation/") {
			t.Fatalf("bulk mail must not reach the annotation surface: %v", f.names())
		}
	}
	if !strings.Contains(errOut, "extract → done: skipped: List-Unsubscribe (bulk mail) — no model call") {
		t.Errorf("stderr = %q", errOut)
	}
}

func TestAgentExtract_NoCueMeansNoModelCall(t *testing.T) {
	f := newMailFake()
	quiet := `{"id":"em_x","blobId":"b_x","from":[{"email":"a@b.test"}],"subject":"Hello",` +
		`"preview":"","bodyValues":{"1":{"value":"Just wanted to say the newsletter looks lovely."}},` +
		`"textBody":[{"partId":"1","type":"text/plain"}]}`
	dbPath := extractServeEnv(t, f, quiet)
	_, errOut, code := runCmd(t, runAgent, dbPath,
		"agent", "serve", "--config", serveConfig(t, extractAgentJSON), "--once")
	if code != 0 {
		t.Fatal(code)
	}
	if !strings.Contains(errOut, "extract → done: no extraction cues — skipped, no model call") {
		t.Errorf("stderr = %q", errOut)
	}
	for _, name := range f.names() {
		if strings.HasPrefix(name, "Annotation/") {
			t.Fatalf("a cue-less message must not reach the annotation surface: %v", f.names())
		}
	}
}

func TestAgentExtract_IdempotenceAcrossEveryStatus(t *testing.T) {
	// A resolved or dismissed claim still proves the pass ran: the retry must
	// not double-extract even when the open queue is empty.
	f := newMailFake()
	f.annotationIDs = map[string]string{"dismissed": `["ann_7"]`}
	f.annotationList = `[{"id":"ann_7","sourceRef":"em_x"}]`
	dbPath := extractServeEnv(t, f, cueyEmail)
	_, errOut, code := runCmd(t, runAgent, dbPath,
		"agent", "serve", "--config", serveConfig(t, extractAgentJSON), "--once")
	if code != 0 {
		t.Fatal(code)
	}
	if !strings.Contains(errOut, "extract → done: already extracted (retry) — no duplicates") {
		t.Errorf("stderr = %q", errOut)
	}
	if f.argsOf("Annotation/set") != "" {
		t.Error("a retry must write nothing")
	}
}

func TestAgentExtract_AnnotateScopeRefusalIsACleanFailure(t *testing.T) {
	// A claim-only token minted without `annotate` is refused server-side;
	// the pass completes as FAILED naming the refusal — never a crash, and
	// the cost of the model call it DID make still rides the result.
	f := newMailFake()
	f.refuseAnnotation = `{"type":"forbidden","description":"token lacks the annotate scope"}`
	dbPath := extractServeEnv(t, f, cueyEmail)
	_, errOut, code := runCmd(t, runAgent, dbPath,
		"agent", "serve", "--config", serveConfig(t, extractAgentJSON), "--once")
	if code != 0 {
		t.Fatalf("the loop must survive: %d", code)
	}
	last := f.calls[len(f.calls)-1]
	var done struct {
		Update map[string]struct {
			Status string `json:"status"`
			Result struct {
				Note string `json:"note"`
			} `json:"result"`
		} `json:"update"`
	}
	_ = json.Unmarshal(last.Args, &done)
	r := done.Update["inv_9"]
	if r.Status != "failed" || !strings.Contains(r.Result.Note, "annotation writes refused") ||
		!strings.Contains(r.Result.Note, "annotate scope") {
		t.Errorf("completion = %s", last.Args)
	}
	if !strings.Contains(errOut, "startup drain: 0 invocation(s) handled") {
		t.Errorf("a failed pass is not handled work: %q", errOut)
	}
}

func TestAgentExtract_MenuFallsBackInOrder(t *testing.T) {
	// First route dead (named env unset), second is the mock: the pass
	// succeeds on the fallback, and cost honesty follows the route USED.
	cfg := `{"binding":"extractor","model":{"provider":"mock"},"pipeline":"extract",` +
		`"modelMenu":[{"provider":"openai-compatible","baseURL":"http://127.0.0.1:1","model":"dead","apiKeyEnv":"BM_TEST_NO_SUCH_KEY"},` +
		`{"provider":"mock"}]}`
	f := newMailFake()
	dbPath := extractServeEnv(t, f, cueyEmail)
	_, errOut, code := runCmd(t, runAgent, dbPath,
		"agent", "serve", "--config", serveConfig(t, cfg), "--once")
	if code != 0 {
		t.Fatal(code)
	}
	if !strings.Contains(errOut, "extract → done: extracted 1") {
		t.Errorf("stderr = %q", errOut)
	}
	var done struct {
		Update map[string]struct {
			Result struct {
				Model string `json:"model"`
			} `json:"result"`
		} `json:"update"`
	}
	_ = json.Unmarshal(f.calls[len(f.calls)-1].Args, &done)
	if done.Update["inv_9"].Result.Model != "mock/mock" {
		t.Errorf("the route USED must be recorded: %s", f.calls[len(f.calls)-1].Args)
	}
}

func TestAgentExtract_ContextCancellation(t *testing.T) {
	// A cancelled context surfaces as an error, not a hang — the graceful-
	// shutdown groundwork (the one named divergence) leans on this.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := callModel(ctx, serveModelConfig{Provider: "openai-compatible", BaseURL: "http://127.0.0.1:1"}, "s", "u")
	if err == nil {
		t.Fatal("a cancelled context must refuse")
	}
}
