package help

// ── `help --json` as a TOOL SCHEMA rather than a help page ──────────────────
//
// The captured spec already carries everything a human needs, and for an agent
// it carries almost everything: the one thing it does not is the SHAPE of an
// invocation. A flag arrives as `{"flag": "--role <role>", "desc": "…"}` — one
// English string — so a reader that wants to know "does --role take a value?"
// has to parse prose, and a POSITIONAL argument is not represented at all: it
// exists only inside `synopsis`, in the same prose.
//
// So this file re-reads the captured JSON into Go types, DERIVES the structure
// that was implied (derive.go), and re-emits it. Every original key survives
// untouched; the additions are:
//
//	spec.options                      the global flags, structured
//	spec.commands[].arguments         positionals: name, required, repeatable
//	spec.commands[].options           the command's flags, structured
//	spec.commands[].subcommands[].*   the same two, per subcommand form
//	spec.argSpecVersion               1 — present iff the additions are
//
// The prose fields (`globalOptions`, `flags`, `synopsis`) are LEFT IN PLACE.
// They are what the man page and the human pages are rendered from upstream,
// and they are the only place a description lives; dropping them to "clean up"
// would be a breaking change to the one surface this port promises not to move.
//
// ── Why re-encoding here is safe, and what proves it ────────────────────────
//
// The rest of this package's guarantee is "the Go binary prints Node's own
// bytes", which a re-encode obviously breaks. Two things keep it honest:
//
//   - encodeSpec must reproduce the captured bytes EXACTLY when nothing has
//     been derived — same key order, same indent, same escaping. spec_test.go's
//     TestUnenrichedRoundTripIsByteIdentical asserts precisely that, so the
//     enrichment is provably ADDITIVE rather than a second renderer that drifts.
//   - Structured() refuses to enrich when that round trip does not hold — a
//     field added to help.ts that these types do not know would be silently
//     DROPPED, and silently dropping data from the surface agents read is worse
//     than not enriching it. Serve then falls back to the captured bytes, which
//     are never wrong, and the test above fails loudly in CI.
//
// Human help — the overview, the per-command pages, --man, --markdown — never
// enters this path at all. Those modes still replay captured bytes verbatim.

import (
	"bytes"
	"encoding/json"
	"sync"
)

// ArgSpecVersion is the version of the DERIVED surface (`options`, `arguments`),
// emitted as `argSpecVersion` so a consumer can tell an enriched spec from a
// bare one — and so the fallback described above is detectable rather than
// mysterious. Bump it when a derived field changes meaning.
const ArgSpecVersion = 1

// Flag is one flag as the upstream spec states it: prose, unchanged.
// `flag` is a whole spelling ("-h, --help", "--to / --cc / --bcc <addr>"), which
// is why Option exists.
type Flag struct {
	Flag string `json:"flag"`
	Desc string `json:"desc"`
}

// Example is one worked invocation.
type Example struct {
	Cmd  string `json:"cmd"`
	Note string `json:"note,omitempty"`
}

// ExitCode is one row of the §1.5 table.
type ExitCode struct {
	Code    int    `json:"code"`
	Meaning string `json:"meaning"`
	When    string `json:"when"`
}

// Option is one flag, structured — the thing a JSON Schema property can be
// generated from without reading a word of English.
//
// One Option is one NAME. `-h, --help` is a single Option (name "help", short
// "h"); `--to / --cc / --bcc <addr>` is THREE, because they are three flags that
// happen to share a description.
type Option struct {
	// Name is the bare long name, no dashes: "if-state", "dry-run". For a flag
	// that has only a short spelling (`-n`) it is that letter.
	Name string `json:"name"`
	// Short is every single-letter spelling other than Name itself.
	Short []string `json:"short,omitempty"`
	// TakesValue says whether the flag consumes the following token. This is the
	// question the prose could not answer, and the one the drift test in
	// internal/cmd checks against the parser's own AST.
	TakesValue bool `json:"takesValue"`
	// Value is the value's placeholder, verbatim from the documentation with the
	// angle brackets or quotes stripped: "path", "a,b,c", "file|-". Empty when
	// TakesValue is false.
	Value string `json:"value,omitempty"`
	// Choices is the closed set of values, and is emitted ONLY where the
	// documentation states one UNAMBIGUOUSLY: an unbracketed alternation such as
	// `--kind api-key|oauth-refresh|…`. A bracketed `<file|->` mixes a
	// placeholder with a literal, so no choices are claimed for it — a wrong
	// enum is worse than an absent one.
	Choices []string `json:"choices,omitempty"`
	// List marks a value that is itself a comma-separated list (`--scopes
	// <a,b,c>`, `--to <addr>[,<addr>]`), which an MCP schema would render as an
	// array joined with commas rather than a plain string.
	List bool `json:"list,omitempty"`
	// Required is set only where the documentation puts the flag OUTSIDE square
	// brackets in the synopsis of the exact form it belongs to — so it appears on
	// subcommands (`creds set --kind …`) and on commands that have no
	// subcommands (`init --base … --token …`), and is left off a command whose
	// requiredness differs per subcommand.
	Required bool `json:"required,omitempty"`
	// Desc is the upstream description, joined by name from the command's own
	// flag list or from the global options. Empty for a flag that appears only in
	// a synopsis and is described nowhere.
	Desc string `json:"desc,omitempty"`
}

