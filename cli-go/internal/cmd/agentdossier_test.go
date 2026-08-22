package cmd

// The dossier's read half (s43 step 2). The properties under test are the
// ones the module's header promises: the console's refusal sentences survive
// verbatim, the floor enrichment never fails the read it decorates, doors are
// reported rather than guessed at, and money renders honestly (six places
// sub-cent, null ≠ zero, no-cap ≠ zero-left).

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/store"
)

// showDossier is the shared fixture: two bindings (one is "extractor", the
// re-provisionable one), a ledger for the first, six invocations so the
// limit-of-5 is observable, and a projection field the CLI predates (zebra).
const showDossier = `{
  "accountId":"a_you","principalId":"p_you","principal":"you@stub.test","tokenScopes":["read"],
  "bindings":[
    {"bindingId":"b_1","name":"hermes","triggerOn":"inbound","slaSeconds":900,"enabled":true,
     "config":{"pipeline":"reply","replyMode":"draft","hasPersona":true},
     "economics":{"budgetMicros":2000000,"defaultModel":"fast",
       "modelMenu":[{"alias":"fast","candidates":["@local/ollama/qwen3","openrouter/minimax/minimax-m3"],"zebra":1}],
       "exploreRate":0.1}},
    {"bindingId":"b_2","name":"extractor","triggerOn":"inbound","slaSeconds":null,"enabled":false,
     "config":{"pipeline":"extract","replyMode":null},
     "economics":{"budgetMicros":null,"defaultModel":null,"modelMenu":[],"exploreRate":null}}
  ],
  "invocations":[
    {"invocationId":"i_1","bindingId":"b_1","bindingName":"hermes","status":"done","emailId":"em_1","note":null,"createdAt":1755600000000,"doneAt":1755600010000,"costMicros":2100,"model":"@local/ollama/qwen3"},
    {"invocationId":"i_2","bindingId":"b_1","bindingName":"hermes","status":"failed","emailId":"em_2","note":null,"createdAt":1755500000000,"doneAt":null,"costMicros":null,"model":null},
    {"invocationId":"i_3","bindingId":"b_2","bindingName":"extractor","status":"done","emailId":"em_3","note":null,"createdAt":1755400000000,"doneAt":null,"costMicros":0,"model":"mock"},
    {"invocationId":"i_4","bindingId":"b_1","bindingName":"hermes","status":"done","emailId":"em_4","note":null,"createdAt":1755300000000,"doneAt":null,"costMicros":900,"model":"@local/ollama/qwen3"},
    {"invocationId":"i_5","bindingId":"b_1","bindingName":"hermes","status":"done","emailId":"em_5","note":null,"createdAt":1755200000000,"doneAt":null,"costMicros":800,"model":"@local/ollama/qwen3"},
    {"invocationId":"i_6","bindingId":"b_1","bindingName":"hermes","status":"done","emailId":"em_6","note":null,"createdAt":1755100000000,"doneAt":null,"costMicros":700,"model":"@local/ollama/qwen3"},
    {"invocationId":"i_7","bindingId":"b_1","bindingName":"hermes","status":"done","emailId":"em_7","note":null,"createdAt":1755000000000,"doneAt":null,"costMicros":600,"model":"@local/ollama/qwen3"}
  ],
  "ledgers":[{"bindingId":"b_1","pending":2,"running":1,"done":40,"failed":3,"oldestPendingAt":1755590000000,"monthSpendMicros":500000,"monthOverageMicros":250000}],
  "ledgerMonthStart":1754006400000
}`

func dossierEnv(t *testing.T, f *mailFake) string {
	t.Helper()
	if f.dossier == "" {
		f.dossier = showDossier
	}
	return sendEnv(t, f)
}

// withAdminPlane points adminUrl/adminToken at an adminFake, as `admin init`
// would have stored them.
func withAdminPlane(t *testing.T, dbPath string, v *adminFake) {
	t.Helper()
	db, err := store.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, kv := range [][2]string{{"adminUrl", v.srv.URL}, {"adminToken", "admin_tok"}} {
		if err := store.SetConfig(db, kv[0], kv[1]); err != nil {
			t.Fatal(err)
		}
	}
}

