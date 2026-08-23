package cmd

// The dossier's write half (s43 step 3). The two hazards the module's header
// names are the two things every test here corners: the re-provision door
// rewrites the WHOLE config (so the read-modify-write must preserve what the
// caller did not say), and it re-enables a disabled binding (so the --yes
// gate must sit in front, refusing at zero cost).

import (
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"testing"

	bmio "github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
)

// writeDossier is showDossier with the extractor binding ENABLED — the shape
// most write tests want; the DISABLED original is the --yes gate's fixture.
var writeDossier = strings.Replace(showDossier, `"enabled":false`, `"enabled":true`, 1)

// extractorConfig is the operator-plane row the RMW reads back: a menu with
// an explore arm, a budget, a frontier rate and maxTokens — one of each thing
// a naive "just POST the new value" would silently drop.
const extractorConfig = `{"defaultModel":"fast",` +
	`"modelAliases":{"fast":[{"provider":"@local/ollama","model":"qwen3"},{"provider":"openrouter","model":"minimax/minimax-m3"}]},` +
	`"budgets":{"spendPerMonth":2000000},"frontier":{"exploreRate":0.1},"maxTokens":512}`

func reprovisionFakes(t *testing.T) (*mailFake, *adminFake, string) {
	t.Helper()
	v := newAdminFake(t)
	v.reply["GET /agent-bindings"] = `{"bindings":[{"id":"b_2","name":"extractor","config_json":` +
		strconv.Quote(extractorConfig) + `}]}`
	v.reply["POST /extractor"] = `{"ok":true,"bindingId":"b_2"}`
	f := newMailFake()
	f.dossier = writeDossier
	dbPath := sendEnv(t, f)
	withAdminPlane(t, dbPath, v)
	return f, v, dbPath
}

// ── the kill switch ─────────────────────────────────────────────────────────

func TestAgentKill_Choreography(t *testing.T) {
	f := newMailFake()
	out, errOut, code := runCmd(t, runAgent, dossierEnv(t, f), "agent", "disable", "hermes")
	if code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, errOut)
	}
	if names := f.names(); strings.Join(names, ",") != "AgentBinding/set" {
		t.Fatalf("calls = %v", names)
	}
	var set struct {
		AccountID string `json:"accountId"`
		Update    map[string]struct {
			Enabled *bool `json:"enabled"`
		} `json:"update"`
	}
	_ = json.Unmarshal([]byte(f.argsOf("AgentBinding/set")), &set)
	u, has := set.Update["b_1"]
	if set.AccountID != "a_you" || !has || u.Enabled == nil || *u.Enabled {
		t.Errorf("update = %+v", set)
	}
	if !strings.Contains(out, "hermes (b_1) is now DISABLED") {
		t.Errorf("stdout = %q", out)
	}
	// The disable chrome carries the held-not-cancelled fact.
	if !strings.Contains(errOut, "queued invocations are HELD, not cancelled") {
		t.Errorf("stderr = %q", errOut)
	}
}

func TestAgentKill_AlreadyInThatStateSaysSo(t *testing.T) {
	// hermes is already enabled; enable again → the write happens (the server
	// decides idempotence), and the chrome says no audit row was added.
	f := newMailFake()
	out, errOut, code := runCmd(t, runAgent, dossierEnv(t, f), "agent", "enable", "hermes")
	if code != 0 {
		t.Fatal(code)
	}
	if !strings.Contains(out, "hermes (b_1) is now ENABLED") {
		t.Errorf("stdout = %q", out)
	}
	if !strings.Contains(errOut, "already in that state — nothing was written and no audit row was added") {
		t.Errorf("stderr = %q", errOut)
	}
}

func TestAgentKill_JSONCarriesBothStates(t *testing.T) {
	f := newMailFake()
	out, _, code := runCmd(t, runAgent, dossierEnv(t, f), "agent", "disable", "hermes", "--json")
	if code != 0 {
		t.Fatal(code)
	}
	var v struct {
		Enabled    bool `json:"enabled"`
		WasEnabled bool `json:"wasEnabled"`
	}
	if err := json.Unmarshal([]byte(out), &v); err != nil || v.Enabled || !v.WasEnabled {
		t.Errorf("json = %q (err %v)", out, err)
	}
}

