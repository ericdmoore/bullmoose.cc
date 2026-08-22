// Package cmd is where the native subcommands live (s08 T6,
// `.plans/s08-go-cli/devPlan.md:116`).
//
// Wave 1 (devPlan.md:135) fills the read-only / local-mirror commands:
// `mailboxes` ("mailbox list"), `search`, `log`, and `accounts` (the CLI's
// nearest thing to the plan's "whoami" — there is no `whoami` subcommand). Each
// reads packages/cli/src/db.ts's local SQLite mirror through internal/store and
// emits byte-identical output to the Node CLI via internal/io (bmio).
//
// Wave 2 (devPlan.md:146) fills the core mail verbs, `read` and `send` — the
// first PORTED commands that talk to the LIVE server (internal/jmap) rather than
// the mirror, and with `send` the first port of a MUTATION. Markdown sends
// (`--expandMD html`), login, token, watch and the vendored codecs are later
// waves.
//
// This package also still holds the T4 seams (cli/007, cli/008) that two closed
// `.feedback` findings are tested against (arch.md §6).
package cmd

import (
	"errors"
	"strings"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
)

// ErrNotImplemented marks a seam T6 has yet to fill. The cli/007 test treats it
// as "skip, for the right reason" rather than a satisfied assertion.
var ErrNotImplemented = errors.New("cli-go: native command not implemented (s08 T6)")

// spec describes one native command: whether it honours --json (the cli/008
// capability bit), whether it is Go-native-only (no Node twin), which flags its
// native implementation actually consumes, and the handler.
type spec struct {
	// json is true when the command honours --json with machine-readable
	// output. cli/008: --json is a GLOBAL flag (packages/cli/src/help.ts
	// GLOBAL_OPTIONS) yet was a silent no-op on eight commands. This bit must
	// never claim support the command does not actually deliver.
	json bool
	// goNative marks a command with NO TypeScript counterpart. Install wires such
	// a command through delegate.RegisterNativeOnly so Dispatch never delegates it
	// (Node has no such command) — the "byte-identical to Node" invariant does not
	// apply because there is nothing to match. `approvals` is the first (s08).
	goNative bool
	// value / boolean / short are the flags THIS command's native implementation
	// reads. Dispatch delegates any invocation carrying a flag outside its
	// command's set, so an unported path stays byte-identical instead of being
	// approximated (delegate/native.go).
	//
	// Per-command rather than one union, and `send` is why: silently dropping a
	// flag a human typed on a command that sends real mail is the wrong failure.
	// `send --expandMD html` must reach Node, which has the Markdown pipeline;
	// under a union it would have run the native plain-text path and sent the
	// wrong message.
	// selfParses marks a command that reads its OWN grammar instead of the
	// shared parse() in args.go. The ownership drift check skips those, because
	// the list it compares against is parse()'s — see registry_test.go.
	selfParses bool
	value      []string
	boolean    []string
	short      []string
	// run serves the command against the process streams, returning the exit
	// code. nil for a command listed for capability only.
	run func(s *bmio.Streams, argv []string) int
}

