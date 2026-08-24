package cloud

// The mail-path doctor — T4's verification surface, read-only. The mail
// path itself is deliberately NOT the installer's to build: provision's
// addDomain (driven by `admin domain add`) enables Email Routing, points
// the catch-all at ingest, and writes the SES DKIM/MAIL FROM/DMARC records,
// each with its own receipt — building it again in Go would be a second
// copy to drift. What the installer OWES the operator is an honest answer
// to "did the mail path land?", from outside the stack, with the fixing
// command named per gap. That is this file.

import (
	"fmt"
	"strings"
)

// MailCheck is one verdict. Fix names the COMMAND that closes the gap —
// the doctor diagnoses, it never treats.
type MailCheck struct {
	Name  string `json:"name"`
	OK    bool   `json:"ok"`
	State string `json:"state"`
	Fix   string `json:"fix,omitempty"`
}

// MailReport is the whole walk.
type MailReport struct {
	Zone   string      `json:"zone"`
	Checks []MailCheck `json:"checks"`
}

func (r *MailReport) AllOK() bool {
	for _, c := range r.Checks {
		if !c.OK {
			return false
		}
	}
	return true
}

// fixLine is the one treatment nearly every gap shares: the stack's own
// domain wiring, run through the admin plane.
func fixLine(zone string) string {
	return "bullmoose admin domain add " + zone + " --tenant <tenantId> (after `admin init`)"
}

// MailDoctor walks the inbound and sender-auth records for zone. Read-only:
// every call is a GET, and a token that cannot read a surface fails that
// CHECK (state names the scope) rather than the walk.
func MailDoctor(c *CF, zone string) (*MailReport, error) {
	var zones []struct {
		ID string `json:"id"`
	}
	if err := c.getJSON("/zones?name="+zone, &zones); err != nil {
		return nil, fmt.Errorf("the token cannot list zones — it needs `Zone > Zone > Read` on %s", zone)
	}
	if len(zones) == 0 {
		return nil, fmt.Errorf("the token sees no zone named %q", zone)
	}
	zoneID := zones[0].ID
	report := &MailReport{Zone: zone}
	add := func(name string, ok bool, state string) {
		chk := MailCheck{Name: name, OK: ok, State: state}
		if !ok {
			chk.Fix = fixLine(zone)
		}
		report.Checks = append(report.Checks, chk)
	}
	// A 403 is a TOKEN gap, not a mail gap — prescribing `admin domain add`
	// for it would send the operator to re-wire a path that may be fine
	// (the live smoke against production found exactly this: rules readable,
	// the settings endpoint scoped away). Unreadable names the scope.
	addUnreadable := func(name, scope string, err error) {
		fix := "re-run once the read succeeds"
		state := "unreadable: " + err.Error()
		if _, denied := err.(errDenied); denied {
			state = "the token cannot read this surface"
			fix = "token gap, not a mail gap — add `" + scope + "` to the token, then re-run"
		}
		report.Checks = append(report.Checks, MailCheck{Name: name, OK: false, State: state, Fix: fix})
	}

	// Inbound half: Email Routing on, catch-all pointed at ingest, MX live.
	var routing struct {
		Enabled bool   `json:"enabled"`
		Status  string `json:"status"`
	}
	if err := c.getJSON("/zones/"+zoneID+"/email/routing", &routing); err != nil {
		addUnreadable("email-routing", "Zone > Email Routing > Read", err)
	} else {
		add("email-routing", routing.Enabled, "enabled="+fmt.Sprint(routing.Enabled)+onlyIf(routing.Status != "", " status="+routing.Status))
	}
	var catchAll struct {
		Enabled bool `json:"enabled"`
		Actions []struct {
			Type  string   `json:"type"`
			Value []string `json:"value"`
		} `json:"actions"`
	}
	if err := c.getJSON("/zones/"+zoneID+"/email/routing/rules/catch_all", &catchAll); err != nil {
		addUnreadable("catch-all→ingest", "Zone > Email Routing > Read", err)
	} else {
		toIngest := false
		target := "(none)"
		for _, a := range catchAll.Actions {
			if len(a.Value) > 0 {
				target = a.Type + ":" + strings.Join(a.Value, ",")
			} else {
				target = a.Type
			}
			if a.Type == "worker" && has(a.Value, "bullmoose-ingest") {
				toIngest = true
			}
		}
		add("catch-all→ingest", catchAll.Enabled && toIngest, "enabled="+fmt.Sprint(catchAll.Enabled)+" action="+target)
	}

	var records []DNSRecord
	if err := c.getJSON("/zones/"+zoneID+"/dns_records?per_page=500", &records); err != nil {
		addUnreadable("dns", "Zone > DNS > Read", err)
		return report, nil
	}
	mx, dkim, dmarc := 0, 0, false
	for _, r := range records {
		switch {
		case r.Type == "MX" && strings.EqualFold(r.Name, zone) && strings.Contains(r.Content, "mx.cloudflare.net"):
			mx++
		case r.Type == "CNAME" && strings.Contains(r.Name, "._domainkey.") && strings.Contains(r.Content, "dkim.amazonses.com"):
			dkim++
		case r.Type == "TXT" && strings.EqualFold(r.Name, "_dmarc."+zone):
			dmarc = true
		}
	}
	add("mx→cloudflare", mx > 0, fmt.Sprintf("%d Email Routing MX record(s)", mx))
	add("ses-dkim", dkim >= 3, fmt.Sprintf("%d/3 DKIM CNAMEs", dkim))
	add("dmarc", dmarc, onlyIf(dmarc, "_dmarc."+zone+" present")+onlyIf(!dmarc, "no _dmarc record"))
	return report, nil
}

func onlyIf(cond bool, s string) string {
	if cond {
		return s
	}
	return ""
}