func TestAgentKill_DryRunWritesNothing(t *testing.T) {
	f := newMailFake()
	_, errOut, code := runCmd(t, runAgent, dossierEnv(t, f), "agent", "disable", "hermes", "--dry-run")
	if code != 0 {
		t.Fatal(code)
	}
	if n := f.names(); len(n) != 0 {
		t.Fatalf("dry run wrote: %v", n)
	}
	if !strings.Contains(errOut, "would disable hermes (b_1); it is currently enabled. Nothing was written.") {
		t.Errorf("stderr = %q", errOut)
	}
}

func TestAgentKill_RefusalIsTheServers(t *testing.T) {
	// "insufficient scope" and a re-worded "forbidden" teach different mental
	// models; the server's sentence survives through the SetError machinery.
	f := newMailFake()
	f.refuseBinding = `{"type":"forbidden","description":"insufficient scope: send"}`
	_, errOut, code := runCmd(t, runAgent, dossierEnv(t, f), "agent", "disable", "hermes")
	if code != 4 {
		t.Fatalf("code = %d, want 4", code)
	}
	if !strings.Contains(errOut, "disable hermes failed: forbidden — insufficient scope: send") {
		t.Errorf("stderr = %q", errOut)
	}
}

// ── the re-provision pair ───────────────────────────────────────────────────

func TestAgentReprovision_NonExtractorHasNoDoor(t *testing.T) {
	// hermes is not the "extractor" binding, so budget/model --set have NO
	// door — exit 2 with the block's own sentence, zero operator calls, and
	// under --json the refusal is a RECORD carrying the door.
	v := newAdminFake(t)
	f := newMailFake()
	f.dossier = writeDossier
	dbPath := sendEnv(t, f)
	withAdminPlane(t, dbPath, v)

	out, errOut, code := runCmd(t, runAgent, dbPath, "agent", "budget", "hermes", "--set", "3000000", "--json")
	if code != 2 {
		t.Fatalf("code = %d, stderr = %s", code, errOut)
	}
	if len(v.calls) != 0 {
		t.Fatalf("refusal cost operator calls: %+v", v.calls)
	}
	var rec struct {
		Written bool `json:"written"`
		Door    struct {
			Unavailable string `json:"unavailable"`
		} `json:"door"`
	}
	if err := json.Unmarshal([]byte(out), &rec); err != nil || rec.Written ||
		!strings.Contains(rec.Door.Unavailable, `no door writes config for binding "hermes"`) {
		t.Errorf("record = %q (err %v)", out, err)
	}
}

func TestAgentReprovision_NeedsTheOperatorPlane(t *testing.T) {
	// extractor IS re-provisionable, but no credential is configured: exit 4
	// naming the exact fix, and "Nothing was written."
	f := newMailFake()
	f.dossier = writeDossier
	_, errOut, code := runCmd(t, runAgent, sendEnv(t, f), "agent", "budget", "extractor", "--set", "3000000")
	if code != 4 {
		t.Fatalf("code = %d", code)
	}
	for _, want := range []string{"holds no provision credential", "bullmoose admin init --url", "Nothing was written."} {
		if !strings.Contains(errOut, want) {
			t.Errorf("stderr missing %q: %s", want, errOut)
		}
	}
}