// registry is the single source of truth for which commands this binary serves
// natively. delegate.native is wired from exactly this set by Install, so routing
// and capability cannot drift apart.
//
//   - wave 1: four read-only local-mirror commands (mailboxes/search/log/accounts).
//   - approvals: Go-NATIVE-ONLY (s08) — the first command that talks to the LIVE
//     server (ActionProposal is not in the mirror). No Node twin, so it is
//     additive: the 61-case contract suite does not exercise it.
//   - agents: Go-NATIVE-ONLY (s10 T4) — the agent CONFIGURATION surface. Also
//     additive, and the first command on the CONTROL plane (the provision
//     worker's admin API) rather than the mail account's JMAP endpoint.
//   - wave 2: `read` and `send` — the core mail verbs, and the first PORTED
//     commands that talk to the live server. `send` is the first MUTATION with a
//     Node twin, so it is the first place the cli/009 single-account rule
//     (account.One) actually bites in a write, exactly as devPlan.md:151 predicted.
var registry = map[string]spec{
	"mailboxes": {json: true, run: runMailboxes,
		value: []string{"db", "account"}, boolean: []string{"json", "ids"}},
	"search": {json: true, run: runSearch,
		value: []string{"db", "account"}, boolean: []string{"json", "ids"}},
	"log": {json: true, run: runLog,
		value:   []string{"db", "account", "mailbox", "n"},
		boolean: []string{"json", "ids"}, short: []string{"n"}},
	"accounts": {json: true, run: runAccounts,
		value: []string{"db", "account"}, boolean: []string{"json", "ids"}},
	// `models` (s08 T6) sweeps the @local ladder. No --db and no --account: it
	// asks HOSTS, not the server, so it is the one read command that works with
	// no session at all. --key-env names an env var; the key itself never
	// reaches argv.
	// NOT goNative: Node HAS `models`, so the byte-identity contract applies and
	// the suite must be able to drive both.
	// `local` is registered WHOLE — connect and setup are verbs of one command,
	// so there is no way to make one native and leave the other delegating.
	// That forced the managed install to be ported too; defaultConfirm is
	// where the care went, because it is the one prompt whose wrong answer
	// installs software.
	// `creds` (s42, ported EXACTLY — the guards are the product): the vault.
	"creds": {json: true, run: runCreds,
		value: []string{"db", "url", "kind", "secret", "secret-env", "meta", "allow", "header",
			"scope", "enforcement", "authorize-url", "token-url", "client-id",
			"client-secret", "oauth-scopes", "port"},
		boolean: []string{"json", "dry-run"}},
	// `identity` (s42): list/show/signature/add/rm over Identity/get + /set.
	"identity": {json: true, run: runIdentity,
		value:   []string{"db", "account", "name", "reply-to", "bcc", "text", "html", "if-state"},
		boolean: []string{"json", "ids", "dry-run", "clear"}},
	// `repoint` (s42): move the stored base WITHOUT re-authenticating.
	// Validates before writing — see repoint.go.
	"repoint": {json: true, run: runRepoint,
		value: []string{"db", "base"}, boolean: []string{"json"}},
	// `discover` (s42): the autodiscovery ladder, read-only, no session needed.
	"discover": {json: true, run: runDiscover,
		// --db is owned and IGNORED, exactly as Node ignores it: it is a global
		// flag there, and a command must own it or `--db` delegates.
		value: []string{"db"}, boolean: []string{"json"}},
	// `vacation` (s42): the RFC 8621 singleton. --until parses CLIENT-side so a
	// garbage date refuses before any request.
	"vacation": {json: true, run: runVacation,
		value:   []string{"db", "account", "subject", "body", "until", "if-state"},
		boolean: []string{"json", "dry-run"}},
	// `share` (s42's first port): list + revoke over the /api/shares REST pair.
	"share": {json: true, run: runShare,
		value:   []string{"db", "account"},
		boolean: []string{"json", "ids", "dry-run"}},
	"local": {json: true, run: runLocal,
		value:   []string{"db", "host", "key-env"},
		boolean: []string{"json", "ids", "yes", "dry-run"}},
	"models": {json: true, run: runModels,
		// --db is owned because the sweep reads the SAVED @local host from the
		// mirror's config table. Without it, `models --db <path>` would
		// delegate and this native path would never run for the one
		// invocation that most needs a specific mirror.
		value: []string{"db", "host", "key-env"}, boolean: []string{"json", "ids"}},
	"read": {json: true, run: runRead,
		value: []string{"db", "account"}, boolean: []string{"json", "ids", "raw"}},
	// \`send\` owns the Markdown pipeline now (s08 T6): --expandMD renders with
	// goldmark, resolves assets to cid:/attachment/expiring-link, assembles the
	// RFC 5322 message and imports it. Byte-identity with Node is DELIBERATELY
	// not claimed for the rendered HTML (the marked→goldmark divergence,
	// internal/markdown) — the submission choreography and the chrome line are
	// still exact. Moving these three flags INTO the owned set is what flips
	// the invocation native; before this line, their presence delegated the
	// whole send to Node.
	"send": {json: true, run: runSend,
		value: []string{"db", "account", "from", "identity", "to", "cc", "bcc", "subject", "file", "body",
			"expandMD", "linkMax", "linkTTL"},
		boolean: []string{"json"}},
	"approvals": {json: true, goNative: true, run: runApprovals},
	"agents":    {json: true, goNative: true, run: runAgents},
	// ---- wave 3 (devPlan.md:154): the standalone gate ----
	//
	// `login` and `init` are the two commands that CREATE the local mirror, so
	// until they landed a Go-only machine had nothing for `watch` to read. They
	// are listed last in the plan's order on purpose: they are the commands the
	// conformance vectors exist for, so porting them last means the vectors are
	// proven by the time the credential paths use them.
	//
	// DELIBERATELY ABSENT from `login`: --account (cmdLogin never reads it) and
	// --token (a login MINTS the token; accepting one would be `init`).
	"login": {json: true, run: runLogin,
		value:   []string{"db", "base", "name", "scopes", "password"},
		boolean: []string{"json", "ids"}},
	// `init` owns --url as well as --base: the alias is documented, and silently
	// discarding it is cli/010 §5. No --ids — cmdInit does not read it, and
	// claiming a flag the native path ignores is the cli/008 shape.
	"init": {json: true, run: runInit,
		value:   []string{"db", "base", "url", "token", "account"},
		boolean: []string{"json", "offline"}},
	// `token` owns --dry-run because `revoke` reads it (tokens.ts:214); `create`
	// and `list` do not, and an unowned flag on those would delegate, which is
	// the safe direction.
	"token": {json: true, run: runToken,
		value:   []string{"db", "name", "scopes"},
		boolean: []string{"json", "ids", "dry-run"}},
	// `sync` is the one-shot counterpart to `watch`, over the SAME engine
	// (internal/mirror). It owns --blobs: the blob mirror is ported (mirror's
	// downloadBlob), so an invocation that asks for it runs natively rather than
	// delegating a flag the native path would otherwise have to ignore.
	// DELIBERATELY ABSENT: --ids, which cmdSync does not read.
	"sync": {json: true, run: runSync,
		value:   []string{"db", "account", "blobs"},
		boolean: []string{"json"}},
	// ---- wave 4 (devPlan.md:150): the vendored codecs ----
	//
	// `contacts` and `calendar` are the two commands the plan told us to budget
	// for, because each carries a codec the CLI cannot import at runtime and
	// therefore vendors: vCard ⇄ JSContact (internal/vcard) and iCal/RRULE
	// (internal/ical). Both have Node twins, so byte-identity applies and both
	// declare every flag their native path consumes.
	//
	// `contacts` owns exactly cmdContacts's reads (contacts.ts:301): --account,
	// --book, -n, --force, plus the four I/O-contract flags. Nothing is
	// deliberately withheld here, unlike `send` — there is no half-ported branch
	// behind a flag, so there is no flag a user can type that the native path
	// would silently ignore.
	"contacts": {json: true, run: runContacts,
		value:   []string{"db", "account", "book", "n", "as", "if-state"},
		boolean: []string{"json", "ids", "dry-run", "force"},
		short:   []string{"n"}},
	// `calendar`'s set is exactly cmdCalendar's reads (calendar.ts:310). Note
	// --days is shared with `creds` in the TypeScript flag table; here it belongs
	// to `agenda`, and per-command ownership is why that is not a problem.
	"calendar": {json: true, run: runCalendar,
		value: []string{"db", "account", "days", "title", "start", "duration", "tz",
			"rrule", "calendar", "occurrence", "as", "if-state"},
		boolean: []string{"json", "ids", "dry-run", "force", "all-day", "ics"}},
	// ---- wave 5: the folder surface, one message, and the blob store ----
	//
	// `mailbox` owns exactly cmdMailbox's reads (main.ts:359 + mailbox.ts's
	// MailboxOpts): --account, --parent, --sort, --force, plus --json/--ids/
	// --dry-run/--if-state.
	// DELIBERATELY ABSENT: --as. MailboxOpts extends IoOpts so the field exists,
	// but nothing in mailbox.ts reads it — claiming it would be the cli/008 shape
	// in reverse, a flag the native path accepts and ignores.
	"mailbox": {json: true, run: runMailbox,
		value:   []string{"db", "account", "parent", "sort", "if-state"},
		boolean: []string{"json", "ids", "dry-run", "force"}},
	// `show` is the mirror-resolved counterpart of `read`, and its flag set says
	// so: main.ts:1106 reads --account (as a FAN-OUT selector), --json and --ids
	// and nothing else. No --if-state (it writes nothing), no --raw (that is
	// `read`'s), no --dry-run.
	"show": {json: true, run: runShow,
		value: []string{"db", "account"}, boolean: []string{"json", "ids"}},
	// `blobs` owns cmdBlobs's reads (main.ts:401): --account plus the I/O flags.
	// --dry-run is `rm`'s rehearsal; `list` ignores it, as in the TypeScript.
	"blobs": {json: true, run: runBlobs,
		value: []string{"db", "account"}, boolean: []string{"json", "ids", "dry-run"}},
	// watch has a Node twin, so byte-identity applies and it must declare every
	// flag its native path consumes — `--exec` above all, since an undeclared one
	// would silently delegate forever and the port would never run. It parses its
	// own grammar (cmd/watch.go) rather than the shared parse(), hence selfParses.
	"watch": {
		json:       true,
		selfParses: true,
		value:      []string{"db", "account", "exec"},
		boolean:    []string{"json", "daemon", "status", "stop"},
		run:        runWatch,
	},
}

