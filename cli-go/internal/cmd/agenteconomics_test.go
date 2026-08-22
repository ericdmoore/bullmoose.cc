package cmd

// agents budget / agents model — the session-plane economics verbs. The
// properties under test: the patch the CLI sends is EXACTLY the named knob
// (never a whole-config rewrite — that hazard is the reason these verbs left
// the operator door), a server refusal is surfaced verbatim, and the printed
// state after a write is the server's answer, not an echo of our own patch.

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	bmio "github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
)

type econFake struct {
	binding map[string]any // the /get row, mutated by /set like the real server
	sets    []map[string]any
	refuse  string // non-empty: /set answers notUpdated with this description
}

func (f *econFake) handle(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet { // the session
		fmt.Fprintf(w, `{"apiUrl":"http://%s/api","accounts":{"a_eric":{"name":"eric@bullmoose.cc","accountCapabilities":{"urn:bullmoose:params:jmap:agent":{"mayDecide":true}}}},"primaryAccounts":{"urn:ietf:params:jmap:mail":"a_eric"}}`, r.Host)
		return
	}
	var req struct {
		MethodCalls [][]json.RawMessage `json:"methodCalls"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	var method string
	_ = json.Unmarshal(req.MethodCalls[0][0], &method)
	switch method {
	case "AgentBinding/get":
		reply(w, "AgentBinding/get", map[string]any{"list": []any{f.binding}})
	case "AgentBinding/set":
		var args struct {
			Update map[string]map[string]any `json:"update"`
		}
		_ = json.Unmarshal(req.MethodCalls[0][1], &args)
		for id, patch := range args.Update {
			f.sets = append(f.sets, patch)
			if f.refuse != "" {
				reply(w, "AgentBinding/set", map[string]any{
					"notUpdated": map[string]any{id: map[string]any{"type": "forbidden", "description": f.refuse}},
				})
				return
			}
			eco := f.binding["economics"].(map[string]any)
			if v, ok := patch["budgetMicros"]; ok {
				eco["budgetMicros"] = v
			}
			if v, ok := patch["modelMenu"]; ok {
				eco["modelMenu"] = v
			}
			if v, ok := patch["defaultModel"]; ok {
				eco["defaultModel"] = v
			}
			if v, ok := patch["exploreRate"]; ok {
				eco["exploreRate"] = v
			}
			reply(w, "AgentBinding/set", map[string]any{"updated": map[string]any{id: map[string]any{}}})
		}
	default:
		http.Error(w, "unknown method "+method, 400)
	}
}

func reply(w http.ResponseWriter, method string, res map[string]any) {
	body, _ := json.Marshal(map[string]any{"methodResponses": []any{[]any{method, res, "0"}}})
	_, _ = w.Write(body)
}

func econWorld(t *testing.T, f *econFake) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(f.handle))
	t.Cleanup(srv.Close)
	return seedMirror(t, srv.URL, "bm_test_token", "a_eric")
}

func baseBinding() map[string]any {
	return map[string]any{
		"id": "bind_x", "name": "extractor", "enabled": true,
		"economics": map[string]any{
			"budgetMicros": 2000000, "spentMicros": 40000,
			"defaultModel": "extract",
			"modelMenu":    []any{map[string]any{"alias": "extract", "candidates": []any{"openrouter/minimax/minimax-m3"}}},
			"exploreRate":  0.25,
		},
	}
}

func runEcon(t *testing.T, dbPath string, argv ...string) (int, string, string) {
	t.Helper()
	var out, errb strings.Builder
	s := bmio.NewTo(&out, &errb)
	// The real dispatch hands runAgents the command head too: argv[0] is
	// "agents", the verb sits at positional 1, the binding at 2 (runAG's
	// convention, kept so these tests exercise the same offsets production
	// does).
	full := append([]string{"agents"}, argv...)
	code := runAgents(s, append(full, "--db", dbPath))
	return code, out.String(), errb.String()
}

func TestBudget_ReadThenSet_PatchIsExactlyTheKnob(t *testing.T) {
	f := &econFake{binding: baseBinding()}
	db := econWorld(t, f)

	code, out, _ := runEcon(t, db, "budget", "extractor")
	if code != 0 || !strings.Contains(out, "$2.00") {
		t.Fatalf("read: code=%d out=%q", code, out)
	}

	code, out, _ = runEcon(t, db, "budget", "extractor", "--set", "5000000")
	if code != 0 || !strings.Contains(out, "$5.00") {
		t.Fatalf("set: code=%d out=%q", code, out)
	}
	if len(f.sets) != 1 {
		t.Fatalf("expected exactly one /set, got %d", len(f.sets))
	}
	// THE point: the patch is the named knob and nothing else. The operator
	// door rewrote the whole config; this door must never.
	if len(f.sets[0]) != 1 {
		t.Fatalf("patch touched more than budgetMicros: %v", f.sets[0])
	}
	if v := f.sets[0]["budgetMicros"]; fmt.Sprint(v) != "5e+06" && fmt.Sprint(v) != "5000000" {
		t.Fatalf("budgetMicros = %v", v)
	}
}

func TestBudget_RefusalIsVerbatim(t *testing.T) {
	f := &econFake{binding: baseBinding(), refuse: "the binding kill switch and its budget are human controls"}
	db := econWorld(t, f)
	code, _, errOut := runEcon(t, db, "budget", "extractor", "--set", "1")
	if code == 0 {
		t.Fatal("a refused write must not exit 0")
	}
	// The server's own words, not a re-wording — the help-text rule.
	if !strings.Contains(errOut, "human controls") {
		t.Fatalf("refusal not surfaced verbatim: %q", errOut)
	}
}

func TestBudget_GarbageAmountRefusedLocally(t *testing.T) {
	f := &econFake{binding: baseBinding()}
	db := econWorld(t, f)
	code, _, errOut := runEcon(t, db, "budget", "extractor", "--set", "five dollars")
	if code == 0 || len(f.sets) != 0 {
		t.Fatalf("garbage must refuse BEFORE the wire: code=%d sets=%d", code, len(f.sets))
	}
	if !strings.Contains(errOut, "µUSD") {
		t.Fatalf("the refusal should teach the unit: %q", errOut)
	}
}

func TestModel_SetBuildsMenuHeadFirst(t *testing.T) {
	f := &econFake{binding: baseBinding()}
	db := econWorld(t, f)
	code, out, _ := runEcon(t, db, "model", "extractor",
		"--set", "workers-ai/@cf/meta/llama-3.3-70b", "--explore", "openrouter/minimax/minimax-m3", "--rate", "0.1")
	if code != 0 {
		t.Fatalf("code=%d", code)
	}
	if len(f.sets) != 1 {
		t.Fatalf("one /set expected, got %d", len(f.sets))
	}
	menu := f.sets[0]["modelMenu"].([]any)[0].(map[string]any)
	cands := menu["candidates"].([]any)
	// Position 0 is the head, 1+ are arms — chooseArm's contract.
	if cands[0] != "workers-ai/@cf/meta/llama-3.3-70b" || cands[1] != "openrouter/minimax/minimax-m3" {
		t.Fatalf("candidates out of order: %v", cands)
	}
	// And the printed state is the SERVER's answer (re-read), not our echo.
	if !strings.Contains(out, "workers-ai/@cf/meta/llama-3.3-70b") {
		t.Fatalf("out=%q", out)
	}
}

func TestModel_ExploreWithoutSetRefused(t *testing.T) {
	f := &econFake{binding: baseBinding()}
	db := econWorld(t, f)
	code, _, errOut := runEcon(t, db, "model", "extractor", "--explore", "x/y")
	if code == 0 || len(f.sets) != 0 {
		t.Fatal("arms without a primary must refuse before the wire")
	}
	if !strings.Contains(errOut, "--set") {
		t.Fatalf("the refusal should name the fix: %q", errOut)
	}
}

func TestUnknownBindingNamesWhatExists(t *testing.T) {
	f := &econFake{binding: baseBinding()}
	db := econWorld(t, f)
	_, _, errOut := runEcon(t, db, "budget", "nope")
	if !strings.Contains(errOut, "extractor") {
		t.Fatalf("not-found should name what IS there: %q", errOut)
	}
}

// Keep the sqlite import honest (seedMirror uses it via approvals_test).
var _ = sql.Drivers
var _ = filepath.Join
