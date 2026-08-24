package cmd

// #343 — the rollup's whole risk is arithmetic that lies: a cost that was
// never recorded averaged as free, a mean drawn from three runs presented
// like a mean drawn from three hundred, or a ranking implied where s45
// deliberately refused one.

import (
	"encoding/json"
	"strings"
	"testing"

	bmio "github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
)

func inv(provider, model, status string, cost any, claimed, done any) any {
	m := map[string]any{"provider": provider, "model": model, "status": status, "costMicros": cost}
	if claimed != nil {
		m["claimedAt"] = claimed
	}
	if done != nil {
		m["doneAt"] = done
	}
	b, _ := json.Marshal(m)
	return json.RawMessage(b)
}

func TestRollup_AggregatesPerModelBusiestFirst(t *testing.T) {
	stats := rollupInvocations([]any{
		inv("workers-ai", "@cf/a", "done", 1000, 1000, 3000),
		inv("workers-ai", "@cf/a", "done", 3000, 1000, 5000),
		inv("openrouter", "x/y", "done", 500, 1000, 2000),
	})
	if len(stats) != 2 || stats[0].Key != "workers-ai/@cf/a" || stats[0].Runs != 2 {
		t.Fatalf("stats = %+v", stats)
	}
	if got := *stats[0].meanCost(); got != 2000 {
		t.Errorf("mean cost = %d, want 2000", got)
	}
	if got := stats[0].meanLatency(); got != "3.0s" {
		t.Errorf("mean latency = %s, want 3.0s", got)
	}
}

func TestRollup_UnrecordedCostIsNotZero(t *testing.T) {
	// The money-honesty rule the per-row receipt already keeps, kept across
	// an average: a NULL cost must not drag the mean toward free.
	stats := rollupInvocations([]any{
		inv("p", "m", "done", nil, 1000, 2000),
		inv("p", "m", "done", 4000, 1000, 2000),
	})
	if got := *stats[0].meanCost(); got != 4000 {
		t.Errorf("mean = %d — the unrecorded row was averaged in as 0", got)
	}
	all := rollupInvocations([]any{inv("p", "m", "done", nil, nil, nil)})
	if all[0].meanCost() != nil {
		t.Error("nothing was costed, so there is no mean — 'not recorded' is the answer")
	}
	if all[0].meanLatency() != "—" {
		t.Error("nothing was timed, so there is no latency")
	}
}

func TestRollup_PartialCostSaysSo(t *testing.T) {
	var out, errOut strings.Builder
	renderModelRollup(bmio.NewTo(&out, &errOut), []any{
		inv("p", "m", "done", 1000, 1000, 2000),
		inv("p", "m", "failed", nil, nil, nil),
	})
	got := out.String() + errOut.String()
	// A mean over SOME rows must name how many, or it reads as the average
	// of all of them.
	if !strings.Contains(got, "(1)") {
		t.Errorf("a partial mean must say how many rows it covers:\n%s", got)
	}
	if !strings.Contains(got, "2") { // runs column
		t.Errorf("the run count is the reader's confidence signal:\n%s", got)
	}
}

func TestRollup_EmptyRendersNothing(t *testing.T) {
	var out, errOut strings.Builder
	renderModelRollup(bmio.NewTo(&out, &errOut), nil)
	if out.String()+errOut.String() != "" {
		t.Errorf("no invocations should render no table, got %q", out.String()+errOut.String())
	}
}