func TestAgentShow_ReadsOneDocument(t *testing.T) {
	f := newMailFake()
	out, errOut, code := runCmd(t, runAgent, dossierEnv(t, f), "agent", "show", "hermes")
	if code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, errOut)
	}
	// One GET of the console projection; no JMAP methods at all.
	if len(f.rest) != 1 || f.rest[0].Method != "GET" || !strings.Contains(f.rest[0].Path, "/console/agents/a_you") {
		t.Fatalf("rest = %+v", f.rest)
	}
	if n := f.names(); len(n) != 0 {
		t.Fatalf("show must not touch JMAP, got %v", n)
	}
	for _, want := range []string{
		"hermes  (b_1)",
		"enabled     yes",
		// The menu: default marked, explore arm indented under its alias.
		"*fast: @local/ollama/qwen3",
		"explore → openrouter/minimax/minimax-m3",
		// remaining = cap + overage − spent = 2000000 + 250000 − 500000.
		"$2.00/month · spent $0.50 · overage $0.25 · remaining $1.75",
		"pending 2 · running 1 · done 40 · failed 3",
		"oldest pending 2025-08-19",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("stdout missing %q\n%s", want, out)
		}
	}
	// The chrome carries the two honesty notes: undivided queue counts, and
	// (with no operator plane) why the floor is unknown.
	if !strings.Contains(errOut, "queue counts cover backfill and live delivery together") {
		t.Errorf("stderr = %q", errOut)
	}
	if !strings.Contains(out, "bullmoose admin init --url") {
		t.Errorf("the floor's absence must name the fix: %s", out)
	}
}

func TestAgentShow_RecentIsCappedAndMoneyHonest(t *testing.T) {
	f := newMailFake()
	out, _, code := runCmd(t, runAgent, dossierEnv(t, f), "agent", "show", "hermes")
	if code != 0 {
		t.Fatal(code)
	}
	// Six b_1 invocations exist; five ride. i_3 belongs to b_2 and never shows.
	if !strings.Contains(out, "5 most recent invocation(s)") {
		t.Errorf("limit of 5 not applied:\n%s", out)
	}
	if strings.Contains(out, "i_7") || strings.Contains(out, "i_3") {
		t.Errorf("wrong invocations shown:\n%s", out)
	}
	// 2100µ keeps six places — $0.00 is the money-honesty failure — and a
	// NULL cost is "not recorded", never a flattering zero.
	if !strings.Contains(out, "$0.002100") {
		t.Errorf("sub-cent cost rounded away:\n%s", out)
	}
	if !strings.Contains(out, "not recorded") {
		t.Errorf("null cost must render as not recorded:\n%s", out)
	}
}

func TestAgentShow_IDsEmitTheBindingID(t *testing.T) {
	f := newMailFake()
	out, _, code := runCmd(t, runAgent, dossierEnv(t, f), "agent", "show", "hermes", "--ids")
	if code != 0 || out != "b_1\n" {
		t.Errorf("code %d out %q, want b_1", code, out)
	}
}

func TestAgentShow_JSONIsHALAndVerbatim(t *testing.T) {
	f := newMailFake()
	out, _, code := runCmd(t, runAgent, dossierEnv(t, f), "agent", "show", "hermes", "--json")
	if code != 0 {
		t.Fatal(code)
	}
	var v map[string]any
	if err := json.Unmarshal([]byte(out), &v); err != nil {
		t.Fatalf("not one JSON value: %v", err)
	}
	// HAL: _self is the document this was read from; _links derive from ids
	// the payload carries. No operator plane → NO lifecycle link (a link
	// nobody can follow is worse than no link).
	if self, _ := v["_self"].(string); !strings.HasSuffix(self, "/console/agents/a_you") {
		t.Errorf("_self = %v", v["_self"])
	}
	links := v["_links"].(map[string]any)
	if _, has := links["lifecycle"]; has {
		t.Error("lifecycle link must not appear without the operator plane")
	}
	// The projection's rows survive VERBATIM: zebra rides the menu entry.
	menu := v["models"].(map[string]any)["menu"].([]any)
	if menu[0].(map[string]any)["zebra"] != float64(1) {
		t.Errorf("projection field dropped: %v", menu[0])
	}
	// The doors block: budget's door exists only for the "extractor" binding,
	// and configured reflects the ABSENT admin credential.
	budgetDoor := v["doors"].(map[string]any)["budget"].(map[string]any)
	if budgetDoor["configured"] != false {
		t.Error("budget door must report the missing operator credential")
	}
	if !strings.Contains(budgetDoor["unavailable"].(string), `no door writes config for binding "hermes"`) {
		t.Errorf("unavailable = %v", budgetDoor["unavailable"])
	}
	if v["budget"].(map[string]any)["remainingMicros"] != float64(1750000) {
		t.Errorf("remaining = %v", v["budget"])
	}
}