// triageVerbs is every spelling of a triage verb main.ts:368-376 routes to
// cmdTriage. They share one spec because they share one implementation and one
// flag grammar — `flag` reads --add/--remove as keywords and `label` reads them
// as mailboxes, but the PARSE is identical, and a per-verb subset would mean
// `archive --unset` delegating while `seen --unset` did not for no reason a user
// could predict.
//
// `delete` is here as well as `rm` because main.ts declares both cases; runTriage
// folds the alias.
var triageVerbs = []string{
	"flag", "seen", "move", "label", "archive", "junk", "trash", "rm", "delete",
}

// The flags cmdTriage actually reads (main.ts:377 + triage.ts's TriageOpts).
//
// DELIBERATELY ABSENT: --ids. TriageOpts carries it — every command module gets
// the whole IoOpts spread — but triage.ts's report() never reads it, because a
// triage verb's stdout is ALREADY bare ids. Claiming it would be the cli/008
// shape in reverse: a flag the native path accepts and ignores.
var (
	triageValueFlags   = []string{"db", "account", "add", "remove", "role", "mailbox", "if-state"}
	triageBooleanFlags = []string{"json", "dry-run", "force", "unset", "no-sync"}
)

func init() {
	for _, verb := range triageVerbs {
		registry[verb] = spec{
			json: true, run: runTriage,
			value: triageValueFlags, boolean: triageBooleanFlags,
		}
	}
}

