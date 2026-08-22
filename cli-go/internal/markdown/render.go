// Package markdown renders `send --expandMD html`'s body.
//
// ## This is the one ported path that is NOT byte-identical to Node
//
// Every other command in this binary is held to the TypeScript's exact bytes,
// and that discipline has caught real bugs — the `models` port was wrong in
// five ways until it was diffed against Node.
//
// It cannot apply here. Node renders with `marked`; no other implementation
// reproduces its HTML byte for byte, because heading ids, entity escaping,
// attribute order and inter-block whitespace differ between every Markdown
// library that exists. Matching `marked` would mean porting `marked`.
//
// So the requirement was loosened DELIBERATELY (Eric, 2026-08-22: "lets
// loosen the byte-for-byte requirement … just go for correct by construction
// and set new baselines"). The bar here is:
//
//   - CommonMark-correct, via goldmark, which is the reference-grade Go
//     implementation and passes the CommonMark suite;
//   - SAFE — see the escaping note below, because this HTML is mail;
//   - STABLE, pinned by the golden corpus in testdata/ so that Go's own
//     rendering cannot drift silently later.
//
// The last one is the point. Byte-identity with `marked` was a guarantee with
// an expiry date — the Node CLI is being deleted — whereas the goldens keep
// their value afterwards, because what they protect is THIS renderer against
// its future self.
//
// ## Raw HTML is escaped — see escape.go
//
// goldmark offers pass-through (`WithUnsafe`) or DELETE, and neither is right
// for mail. Pass-through puts a pasted `<script>` live in someone's inbox;
// delete silently removes the sender's own text. This package escapes, so the
// recipient sees exactly what was typed and nothing executes. That is
// STRICTER than `marked`, and it is the one place this divergence is a
// deliberate improvement rather than a tolerated difference.
package markdown

import (
	"bytes"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/renderer"
	"github.com/yuin/goldmark/renderer/html"
	"github.com/yuin/goldmark/util"
)

// renderer is built once: goldmark's Markdown value is safe for concurrent use
// and rebuilding it per call would parse the extension set every time.
var md = goldmark.New(
	// GFM is what people mean by "Markdown" in mail: tables, strikethrough,
	// autolinks, task lists. Plain CommonMark would silently render a table as
	// a paragraph of pipes, which reads as the tool being broken.
	goldmark.WithExtensions(extension.GFM),
	goldmark.WithRendererOptions(
		// Raw HTML is ESCAPED rather than dropped — see escape.go. goldmark's
		// own choices are pass-through (unsafe) or DELETE, and delete loses
		// the sender's text without telling them.
		renderer.WithNodeRenderers(util.Prioritized(escapeRawHTML{}, 1)),
		// Hard-wrap OFF: a single newline in a Markdown paragraph is a
		// continuation, not a <br>. Mail clients reflow anyway, and turning
		// this on makes every wrapped-at-80 source file render as ragged
		// forced breaks.
		html.WithXHTML(),
		// NOT html.WithUnsafe(): raw HTML in the source is escaped. See the
		// package comment — this input becomes an outbound message.
	),
)

// ToHTML renders Markdown to the HTML body of a message.
//
// The caller keeps the RAW MARKDOWN as the text/plain alternative rather than
// stripping tags out of this output: the source is already the better plain
// text, and a de-tagged HTML rendering is a worse one that also loses link
// targets.
func ToHTML(src string) (string, error) {
	// Frontmatter never reaches the renderer — see frontmatter.go. Rendering it
	// puts `title:` and `to:` in the recipient's message as a heading.
	_, body := SplitFrontmatter(src)
	var buf bytes.Buffer
	if err := md.Convert([]byte(body), &buf); err != nil {
		return "", err
	}
	return buf.String(), nil
}