func TestAgentShow_FloorRidesTheOperatorPlane(t *testing.T) {
	// historyFloor (an APPROVED widening) wins over createdAt (the default
	// floor); the GET is by the account's address.
	v := newAdminFake(t)
	v.reply["GET /agent-bindings"] = `{"bindings":[{"id":"b_1","name":"hermes",` +
		`"config_json":"{\"createdAt\":1750000000000,\"historyFloor\":1740000000000}"}]}`
	f := newMailFake()
	dbPath := dossierEnv(t, f)
	withAdminPlane(t, dbPath, v)

	out, _, code := runCmd(t, runAgent, dbPath, "agent", "show", "hermes")
	if code != 0 {
		t.Fatal(code)
	}
	if len(v.calls) != 1 || !strings.Contains(v.calls[0].Path, "/agent-bindings?email=you%40stub.test") {
		t.Fatalf("operator calls = %+v", v.calls)
	}
	if !strings.Contains(out, "floor 2025-02-19") || !strings.Contains(out, "(historyFloor)") {
		t.Errorf("floor line wrong:\n%s", out)
	}
}

func TestAgentShow_EnrichmentNeverFailsTheRead(t *testing.T) {
	// The operator plane is configured but answers 500: the read it decorates
	// still exits 0, and the note says what happened.
	v := newAdminFake(t)
	v.status = 500
	f := newMailFake()
	dbPath := dossierEnv(t, f)
	withAdminPlane(t, dbPath, v)

	out, _, code := runCmd(t, runAgent, dbPath, "agent", "show", "hermes")
	if code != 0 {
		t.Fatalf("a read-only enrichment failed the read: %d", code)
	}
	if !strings.Contains(out, "operator plane unreachable") {
		t.Errorf("the failure must be a note, not silence:\n%s", out)
	}
	// And with the plane configured, the lifecycle link DOES appear.
	outJSON, _, _ := runCmd(t, runAgent, dbPath, "agent", "show", "hermes", "--json")
	var view map[string]any
	_ = json.Unmarshal([]byte(outJSON), &view)
	if _, has := view["_links"].(map[string]any)["lifecycle"]; !has {
		t.Error("lifecycle link must appear when the operator plane is configured")
	}
}

func TestAgentShow_ConsoleRefusalSurvivesVerbatim(t *testing.T) {
	// Three refusals, three different sentences — the sentence is the only
	// part a human needs, so it must not be re-worded into "forbidden".
	f := newMailFake()
	f.dossierRefusal = restRefusal{status: 403,
		body: `{"error":"agent tokens cannot read the console projection"}`}
	f.dossier = showDossier
	_, errOut, code := runCmd(t, runAgent, sendEnv(t, f), "agent", "show", "hermes")
	if code != 4 {
		t.Fatalf("code = %d, want 4", code)
	}
	if !strings.Contains(errOut, "agent tokens cannot read the console projection") {
		t.Errorf("the server's sentence was lost: %q", errOut)
	}
}

