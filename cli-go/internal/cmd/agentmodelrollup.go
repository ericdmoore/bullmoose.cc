package cmd

// The per-(model, pipeline) rollup on `agents model` — s45's open nicety
// (#343). The raw columns landed with the measured receipt (#328); nothing
// aggregated them, so a human comparing two models had to read a list of
// individual invocations and hold the arithmetic in their head.
//
// What it does NOT do is rank. s45's own concession governs here — "param
// count is a poor excuse for quality" — and so does the money rule: a cost
// that was never recorded is NOT zero. So the table reports what was
// measured, says how many rows it is measuring, and lets the reader judge.
// A mean over three invocations and a mean over three hundred deserve
// different confidence, so the count is a column rather than a footnote.

import (
	"encoding/json"
	"fmt"
	"sort"

	bmio "github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/jsobj"
)

type modelStat struct {
	Key       string // "provider/model"
	Runs      int
	Costed    int   // runs whose cost was actually recorded
	CostTotal int64 // micros, over Costed only
	Timed     int   // runs with both claimedAt and doneAt
	MsTotal   float64
	Failed    int
}

/** meanCost is nil when nothing was costed — "not recorded" is a fact, and
 *  averaging it into 0 would be the money-honesty failure the receipt line
 *  already refuses one row at a time. */
func (m modelStat) meanCost() *int64 {
	if m.Costed == 0 {
		return nil
	}
	v := m.CostTotal / int64(m.Costed)
	return &v
}

func (m modelStat) meanLatency() string {
	if m.Timed == 0 {
		return "—"
	}
	return fmt.Sprintf("%.1fs", m.MsTotal/float64(m.Timed)/1000)
}

// rollupInvocations aggregates the SAME rows the recent list prints.
func rollupInvocations(raws []any) []modelStat {
	by := map[string]*modelStat{}
	for _, raw := range raws {
		o, err := jsobj.Parse(raw.(json.RawMessage))
		if err != nil {
			continue
		}
		key := o.JSStringOr("provider", "—") + "/" + o.JSStringOr("model", "—")
		st, ok := by[key]
		if !ok {
			st = &modelStat{Key: key}
			by[key] = st
		}
		st.Runs++
		if o.JSString("status") == "failed" {
			st.Failed++
		}
		// Raw, not Num — jsobj.Num mirrors JS (Number(null) is 0), and a NULL
		// cost counted as a zero would drag every mean toward free.
		if r, ok := o.Raw("costMicros"); ok && string(r) != "null" {
			if c, ok := o.Num("costMicros"); ok {
				st.Costed++
				st.CostTotal += int64(c)
			}
		}
		if cl, ok := o.Num("claimedAt"); ok {
			if dn, ok2 := o.Num("doneAt"); ok2 && dn >= cl {
				st.Timed++
				st.MsTotal += dn - cl
			}
		}
	}
	out := make([]modelStat, 0, len(by))
	for _, st := range by {
		out = append(out, *st)
	}
	// Busiest first — the row a reader most wants is the one with the most
	// evidence behind it. Ties by name so the table is stable between runs.
	sort.Slice(out, func(i, j int) bool {
		if out[i].Runs != out[j].Runs {
			return out[i].Runs > out[j].Runs
		}
		return out[i].Key < out[j].Key
	})
	return out
}

func renderModelRollup(s *bmio.Streams, raws []any) {
	stats := rollupInvocations(raws)
	if len(stats) == 0 {
		return
	}
	fieldLine(s, "measured", fmt.Sprintf("%d model(s) over %d invocation(s)", len(stats), len(raws)))
	s.Out("  " + padEnd("provider/model", 36) + "  " + padStart("runs", 5) + "  " +
		padStart("mean cost", 12) + "  " + padStart("mean run", 9) + "  " + padStart("failed", 7))
	for _, st := range stats {
		cost := "not recorded"
		if mean := st.meanCost(); mean != nil {
			cost = usd(mean)
			// A mean drawn from SOME of the runs must say so, or it reads as
			// the average of all of them.
			if st.Costed < st.Runs {
				cost += fmt.Sprintf(" (%d)", st.Costed)
			}
		}
		s.Out("  " + padEnd(st.Key, 36) + "  " + padStart(fmt.Sprint(st.Runs), 5) + "  " +
			padStart(cost, 12) + "  " + padStart(st.meanLatency(), 9) + "  " +
			padStart(fmt.Sprint(st.Failed), 7))
	}
}