func TestAgentReprovision_DisabledDemandsYes(t *testing.T) {
	// The kill switch outranks a tuning knob: POST /extractor sets enabled=1,
	// so a disabled binding refuses at exit 5 BEFORE any operator call —
	// and --yes is the explicit acceptance of the re-enable side effect.
	v := newAdminFake(t)
	v.reply["GET /agent-bindings"] = `{"bindings":[{"id":"b_2","name":"extractor","config_json":` +
		strconv.Quote(extractorConfig) + `}]}`
	v.reply["POST /extractor"] = `{"ok":true}`
	f := newMailFake()
	f.dossier = showDossier // extractor DISABLED here
	dbPath := sendEnv(t, f)
	withAdminPlane(t, dbPath, v)

	_, errOut, code := runCmd(t, runAgent, dbPath, "agent", "budget", "extractor", "--set", "3000000")
	if code != 5 {
		t.Fatalf("code = %d, stderr = %s", code, errOut)
	}
	if !strings.Contains(errOut, "Re-run with --yes to accept the re-enable") {
		t.Errorf("stderr = %q", errOut)
	}
	if len(v.calls) != 0 {
		t.Fatalf("the gate must sit before any operator call: %+v", v.calls)
	}

	// --yes: the write proceeds, and the chrome owns up to the side effect.
	_, errOut2, code2 := runCmd(t, runAgent, dbPath, "agent", "budget", "extractor", "--set", "3000000", "--yes")
	if code2 != 0 {
		t.Fatalf("with --yes: code = %d, stderr = %s", code2, errOut2)
	}
	if !strings.Contains(errOut2, "was disabled and is now ENABLED again (the door's side effect)") {
		t.Errorf("stderr = %q", errOut2)
	}
}

func TestAgentReprovision_RMWPreservesTheRest(t *testing.T) {
	// The whole point of the read-modify-write: a budget change re-sends the
	// menu, arms, rate and maxTokens unchanged; a model change re-sends the
	// budget. Either direction, nothing the caller did not name moves.
	t.Run("budget --set keeps the menu", func(t *testing.T) {
		_, v, dbPath := reprovisionFakes(t)
		out, errOut, code := runCmd(t, runAgent, dbPath, "agent", "budget", "extractor", "--set", "3000000")
		if code != 0 {
			t.Fatalf("code = %d, stderr = %s", code, errOut)
		}
		if len(v.calls) != 2 || !strings.Contains(v.calls[0].Path, "/agent-bindings?email=you%40stub.test") ||
			v.calls[1].Path != "/extractor" {
			t.Fatalf("calls = %+v", v.calls)
		}
		var body extractorBody
		if err := json.Unmarshal([]byte(v.calls[1].Body), &body); err != nil {
			t.Fatal(err)
		}
		if body.Email != "you@stub.test" || body.Provider != "@local/ollama" || body.Model != "qwen3" ||
			body.BudgetMicros != 3000000 {
			t.Errorf("body = %+v", body)
		}
		if len(body.ExploreModels) != 1 || body.ExploreModels[0].Provider != "openrouter" ||
			body.ExploreModels[0].Model != "minimax/minimax-m3" {
			t.Errorf("the explore arm was dropped: %+v", body.ExploreModels)
		}
		if body.ExploreRate == nil || *body.ExploreRate != 0.1 || body.MaxTokens == nil || *body.MaxTokens != 512 {
			t.Errorf("rate/maxTokens dropped: %+v", body)
		}
		if !strings.Contains(out, "budget for extractor set to $3.00/month") {
			t.Errorf("stdout = %q", out)
		}
		if !strings.Contains(errOut, "the sanctioned re-provision-in-place path") {
			t.Errorf("stderr = %q", errOut)
		}
	})
	t.Run("model --set keeps the budget", func(t *testing.T) {
		_, v, dbPath := reprovisionFakes(t)
		out, _, code := runCmd(t, runAgent, dbPath, "agent", "model", "extractor", "--set", "openrouter/minimax/minimax-m3")
		if code != 0 {
			t.Fatal(code)
		}
		var body extractorBody
		_ = json.Unmarshal([]byte(v.calls[1].Body), &body)
		// First-slash split: the vendor-qualified id survives whole.
		if body.Provider != "openrouter" || body.Model != "minimax/minimax-m3" {
			t.Errorf("candidate split wrong: %+v", body)
		}
		if body.BudgetMicros != 2000000 {
			t.Errorf("the budget was not preserved: %d", body.BudgetMicros)
		}
		// Arms were NOT named, so the current tail is re-sent.
		if len(body.ExploreModels) != 1 || body.ExploreModels[0].Provider != "openrouter" {
			t.Errorf("arms = %+v", body.ExploreModels)
		}
		if !strings.Contains(out, "model for extractor: openrouter/minimax/minimax-m3") {
			t.Errorf("stdout = %q", out)
		}
	})
}

