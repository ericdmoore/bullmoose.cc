package cmd

// The invoke third of `agent` (s43 step 1). The s42 bar: the JMAP choreography
// and refusal costs are exact; rendering is asserted through parse-back and
// documented properties, not Node's bytes.

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestAgentInvoke_Choreography(t *testing.T) {
	f := newMailFake()
	out, errOut, code := runCmd(t, runAgent, sendEnv(t, f),
		"agent", "invoke", "hermes-responder", "--email", "em_7", "--note", "look at this one")
	if code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, errOut)
	}
	if names := f.names(); len(names) != 1 || names[0] != "AgentInvocation/set" {
		t.Fatalf("calls = %v, want exactly one AgentInvocation/set", names)
	}
	var set struct {
		AccountID string `json:"accountId"`
		Create    map[string]struct {
			BindingName string `json:"bindingName"`
			EmailID     string `json:"emailId"`
			Note        string `json:"note"`
		} `json:"create"`
	}
	if err := json.Unmarshal([]byte(f.argsOf("AgentInvocation/set")), &set); err != nil {
		t.Fatal(err)
	}
	c := set.Create["c"]
	if set.AccountID != "a_you" || c.BindingName != "hermes-responder" || c.EmailID != "em_7" || c.Note != "look at this one" {
		t.Errorf("create = %+v on %s", c, set.AccountID)
	}
	// The record carries the queue position; the chrome carries who drains it.
	if !strings.Contains(out, "queued inv_new_1 on hermes-responder for em_7 (status: pending)") {
		t.Errorf("stdout = %q", out)
	}
	if !strings.Contains(errOut, "a runtime claims it over the changelog") {
		t.Errorf("stderr = %q", errOut)
	}
}

func TestAgentInvoke_NoteStaysOffTheWireWhenAbsent(t *testing.T) {
	// Node sends `note` only when --note was given. An empty-string note is a
	// DIFFERENT request than no note — the server stores what it is sent.
	f := newMailFake()
	_, errOut, code := runCmd(t, runAgent, sendEnv(t, f),
		"agent", "invoke", "hermes-responder", "--email", "em_7")
	if code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, errOut)
	}
	var set struct {
		Create map[string]map[string]json.RawMessage `json:"create"`
	}
	if err := json.Unmarshal([]byte(f.argsOf("AgentInvocation/set")), &set); err != nil {
		t.Fatal(err)
	}
	if _, present := set.Create["c"]["note"]; present {
		t.Error("no --note must mean no note key, not an empty one")
	}
}

func TestAgentInvoke_JSONParsesBack(t *testing.T) {
	f := newMailFake()
	out, errOut, code := runCmd(t, runAgent, sendEnv(t, f),
		"agent", "invoke", "hermes-responder", "--email", "em_7", "--json")
	if code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, errOut)
	}
	var v struct {
		ID      string  `json:"id"`
		Binding string  `json:"binding"`
		EmailID string  `json:"emailId"`
		Status  string  `json:"status"`
		State   *string `json:"state"`
	}
	if err := json.Unmarshal([]byte(out), &v); err != nil {
		t.Fatalf("stdout is not JSON: %v\n%s", err, out)
	}
	if v.ID != "inv_new_1" || v.Binding != "hermes-responder" || v.EmailID != "em_7" ||
		v.Status != "pending" || v.State == nil || *v.State != "agstate-2" {
		t.Errorf("parsed back %+v", v)
	}
}

func TestAgentInvoke_RefusalsCostZero(t *testing.T) {
	// Every bad invocation refuses BEFORE any request — including the unknown
	// verb, which must answer with the whole family map, not an echo.
	for _, tc := range []struct {
		name string
		argv []string
		want string
	}{
		{"no verb", []string{"agent"}, "usage: bullmoose agent serve"},
		{"unknown verb", []string{"agent", "summon"}, "usage: bullmoose agent serve"},
		{"invoke without binding", []string{"agent", "invoke"}, "usage: bullmoose agent invoke <binding>"},
		{"invoke without --email", []string{"agent", "invoke", "b1"}, "usage: agent invoke requires --email"},
		{"rm without id", []string{"agent", "rm"}, "usage: bullmoose agent rm <invId>"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newMailFake()
			_, errOut, code := runCmd(t, runAgent, sendEnv(t, f), tc.argv[0], tc.argv[1:]...)
			if code != 2 {
				t.Fatalf("code = %d, want 2", code)
			}
			if !strings.Contains(errOut, tc.want) {
				t.Errorf("stderr = %q, want %q", errOut, tc.want)
			}
			if n := f.names(); len(n) != 0 {
				t.Errorf("a refusal must cost zero requests, cost %v", n)
			}
		})
	}
}