// SupportsJSON reports whether the NATIVE command honours --json, and whether it
// is implemented at all. A command that still delegates is (false, false): the
// cli/008 test skips those rather than failing, because the requirement is about
// commands this binary actually serves — a delegated command's --json is the
// TypeScript CLI's job.
func SupportsJSON(command string) (jsonSupported, implemented bool) {
	if s, ok := registry[command]; ok {
		return s.json, true
	}
	// The cli/008 regression set names two entries by VERB ("token create",
	// "token revoke") because that is how the finding was written. The registry is
	// keyed by command, and a command's `json` bit is a claim about every verb it
	// serves — `token` honours --json on create, list and revoke alike — so a
	// verb resolves to its command rather than reporting "not implemented" and
	// leaving the requirement asleep.
	if head, _, found := strings.Cut(command, " "); found {
		if s, ok := registry[head]; ok {
			return s.json, true
		}
	}
	return false, false
}

// Install wires every registered native command into the delegate's routing map
// (via the callbacks main.go passes). Each handler is bound to the process
// streams (bmio.New) at call time, so a broken-pipe mid-output exits 0 exactly as
// io.ts does. A goNative command is additionally registered as native-only, so
// Dispatch never delegates it. Keeping delegate.native derived from this registry
// is what keeps the routing table and the cli/008 capability table the same source.
func Install(
	register func(command string, run func(argv []string) int),
	registerNativeOnly func(command string),
	registerFlags func(command string, value, boolean, short []string),
) {
	for name, s := range registry {
		if s.run == nil {
			continue
		}
		run := s.run
		register(name, func(argv []string) int { return run(bmio.New(), argv) })
		if s.goNative {
			registerNativeOnly(name)
			continue // no Node twin → no byte-identity guard to feed
		}
		registerFlags(name, s.value, s.boolean, s.short)
	}
}