// Argument is one positional slot, in the order it is written.
type Argument struct {
	// Name is the placeholder with its brackets and ellipsis stripped: "emailId",
	// "id", "fts5-query". For a command with subcommands it is the literal
	// "subcommand", whose Choices are the subcommand names.
	Name string `json:"name"`
	// Required is false for a bracketed slot (`[emailId]`).
	Required bool `json:"required"`
	// Repeatable is true for an ellipsis slot (`<id…>`) — the shape every triage
	// verb takes.
	Repeatable bool `json:"repeatable,omitempty"`
	// Choices is the closed set of literals this slot accepts: the subcommand
	// names, or an unbracketed alternation such as `vacation on|off|status`.
	Choices []string `json:"choices,omitempty"`
}

// SubCommand is one verb form of a command.
type SubCommand struct {
	Name     string `json:"name"`
	Synopsis string `json:"synopsis"`
	Summary  string `json:"summary"`

	// ---- derived (derive.go) ----
	Arguments []Argument `json:"arguments,omitempty"`
	Options   []Option   `json:"options,omitempty"`
}

// Command is one entry of the spec's command list. The first eight fields are
// the upstream `Command` interface (packages/cli/src/help.ts) in ITS OWN order,
// which is what makes the unenriched round trip byte-identical.
type Command struct {
	Name        string       `json:"name"`
	Synopsis    string       `json:"synopsis"`
	Summary     string       `json:"summary"`
	Description string       `json:"description,omitempty"`
	Subcommands []SubCommand `json:"subcommands,omitempty"`
	Flags       []Flag       `json:"flags,omitempty"`
	Examples    []Example    `json:"examples,omitempty"`
	SeeAlso     []string     `json:"seeAlso,omitempty"`

	// ---- derived (derive.go) ----
	Arguments []Argument `json:"arguments,omitempty"`
	Options   []Option   `json:"options,omitempty"`
}

// Spec is the whole `help --json` document.
type Spec struct {
	Name    string `json:"name"`
	Tagline string `json:"tagline"`
	// ArgSpecVersion is derived; omitempty is load-bearing, since a zero value is
	// what makes the round trip in TestUnenrichedRoundTripIsByteIdentical possible.
	ArgSpecVersion int      `json:"argSpecVersion,omitempty"`
	Notes          []string `json:"notes"`
	GlobalOptions  []Flag   `json:"globalOptions"`
	// Options is GlobalOptions, structured. Every command accepts these on top of
	// its own — they are listed once here rather than copied into all 33.
	Options   []Option   `json:"options,omitempty"`
	ExitCodes []ExitCode `json:"exitCodes"`
	Commands  []Command  `json:"commands"`
}

// encodeSpec renders a Spec the way JSON.stringify(spec, null, 2) does, which is
// what the upstream CLI prints:
//
//   - two-space indent, and the trailing newline console.log adds (Encode's);
//   - SetEscapeHTML(false), because Go escapes `<`, `>` and `&` by default and
//     JavaScript does not — and this spec is FULL of `<placeholder>`.
//
// Any remaining difference is caught by the byte-identity test rather than
// argued about here.
func encodeSpec(s Spec) (string, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(s); err != nil {
		return "", err
	}
	return buf.String(), nil
}

var (
	structOnce sync.Once
	structured Spec
	faithful   bool
)

// Structured returns the captured spec with the derived surface filled in.
//
// ok is false when the captured JSON does not survive a lossless round trip
// through these types — the shape upstream grew a field this file does not
// know. In that case the Spec is not usable and callers must fall back to the
// captured bytes: emitting a spec with a field quietly missing would be a
// machine-readable lie, and the whole point of this surface is that a machine
// can trust it.
func Structured() (Spec, bool) {
	structOnce.Do(buildStructured)
	return structured, faithful
}

func buildStructured() {
	spec := load()
	if spec.err != nil {
		return
	}
	raw := spec.entries["json"].stdout
	if raw == "" {
		return
	}
	var base Spec
	if err := json.Unmarshal([]byte(raw), &base); err != nil {
		return
	}
	round, err := encodeSpec(base)
	if err != nil || round != raw {
		return
	}
	base.ArgSpecVersion = ArgSpecVersion
	structured, faithful = enrich(base), true
}
