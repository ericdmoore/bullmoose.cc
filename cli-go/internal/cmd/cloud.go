package cmd

// `bullmoose cloud` — s46, the CLI as a CREATOR of a bullmoose deployment.
// T2 ships the read-only half: `cloud plan --zone <domain>` probes the
// Cloudflare account the token can see and prints, whole, what an install
// would do — every resource by name, refusals above everything, the popcorn
// consent model's third instance. `cloud install` (T3) is this plan plus
// one honest yes plus apply; nothing in THIS verb mutates anything.
//
// Inputs, and where they may travel:
//
//	CLOUDFLARE_API_TOKEN   env only — never argv, never a URL. The probe
//	                       sends it as a Bearer header to api.cloudflare.com
//	                       and nowhere else.
//	--zone                 the target domain; with the token these are the
//	                       ENTIRE required inputs (the account is derived
//	                       from the zone, not asked for).
//	--stack-version/-base  which published stack to plan against; default
//	                       is dl.bullmoose.cc/stack's latest.
//
// Exit codes: 0 = the plan is applyable as printed; 1 = the plan contains
// refusals or blocked surfaces (each named, with the token scope to add);
// 2 = the invocation itself is malformed.

import (
	"os"
	"strings"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/cloud"
	bmio "github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
)

type cloudArgs struct {
	JSON         bool
	Help         bool
	Zone         string
	StackVersion string
	StackBase    string
	Positionals  []string
	badFlag      string
}

func parseCloud(argv []string) cloudArgs {
	var a cloudArgs
	endOpts := false
	for i := 0; i < len(argv); i++ {
		arg := argv[i]
		switch {
		case endOpts:
			a.Positionals = append(a.Positionals, arg)
		case arg == "--":
			endOpts = true
		case strings.HasPrefix(arg, "--"):
			name, inlineVal, inline := strings.Cut(strings.TrimPrefix(arg, "--"), "=")
			value := func() string {
				if inline {
					return inlineVal
				}
				if i+1 < len(argv) {
					i++
					return argv[i]
				}
				return ""
			}
			switch name {
			case "json":
				a.JSON = true
			case "help":
				a.Help = true
			case "zone":
				a.Zone = value()
			case "stack-version":
				a.StackVersion = value()
			case "stack-base":
				a.StackBase = value()
			default:
				if a.badFlag == "" {
					a.badFlag = "--" + name
				}
			}
		default:
			a.Positionals = append(a.Positionals, arg)
		}
	}
	return a
}

func runCloud(s *bmio.Streams, argv []string) int {
	a := parseCloud(argv[1:]) // argv[0] is the command name, per args.go:236
	// goNative: Route hands argv over untouched, so --help is answered here
	// (the embedded spec predates this command; see undocumentedByDesign).
	if a.Help {
		s.Out("usage: bullmoose cloud plan --zone <domain> [--stack-version <v>] [--stack-base <url>] [--json]")
		s.Out("")
		s.Out("Read-only: probes the Cloudflare account CLOUDFLARE_API_TOKEN can see and")
		s.Out("prints what installing the published stack onto <domain> would do — every")
		s.Out("resource by name, refusals first. `cloud install` (apply) is s46 T3.")
		return 0
	}
	if a.badFlag != "" {
		return die(s, bmio.Fail(a.badFlag+" is not a flag of `bullmoose cloud`", bmio.ExitUsage))
	}
	verb := ""
	if len(a.Positionals) > 0 {
		verb = a.Positionals[0]
	}
	switch verb {
	case "plan":
		return runCloudPlan(s, a)
	case "":
		return die(s, bmio.Fail("cloud needs a verb: `bullmoose cloud plan --zone <domain>`", bmio.ExitUsage))
	default:
		return die(s, bmio.Fail("unknown cloud verb '"+verb+"' — only `plan` exists today (install is s46 T3)", bmio.ExitUsage))
	}
}

func runCloudPlan(s *bmio.Streams, a cloudArgs) int {
	if a.Zone == "" {
		return die(s, bmio.Fail("cloud plan needs --zone <domain> — the domain the stack would install onto", bmio.ExitUsage))
	}
	token := os.Getenv("CLOUDFLARE_API_TOKEN")
	if token == "" {
		return die(s, bmio.Fail("CLOUDFLARE_API_TOKEN is not set — the probe is read-only but still needs a token; see the plan's own output for the scopes apply would use", bmio.ExitUsage))
	}

	fetcher := cloud.NewFetcher(a.StackBase, nil)
	st, err := fetcher.Fetch(a.StackVersion)
	if err != nil {
		return die(s, err)
	}
	probe, err := cloud.Probe(cloud.NewCF(os.Getenv("CLOUDFLARE_API_BASE_URL"), token, nil), a.Zone)
	if err != nil {
		return die(s, err)
	}
	plan := cloud.BuildPlan(st, probe, a.Zone)

	if a.JSON {
		if err := s.EmitJSON(plan); err != nil {
			return die(s, err)
		}
	} else {
		renderPlan(s, plan)
	}
	if len(plan.Refusals) > 0 || len(plan.Blocked) > 0 {
		return int(bmio.ExitFail)
	}
	return 0
}

// renderPlan prints the whole plan, refusals FIRST — they are the point;
// the inventory is the context (the same ranking the popcorn planner and
// the Settings reconcile view use).
func renderPlan(s *bmio.Streams, p *cloud.Plan) {
	s.Out("plan: stack " + p.Version + " onto " + p.Zone)
	if len(p.Refusals) > 0 {
		s.Out("")
		s.Out("REFUSALS — apply will not run while these stand:")
		for _, r := range p.Refusals {
			s.Out("  ✗ " + r.Kind + " " + r.Name + ": " + r.Detail)
		}
	}
	if len(p.Blocked) > 0 {
		s.Out("")
		s.Out("BLOCKED — the token could not read these surfaces; add the scope and re-run:")
		for _, b := range p.Blocked {
			s.Out("  ? " + b.Surface + " needs `" + b.Scope + "`")
		}
	}
	s.Out("")
	for _, it := range p.Items {
		mark := map[cloud.Action]string{
			cloud.Create: "+", cloud.Reuse: "=", cloud.Refuse: "✗",
			cloud.Blocked: "?", cloud.Mint: "⚿", cloud.Supply: "→",
		}[it.Action]
		line := "  " + mark + " " + it.Kind + " " + it.Name + " (" + string(it.Action) + ")"
		if it.Detail != "" {
			line += " — " + it.Detail
		}
		s.Out(line)
	}
	s.Out("")
	s.Out("legend: + create   = reuse (already yours; apply reconciles)   ⚿ mint locally   → you supply")
	s.Out("read-only: nothing above has happened. `cloud install` (T3) is this plan plus one yes.")
}
