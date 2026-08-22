package markdown

// Raw HTML is ESCAPED, not omitted — and goldmark does neither by default.
//
// goldmark has two settings and both are wrong for mail:
//
//	WithUnsafe()  passes raw HTML straight through — a pasted <script> or a
//	              tracking pixel in a .md file becomes live markup in someone
//	              else's inbox.
//	the default   DROPS it, leaving `<!-- raw HTML omitted -->`.
//
// The default looks safe and is worse than it appears. It DELETES USER TEXT:
// a body reading "use <brackets> like this" arrives with the middle word
// simply gone, and nothing tells the sender. That was caught by reading the
// generated goldens rather than trusting them — `entities.html` came back as
// `AT&amp;T -- &quot;quoted&quot; &amp; <!-- raw HTML omitted -->`.
//
// Escaping is the honest third option: the recipient sees exactly what the
// sender typed, as text, and no markup executes. It is what the package
// comment always promised, so this makes the promise true rather than
// rewriting it downwards.

import (
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/renderer"
	"github.com/yuin/goldmark/util"
)

type escapeRawHTML struct{}

func (escapeRawHTML) RegisterFuncs(reg renderer.NodeRendererFuncRegisterer) {
	reg.Register(ast.KindRawHTML, renderEscapedInline)
	reg.Register(ast.KindHTMLBlock, renderEscapedBlock)
}

// renderEscapedInline handles `<b>` mid-sentence.
func renderEscapedInline(w util.BufWriter, source []byte, node ast.Node, entering bool) (ast.WalkStatus, error) {
	if !entering {
		return ast.WalkSkipChildren, nil
	}
	n := node.(*ast.RawHTML)
	for i := 0; i < n.Segments.Len(); i++ {
		seg := n.Segments.At(i)
		_, _ = w.Write(escapeHTML(seg.Value(source)))
	}
	return ast.WalkSkipChildren, nil
}

// renderEscapedBlock handles a whole `<div>…</div>` block. The block is wrapped
// in <p> so it lands as a paragraph of visible text rather than as a bare run
// against the previous one.
func renderEscapedBlock(w util.BufWriter, source []byte, node ast.Node, entering bool) (ast.WalkStatus, error) {
	n := node.(*ast.HTMLBlock)
	if !entering {
		if n.HasClosure() {
			_, _ = w.Write(escapeHTML(n.ClosureLine.Value(source)))
		}
		_, _ = w.WriteString("</p>\n")
		return ast.WalkContinue, nil
	}
	_, _ = w.WriteString("<p>")
	l := n.Lines().Len()
	for i := 0; i < l; i++ {
		line := n.Lines().At(i)
		_, _ = w.Write(escapeHTML(line.Value(source)))
	}
	return ast.WalkContinue, nil
}

// escapeHTML is the minimal, correct set. `&` FIRST — escaping it after the
// others would double-escape the entities they just produced.
func escapeHTML(b []byte) []byte {
	out := make([]byte, 0, len(b)+16)
	for _, c := range b {
		switch c {
		case '&':
			out = append(out, "&amp;"...)
		case '<':
			out = append(out, "&lt;"...)
		case '>':
			out = append(out, "&gt;"...)
		case '"':
			out = append(out, "&quot;"...)
		case '\'':
			out = append(out, "&#39;"...)
		default:
			out = append(out, c)
		}
	}
	return out
}
