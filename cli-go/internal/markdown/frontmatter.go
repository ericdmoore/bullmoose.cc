package markdown

// Frontmatter is SPLIT OFF before rendering, never rendered.
//
// Without this, CommonMark reads a leading `---` as a thematic break and the
// line after it as a setext heading, so
//
//	---
//	title: Notes
//	to: a@b.com
//	---
//
// arrives in the recipient's mail as `<hr />` followed by an `<h2>` containing
// "title: Notes to: a@b.com" — with the address helpfully autolinked. That is
// not a goldmark quirk; `marked` does the same, so Node has it too.
//
// ## Split, not parse — and deliberately so
//
// This recognises the block and hands the raw text back UNPARSED. Suppression
// needs no YAML, and adding a YAML dependency to delete some lines would be
// paying for a parser to throw its output away.
//
// The raw block is RETURNED rather than discarded because the next slice wants
// it: honouring `to:` / `subject:` as real message headers is designed in
// `.plans/s40-markdown-headers`. Returning it keeps that door open without
// deciding anything here.
//
// ## What counts as frontmatter
//
// Only a `---` fence on the VERY FIRST line, closed by a later `---` on its
// own line. That strictness is the point: a document that opens with a
// thematic break is legal Markdown, and a looser rule would silently eat the
// first section of somebody's letter.

import "strings"

// SplitFrontmatter returns the raw frontmatter block (without its fences) and
// the remaining body. When there is no frontmatter the block is empty and the
// body is the input unchanged.
func SplitFrontmatter(src string) (front, body string) {
	// A BOM would push the fence off line 1 and silently disable the split.
	trimmed := strings.TrimPrefix(src, "\ufeff")

	const fence = "---"
	rest, ok := cutFence(trimmed, fence)
	if !ok {
		return "", src
	}
	// The closing fence must be a line of its own. Scanning line-wise rather
	// than with strings.Index stops a `---` INSIDE a value (or a table rule)
	// from ending the block early.
	lines := strings.Split(rest, "\n")
	for i, line := range lines {
		if strings.TrimRight(line, "\r") == fence {
			front = strings.Join(lines[:i], "\n")
			body = strings.Join(lines[i+1:], "\n")
			// A blank line after the fence is conventional and is not part of
			// the body; leaving it turns into a leading empty paragraph.
			return front, strings.TrimPrefix(body, "\n")
		}
	}
	// Opened and never closed. That is not frontmatter — it is a document
	// starting with a thematic break, and eating the rest of it would be the
	// worst possible reading.
	return "", src
}

// cutFence consumes an opening fence that must sit on the very first line.
func cutFence(s, fence string) (rest string, ok bool) {
	if !strings.HasPrefix(s, fence) {
		return "", false
	}
	after := s[len(fence):]
	switch {
	case strings.HasPrefix(after, "\r\n"):
		return after[2:], true
	case strings.HasPrefix(after, "\n"):
		return after[1:], true
	default:
		// `----` or `--- text` — a thematic break or a heading, not a fence.
		return "", false
	}
}
