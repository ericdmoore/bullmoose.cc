// Package watch is where the native `watch` command will live (s08 T6,
// `.plans/s08-go-cli/devPlan.md:126`).
//
// Only the `--exec` hook contract is defined here so far, and deliberately as a
// failing test before the command exists (`arch.md` §6). The closed finding
// `.feedback/fromClaude/cli/006` is fixed in TypeScript the Go port will never
// read, so a fresh implementation re-derives the shell-injection blocklist by
// default. T4's job is that the test catches the regression the instant it is
// reintroduced — which is why BuildHookPlan is a seam now and an implementation
// in T6, not the other way round.
package watch

import "errors"

// HookPreviewMax caps $BM_PREVIEW so a huge body cannot blow the env size
// limit. Mirrors HOOK_PREVIEW_MAX in packages/cli/src/watch.ts.
const HookPreviewMax = 120

// ErrNotImplemented is returned by BuildHookPlan until T6 writes the native
// watch command. The cli/006 test treats this sentinel as "skip, for the right
// reason" — never as a satisfied assertion — so the security property enforces
// itself the moment this stops being returned. See cli006_test.go.
var ErrNotImplemented = errors.New("cli-go: native `watch --exec` not implemented (s08 T6)")

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

// BuildHookPlan is the seam cli006_test.go asserts against. T6 implements it;
// until then it returns ErrNotImplemented so the test skips rather than passing
// for the wrong reason.
//
// The implementation T6 lands must satisfy: Args contains the template verbatim
// with no field interpolated, and every HookFields value appears only in Env,
// literal and uninterpreted (BM_ID, BM_ACCOUNT, BM_FROM, BM_SUBJECT, BM_PREVIEW
// truncated to HookPreviewMax).
func BuildHookPlan(template string, fields HookFields) (HookPlan, error) {
	return HookPlan{}, ErrNotImplemented
}