func TestAgentReprovision_NothingToPreserveRefuses(t *testing.T) {
	// A re-provision that names no primary (or no budget) would take the
	// server's PAID default — a spend decision this command will not make.
	for _, tc := range []struct {
		name, config, argvVerb, argvFlagVal, want string
	}{
		{"no primary", `{"budgets":{"spendPerMonth":2000000}}`, "budget", "3000000",
			"no primary model candidate to preserve"},
		{"no budget", `{"defaultModel":"fast","modelAliases":{"fast":[{"provider":"p","model":"m"}]}}`,
			"model", "p/m2", "no monthly budget to preserve"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			v := newAdminFake(t)
			v.reply["GET /agent-bindings"] = `{"bindings":[{"id":"b_2","name":"extractor","config_json":` +
				strconv.Quote(tc.config) + `}]}`
			f := newMailFake()
			f.dossier = writeDossier
			dbPath := sendEnv(t, f)
			withAdminPlane(t, dbPath, v)
			_, errOut, code := runCmd(t, runAgent, dbPath, "agent", tc.argvVerb, "extractor", "--set", tc.argvFlagVal)
			if code != 2 {
				t.Fatalf("code = %d, stderr = %s", code, errOut)
			}
			if !strings.Contains(errOut, tc.want) || !strings.Contains(errOut, "Nothing was written.") {
				t.Errorf("stderr = %q", errOut)
			}
			for _, c := range v.calls {
				if c.Path == "/extractor" {
					t.Fatal("the refusal must precede the POST")
				}
			}
		})
	}
}

func TestAgentReprovision_DryRunPrintsTheRequest(t *testing.T) {
	// The record IS the request body — what would be sent, verbatim, on
	// stdout — and no POST happens.
	_, v, dbPath := reprovisionFakes(t)
	out, errOut, code := runCmd(t, runAgent, dbPath, "agent", "budget", "extractor", "--set", "3000000", "--dry-run")
	if code != 0 {
		t.Fatal(code)
	}
	for _, c := range v.calls {
		if c.Path == "/extractor" {
			t.Fatal("dry run must not POST")
		}
	}
	if !strings.Contains(errOut, "nothing was written") {
		t.Errorf("stderr = %q", errOut)
	}
	var body extractorBody
	if err := json.Unmarshal([]byte(strings.TrimSpace(out)), &body); err != nil || body.BudgetMicros != 3000000 {
		t.Errorf("stdout must be the request body: %q (err %v)", out, err)
	}
}

// ── the pure parsers ────────────────────────────────────────────────────────

func TestParseCandidate(t *testing.T) {
	c, err := parseCandidate("openrouter/minimax/minimax-m3", "--set")
	if err != nil || c.Provider != "openrouter" || c.Model != "minimax/minimax-m3" {
		t.Errorf("first-slash split failed: %+v (%v)", c, err)
	}
	for _, bad := range []string{"nohost", "/model", "host/", ""} {
		if _, err := parseCandidate(bad, "--set"); err == nil {
			t.Errorf("%q must refuse", bad)
		}
	}
}

func TestParseMicros(t *testing.T) {
	if n, err := parseMicros(" 2000000 ", "--set"); err != nil || n != 2000000 {
		t.Errorf("got %d, %v", n, err)
	}
	// Dollars are a display format; the wire is µUSD, and guessing which one
	// "2.00" meant would be a two-orders-of-magnitude spend bug.
	for _, bad := range []string{"2.00", "$2", "-5", ""} {
		if _, err := parseMicros(bad, "--set"); err == nil {
			t.Errorf("%q must refuse", bad)
		}
	}
}

