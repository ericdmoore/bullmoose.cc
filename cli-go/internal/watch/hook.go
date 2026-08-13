// Package watch is the native `watch` command's engine (s08 T6,
// `.plans/s08-go-cli/devPlan.md:126`) — the push channel, the changes cursor,
// the event stream, and the `--exec` hook.
//
// The `--exec` contract was staked out here as a deliberately failing test
// BEFORE the command existed (`arch.md` §6). The closed finding
// `.feedback/fromClaude/cli/006` is fixed in TypeScript that the Go port will
// never read, so a fresh implementation re-derives the shell-injection blocklist
// by default. cli006_test.go is what makes that impossible: it skipped while
// BuildHookPlan returned ErrNotImplemented and became enforcing the moment this
// file stopped returning it. Nothing in that test was relaxed to make it pass.
package watch

import (
	"errors"
	"os"
	"os/exec"
	"strings"
)

// HookPreviewMax caps $BM_PREVIEW so a huge body cannot blow the env size
// limit. Mirrors HOOK_PREVIEW_MAX in packages/cli/src/watch.ts.
const HookPreviewMax = 120

// ErrNotImplemented was returned by BuildHookPlan until this file implemented
// it. It is KEPT — cli006_test.go treats the sentinel as "skip, for the right
// reason", so deleting it would edit the test, and the test is the contract.
// Nothing returns it any more, which is exactly why the cli/006 assertions now
// run on every `go test`.
var ErrNotImplemented = errors.New("cli-go: native `watch --exec` not implemented (s08 T6)")

// ErrEmptyTemplate refuses `--exec ""`. A hook that runs the empty command is a
// typo, and running `sh -c ""` per message forever is a silent one.
var ErrEmptyTemplate = errors.New("--exec needs a command")

// HookFields are the message fields a `--exec` hook receives. EVERY one is
// attacker-controlled: a stranger chooses the subject, display name and body of
// the mail they send you. That is the whole reason cli/006 exists.
type HookFields struct {
	ID      string
	Account string
	From    string
	Subject string
	Preview string
}

// HookPlan is what would be handed to the OS to run one `--exec` hook.
//
// SECURITY CONTRACT (cli/006, do not weaken): Args carries ONLY the operator's
// own template, byte-for-byte. Not one HookFields value is ever spliced into
// Command or Args — they reach the hook through Env, where the shell copies
// them as opaque bytes and the operator's quoting alone decides how they
// expand. The original defect interpolated the fields into the command string
// and leaned on a character blocklist; that is remotely-triggered RCE the
// moment a template leaves a placeholder outside double quotes. Escaping shell
// metacharacters is not a winnable game — the lesson of cli/006 is that a
// blocklist was the wrong *shape*, so the port must not re-derive one.
type HookPlan struct {
	// Command is the program to run. Env is delivered to it as environment.
	Command string
	Args    []string
	Env     map[string]string
}

// legacyPlaceholders are the substitutions the OLD, injectable contract
// performed. They are recognised only so the watcher can WARN; substituting them
// is the vulnerability (watch.ts:70).
var legacyPlaceholders = []string{"{id}", "{from}", "{subject}", "{preview}"}

// LegacyPlaceholders reports which retired `{…}` placeholders a template still
// uses — watch.ts:73. A template written against the old contract otherwise
// fails silently (the literal `{subject}` reaches the shell), so `watch` says so
// once at startup and then leaves it alone.
func LegacyPlaceholders(template string) []string {
	var found []string
	for _, p := range legacyPlaceholders {
		if strings.Contains(template, p) {
			found = append(found, p)
		}
	}
	return found
}

// LegacyPlaceholderWarning is the one-line hint watch.ts:163 prints. Kept as a
// constant so the Go and TypeScript wordings can be diffed by eye.
const LegacyPlaceholderWarning = " are no longer substituted (they were a shell-injection vector). " +
	"Use the environment instead: $BM_ID $BM_ACCOUNT $BM_FROM $BM_SUBJECT $BM_PREVIEW — " +
	`e.g. --exec 'notify-send "$BM_FROM: $BM_SUBJECT"'`

