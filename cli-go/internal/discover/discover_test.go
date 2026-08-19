package discover

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
)

// noSRV is the world as it has actually been since 2026-08-13: the record is
// gone, so the system resolver answers NXDOMAIN.
func noSRV(context.Context, string, string, string) (string, []*net.SRV, error) {
	return "", nil, &net.DNSError{Err: "no such host", IsNotFound: true}
}

// rewriteTo makes every outbound request land on the test server, whatever
// hostname the resolver decided to try. That is what lets these tests exercise
// real https:// candidate URLs without a network.
func rewriteTo(srv *httptest.Server, hosts map[string]bool) *http.Client {
	return &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if hosts != nil && !hosts[r.URL.Host] {
			return nil, &net.DNSError{Err: "no such host", IsNotFound: true, Name: r.URL.Host}
		}
		clone := r.Clone(r.Context())
		clone.URL.Scheme = "http"
		clone.URL.Host = strings.TrimPrefix(srv.URL, "http://")
		return http.DefaultTransport.RoundTrip(clone)
	})}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// TestWellKnownIsFoundWithNoSRV is the live path: no SRV record anywhere, and the
// server answers the session resource with the 401 an unauthenticated probe
// should get. Discovery must land on https://<domain> and say so.
func TestWellKnownIsFoundWithNoSRV(t *testing.T) {
	var asked []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked = append(asked, r.URL.Path)
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
	}))
	defer srv.Close()

	r := &Resolver{LookupSRV: noSRV, HTTP: rewriteTo(srv, nil)}
	got, err := r.Resolve(context.Background(), "eric@bullmoose.cc")
	if err != nil {
		t.Fatalf("discovery failed on the live path: %v", err)
	}
	if got.Base != "https://bullmoose.cc" {
		t.Errorf("base = %q, want https://bullmoose.cc", got.Base)
	}
	if got.Via != "fallback" {
		t.Errorf("via = %q, want fallback (the well-known rung)", got.Via)
	}
	if len(asked) != 1 || asked[0] != "/.well-known/jmap" {
		t.Errorf("probed %v, want exactly one GET of /.well-known/jmap", asked)
	}
}