func TestParseSince(t *testing.T) {
	now := int64(1755820800000) // 2025-08-22T00:00:00Z
	start, days, err := parseSince("30d", now)
	if err != nil || days != 30 || start != now-30*dayMs {
		t.Errorf("30d: %d %f %v", start, days, err)
	}
	start, days, err = parseSince("2025-06-01", now)
	if err != nil || start != 1748736000000 || days != 82 {
		t.Errorf("date: %d %f %v", start, days, err)
	}
	if _, _, err := parseSince("2025-06-01T12:30:00Z", now); err != nil {
		t.Errorf("ISO datetime refused: %v", err)
	}
	if _, _, err := parseSince("junk", now); err == nil {
		t.Error("garbage must refuse")
	}
	// A window that starts in the future bounds nothing.
	if _, _, err := parseSince("2026-01-01", now); err == nil {
		t.Error("future must refuse")
	}
	var cli *bmio.CliError
	if _, _, err := parseSince("junk", now); err != nil {
		if ok := errors.As(err, &cli); !ok || cli.Code != bmio.ExitUsage {
			t.Errorf("refusals are usage errors: %v", err)
		}
	}
}

// ── backfill ────────────────────────────────────────────────────────────────

const fixedNow = int64(1755820800000) // 2025-08-22T00:00:00Z

func agentAt(now int64) func(*bmio.Streams, []string) int {
	return func(s *bmio.Streams, argv []string) int { return runAgentWith(s, argv, func() int64 { return now }) }
}

func TestAgentBackfill_SinceIsRequired(t *testing.T) {
	// The route assumes 90 days when nobody names a window; this CLI refuses
	// to inherit that choice — before any request at all.
	f := newMailFake()
	_, errOut, code := runCmd(t, runAgent, dossierEnv(t, f), "agent", "backfill", "hermes")
	if code != 2 {
		t.Fatalf("code = %d", code)
	}
	if !strings.Contains(errOut, "--since is required") ||
		!strings.Contains(errOut, "not a default this CLI will pick for you") {
		t.Errorf("stderr = %q", errOut)
	}
	if len(f.rest) != 0 {
		t.Error("the refusal must cost zero requests")
	}
}

func TestAgentBackfill_Choreography(t *testing.T) {
	v := newAdminFake(t)
	v.reply["POST /agent-bindings/b_1/backfill"] = `{"minted":42,"skipped":3,` +
		`"windowStartMs":1748736000000,"windowEndMs":1755820800000,` +
		`"floorMs":1740000000000,"floorSource":"historyFloor","floorClamped":true,"capped":true,` +
		`"note":"minted rows are ordinary pending invocations"}`
	f := newMailFake()
	dbPath := dossierEnv(t, f)
	withAdminPlane(t, dbPath, v)

	out, errOut, code := runCmd(t, agentAt(fixedNow), dbPath,
		"agent", "backfill", "hermes", "--since", "2025-06-01", "--budget", "500000")
	if code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, errOut)
	}
	if len(v.calls) != 1 || v.calls[0].Path != "/agent-bindings/b_1/backfill" {
		t.Fatalf("calls = %+v", v.calls)
	}
	var body struct {
		SinceDays    float64 `json:"sinceDays"`
		BudgetMicros int64   `json:"budgetMicros"`
	}
	_ = json.Unmarshal([]byte(v.calls[0].Body), &body)
	if body.SinceDays != 82 || body.BudgetMicros != 500000 {
		t.Errorf("body = %+v", body)
	}
	for _, want := range []string{
		"backfill hermes: minted 42 invocation(s), skipped 3 already covered",
		"2025-06-01 00:00 → 2025-08-22 00:00 UTC",
		"floor       2025-02-19 21:20 (historyFloor) — window CLAMPED to it",
		"envelope    $0.50",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("stdout missing %q\n%s", want, out)
		}
	}
	if !strings.Contains(errOut, "the mint cap was reached") ||
		!strings.Contains(errOut, "minted rows are ordinary pending invocations") {
		t.Errorf("stderr = %q", errOut)
	}
}

