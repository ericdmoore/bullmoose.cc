package markdown

// Two inline styles, and only two (#292, decided 2026-08-22).
//
// `--expandMD html` ships NO stylesheet: client defaults render a Markdown
// document correctly, adapt to dark mode by themselves, and leave nothing to
// test in Outlook. The plain-text alternative is the raw Markdown, so a badly
// rendering client still shows something well-formed.
//
// Two elements are where the defaults are genuinely poor:
//
//	td / th        GFM tables render with NO borders — a four-column table
//	               arrives as ambiguous runs of text.
//	inline code    inherits the body font, so a literal reads as prose and
//	               loses the one signal it carries.
//
// The constraints are the design, and each is a refusal:
//
//   - INLINE `style=""` ONLY. A <style> block is stripped or mangled by
//     clients (Outlook's Word engine above all) — that is what Premailer
//     exists to work around, and there is no reason to import the problem.
//   - NO COLOURS. `border: 1px solid` with no colour INHERITS the text
//     colour, which is what adapts to dark mode. A hardcoded #ddd is how a
//     message renders black-on-black in someone's night theme.
//   - RELATIVE UNITS. `padding: .35em .6em` scales with whatever type size
//     the reader chose; `8px` overrides them.
//
// Everything else — headings, lists, blockquotes, links, fenced blocks —
// stays client-default on purpose. This file exists to be short.

import (
	"github.com/yuin/goldmark/ast"
	east "github.com/yuin/goldmark/extension/ast"
	"github.com/yuin/goldmark/renderer"
	"github.com/yuin/goldmark/util"
)

const (
	// A thin rule and room to breathe. No colour: inherits the text's.
	cellStyle = "border:1px solid;border-collapse:collapse;padding:.35em .6em"
	// Collapsed borders on the table itself, or every cell doubles its rule.
	tableStyle = "border-collapse:collapse"
	// A literal, made to look like one — the background is a NEUTRAL alpha so
	// it darkens a light theme and lightens a dark one from the same value.
	codeStyle = "font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;" +
		"background:rgba(127,127,127,.15);padding:.1em .3em;border-radius:.2em"
)

type mailStyles struct{}

func (mailStyles) RegisterFuncs(reg renderer.NodeRendererFuncRegisterer) {
	reg.Register(east.KindTable, renderTable)
	reg.Register(east.KindTableCell, renderTableCell)
	reg.Register(ast.KindCodeSpan, renderCodeSpan)
}

func renderTable(w util.BufWriter, _ []byte, _ ast.Node, entering bool) (ast.WalkStatus, error) {
	if entering {
		_, _ = w.WriteString(`<table style="` + tableStyle + "\">\n")
	} else {
		_, _ = w.WriteString("</table>\n")
	}
	return ast.WalkContinue, nil
}

func renderTableCell(w util.BufWriter, _ []byte, node ast.Node, entering bool) (ast.WalkStatus, error) {
	n := node.(*east.TableCell)
	tag := "td"
	if n.Parent() != nil && n.Parent().Kind() == east.KindTableHeader {
		tag = "th"
	}
	if !entering {
		_, _ = w.WriteString("</" + tag + ">\n")
		return ast.WalkContinue, nil
	}
	style := cellStyle
	// The column alignment GFM declared, kept — dropping it would make this
	// override a REGRESSION against the default renderer it replaces.
	switch n.Alignment {
	case east.AlignLeft:
		style += ";text-align:left"
	case east.AlignRight:
		style += ";text-align:right"
	case east.AlignCenter:
		style += ";text-align:center"
	}
	_, _ = w.WriteString("<" + tag + ` style="` + style + "\">")
	return ast.WalkContinue, nil
}

// renderCodeSpan is `like this` mid-sentence — NOT a fenced block, which
// clients already render distinctly and which this file leaves alone.
func renderCodeSpan(w util.BufWriter, source []byte, node ast.Node, entering bool) (ast.WalkStatus, error) {
	if !entering {
		_, _ = w.WriteString("</code>")
		return ast.WalkContinue, nil
	}
	_, _ = w.WriteString(`<code style="` + codeStyle + `">`)
	// Children are text segments; the default renderer escapes them the same
	// way, and skipping that would put raw `<` from `` `<b>` `` into the mail.
	for c := node.FirstChild(); c != nil; c = c.NextSibling() {
		if t, ok := c.(*ast.Text); ok {
			_, _ = w.Write(escapeHTML(t.Segment.Value(source)))
		}
	}
	return ast.WalkSkipChildren, nil
}