func TestAgentInvoke_DryRunCostsZero(t *testing.T) {
	// The preview names what it is NOT doing, in the write's own terms.
	t.Run("invoke", func(t *testing.T) {
		f := newMailFake()
		out, errOut, code := runCmd(t, runAgent, sendEnv(t, f),
			"agent", "invoke", "b1", "--email", "em_7", "--dry-run", "--json")
		if code != 0 {
			t.Fatalf("code = %d, stderr = %s", code, errOut)
		}
		if n := f.names(); len(n) != 0 {
			t.Fatalf("dry run cost %v", n)
		}
		if !strings.Contains(errOut, "dry run: would invoke b1 on em_7; nothing was queued") {
			t.Errorf("stderr = %q", errOut)
		}
		var v struct {
			DryRun  bool   `json:"dryRun"`
			Binding string `json:"binding"`
			EmailID string `json:"emailId"`
		}
		if err := json.Unmarshal([]byte(out), &v); err != nil || !v.DryRun || v.Binding != "b1" || v.EmailID != "em_7" {
			t.Errorf("json = %q (err %v)", out, err)
		}
	})
	t.Run("rm", func(t *testing.T) {
		f := newMailFake()
		_, errOut, code := runCmd(t, runAgent, sendEnv(t, f),
			"agent", "rm", "inv_1", "--dry-run")
		if code != 0 {
			t.Fatalf("code = %d, stderr = %s", code, errOut)
		}
		if n := f.names(); len(n) != 0 {
			t.Fatalf("dry run cost %v", n)
		}
		if !strings.Contains(errOut, "dry run: would remove invocation inv_1; nothing was written") {
			t.Errorf("stderr = %q", errOut)
		}
	})
}

func TestAgentInvoke_RefusalTypesKeepTheirExitCodes(t *testing.T) {
	// The kill switch's CLI face: a disabled binding refuses the create
	// server-side, and each SetError type arrives as ITS code — the server's
	// judgement, never a generic 1.
	for _, tc := range []struct {
		name     string
		refusal  string
		wantCode int
		wantMsg  string
	}{
		{"disabled binding is forbidden → 4",
			`{"type":"forbidden","description":"binding is disabled"}`, 4,
			"invoke hermes failed: forbidden — binding is disabled"},
		{"unknown binding is notFound → 3",
			`{"type":"notFound"}`, 3, "invoke hermes failed: notFound"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newMailFake()
			f.refuseInvocation = tc.refusal
			_, errOut, code := runCmd(t, runAgent, sendEnv(t, f),
				"agent", "invoke", "hermes", "--email", "em_7")
			if code != tc.wantCode {
				t.Fatalf("code = %d, want %d (stderr %q)", code, tc.wantCode, errOut)
			}
			if !strings.Contains(errOut, tc.wantMsg) {
				t.Errorf("stderr = %q, want %q", errOut, tc.wantMsg)
			}
		})
	}
}

func TestAgentInvocations_ListChoreography(t *testing.T) {
	f := newMailFake()
	f.invocationIDs = `["inv_1","inv_2"]`
	f.invocationList = `[` +
		`{"id":"inv_1","status":"pending","bindingName":"hermes","emailId":"em_1","createdAt":"2026-08-21T10:00:00Z"},` +
		`{"id":"inv_2","status":"failed","bindingName":"allen","emailId":null,"createdAt":"2026-08-20T09:00:00Z","alert":{"kind":"unclaimable"}}]`
	out, errOut, code := runCmd(t, runAgent, sendEnv(t, f), "agent", "invocations")
	if code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, errOut)
	}
	if names := f.names(); strings.Join(names, ",") != "AgentInvocation/query,AgentInvocation/get" {
		t.Fatalf("calls = %v", names)
	}
	var q struct {
		Status string `json:"status"`
	}
	_ = json.Unmarshal([]byte(f.argsOf("AgentInvocation/query")), &q)
	if q.Status != "pending" {
		t.Errorf("default status = %q, want pending", q.Status)
	}
	var g struct {
		IDs []string `json:"ids"`
	}
	_ = json.Unmarshal([]byte(f.argsOf("AgentInvocation/get")), &g)
	if strings.Join(g.IDs, ",") != "inv_1,inv_2" {
		t.Errorf("get ids = %v — the get must fetch exactly what the query returned", g.IDs)
	}
	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
	if len(lines) != 2 {
		t.Fatalf("want 2 record lines, got %q", out)
	}
	// A null emailId prints as "-", and the alert marker rides its row —
	// the one place a human meets a stuck invocation.
	if !strings.Contains(lines[1], "allen") || !strings.Contains(lines[1], "  -  ") {
		t.Errorf("null emailId must render as -: %q", lines[1])
	}
	if !strings.Contains(lines[1], "[alert: unclaimable]") {
		t.Errorf("alert marker missing: %q", lines[1])
	}
	if strings.Contains(lines[0], "[alert") {
		t.Errorf("no alert on inv_1, none rendered: %q", lines[0])
	}
}

