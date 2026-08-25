package cmd

// `bullmoose cloud` — s46, the CLI as a CREATOR of a bullmoose deployment.
// Four verbs, one consent model (popcorn's, third instance): `plan` probes
// read-only and prints, whole, what an install would do — every resource
// by name, refusals above everything; `install` is that plan plus one
// honest yes plus apply, ending at the `admin init` hand-off; `update` is
// install pointed at the newest published stack (reconcile makes the alias
// true); `doctor` walks the zone's mail path read-only, fixes named per
// gap. docs/install-cloud.md is the operator's side of this file.
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
// Exit codes: 0 = applyable/applied/healthy; 1 = refusals, blocked
// surfaces or mail-path gaps (each named, with the scope or command that
// fixes it); 2 = the invocation itself is malformed.

import (
	"os"
	"strconv"
	"strings"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/cloud"
	bmio "github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/store"
)

type cloudArgs struct {
	JSON         bool
	Help         bool
	Yes          bool
	Zone         string
	StackVersion string
	StackBase    string
	Dir          string
	Prefix       string
	Bucket       string
	Account      string
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
			case "dir":
				a.Dir = value()
			case "prefix":
				a.Prefix = value()
			case "bucket":
				a.Bucket = value()
			case "account":
				a.Account = value()
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
		s.Out("         storage, D1 schema, workers, secrets, routes — ending at the `admin init`")
		s.Out("         hand-off. The mail path is the stack's own job (`admin domain add`).")
		s.Out("update   the same machinery against the newest published stack: reuse binds what")
		s.Out("         exists, secrets are kept (never rotated), workers re-upload. One yes.")
		s.Out("doctor   read-only walk of <domain>'s mail path — Email Routing, catch-all→ingest,")
		s.Out("         MX, SES DKIM, DMARC — with the fixing command named per gap.")
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
	case "update":
		// The fullmonty of the cloud half: the SAME machinery pointed at a
		// newer stack/<version>. Apply is reconcile-by-construction (reuse
		// binds existing ids, kept secrets are never rotated, our-shaped
		// DNS reuses), so update IS install — the verb exists so the mental
		// model matches popcorn's.
		return runCloudInstall(s, a)
	case "doctor":
		return runCloudDoctor(s, a)
	case "site":
		return runCloudSite(s, a)
	case "":
		return die(s, bmio.Fail("cloud needs a verb: `bullmoose cloud plan|install|doctor --zone <domain>`", bmio.ExitUsage))
	default:
		return die(s, bmio.Fail("unknown cloud verb '"+verb+"' — `plan`, `install`, `update` and `doctor` exist today", bmio.ExitUsage))
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

	// The hand-off: `cloud install` ends exactly where `admin init` begins
	// (the s46 boundary, stated as a table in the plan). The mail path is
	// the STACK's own job — provision's addDomain enables Email Routing,
	// points the catch-all at ingest and writes the SES DKIM/DMARC records,
	// each step receipted — so the next commands are the product's, not
	// more installer.
	s.Out("")
	sub, subErr := cloud.NewCF(os.Getenv("CLOUDFLARE_API_BASE_URL"), os.Getenv("CLOUDFLARE_API_TOKEN"), nil).
		WorkersSubdomain(probe.Zone.AccountID)
	switch {
	case subErr != nil || sub == "":
		s.Out("next: this account has no workers.dev subdomain, and the admin plane (bullmoose-provision)")
		s.Out("is reachable only there — claim one in the Cloudflare dashboard (Workers → your subdomain),")
		s.Out("then: bullmoose admin init --token <ADMIN_TOKEN above>   # --url is derived once a subdomain exists")
	default:
		// (1) OFFER to connect this device. The installer holds both halves
		// already — it DERIVED the url and MINTED the token — so asking the
		// operator to copy a freshly made secret out of scrollback buys
		// nothing and risks a paste buffer. What you minted, you can write
		// down; the hand-off boundary is respected because persisting your
		// own output is not doing the product's job.
		//
		// An OFFER, never a side effect: the machine that installs is
		// usually the machine that operates, but "usually" is not "always",
		// and a config written without asking is one nobody knows is there.
		adminURL := "https://" + provisionWorker + "." + sub + ".workers.dev"
		token, minted := applied.Minted["ADMIN_TOKEN"]
		connected := false
		if minted && token != "" {
			if defaultConfirm(s, a.Yes)("connect this device to the admin plane now (writes the url and token to your bullmoose config)? [Y/n] ") {
				if err := connectAdminPlane(cloudInstallDB(), adminURL, token); err != nil {
					s.Note("could not write the admin config (" + err.Error() + ") — run admin init by hand, below")
				} else {
					connected = true
				}
			}
		}
		if connected {
			s.Out("admin plane connected: " + adminURL)
			s.Out("next — let the stack wire its own mail path (nothing to copy):")
		} else {
			s.Out("next — connect the admin plane, then let the stack wire its own mail path:")
			s.Out("  bullmoose admin init --token <ADMIN_TOKEN above>   # --url is derived")
		}
	}
	s.Out("  bullmoose admin tenant add <name>")
	s.Out("  bullmoose admin domain add " + a.Zone + " --tenant <tenantId>   # MX + Email Routing + catch-all→ingest + SES DKIM/DMARC")
	s.Out("  bullmoose cloud doctor --zone " + a.Zone + "                    # read-only: did the mail path land?")

	s.Out("")
	s.Out("The webmail is already live at https://app." + a.Zone + " — its files were uploaded to R2")
	s.Out("and are served by bullmoose-webhost. There is no build step and nothing else to run.")
	return 0
}

