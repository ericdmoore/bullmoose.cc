package cmd

// `bullmoose discover` — show what autodiscovery finds and probe the server.
// A thin wrapper: internal/discover already runs the full ladder (SRV →
// SRV-over-DoH → well-known, probing each candidate), because `login` needed
// it first. This command exists so a human can see the ladder's verdict
// without logging in.
//
// s42 note: the Go Resolve returns an ERROR when no rung answers, carrying the
// full tried-list and the --base escape hatch. The TypeScript instead printed
// a ✗ line and exited FAIL. Same information, same exit meaning (nonzero on
// no-server), one path instead of two — the divergence this port spends its
// licence on.

import (
	"context"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/discover"
	bmio "github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
)

// discoverDeps is the one effect a test cannot have — the login.go pattern.
type discoverDeps struct {
	resolver interface {
		Resolve(ctx context.Context, email string) (discover.Result, error)
	}
}

func runDiscover(s *bmio.Streams, argv []string) int {
	return runDiscoverWith(s, argv, discoverDeps{})
}

func runDiscoverWith(s *bmio.Streams, argv []string, deps discoverDeps) int {
	a := parse(argv)
	target := a.at(1)
	if target == "" {
		s.Note("usage: bullmoose discover <email-or-domain>")
		return 2
	}
	// A bare domain probes as a synthetic address — discovery only reads the
	// part after the @.
	if !hasAt(target) {
		target = "probe@" + target
	}

	finder := deps.resolver
	if finder == nil {
		finder = discover.New()
	}
	found, err := finder.Resolve(context.Background(), target)
	if err != nil {
		return die(s, err)
	}

	if a.JSON {
		row := map[string]any{
			"domain": found.Domain,
			"via":    found.Via,
			"base":   found.Base,
			"ok":     true,
		}
		if found.RedirectedFrom != "" {
			row["redirectedFrom"] = found.RedirectedFrom
		}
		if err := s.EmitJSON(row); err != nil {
			return die(s, err)
		}
		return 0
	}
	s.Out("domain:  " + found.Domain)
	method := "SRV _jmap._tcp (" + found.Via + ")"
	if found.Via == "fallback" {
		method = "no SRV record — well-known fallback"
	}
	s.Out("method:  " + method)
	s.Out("base:    " + found.Base)
	if found.RedirectedFrom != "" {
		s.Out("         (" + found.RedirectedFrom + " redirected the session resource here)")
	}
	s.Out("session: ✓ answered")
	return 0
}

func hasAt(v string) bool {
	for i := 0; i < len(v); i++ {
		if v[i] == '@' {
			return true
		}
	}
	return false
}
