package markdown

import "strings"
import "testing"

func TestSplitFrontmatter(t *testing.T) {
	t.Run("a fenced block is taken off the body", func(t *testing.T) {
		front, body := SplitFrontmatter("---\nto: a@b.com\nsubject: Hi\n---\n\n# Body\n")
		if !strings.Contains(front, "to: a@b.com") || !strings.Contains(front, "subject: Hi") {
			t.Errorf("front = %q", front)
		}
		if body != "# Body\n" {
			t.Errorf("body = %q, want the document with the block and its blank line gone", body)
		}
	})

	t.Run("no frontmatter leaves the document untouched", func(t *testing.T) {
		src := "# Body\n\ntext\n"
		front, body := SplitFrontmatter(src)
		if front != "" || body != src {
			t.Errorf("front = %q, body = %q", front, body)
		}
	})

	t.Run("an UNCLOSED fence is a thematic break, not frontmatter", func(t *testing.T) {
		// The dangerous case. Treating this as frontmatter would silently eat
		// the whole letter — the worst possible reading of a legal document.
		src := "---\n\nA document that opens with a rule.\n"
		front, body := SplitFrontmatter(src)
		if front != "" || body != src {
			t.Errorf("an unclosed fence must be left alone: front = %q, body = %q", front, body)
		}
	})

	t.Run("a fence must be the very FIRST line", func(t *testing.T) {
		src := "intro\n\n---\nto: a@b.com\n---\n"
		front, body := SplitFrontmatter(src)
		if front != "" || body != src {
			t.Errorf("mid-document rules are content: front = %q", front)
		}
	})

	t.Run("--- inside a value does not close the block early", func(t *testing.T) {
		front, body := SplitFrontmatter("---\nsubject: a --- b\nto: x@y.z\n---\n\nbody\n")
		if !strings.Contains(front, "to: x@y.z") {
			t.Errorf("block closed early: front = %q", front)
		}
		if body != "body\n" {
			t.Errorf("body = %q", body)
		}
	})

	t.Run("---- and `--- text` are not fences", func(t *testing.T) {
		for _, src := range []string{"----\ntitle: x\n----\n", "--- text\nmore\n"} {
			front, body := SplitFrontmatter(src)
			if front != "" || body != src {
				t.Errorf("%q was treated as frontmatter", src)
			}
		}
	})

	t.Run("CRLF is handled — .md files come off Windows too", func(t *testing.T) {
		front, _ := SplitFrontmatter("---\r\nto: a@b.com\r\n---\r\nbody\r\n")
		if !strings.Contains(front, "to: a@b.com") {
			t.Errorf("front = %q", front)
		}
	})
}

func TestFrontmatterNeverRendersIntoTheMessage(t *testing.T) {
	// The bug this exists for: CommonMark reads `---` as a thematic break and
	// the next line as a setext heading, so metadata arrived in the
	// recipient's mail as an <h2> — with the `to:` address autolinked.
	got, err := ToHTML("---\ntitle: Notes\nto: a@b.com\n---\n\n# Body\n\ntext\n")
	if err != nil {
		t.Fatal(err)
	}
	for _, leak := range []string{"title:", "to:", "a@b.com", "<hr"} {
		if strings.Contains(got, leak) {
			t.Errorf("frontmatter leaked into the body (%q):\n%s", leak, got)
		}
	}
	if !strings.Contains(got, "<h1>Body</h1>") {
		t.Errorf("the real body did not survive:\n%s", got)
	}
}