func TestAgentDossier_SelectorResolution(t *testing.T) {
	amb := strings.Replace(showDossier, `"name":"extractor"`, `"name":"HERMES"`, 1)
	for _, tc := range []struct {
		name     string
		dossier  string
		selector string
		wantCode int
		wantErr  string
	}{
		{"by id", showDossier, "b_2", 0, ""},
		{"case-insensitive name", showDossier, "HERMES", 0, ""},
		{"missing carries the roster", showDossier, "nope", 3,
			`no binding "nope" on a_you. This account carries: hermes (b_1), extractor (b_2)`},
		// With hermes AND HERMES on the account, "Hermes" matches neither
		// exactly and both case-insensitively — THAT is the ambiguity; an
		// exact spelling picks its binding outright (covered below).
		{"ambiguity refuses with ids", amb, "Hermes", 2, "matches 2 bindings on a_you; name one by id"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newMailFake()
			f.dossier = tc.dossier
			_, errOut, code := runCmd(t, runAgent, sendEnv(t, f), "agent", "show", tc.selector)
			if code != tc.wantCode {
				t.Fatalf("code = %d, want %d (stderr %q)", code, tc.wantCode, errOut)
			}
			if tc.wantErr != "" && !strings.Contains(errOut, tc.wantErr) {
				t.Errorf("stderr = %q, want %q", errOut, tc.wantErr)
			}
		})
	}
	// An exact-case match beats the case-insensitive pool: no ambiguity here.
	t.Run("exact beats ci", func(t *testing.T) {
		f := newMailFake()
		f.dossier = amb // hermes (b_1) + HERMES (b_2)
		out, _, code := runCmd(t, runAgent, sendEnv(t, f), "agent", "show", "hermes", "--ids")
		if code != 0 || out != "b_1\n" {
			t.Errorf("code %d out %q — exact name must win outright", code, out)
		}
	})
}

func TestAgentDossier_NoSelectorCostsZero(t *testing.T) {
	f := newMailFake()
	_, errOut, code := runCmd(t, runAgent, sendEnv(t, f), "agent", "show")
	if code != 2 {
		t.Fatalf("code = %d", code)
	}
	if !strings.Contains(errOut, "usage: bullmoose agent show <binding>") {
		t.Errorf("stderr = %q", errOut)
	}
	if len(f.rest) != 0 || len(f.names()) != 0 {
		t.Error("a usage refusal must cost zero requests")
	}
}

func TestAgentBudgetRead_NoCapIsNotZeroLeft(t *testing.T) {
	// "Unbounded" and "zero left" must never render the same.
	f := newMailFake()
	out, _, code := runCmd(t, runAgent, dossierEnv(t, f), "agent", "budget", "extractor")
	if code != 0 {
		t.Fatal(code)
	}
	if !strings.Contains(out, "no monthly cap configured") {
		t.Errorf("stdout = %q", out)
	}

	outJSON, _, _ := runCmd(t, runAgent, dossierEnv(t, newMailFake()), "agent", "budget", "extractor", "--json")
	var v map[string]any
	if err := json.Unmarshal([]byte(outJSON), &v); err != nil {
		t.Fatal(err)
	}
	if v["capMicros"] != nil || v["remainingMicros"] != nil {
		t.Errorf("no cap must be null, not 0: %v", v)
	}
	// The door rides the record: extractor IS the re-provisionable binding,
	// so no `unavailable` — but the credential is absent, and the block says so.
	door := v["door"].(map[string]any)
	if _, has := door["unavailable"]; has {
		t.Errorf("extractor's budget door must exist: %v", door)
	}
	if door["configured"] != false {
		t.Errorf("door must report the missing credential: %v", door)
	}
}

func TestAgentModelRead_MenuWithDoors(t *testing.T) {
	f := newMailFake()
	out, _, code := runCmd(t, runAgent, dossierEnv(t, f), "agent", "model", "hermes")
	if code != 0 {
		t.Fatal(code)
	}
	for _, want := range []string{"*fast", "primary → @local/ollama/qwen3",
		"explore → openrouter/minimax/minimax-m3", "explore rate 0.1"} {
		if !strings.Contains(out, want) {
			t.Errorf("stdout missing %q\n%s", want, out)
		}
	}
}
