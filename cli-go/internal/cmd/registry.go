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
	"read": {json: true, run: runRead,
		value: []string{"db", "account"}, boolean: []string{"json", "ids", "raw"}},
	// `send`'s set is exactly main.ts:568 cmdSend's reads and no more.
	// DELIBERATELY ABSENT: --expandMD / --linkMax / --linkTTL (the Markdown →
	// MIME pipeline, `marked` + processAssets + buildMime, not ported — decision
	// 3, devPlan.md:179, is still open), and --dry-run/--if-state, which cmdSend
	// does not read either. Any of them present → the invocation delegates and
	// Node does the whole send.
	"send": {json: true, run: runSend,
		value:   []string{"db", "account", "from", "identity", "to", "cc", "bcc", "subject", "file", "body"},
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
