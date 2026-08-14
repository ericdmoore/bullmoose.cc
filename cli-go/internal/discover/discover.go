// Package discover is JMAP autodiscovery (RFC 8620 §2.2): given only an email
// address, find the server. It is the Go port of packages/cli/src/discover.ts.
//
// ── The ladder, and which rung is actually load-bearing today ──────────────
//
//  1. SRV _jmap._tcp.<domain> over the system resolver
//  2. the same query over DNS-over-HTTPS (for UDP-53-blocked networks)
//  3. https://<domain>/.well-known/jmap — the spec fallback
//
// ⚠️ Rung 3 is the LIVE path. The SRV record was removed on 2026-08-13 because
// Cloudflare cannot serve a working one for a proxied host: the record has to
// name a hostname that resolves to the origin, and a proxied host does not. Both
// rungs stay implemented — a self-hosted deployment can still publish SRV, and
// RFC 8620 says to look — but nothing may ASSUME the SRV rung answers.
//
// ── What this port adds, deliberately: it PROBES ──────────────────────────
//
// discover.ts picks a base and returns it unverified, so a domain with no
// bullmoose behind it is only discovered to be wrong one step later, when
// `login` POSTs to /auth/login and the failure is rendered as
//
//	login failed: HTTP 404 <!doctype html><html …
//
// — an HTML page dumped into the terminal. That is the failure this port is
// asked to fix, so discovery here ends with `probe`: each candidate is checked
// against /.well-known/jmap and the FIRST ONE THAT ANSWERS wins ("prefer what
// works", rather than "prefer SRV"). When none answers, the error names every
// candidate, how each failed, and the flag that bypasses the whole question —
// and it never prints a page of markup to do it.
//
// This is a divergence from the TypeScript twin, and an intentional one; the
// contract suite has no `login` case, so 61/61 is unaffected. Recorded in the
// wave report as a delta to fold back into discover.ts.
package discover

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
)

// Result is discover.ts's Discovery: where the server is, and which rung of the
// ladder answered — `login` prints the pair so a surprising base is visible
// rather than silent.
type Result struct {
	Base   string
	Via    string // "srv" | "srv-doh" | "fallback"
	Domain string
}

// Resolver holds the two effects discovery has, so a test can drive every rung
// without a network. Build the production one with New.
type Resolver struct {
	// LookupSRV defaults to net.DefaultResolver.LookupSRV.
	LookupSRV func(ctx context.Context, service, proto, name string) (string, []*net.SRV, error)
	// HTTP defaults to a 15s client; used for both DoH and the probe.
	HTTP *http.Client
	// DoHURL is the DNS-over-HTTPS endpoint. Empty disables that rung.
	DoHURL string
}

const defaultDoH = "https://cloudflare-dns.com/dns-query"

// New is the resolver the commands use: the system resolver, a real HTTP client
// and Cloudflare's DoH endpoint. The ZERO value deliberately has no DoH endpoint,
// so a test that forgets to set one cannot reach the network by accident.
func New() *Resolver { return &Resolver{DoHURL: defaultDoH} }

func (r *Resolver) lookupSRV(ctx context.Context, name string) ([]*net.SRV, error) {
	if r.LookupSRV != nil {
		return second(r.LookupSRV(ctx, "", "", name))
	}
	// The service/proto-less form: the name is already fully qualified, which is
	// what discover.ts's `_jmap._tcp.<domain>` string is.
	return second(net.DefaultResolver.LookupSRV(ctx, "", "", name))
}

func second(_ string, recs []*net.SRV, err error) ([]*net.SRV, error) { return recs, err }

func (r *Resolver) client() *http.Client {
	if r.HTTP != nil {
		return r.HTTP
	}
	return &http.Client{Timeout: 15 * time.Second}
}

// Resolve finds the JMAP base for an address, or explains why it could not.
func (r *Resolver) Resolve(ctx context.Context, email string) (Result, error) {
	at := strings.LastIndex(email, "@")
	if at < 0 || at == len(email)-1 {
		// discover.ts:30 — a usage error, not a discovery failure.
		return Result{}, bmio.Usage("not an email address: " + email)
	}
	domain := strings.ToLower(email[at+1:])

	candidates := r.candidates(ctx, domain)

	var tried []string
	for _, c := range candidates {
		ok, detail := r.probe(ctx, c.Base)
		if ok {
			return c, nil
		}
		tried = append(tried, fmt.Sprintf("  %-40s %s (%s)", c.Base+"/.well-known/jmap", detail, c.Via))
	}

	// Every rung failed. Say what was tried, in order, and how to skip the
	// question entirely — this is the message that replaces a dumped HTML page.
	return Result{}, bmio.NotFound(
		"no JMAP server found for " + domain + ". Tried:\n" +
			strings.Join(tried, "\n") +
			"\nIf the server is elsewhere, name it: bullmoose login " + email + " --base <url>")
}

