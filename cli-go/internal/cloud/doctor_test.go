package cloud

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The doctor diagnoses and names the treatment; it never treats. A healthy
// zone answers all-OK; each gap reports its state AND the fixing command
// (`admin domain add` — the stack's own wiring, not more installer).

type doctorZone struct {
	routingEnabled  bool
	catchAllTargets []string // worker names; empty = drop action
	mx, dkim        int
	dmarc           bool
}

func doctorFake(t *testing.T, z doctorZone) *CF {
	t.Helper()
	env := func(result any) []byte {
		b, _ := json.Marshal(map[string]any{"success": true, "errors": []any{}, "result": result})
		return b
	}
	records := []map[string]string{}
	for i := 0; i < z.mx; i++ {
		records = append(records, map[string]string{"type": "MX", "name": "tea.example", "content": "route1.mx.cloudflare.net"})
	}
	for i := 0; i < z.dkim; i++ {
		records = append(records, map[string]string{"type": "CNAME", "name": "tok._domainkey.tea.example", "content": "tok.dkim.amazonses.com"})
	}
	if z.dmarc {
		records = append(records, map[string]string{"type": "TXT", "name": "_dmarc.tea.example", "content": "v=DMARC1; p=none"})
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("the doctor mutated: %s %s", r.Method, r.URL.Path)
			return
		}
		switch {
		case r.URL.Path == "/zones":
			w.Write(env([]map[string]any{{"id": "z1", "name": "tea.example"}}))
		case strings.HasSuffix(r.URL.Path, "/email/routing"):
			w.Write(env(map[string]any{"enabled": z.routingEnabled, "status": "ready"}))
		case strings.HasSuffix(r.URL.Path, "/rules/catch_all"):
			action := map[string]any{"type": "drop", "value": []string{}}
			if len(z.catchAllTargets) > 0 {
				action = map[string]any{"type": "worker", "value": z.catchAllTargets}
			}
			w.Write(env(map[string]any{"enabled": len(z.catchAllTargets) > 0, "actions": []any{action}}))
		case strings.HasSuffix(r.URL.Path, "/dns_records"):
			w.Write(env(records))
		default:
			t.Errorf("unexpected: %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return NewCF(srv.URL, "t", nil)
}

func TestMailDoctor_HealthyZone(t *testing.T) {
	report, err := MailDoctor(doctorFake(t, doctorZone{
		routingEnabled: true, catchAllTargets: []string{"bullmoose-ingest"}, mx: 3, dkim: 3, dmarc: true,
	}), "tea.example")
	if err != nil {
		t.Fatal(err)
	}
	if !report.AllOK() {
		t.Errorf("healthy zone reported gaps: %+v", report.Checks)
	}
	for _, c := range report.Checks {
		if c.Fix != "" {
			t.Errorf("an OK check must carry no fix: %+v", c)
		}
	}
}

func TestMailDoctor_UnwiredZoneNamesTheFixPerGap(t *testing.T) {
	report, err := MailDoctor(doctorFake(t, doctorZone{}), "tea.example")
	if err != nil {
		t.Fatal(err)
	}
	if report.AllOK() {
		t.Fatal("an unwired zone reported healthy")
	}
	for _, c := range report.Checks {
		if c.OK {
			t.Errorf("nothing is wired, yet %s reports OK (%s)", c.Name, c.State)
		}
		if !strings.Contains(c.Fix, "admin domain add tea.example") {
			t.Errorf("%s: the fix must name the command: %q", c.Name, c.Fix)
		}
	}
}

func TestMailDoctor_CatchAllToSomewhereElseIsAGap(t *testing.T) {
	// Routed, but not to ingest: mail arrives at Cloudflare and goes to a
	// forwarding address instead of the stack — the honest state line must
	// show WHERE it goes.
	report, err := MailDoctor(doctorFake(t, doctorZone{
		routingEnabled: true, catchAllTargets: []string{"someone-elses-worker"}, mx: 3, dkim: 3, dmarc: true,
	}), "tea.example")
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range report.Checks {
		if c.Name == "catch-all→ingest" {
			if c.OK {
				t.Fatal("catch-all to a different worker must not pass")
			}
			if !strings.Contains(c.State, "someone-elses-worker") {
				t.Errorf("the state must show where mail actually goes: %s", c.State)
			}
		}
	}
}
