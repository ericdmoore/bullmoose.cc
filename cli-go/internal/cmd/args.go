package cmd

import (
	"strings"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
)

// args is the parsed view a native command needs. It is intentionally NARROW:
// delegate.Dispatch only routes an invocation here when every flag it carries is
// one the TARGET command understands (delegate/native.go ownedNatively, fed from
// this package's registry), so this parser never has to reject an unknown flag or
// render help — those went to Node. That keeps the whole flag grammar and the
// help system (packages/cli/src/help.ts, ~1k lines) on the TypeScript side until
// a later wave.
type args struct {
	JSON        bool
	IDs         bool
	Raw         bool // `read --raw` — the RFC 5322 source
	DB          string
	Account     string
	Mailbox     string
	N           string // -n / --n, default "20" as main.ts:159
	Positionals []string

	// ---- compose (`send`, main.ts:86-93) ----
	//
	// To/CC/BCC are `multiple: true` in the parseArgs spec, so repetition
	// ACCUMULATES rather than overwrites; each element may itself be a
	// comma-separated list, which splitAddresses flattens (main.ts:767).
	To       []string
	CC       []string
	BCC      []string
	Subject  string
	From     string
	Identity string
	File     string
	Body     string
	// ---- the Markdown pipeline (`send --expandMD`, s08 T6) ----
	// Until is `vacation on --until <date>` — parsed to RFC 3339 at use.
	Until string

	// ---- identity (`identity signature|add`, s42) ----
	// ---- creds (`creds set|oauth`, s42 — the vault) ----
	//
	// SecretEnv NAMES an env var; Secret carries a literal for scripting; the
	// hidden prompt is the human path. CredScope carries --scope (singular —
	// the token flag is --scopes, PLURAL, so there is no collision; the first
	// draft renamed this to --cred-scope against an imagined one, and the
	// parser-grammar drift test caught the invented flag immediately).
	// ---- admin (s42 — the operator plane) ----
	Tenant         string
	Principal      string
	SLA            string
	ReplyMode      string
	Expires        string
	IncludeDeleted bool
	Provider       string
	Model          string
	Budget         string
	// Explore is repeatable — each use adds one frontier arm.
	Explore []string
	Config  string

	Kind         string
	Secret       string
	SecretEnv    string
	Meta         string
	Allow        string
	Header       string
	CredScope    string
	Enforcement  string
	AuthorizeURL string
	TokenURL     string
	ClientID     string
	ClientSecret string
	OAuthScopes  string
	Port         string

	ReplyTo string
	// Text/HTML are signature SOURCES (a path, or "-" for stdin), not content.
	Text    string
	HasText bool
	HTML    string
	HasHTML bool
	Clear   bool

	ExpandMD string // "html" is the only accepted value; "" = plain text
	LinkMax  string // MiB before a file becomes an expiring link (default 4)
	LinkTTL  string // days an expiring link lives (default 30)

	// HasBody records PRESENCE, not truthiness: main.ts:778 tests
	// `opts.body !== undefined`, so `--body ""` is an explicit empty body and
	// must NOT fall through to stdin.
	HasBody bool

	// ---- the @local ladder (`local`, `models`, s08 T6) ----
	//
	// KeyEnv is the NAME of an environment variable, never a key. A local host
	// behind LiteLLM's master key is reachable without that key ever appearing
	// in argv, history, or a process listing.
	Host   string
	KeyEnv string
	// Yes is consent given AHEAD of time for `local setup`'s managed install.
	// It is the only thing besides an explicit y/yes that may proceed — see
	// defaultConfirm, which fails closed on everything else.
	Yes bool

	// ---- the credential gate (`login`, `init`, `token`) ----
	//
	// Every flag here records PRESENCE beside its value, for the same reason
	// --body does, and here it is load-bearing repeatedly. All of main.ts's reads
	// are `??`, which is nullish — NOT falsy — so an explicitly empty flag is a
	// value:
	//
	//	--scopes ""    a usage error, not "the server default" (scopes.ts:57);
	//	               absent-vs-empty is the whole of the cli/007 fix
	//	--password ""  an explicit empty password (the vector has a case for it),
	//	               not a reason to open a prompt the user did not ask for
	//	--token ""     `init`'s `opts.token ?? boot.token` keeps the empty flag and
	//	               refuses, rather than silently using the bootstrap file's
	Base       string
	HasBase    bool
	URL        string // `init --url`, the documented alias for --base
	Token      string
	HasToken   bool
	HasAccount bool
	Name       string
	Scopes     string
	HasScopes  bool
	// Password is never printed, never logged and never stored. It exists in this
	// struct for the length of one derivation; what travels is the derived key.
	Password    string
	HasPassword bool
	Offline     bool
	DryRun      bool

	// ---- the triage verbs (sVOL 019, triage.ts) ----
	//
	// Add/Remove are `multiple: true` in the parseArgs spec (main.ts:167), so
	// repetition ACCUMULATES rather than overwrites: `--add '$flagged' --add
	// '$important'` is two keywords, and a port that assigned would silently drop
	// the first. Unlike --to they are NOT comma-split — a keyword may legitimately
	// contain one.
	Add    []string
	Remove []string
	Role   string
	Unset  bool
	NoSync bool
	// Force and IfState are declared below with the I/O-contract flags: that pair
	// also tracks PRESENCE (HasIfState), which the triage verbs do not need but
	// which is a superset of what they read.

	// ---- sync ----
	//
	// Blobs is `--blobs <dir>`: mirror every message's RFC 5322 source beside the
	// metadata. Absent means metadata only.
	Blobs string
	// ---- the I/O contract's own remaining flags (arch.md §1.4 / §1.7) ----
	//
	// `--as` and `--if-state` record PRESENCE for the same reason --body does:
	// io.ts:371 tests `opts.as` for undefined (an empty --as is a usage error, not
	// "infer"), and contacts.ts:791 sends `ifInState` iff the flag is present.
	As         string
	HasAs      bool
	IfState    string
	HasIfState bool
	// Force is `books rm`/`calendar rm`'s onDestroyRemove* and `contacts`' own
	// non-empty-book confirmation. Distinct from `--yes`, which the admin verbs use.
	Force bool

	// ---- contacts (sVOL 017) ----
	Book string

	// ---- mailbox CRUD (sVOL 004) ----
	//
	// Both record PRESENCE, and both need to: mailbox.ts:62 sets parentId iff
	// `opts.parent !== undefined`, and `mailbox move` reads the same distinction
	// as its required-argument check — so `--parent ""` is an explicit (and
	// unresolvable) answer where a missing --parent is a usage error. `--sort ""`
	// is likewise a value: `Number("")` is 0, a legal sortOrder.
	Parent    string
	HasParent bool
	Sort      string
	HasSort   bool

	// ---- calendar (sVOL 018) ----
	//
	// Every value flag here records presence, because calendar.ts:528
	// applyEventFlags overlays a field iff `opts.X !== undefined` — so
	// `--title ""` clears a title and is NOT the same as omitting it, and
	// `--occurrence ""` still hits the deferred-feature refusal.
	Days          string
	Title         string
	HasTitle      bool
	Start         string
	HasStart      bool
	Duration      string
	HasDuration   bool
	TZ            string
	HasTZ         bool
	AllDay        bool
	RRule         string
	HasRRule      bool
	Calendar      string
	Occurrence    string
	HasOccurrence bool
	ICS           bool
}