// candidates is the ladder, in order, de-duplicated: any SRV target first, then
// the well-known fallback. Both are returned even when SRV answers, because an
// SRV record that points at a dead host must not strand a working well-known
// deployment (the "prefer what works" rule in the package header).
func (r *Resolver) candidates(ctx context.Context, domain string) []Result {
	name := "_jmap._tcp." + domain

	via := "srv"
	records, err := r.lookupSRV(ctx, name)
	if err != nil || len(records) == 0 {
		// discover.ts:44 — the system resolver failing is the normal case on a
		// network that blocks UDP 53, so ask over HTTPS before giving up.
		// (Since the SRV record was retired this rung is now always a miss; it
		// stays because a self-hosted deployment may still publish one.)
		records = r.lookupDoH(ctx, name)
		via = "srv-doh"
	}

	var out []Result
	if best := pickSRV(records); best != nil {
		target := strings.TrimSuffix(best.Target, ".")
		base := "https://" + target
		if best.Port != 443 {
			base = fmt.Sprintf("https://%s:%d", target, best.Port)
		}
		out = append(out, Result{Base: base, Via: via, Domain: domain})
	}
	fallback := Result{Base: "https://" + domain, Via: "fallback", Domain: domain}
	if len(out) == 0 || out[0].Base != fallback.Base {
		out = append(out, fallback)
	}
	return out
}

// pickSRV is RFC 2782 selection: lowest priority, then highest weight. A target
// of "." means "service explicitly not offered" and is discarded, which drops
// straight through to the fallback (discover.ts:59).
func pickSRV(records []*net.SRV) *net.SRV {
	var usable []*net.SRV
	for _, r := range records {
		if r != nil && r.Target != "" && r.Target != "." {
			usable = append(usable, r)
		}
	}
	if len(usable) == 0 {
		return nil
	}
	sort.SliceStable(usable, func(i, j int) bool {
		if usable[i].Priority != usable[j].Priority {
			return usable[i].Priority < usable[j].Priority
		}
		return usable[i].Weight > usable[j].Weight
	})
	return usable[0]
}

// lookupDoH is discover.ts:66 resolveSrvDoH — the same query as JSON over HTTPS.
// Every failure is silent and yields no records: this rung exists as a fallback,
// so its own failure must not become the user's error.
func (r *Resolver) lookupDoH(ctx context.Context, name string) []*net.SRV {
	endpoint := r.DoHURL
	if endpoint == "" {
		return nil // no DoH configured — see New
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		endpoint+"?name="+url.QueryEscape(name)+"&type=SRV", nil)
	if err != nil {
		return nil
	}
	req.Header.Set("accept", "application/dns-json")
	resp, err := r.client().Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil
	}
	var body struct {
		Answer []struct {
			Type int    `json:"type"`
			Data string `json:"data"`
		} `json:"Answer"`
	}
	if json.NewDecoder(resp.Body).Decode(&body) != nil {
		return nil
	}
	var out []*net.SRV
	for _, a := range body.Answer {
		if a.Type != 33 { // SRV
			continue
		}
		var priority, weight, port uint16
		var target string
		if n, _ := fmt.Sscanf(a.Data, "%d %d %d %s", &priority, &weight, &port, &target); n == 4 && target != "" {
			out = append(out, &net.SRV{Target: target, Port: port, Priority: priority, Weight: weight})
		}
	}
	return out
}

// probe asks the candidate whether it is a JMAP server — discover.ts:94
// probeSession, including the case that decides everything: an UNAUTHENTICATED
// GET of the session resource answers 401, and that is a YES. The bodies here are
// never printed; only these short verdicts are.
func (r *Resolver) probe(ctx context.Context, base string) (bool, string) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/.well-known/jmap", nil)
	if err != nil {
		return false, "not a usable URL"
	}
	resp, err := r.client().Do(req)
	if err != nil {
		return false, transportDetail(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized {
		return true, "JMAP server present (auth required — expected)"
	}
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		if strings.Contains(resp.Header.Get("content-type"), "json") {
			return true, "JMAP session served"
		}
		// The HTML-dump case, named rather than pasted: a parked domain, a
		// marketing page, or a proxy that answers everything with 200.
		return false, fmt.Sprintf("responds, but not with a JMAP session (%s)",
			contentType(resp.Header.Get("content-type")))
	}
	return false, fmt.Sprintf("HTTP %d", resp.StatusCode)
}

// transportDetail keeps a connection failure to one line. net's errors are
// wrapped several deep and read as a stack fragment; the user needs the reason.
func transportDetail(err error) string {
	var dns *net.DNSError
	if errors.As(err, &dns) {
		if dns.IsNotFound {
			return "no such host"
		}
		return "DNS: " + dns.Err
	}
	msg := err.Error()
	if i := strings.LastIndex(msg, ": "); i >= 0 && i+2 < len(msg) {
		msg = msg[i+2:]
	}
	return msg
}

func contentType(raw string) string {
	if raw == "" {
		return "no content-type"
	}
	if i := strings.Index(raw, ";"); i >= 0 {
		raw = raw[:i]
	}
	return strings.TrimSpace(raw)
}
