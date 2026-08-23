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
	"strconv"
	"strings"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/cloud"
	bmio "github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
)

type cloudArgs struct {
	JSON         bool
	Help         bool
	Yes          bool
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
			case "yes":
				a.Yes = true
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
		s.Out("usage: bullmoose cloud plan    --zone <domain> [--stack-version <v>] [--stack-base <url>] [--json]")
		s.Out("       bullmoose cloud install --zone <domain> [--yes] [same flags]")
		s.Out("")
		s.Out("plan     read-only: probes the account CLOUDFLARE_API_TOKEN can see and prints")
		s.Out("         what installing the published stack onto <domain> would do — every")
		s.Out("         resource by name, refusals first.")
		s.Out("install  the same plan, one honest yes (--yes skips the prompt), then apply:")
		s.Out("         storage, D1 schema, workers, secrets, routes. Mail path lands in T4.")
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
	case "install":
		return runCloudInstall(s, a)
	case "":
		return die(s, bmio.Fail("cloud needs a verb: `bullmoose cloud plan|install --zone <domain>`", bmio.ExitUsage))
	default:
		return die(s, bmio.Fail("unknown cloud verb '"+verb+"' — `plan` and `install` exist today", bmio.ExitUsage))
	}
}

// cloudContext runs the shared read half — fetch, probe, plan. Returns a
// non-zero code (and nils) when the read half itself failed.
func cloudContext(s *bmio.Streams, a cloudArgs, verb string) (*cloud.Stack, *cloud.ProbeResult, *cloud.Plan, int) {
	if a.Zone == "" {
		return nil, nil, nil, die(s, bmio.Fail("cloud "+verb+" needs --zone <domain> — the domain the stack targets", bmio.ExitUsage))
	}
	token := os.Getenv("CLOUDFLARE_API_TOKEN")
	if token == "" {
		return nil, nil, nil, die(s, bmio.Fail("CLOUDFLARE_API_TOKEN is not set — see the plan's own output for the scopes apply would use", bmio.ExitUsage))
	}
	fetcher := cloud.NewFetcher(a.StackBase, nil)
	st, err := fetcher.Fetch(a.StackVersion)
	if err != nil {
		return nil, nil, nil, die(s, err)
	}
	probe, err := cloud.Probe(cloud.NewCF(os.Getenv("CLOUDFLARE_API_BASE_URL"), token, nil), a.Zone)
	if err != nil {
		return nil, nil, nil, die(s, err)
	}
	return st, probe, cloud.BuildPlan(st, probe, a.Zone), 0
}

func runCloudPlan(s *bmio.Streams, a cloudArgs) int {
	_, _, plan, code := cloudContext(s, a, "plan")
	if code != 0 {
		return code
	}
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

// runCloudInstall is the plan plus ONE honest yes plus apply. The prompt is
// the rendered plan itself — nothing is asked that was not first shown
// whole — and refusals/blocked gate BEFORE any prompt could (a question
// whose yes cannot be honoured is not a question).
func runCloudInstall(s *bmio.Streams, a cloudArgs) int {
	st, probe, plan, code := cloudContext(s, a, "install")
	if code != 0 {
		return code
	}
	renderPlan(s, plan)
	if len(plan.Refusals) > 0 || len(plan.Blocked) > 0 {
		s.Note("install: the plan is not applyable as printed — resolve the refusals/blocked scopes above and re-run")
		return int(bmio.ExitFail)
	}

	confirm := defaultConfirm(s, a.Yes)
	if !confirm("\napply this plan to " + a.Zone + "? [y/N] ") {
		s.Note("declined — nothing was applied; the same `cloud install` resumes whenever you are ready")
		return int(bmio.ExitFail)
	}

	// Operator-supplied secrets ride from the environment, by exactly the
	// names the manifest lists; values never touch argv.
	external := map[string]string{}
	for name := range st.Manifest.Secrets.External {
		if v := os.Getenv(name); v != "" {
			external[name] = v
		}
	}

	applied, err := cloud.ApplyCore(cloud.NewCF(os.Getenv("CLOUDFLARE_API_BASE_URL"), os.Getenv("CLOUDFLARE_API_TOKEN"), nil),
		st, probe, plan, cloud.ApplyOpts{Zone: a.Zone, External: external, Log: func(line string) { s.Note("  " + line) }})
	if err != nil {
		if applied != nil && len(applied.Steps) > 0 {
			s.Note("install: stopped after " + strconv.Itoa(len(applied.Steps)) + " step(s) — the plan is resumable: fix the cause and re-run `cloud install`")
		}
		return die(s, err)
	}

	s.Out("")
	s.Out("core stack applied to " + a.Zone + " (" + strconv.Itoa(len(applied.Steps)) + " steps).")
	if v, ok := applied.Minted["ADMIN_TOKEN"]; ok {
		s.Out("")
		s.Out("ADMIN_TOKEN (minted locally, stored ONLY as a worker secret — save it now, it is not shown again):")
		s.Out("  " + v)
	}
	for _, name := range applied.MissingExternal {
		s.Out("still needed: " + name + " — set it in the environment and re-run `cloud install` (everything applied stays applied)")
	}
	s.Out("")
	s.Out("not yet wired (by design): the mail path — MX + Email Routing + delivery verification is s46 T4;")
	s.Out("the webmail app upload and `admin init` hand-off are T5.")
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