// TestSRVIsPreferredWhenItAnswers: a self-hosted deployment can still publish the
// record, and when its target is alive it wins — including the non-443 port form.
func TestSRVIsPreferredWhenItAnswers(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"username":"eric@bullmoose.cc"}`))
	}))
	defer srv.Close()

	r := &Resolver{
		LookupSRV: func(context.Context, string, string, string) (string, []*net.SRV, error) {
			return "", []*net.SRV{
				{Target: "far.example.", Port: 443, Priority: 20, Weight: 10},
				{Target: "jmap.bullmoose.cc.", Port: 8443, Priority: 10, Weight: 5},
			}, nil
		},
		HTTP: rewriteTo(srv, nil),
	}
	got, err := r.Resolve(context.Background(), "eric@bullmoose.cc")
	if err != nil {
		t.Fatal(err)
	}
	// RFC 2782: lowest priority wins, the trailing dot is stripped, and a port
	// other than 443 is carried into the URL.
	if got.Base != "https://jmap.bullmoose.cc:8443" {
		t.Errorf("base = %q, want https://jmap.bullmoose.cc:8443", got.Base)
	}
	if got.Via != "srv" {
		t.Errorf("via = %q, want srv", got.Via)
	}
}

// TestDeadSRVFallsThroughToWellKnown is the "prefer what works" rule, and the
// reason discovery probes at all: a record pointing at a host that no longer
// serves must not strand a working well-known deployment. discover.ts returns the
// dead SRV target unverified and login then fails against it.
func TestDeadSRVFallsThroughToWellKnown(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
	}))
	defer srv.Close()

	r := &Resolver{
		LookupSRV: func(context.Context, string, string, string) (string, []*net.SRV, error) {
			return "", []*net.SRV{{Target: "gone.bullmoose.cc.", Port: 443}}, nil
		},
		// Only the apex resolves; the SRV target does not.
		HTTP: rewriteTo(srv, map[string]bool{"bullmoose.cc": true}),
	}
	got, err := r.Resolve(context.Background(), "eric@bullmoose.cc")
	if err != nil {
		t.Fatalf("a dead SRV target stranded a working server: %v", err)
	}
	if got.Base != "https://bullmoose.cc" || got.Via != "fallback" {
		t.Errorf("got %q via %q, want https://bullmoose.cc via fallback", got.Base, got.Via)
	}
}

// TestSRVTargetDotMeansNotOffered — RFC 2782's explicit "no service here".
func TestSRVTargetDotMeansNotOffered(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
	}))
	defer srv.Close()
	r := &Resolver{
		LookupSRV: func(context.Context, string, string, string) (string, []*net.SRV, error) {
			return "", []*net.SRV{{Target: ".", Port: 443}}, nil
		},
		HTTP: rewriteTo(srv, nil),
	}
	got, err := r.Resolve(context.Background(), "eric@bullmoose.cc")
	if err != nil {
		t.Fatal(err)
	}
	if got.Base != "https://bullmoose.cc" {
		t.Errorf(`a target of "." must drop to the fallback, got %q`, got.Base)
	}
}

// TestDoHRungIsUsedWhenTheSystemResolverFails: on a network that blocks UDP 53
// the system lookup fails, and discover.ts asks the same question over HTTPS.
func TestDoHRungIsUsedWhenTheSystemResolverFails(t *testing.T) {
	var dohQueries []string
	doh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		dohQueries = append(dohQueries, r.URL.Query().Get("name"))
		w.Header().Set("content-type", "application/dns-json")
		_, _ = w.Write([]byte(`{"Answer":[{"type":33,"data":"10 5 443 jmap.bullmoose.cc."}]}`))
	}))
	defer doh.Close()
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
	}))
	defer target.Close()

	r := &Resolver{
		LookupSRV: noSRV,
		DoHURL:    doh.URL,
		HTTP: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			// The DoH request goes to the DoH server; probes go to the target.
			dest := target.URL
			if strings.HasPrefix(req.URL.String(), doh.URL) {
				dest = doh.URL
			}
			clone := req.Clone(req.Context())
			clone.URL.Scheme = "http"
			clone.URL.Host = strings.TrimPrefix(dest, "http://")
			return http.DefaultTransport.RoundTrip(clone)
		})},
	}
	got, err := r.Resolve(context.Background(), "eric@bullmoose.cc")
	if err != nil {
		t.Fatal(err)
	}
	if len(dohQueries) != 1 || dohQueries[0] != "_jmap._tcp.bullmoose.cc" {
		t.Errorf("DoH was asked %v, want one query for _jmap._tcp.bullmoose.cc", dohQueries)
	}
	if got.Base != "https://jmap.bullmoose.cc" || got.Via != "srv-doh" {
		t.Errorf("got %q via %q, want https://jmap.bullmoose.cc via srv-doh", got.Base, got.Via)
	}
}

// TestFailureIsLegibleNotAnHtmlDump is the failure Eric actually hit: a domain
// that answers 200 with a marketing page. The refusal must name what was tried
// and how to bypass it, must carry exit 3, and must NOT contain the page.
func TestFailureIsLegibleNotAnHtmlDump(t *testing.T) {
	page := "<!doctype html><html><head><title>Parked</title></head><body>" +
		strings.Repeat("buy this domain ", 200) + "</body></html>"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(page))
	}))
	defer srv.Close()

	r := &Resolver{LookupSRV: noSRV, HTTP: rewriteTo(srv, nil)}
	_, err := r.Resolve(context.Background(), "eric@parked.example")
	if err == nil {
		t.Fatal("a parked domain must not be accepted as a JMAP server")
	}
	msg := err.Error()
	if strings.Contains(msg, "<html") || strings.Contains(msg, "buy this domain") {
		t.Errorf("the HTML page leaked into the error:\n%s", msg)
	}
	for _, want := range []string{
		"no JMAP server found for parked.example",
		"/.well-known/jmap",
		"text/html",
		"--base",
	} {
		if !strings.Contains(msg, want) {
			t.Errorf("the refusal should mention %q:\n%s", want, msg)
		}
	}
	if got := bmio.ExitCodeFor(err); got != bmio.ExitNotFound {
		t.Errorf("exit code = %d, want %d (the named thing does not exist)", got, bmio.ExitNotFound)
	}
	if len(msg) > 600 {
		t.Errorf("the refusal is %d characters — a legible error fits on a screen", len(msg))
	}
}

// TestNotAnEmailAddress is a usage error (exit 2), not a discovery failure: no
// lookup and no request should happen at all.
func TestNotAnEmailAddress(t *testing.T) {
	r := &Resolver{
		LookupSRV: func(context.Context, string, string, string) (string, []*net.SRV, error) {
			t.Error("a malformed address must not reach DNS")
			return "", nil, errors.New("unreachable")
		},
		HTTP: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			t.Error("a malformed address must not reach the network")
			return nil, errors.New("unreachable")
		})},
	}
	for _, bad := range []string{"eric", "eric@", ""} {
		_, err := r.Resolve(context.Background(), bad)
		if err == nil {
			t.Fatalf("%q was accepted as an address", bad)
		}
		if got := bmio.ExitCodeFor(err); got != bmio.ExitUsage {
			t.Errorf("%q: exit code %d, want %d", bad, got, bmio.ExitUsage)
		}
	}
}

// TestWellKnownRedirectMovesTheBase is the live bullmoose.cc shape, and the bug
// it fixes: the apex is a Pages site that 302s ONLY /.well-known/jmap to
// app.bullmoose.cc. Probing through the redirect and then reporting the apex as
// the base yields a config that discovers fine and cannot log in — the apex
// answers POST /auth/login with 405. The base has to be the origin that
// answered (RFC 8620 §2.2).
func TestWellKnownRedirectMovesTheBase(t *testing.T) {
	apex := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("location", "https://app.bullmoose.cc/.well-known/jmap")
		w.WriteHeader(http.StatusFound)
	}))
	defer apex.Close()
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
	}))
	defer app.Close()

	// Two origins, routed by the hostname discovery ASKED for — recording it
	// here rather than in a handler, because the rewrite that lets these tests
	// run without a network is exactly what erases it downstream.
	var asked []string
	r := &Resolver{LookupSRV: noSRV, HTTP: &http.Client{
		Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			asked = append(asked, req.URL.Host+req.URL.Path)
			dest := app.URL
			if req.URL.Host == "bullmoose.cc" {
				dest = apex.URL
			}
			clone := req.Clone(req.Context())
			clone.URL.Scheme = "http"
			clone.URL.Host = strings.TrimPrefix(dest, "http://")
			return http.DefaultTransport.RoundTrip(clone)
		}),
	}}
	got, err := r.Resolve(context.Background(), "eric@bullmoose.cc")
	if err != nil {
		t.Fatal(err)
	}
	if got.Base != "https://app.bullmoose.cc" {
		t.Errorf("base = %q, want the origin that answered (https://app.bullmoose.cc)", got.Base)
	}
	if got.RedirectedFrom != "https://bullmoose.cc" {
		t.Errorf("redirectedFrom = %q, want https://bullmoose.cc — a moved base must not be silent", got.RedirectedFrom)
	}
	if got.Via != "fallback" {
		t.Errorf("via = %q, want fallback — a redirect does not change which RUNG answered", got.Via)
	}
	want := []string{"bullmoose.cc/.well-known/jmap", "app.bullmoose.cc/.well-known/jmap"}
	if len(asked) != 2 || asked[0] != want[0] || asked[1] != want[1] {
		t.Errorf("requests = %v, want %v", asked, want)
	}
}

// TestSameOriginRedirectLeavesTheBaseAlone: only a CROSS-ORIGIN hop is a move.
// A server that normalises a path must not rewrite the user's base.
func TestSameOriginRedirectLeavesTheBaseAlone(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/.well-known/jmap" {
			w.Header().Set("location", "/.well-known/jmap/")
			w.WriteHeader(http.StatusMovedPermanently)
			return
		}
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
	}))
	defer srv.Close()

	r := &Resolver{LookupSRV: noSRV, HTTP: rewriteTo(srv, nil)}
	got, err := r.Resolve(context.Background(), "eric@bullmoose.cc")
	if err != nil {
		t.Fatal(err)
	}
	if got.Base != "https://bullmoose.cc" || got.RedirectedFrom != "" {
		t.Errorf("base = %q (from %q), want https://bullmoose.cc unmoved", got.Base, got.RedirectedFrom)
	}
}

// TestRedirectLoopIsRefusedNotFollowedForever — a bounded follow, reported as a
// candidate that failed rather than as a hang.
func TestRedirectLoopIsRefusedNotFollowedForever(t *testing.T) {
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.Header().Set("location", "https://elsewhere.example/.well-known/jmap")
		w.WriteHeader(http.StatusFound)
	}))
	defer srv.Close()

	r := &Resolver{LookupSRV: noSRV, HTTP: rewriteTo(srv, nil)}
	if _, err := r.Resolve(context.Background(), "eric@bullmoose.cc"); err == nil {
		t.Fatal("a redirect loop was accepted as a discovered server")
	}
	if hits > maxRedirects+1 {
		t.Errorf("followed %d hops, want at most %d", hits, maxRedirects+1)
	}
}