// BuildHookPlan turns the operator's template and one message into the exact
// argv + environment the hook will run with.
//
// The whole security property is the shape of what it returns, and it is worth
// stating as three facts rather than as a rule to remember:
//
//  1. Args is ALWAYS exactly {"-c", template}. There is no code path on which a
//     field is concatenated, escaped, quoted or substituted into it — so there
//     is no escaping to get wrong, and the "does this blocklist cover `$(`?"
//     question never arises.
//  2. Fields travel in Env. execve carries them as counted byte strings, not as
//     shell source: the shell receives them AFTER parsing is over, so no byte in
//     a subject can change how the template parses.
//  3. Whether an expansion is quoted is the OPERATOR's decision about their own
//     text, which is the only place that decision can be made safely.
//
// This is a straight port of watch.ts:89 hookPlan, which is the shape the
// TypeScript fix arrived at. It is not bug-compatible with the DEFECT — nothing
// here reproduces the `{subject}` substitution — and cli006_test.go's
// "through a real shell" case asserts exactly that: a template containing an
// unquoted `{subject}` prints the literal `{subject}`.
func BuildHookPlan(template string, fields HookFields) (HookPlan, error) {
	if strings.TrimSpace(template) == "" {
		return HookPlan{}, ErrEmptyTemplate
	}
	env := environMap(os.Environ())
	env["BM_ID"] = fields.ID
	env["BM_ACCOUNT"] = fields.Account
	env["BM_FROM"] = fields.From
	env["BM_SUBJECT"] = fields.Subject
	env["BM_PREVIEW"] = truncateBytes(fields.Preview, HookPreviewMax)
	return HookPlan{
		Command: "sh",
		// The operator's template, verbatim, as ONE argv element. `sh -c` parses
		// this and only this.
		Args: []string{"-c", template},
		Env:  env,
	}, nil
}

// HookOptions are the run-time knobs, separate from the plan so the plan stays a
// pure value the test can inspect.
type HookOptions struct {
	// JSON routes the hook's stdout to OUR stderr. Under --json stdout is an
	// NDJSON data stream, and a chatty hook would corrupt it — the secondary
	// defect in cli/006, whose own documented example combined both flags.
	JSON bool
	// OnError reports a hook that could not be started. A hook failure is never
	// fatal to the watcher.
	OnError func(string)
}

// RunHook starts one hook and does NOT wait for it — watch.ts:124. Fire-and-
// forget is a requirement, not an optimisation: a hook that blocks (an editor, a
// prompt, a slow HTTP call) must never stall the sync loop behind it.
//
// The child gets NO stdin (a hook must never steal the terminal) and is reaped
// by a goroutine so a long-running watcher does not accumulate zombies — the one
// thing Go has to do explicitly that Node's runtime does for you.
func RunHook(plan HookPlan, opts HookOptions) {
	cmd := exec.Command(plan.Command, plan.Args...) //nolint:gosec // see BuildHookPlan
	cmd.Env = envPairs(plan.Env)
	cmd.Stdin = nil // → /dev/null, watch.ts:109's "ignore"
	cmd.Stdout = os.Stdout
	if opts.JSON {
		cmd.Stdout = os.Stderr
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		if opts.OnError != nil {
			opts.OnError("--exec failed: " + err.Error())
		}
		return
	}
	go func() { _ = cmd.Wait() }()
}

// environMap parses a "KEY=VALUE" environment into a map. A malformed entry
// (no "=") is dropped, which is what execve would make of it anyway.
func environMap(environ []string) map[string]string {
	out := make(map[string]string, len(environ)+5)
	for _, entry := range environ {
		if key, value, ok := strings.Cut(entry, "="); ok {
			out[key] = value
		}
	}
	return out
}

// envPairs renders the plan's env as the "KEY=VALUE" slice os/exec wants.
func envPairs(env map[string]string) []string {
	out := make([]string, 0, len(env))
	for k, v := range env {
		out = append(out, k+"="+v)
	}
	return out
}

// truncateBytes cuts to at most n BYTES, which is what
// `preview.slice(0, HOOK_PREVIEW_MAX)` bounds in the environment. It backs off
// to a rune boundary so the value stays valid UTF-8 — a JS slice can split a
// surrogate pair, and reproducing that particular bug is not fidelity.
func truncateBytes(s string, n int) string {
	if len(s) <= n {
		return s
	}
	cut := n
	for cut > 0 && !utf8Start(s[cut]) {
		cut--
	}
	return s[:cut]
}

// utf8Start reports whether b begins a UTF-8 sequence (i.e. is not a 10xxxxxx
// continuation byte).
func utf8Start(b byte) bool { return b&0xC0 != 0x80 }