// runCloudDoctor is the T4 verification surface: a read-only walk of the
// zone's mail path with the fixing command named per gap. It deliberately
// does not require the stack — it reads the ZONE, so it answers honestly
// before admin init, after domain add, and any time mail goes quiet.
func runCloudDoctor(s *bmio.Streams, a cloudArgs) int {
	if a.Zone == "" {
		return die(s, bmio.Fail("cloud doctor needs --zone <domain>", bmio.ExitUsage))
	}
	token := os.Getenv("CLOUDFLARE_API_TOKEN")
	if token == "" {
		return die(s, bmio.Fail("CLOUDFLARE_API_TOKEN is not set — the doctor is read-only but still needs to read the zone", bmio.ExitUsage))
	}
	report, err := cloud.MailDoctor(cloud.NewCF(os.Getenv("CLOUDFLARE_API_BASE_URL"), token, nil), a.Zone)
	if err != nil {
		return die(s, err)
	}
	if a.JSON {
		if err := s.EmitJSON(report); err != nil {
			return die(s, err)
		}
	} else {
		s.Out("mail path for " + report.Zone + ":")
		for _, c := range report.Checks {
			mark := "✓"
			if !c.OK {
				mark = "✗"
			}
			line := "  " + mark + " " + c.Name + " — " + c.State
			if c.Fix != "" {
				line += " → fix: " + c.Fix
			}
			s.Out(line)
		}
	}
	if !report.AllOK() {
		return int(bmio.ExitFail)
	}
	return 0
}

/**
 * `cloud site push --dir <built site>` — put a built webmail in R2.
 *
 * The install path uploads the PUBLISHED tarball; this uploads a directory
 * you just built. It exists so our own CI has something to call instead of
 * reimplementing the upload in bash: the content-type table, the key
 * escaping that keeps `_astro/app.js` two segments, and the "there must be
 * an index.html" rule then have exactly one home (internal/cloud/webmail.go)
 * rather than one per caller, drifting.
 *
 * The account comes from --account or CLOUDFLARE_ACCOUNT_ID, and only falls
 * back to deriving it from --zone. CI already holds the account id, and
 * asking it to spend `Zone > Read` for something it can be told is a wider
 * token for no reason.
 */
func runCloudSite(s *bmio.Streams, a cloudArgs) int {
	sub := ""
	if len(a.Positionals) > 1 {
		sub = a.Positionals[1]
	}
	if sub != "push" && sub != "prune" {
		return die(s, bmio.Fail("cloud site takes `push --dir <built site>` or `prune --prefix <prefix>`", bmio.ExitUsage))
	}
	if sub == "push" && a.Dir == "" {
		return die(s, bmio.Fail("cloud site push needs --dir <built site> (e.g. webmail/dist after `npm run -w webmail build`)", bmio.ExitUsage))
	}
	token := os.Getenv("CLOUDFLARE_API_TOKEN")
	if token == "" {
		return die(s, bmio.Fail("CLOUDFLARE_API_TOKEN is not set — this upload needs `Account > Workers R2 Storage > Edit`", bmio.ExitUsage))
	}
	bucket := a.Bucket
	if bucket == "" {
		bucket = cloud.WebmailBucket
	}
	cf := cloud.NewCF(os.Getenv("CLOUDFLARE_API_BASE_URL"), token, nil)

	acct := a.Account
	if acct == "" {
		acct = os.Getenv("CLOUDFLARE_ACCOUNT_ID")
	}
	if acct == "" {
		if a.Zone == "" {
			return die(s, bmio.Fail("no account: pass --account, set CLOUDFLARE_ACCOUNT_ID, or pass --zone to derive it", bmio.ExitUsage))
		}
		probe, err := cloud.Probe(cf, a.Zone)
		if err != nil {
			return die(s, err)
		}
		acct = probe.Zone.AccountID
	}

	if sub == "prune" {
		n, err := cloud.PruneSitePrefix(cf, acct, bucket, a.Prefix, func(line string) { s.Note("  " + line) })
		if err != nil {
			return die(s, err)
		}
		s.Out("pruned " + strconv.Itoa(n) + " object(s) from r2://" + bucket + "/" + strings.TrimSuffix(a.Prefix, "/") + ".")
		return 0
	}

	n, err := cloud.UploadSiteDir(cf, acct, bucket, a.Dir, a.Prefix, func(line string) { s.Note("  " + line) })
	if err != nil {
		if n > 0 {
			// Same contract as the installer: what landed stays, and a re-run
			// overwrites by key. Naming the count makes the retry informed
			// rather than a coin flip about whether to start over.
			s.Note("site push: stopped after " + strconv.Itoa(n) + " file(s) — re-running is safe, objects overwrite by key")
		}
		return die(s, err)
	}
	where := "r2://" + bucket
	if a.Prefix != "" {
		where += "/" + strings.TrimSuffix(a.Prefix, "/")
	}
	s.Out("site pushed to " + where + " (" + strconv.Itoa(n) + " objects).")
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

// cloudInstallDB is the device mirror `cloud install` may write the admin
// pair into. `cloud` owns no --db flag, so this is the ordinary resolution
// ($BULLMOOSE_DB, else ~/.bullmoose/mail.db) named in one place — which is
// also what lets a test point it somewhere harmless.
func cloudInstallDB() string { return store.DBPath("") }