// scopesFlag returns --scopes the way scopes.ParseFlag wants it: nil for absent,
// a pointer to the (possibly empty) value for present.
func (a args) scopesFlag() *string {
	if !a.HasScopes {
		return nil
	}
	return &a.Scopes
}

// at is positionals[n] or "" — main.ts reads a missing positional as undefined
// and every consumer treats that as absent.
func (a args) at(n int) string {
	if n < len(a.Positionals) {
		return a.Positionals[n]
	}
	return ""
}

// Which command owns which flag now lives in registry.go, one entry per command,
// and is pushed to delegate.RegisterFlags from there — so the guard and the
// parser below are fed from the same declaration rather than from two lists that
// have to be kept level by hand.
//
// parse walks argv the way node:util parseArgs (main.ts:65) would for this
// narrow flag set: `--flag value`, `--flag=value`, `-n value`, booleans, and a
// `--` end-of-options marker. Positionals[0] is the command name (main.ts:183).
func parse(argv []string) args {
	a := args{N: "20"} // main.ts:159 default
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
			case "ids":
				a.IDs = true
			case "raw":
				a.Raw = true
			case "db":
				a.DB = value()
			case "account":
				a.Account = value()
				a.HasAccount = true
			case "mailbox":
				a.Mailbox = value()
			case "n":
				a.N = value()
			case "host":
				a.Host = value()
			case "key-env":
				a.KeyEnv = value()
			case "expandMD":
				a.ExpandMD = value()
			case "linkMax":
				a.LinkMax = value()
			case "linkTTL":
				a.LinkTTL = value()
			case "until":
				a.Until = value()
			case "reply-to":
				a.ReplyTo = value()
			case "tenant":
				a.Tenant = value()
			case "principal":
				a.Principal = value()
			case "sla":
				a.SLA = value()
			case "reply-mode":
				a.ReplyMode = value()
			case "expires":
				a.Expires = value()
			case "include-deleted":
				a.IncludeDeleted = true
			case "provider":
				a.Provider = value()
			case "model":
				a.Model = value()
			case "budget":
				a.Budget = value()
			case "explore":
				a.Explore = append(a.Explore, value())
			case "config":
				a.Config = value()
			case "kind":
				a.Kind = value()
			case "secret":
				a.Secret = value()
			case "secret-env":
				a.SecretEnv = value()
			case "meta":
				a.Meta = value()
			case "allow":
				a.Allow = value()
			case "header":
				a.Header = value()
			case "scope":
				a.CredScope = value()
			case "enforcement":
				a.Enforcement = value()
			case "authorize-url":
				a.AuthorizeURL = value()
			case "token-url":
				a.TokenURL = value()
			case "client-id":
				a.ClientID = value()
			case "client-secret":
				a.ClientSecret = value()
			case "oauth-scopes":
				a.OAuthScopes = value()
			case "port":
				a.Port = value()
			case "text":
				a.Text = value()
				a.HasText = true
			case "html":
				a.HTML = value()
				a.HasHTML = true
			case "clear":
				a.Clear = true
			case "yes":
				a.Yes = true
			case "to":
				a.To = append(a.To, value())
			case "cc":
				a.CC = append(a.CC, value())
			case "bcc":
				a.BCC = append(a.BCC, value())
			case "subject":
				a.Subject = value()
			case "from":
				a.From = value()
			case "identity":
				a.Identity = value()
			case "file":
				a.File = value()
			case "body":
				a.Body = value()
				a.HasBody = true
			case "base":
				a.Base = value()
				a.HasBase = true
			case "url":
				a.URL = value()
			case "token":
				a.Token = value()
				a.HasToken = true
			case "name":
				a.Name = value()
			case "scopes":
				a.Scopes = value()
				a.HasScopes = true
			case "password":
				a.Password = value()
				a.HasPassword = true
			case "offline":
				a.Offline = true
			case "dry-run":
				a.DryRun = true
			case "add":
				a.Add = append(a.Add, value())
			case "remove":
				a.Remove = append(a.Remove, value())
			case "role":
				a.Role = value()
			case "force":
				a.Force = true
			case "unset":
				a.Unset = true
			case "no-sync":
				a.NoSync = true
			case "blobs":
				a.Blobs = value()
			case "as":
				a.As = value()
				a.HasAs = true
			case "if-state":
				a.IfState = value()
				a.HasIfState = true
			case "book":
				a.Book = value()
			case "parent":
				a.Parent = value()
				a.HasParent = true
			case "sort":
				a.Sort = value()
				a.HasSort = true
			case "days":
				a.Days = value()
			case "title":
				a.Title = value()
				a.HasTitle = true
			case "start":
				a.Start = value()
				a.HasStart = true
			case "duration":
				a.Duration = value()
				a.HasDuration = true
			case "tz":
				a.TZ = value()
				a.HasTZ = true
			case "all-day":
				a.AllDay = true
			case "rrule":
				a.RRule = value()
				a.HasRRule = true
			case "calendar":
				a.Calendar = value()
			case "occurrence":
				a.Occurrence = value()
				a.HasOccurrence = true
			case "ics":
				a.ICS = true
			}

		case arg == "-n":
			if i+1 < len(argv) {
				i++
				a.N = argv[i]
			}

		default:
			// A positional, including a bare "-" (stdin marker, arch.md §1.4).
			a.Positionals = append(a.Positionals, arg)
		}
	}
	return a
}

// die is the one exit path, io.ts:436: `error: <message>` on stderr, and the
// code the §1.5 table maps the error to (bmio.ExitCodeFor). A CliError carries
// its own code (usage → 2, notFound → 3); anything else falls to 1.
func die(s *bmio.Streams, err error) int {
	s.Note("error: " + bmio.ErrorMessage(err))
	return int(bmio.ExitCodeFor(err))
}