func TestAgentBackfill_NoBudgetIsSaidOutLoud(t *testing.T) {
	v := newAdminFake(t)
	v.reply["POST /agent-bindings/b_1/backfill"] = `{"minted":1,"skipped":0,"note":"ok"}`
	f := newMailFake()
	dbPath := dossierEnv(t, f)
	withAdminPlane(t, dbPath, v)
	out, errOut, code := runCmd(t, agentAt(fixedNow), dbPath, "agent", "backfill", "hermes", "--since", "30d")
	if code != 0 {
		t.Fatal(code)
	}
	if !strings.Contains(errOut, "no --budget: minted rows carry no envelope") {
		t.Errorf("stderr = %q", errOut)
	}
	if !strings.Contains(out, "envelope    none (draws on the monthly budget)") {
		t.Errorf("stdout = %q", out)
	}
	if strings.Contains(v.calls[0].Body, "budgetMicros") {
		t.Errorf("no --budget must mean no budgetMicros key: %s", v.calls[0].Body)
	}
}

func TestAgentBackfill_409SplitsApprovalFromFailure(t *testing.T) {
	// A 409 carrying requestedStartMs is an APPROVAL question and earns the
	// --request-floor hint; a 409 without one (kill switch) does not.
	for _, tc := range []struct {
		name     string
		body     string
		wantHint bool
	}{
		{"behind the floor → hint", `{"error":"window reaches past the floor","requestedStartMs":1748736000000}`, true},
		{"disabled binding → no hint", `{"error":"binding is disabled"}`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			v := newAdminFake(t)
			v.statusFor["POST /agent-bindings/b_1/backfill"] = 409
			v.reply["POST /agent-bindings/b_1/backfill"] = tc.body
			f := newMailFake()
			dbPath := dossierEnv(t, f)
			withAdminPlane(t, dbPath, v)
			_, errOut, code := runCmd(t, agentAt(fixedNow), dbPath,
				"agent", "backfill", "hermes", "--since", "2025-06-01")
			if code != 5 {
				t.Fatalf("code = %d, stderr = %s", code, errOut)
			}
			if !strings.Contains(errOut, "Nothing was queued.") {
				t.Errorf("stderr = %q", errOut)
			}
			hinted := strings.Contains(errOut, "--request-floor")
			if hinted != tc.wantHint {
				t.Errorf("hint = %v, want %v: %q", hinted, tc.wantHint, errOut)
			}
		})
	}
}

func TestAgentBackfill_RequestFloorIsTheApproval(t *testing.T) {
	// It mints a tier-1 proposal and queues NO work — opt-in only.
	v := newAdminFake(t)
	v.reply["POST /agent-bindings/b_1/floor-request"] = `{"proposalId":"p_9","minted":true}`
	f := newMailFake()
	dbPath := dossierEnv(t, f)
	withAdminPlane(t, dbPath, v)

	out, errOut, code := runCmd(t, agentAt(fixedNow), dbPath,
		"agent", "backfill", "hermes", "--since", "2025-06-01", "--request-floor")
	if code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, errOut)
	}
	if len(v.calls) != 1 || v.calls[0].Path != "/agent-bindings/b_1/floor-request" {
		t.Fatalf("calls = %+v", v.calls)
	}
	if !strings.Contains(v.calls[0].Body, `"toEpochMs":1748736000000`) {
		t.Errorf("body = %s", v.calls[0].Body)
	}
	if !strings.Contains(out, "floor-request p_9 — pending a human") {
		t.Errorf("stdout = %q", out)
	}
	if !strings.Contains(errOut, "no backfill ran: this is the approval") {
		t.Errorf("stderr = %q", errOut)
	}
}

func TestAgentBackfill_NoAdminRefusesWithTheFix(t *testing.T) {
	f := newMailFake()
	_, errOut, code := runCmd(t, agentAt(fixedNow), dossierEnv(t, f),
		"agent", "backfill", "hermes", "--since", "30d")
	if code != 4 {
		t.Fatalf("code = %d", code)
	}
	if !strings.Contains(errOut, "Nothing was queued.") || !strings.Contains(errOut, "bullmoose admin init --url") {
		t.Errorf("stderr = %q", errOut)
	}
}
