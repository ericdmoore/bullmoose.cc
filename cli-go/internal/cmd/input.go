package cmd

// §1.4 — stdin as an input source, `-` as explicit stdin, and `--as` to force the
// content type. A port of packages/cli/src/io.ts:309-399 (parseAs / inferType /
// readInput), which `contacts` and `calendar` both lean on hard: every write verb
// in both takes its body from a path, a pipe, or `-`.
//
// `send` (send.go) already had the required-TEXT half of readInput and keeps it —
// it never needs a type, so it never needed the sniffing.

import (
	"os"
	"strings"
	"unicode"

	"golang.org/x/term"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
)

// inputType is io.ts:310 — the content types the CLI can be handed.
type inputType string

const (
	typeVCard inputType = "vcard"
	typeICal  inputType = "ical"
	typeJSON  inputType = "json"
	typeText  inputType = "text"
)

// asValues is io.ts:312's alias table for `--as`.
var asValues = map[string]inputType{
	"vcard": typeVCard, "vcf": typeVCard,
	"ical": typeICal, "ics": typeICal, "icalendar": typeICal,
	"json": typeJSON,
	"text": typeText,
}

// parseAs validates `--as`; absent means "infer". io.ts:323.
func parseAs(raw string, present bool) (inputType, bool, error) {
	if !present {
		return "", false, nil
	}
	t, ok := asValues[strings.ToLower(strings.TrimSpace(raw))]
	if !ok {
		return "", false, bmio.Fail(
			`--as must be one of vcard, ical, json, text (got "`+raw+`")`, bmio.ExitUsage)
	}
	return t, true, nil
}

// inferType sniffs the payload — io.ts:340. vCard and iCalendar announce
// themselves on line 1 (RFC 6350 §6.1.1, RFC 5545 §3.4) and JSON is unambiguous
// from its first non-space byte, so this needs no heuristics and cannot be fooled
// by content.
func inferType(text string) inputType {
	head := strings.TrimLeftFunc(strings.TrimPrefix(text, "\ufeff"), isJSWhitespace)
	upper := strings.ToUpper(jsSlice(head, 32))
	switch {
	case strings.HasPrefix(upper, "BEGIN:VCARD"):
		return typeVCard
	case strings.HasPrefix(upper, "BEGIN:VCALENDAR"):
		return typeICal
	}
	if head != "" {
		switch head[0] {
		case '{', '[':
			return typeJSON
		}
	}
	return typeText
}

// isJSWhitespace is what `String.prototype.trimStart` strips: the Unicode space
// separators plus the line terminators plus U+FEFF, which unicode.IsSpace does
// not include.
func isJSWhitespace(r rune) bool {
	return unicode.IsSpace(r) || r == '\ufeff'
}

// jsSlice is `s.slice(0, n)` over code points, so a multi-byte character is never
// cut in half by the 32-byte sniff window.
func jsSlice(s string, n int) string {
	runes := []rune(s)
	if len(runes) <= n {
		return s
	}
	return string(runes[:n])
}

// sourceInput is io.ts:350 Input — the bytes, their type, and where they came
// from (which appears verbatim in error messages).
type sourceInput struct {
	Text string
	Type inputType
	From string
}

// readSource is io.ts:367 readInput. The rule it generalises is `send`'s:
// EXPLICIT beats IMPLICIT.
//
//	readSource("",  …)   no path → stdin, but only when stdin is not a terminal
//	readSource("-", …)   explicit stdin, even from a terminal
//	readSource("f", …)   a path
//
// A nil return with a nil error is the not-required, no-input case — `calendar
// event create --title … --start …` with nothing piped.
func readSource(source string, as string, hasAs bool, required bool, what string) (*sourceInput, error) {
	forced, isForced, err := parseAs(as, hasAs)
	if err != nil {
		return nil, err
	}
	var text string
	haveText := false
	from := "(none)"

	switch {
	case source == "-":
		b, err := readStdin()
		if err != nil {
			return nil, err
		}
		text, haveText, from = b, true, "(stdin)"
	case source != "":
		b, err := os.ReadFile(source)
		if err != nil {
			return nil, &bmio.CliError{Msg: nodeFsMessage(err, source), Code: bmio.ExitFail}
		}
		text, haveText, from = string(b), true, source
	case !term.IsTerminal(int(os.Stdin.Fd())):
		piped, err := readStdin()
		if err != nil {
			return nil, err
		}
		from = "(stdin)"
		// An EMPTY pipe counts as no input — io.ts:383. `-` does not: an explicit
		// stdin that happens to be empty is still an explicit answer.
		if piped != "" {
			text, haveText = piped, true
		}
	}

	if !haveText {
		if required {
			if what == "" {
				what = "input"
			}
			return nil, &bmio.CliError{
				Msg:  "no " + what + `: pipe it on stdin, pass a path, or pass "-" for explicit stdin`,
				Code: bmio.ExitUsage,
			}
		}
		return nil, nil
	}
	t := inferType(text)
	if isForced {
		t = forced
	}
	return &sourceInput{Text: text, Type: t, From: from}, nil
}

// failSetErrorOf is io.ts:429 for a SetError already in hand — the single-object
// form contacts/calendar need, where `send`'s map+key form does not fit.
//
// The type decides the exit code through the SAME §1.5 table a method-level
// error goes through, which is what makes a governed-book refusal
// (`forbidden`, packages/mailstore/src/governance.ts refusedDirectWrite) land on
// exit 4 with the server's own sentence — "file a grant-request proposal for a
// human to approve" — instead of a generic failure.
func failSetErrorOf(verb string, e setErr) error {
	typ := e.Type
	if typ == "" {
		typ = "unknown"
	}
	detail := ""
	if e.Description != "" {
		detail = " — " + e.Description
	}
	// JMAPType carries e.Type (possibly ""), NOT the "unknown" placeholder: an
	// absent type must fall to exit 1 by rule rather than by accident.
	return &bmio.ServerError{Msg: verb + " failed: " + typ + detail, JMAPType: e.Type}
}
