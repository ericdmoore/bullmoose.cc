package markdown

import (
	"regexp"
	"strings"
	"testing"
)

// #292's constraints are the design, so they are the test: two elements get
// inline styles, nothing else does, and the styles carry no colour and no
// absolute unit. A stylesheet-happy edit fails here rather than in someone's
// dark-mode inbox.

func render(t *testing.T, src string) string {
	t.Helper()
	out, err := ToHTML(src)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestMailStyle_OnlyTheTwoExceptionsCarryStyle(t *testing.T) {
	html := render(t, `# h

para with `+"`code`"+` and *em*.

> quote

- item

| a | b |
|---|---|
| 1 | 2 |

`+"```go\nfenced := true\n```"+`

[link](https://x.dev)
`)
	styled := regexp.MustCompile(`<([a-z]+)[^>]*\sstyle="`).FindAllStringSubmatch(html, -1)
	seen := map[string]bool{}
	for _, m := range styled {
		seen[m[1]] = true
	}
	for tag := range seen {
		switch tag {
		case "table", "th", "td", "code":
		default:
			t.Errorf("%s carries an inline style — #292 ships styles for tables and inline code ONLY", tag)
		}
	}
	// The fenced block's <code> is inside <pre>: clients render that
	// distinctly already, and styling it was not asked for.
	if pre := strings.Index(html, "<pre>"); pre >= 0 {
		block := html[pre:]
		if end := strings.Index(block, "</pre>"); end > 0 {
			if strings.Contains(block[:end], "style=") {
				t.Error("a fenced block was styled — only INLINE code spans are the exception")
			}
		}
	}
}

func TestMailStyle_NoColoursNoAbsoluteUnits(t *testing.T) {
	html := render(t, "| a |\n|---|\n| 1 |\n\nand `code`\n")
	for _, style := range regexp.MustCompile(`style="([^"]*)"`).FindAllStringSubmatch(html, -1) {
		v := style[1]
		// A hardcoded colour is how a message goes black-on-black in a dark
		// theme; rgba(127,127,127,…) is the deliberate NEUTRAL exception,
		// symmetric in both themes.
		if regexp.MustCompile(`#[0-9a-fA-F]{3,6}\b`).MatchString(v) {
			t.Errorf("hex colour in %q — no colours (dark mode)", v)
		}
		for _, named := range []string{"black", "white", "gray", "grey", "#fff", "#000"} {
			if strings.Contains(strings.ToLower(v), named) {
				t.Errorf("named colour %q in %q", named, v)
			}
		}
		if regexp.MustCompile(`\b\d+(\.\d+)?(px|pt)\b`).MatchString(v) {
			// 1px borders are the one absolute the issue itself specifies
			// ("border: 1px solid"); anything else must be relative.
			for _, decl := range strings.Split(v, ";") {
				if regexp.MustCompile(`\b\d+(\.\d+)?(px|pt)\b`).MatchString(decl) && !strings.HasPrefix(decl, "border:") {
					t.Errorf("absolute unit outside the border rule: %q", decl)
				}
			}
		}
	}
}

func TestMailStyle_AlignmentSurvivesAndCodeIsStillEscaped(t *testing.T) {
	// Overriding the renderer must not LOSE what the default gave: GFM
	// column alignment, and the escaping of a literal's contents.
	html := render(t, "| l | c | r |\n|:--|:-:|--:|\n| 1 | 2 | 3 |\n\nand `<b>` too\n")
	for _, want := range []string{"text-align:left", "text-align:center", "text-align:right"} {
		if !strings.Contains(html, want) {
			t.Errorf("alignment lost: %s missing", want)
		}
	}
	if !strings.Contains(html, "&lt;b&gt;") || strings.Contains(html, "<code style=\"...\"><b>") {
		t.Errorf("inline code must still escape its contents:\n%s", html)
	}
}

func TestMailStyle_NoStyleBlockEverAppears(t *testing.T) {
	// The whole reason these are inline: <style> is stripped or mangled by
	// real clients. If one ever appears, this decision was reversed by
	// accident.
	html := render(t, "| a |\n|---|\n| 1 |\n")
	if strings.Contains(strings.ToLower(html), "<style") {
		t.Error("a <style> block reached the output — #292 is inline-only")
	}
}