func TestAgentInvocations_StatusIsAPositional(t *testing.T) {
	f := newMailFake()
	_, errOut, code := runCmd(t, runAgent, sendEnv(t, f), "agent", "invocations", "done")
	if code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, errOut)
	}
	var q struct {
		Status string `json:"status"`
	}
	_ = json.Unmarshal([]byte(f.argsOf("AgentInvocation/query")), &q)
	if q.Status != "done" {
		t.Errorf("status = %q, want done", q.Status)
	}
	// Empty answer: the status word rides the notice, and no get is made.
	if !strings.Contains(errOut, "(no done invocations)") {
		t.Errorf("stderr = %q", errOut)
	}
	if names := f.names(); strings.Join(names, ",") != "AgentInvocation/query" {
		t.Errorf("an empty queue must not be fetched: %v", names)
	}
}

func TestAgentInvocations_IDsSkipTheGet(t *testing.T) {
	// An id listing that fetched the objects would pay for data it throws away.
	f := newMailFake()
	f.invocationIDs = `["inv_1","inv_2"]`
	out, errOut, code := runCmd(t, runAgent, sendEnv(t, f), "agent", "invocations", "--ids")
	if code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, errOut)
	}
	if names := f.names(); strings.Join(names, ",") != "AgentInvocation/query" {
		t.Fatalf("--ids must answer from the query alone, got %v", names)
	}
	if out != "inv_1\ninv_2\n" {
		t.Errorf("stdout = %q", out)
	}
}

func TestAgentInvocations_NDJSONIsTheServersRows(t *testing.T) {
	// Verbatim re-emission: a field this CLI predates (the facet, a new alert
	// shape) survives to the consumer instead of being narrowed by a struct.
	f := newMailFake()
	f.invocationIDs = `["inv_1"]`
	f.invocationList = `[{"id":"inv_1","status":"pending","bindingName":"hermes","requires":{"vision":true},"zebra":1}]`
	out, errOut, code := runCmd(t, runAgent, sendEnv(t, f), "agent", "invocations", "--json")
	if code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, errOut)
	}
	var row map[string]any
	if err := json.Unmarshal([]byte(strings.TrimRight(out, "\n")), &row); err != nil {
		t.Fatalf("not NDJSON: %v\n%s", err, out)
	}
	if row["zebra"] != float64(1) {
		t.Errorf("unknown field dropped: %v", row)
	}
	if req, ok := row["requires"].(map[string]any); !ok || req["vision"] != true {
		t.Errorf("facet dropped: %v", row)
	}
}

func TestAgentRm_Choreography(t *testing.T) {
	f := newMailFake()
	out, errOut, code := runCmd(t, runAgent, sendEnv(t, f), "agent", "rm", "inv_9")
	if code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, errOut)
	}
	var set struct {
		AccountID string   `json:"accountId"`
		Destroy   []string `json:"destroy"`
	}
	_ = json.Unmarshal([]byte(f.argsOf("AgentInvocation/set")), &set)
	if set.AccountID != "a_you" || strings.Join(set.Destroy, ",") != "inv_9" {
		t.Errorf("destroy = %+v", set)
	}
	if !strings.Contains(out, "removed inv_9") {
		t.Errorf("stdout = %q", out)
	}
}

func TestAgentRm_RunningInvocationRefusal(t *testing.T) {
	// A running invocation is refused server-side (forbidden); the CLI's job
	// is to relay that judgement as exit 4, not to soften or retry it.
	f := newMailFake()
	f.refuseInvocation = `{"type":"forbidden","description":"invocation is running"}`
	_, errOut, code := runCmd(t, runAgent, sendEnv(t, f), "agent", "rm", "inv_9")
	if code != 4 {
		t.Fatalf("code = %d, want 4 (stderr %q)", code, errOut)
	}
	if !strings.Contains(errOut, "rm inv_9 failed: forbidden — invocation is running") {
		t.Errorf("stderr = %q", errOut)
	}
}
