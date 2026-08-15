package help

// ── Deriving structure from the documentation's own notation ────────────────
//
// The upstream spec writes flags and positionals in a small, consistent
// notation, and this file reads it. It is a PARSER, not a heuristic pass over
// English: the input is `--to / --cc / --bcc <addr>` and `mailbox move <box>
// --parent <box|->`, never a sentence. Descriptions are carried through
// untouched and never inspected.
//
// The notation, in full, as the spec actually uses it:
//
//	--flag                       a boolean
//	--flag <ph>                  takes a value; <ph> is the placeholder
//	--flag ph                    ditto, placeholder written bare ("VAR", "actor")
//	--flag a|b|c                 ditto, and the values are a closed set
//	-h, --help                   two spellings of one flag
//	--man / --markdown           two flags sharing one description
//	--to / --cc / --bcc <addr>   three flags sharing one description AND one
//	                             placeholder, written once at the end
//	<x>                          a required positional
//	[<x>] / [x]                  an optional one
//	<x…>                         a repeatable one
//	a | b | c                    alternative FORMS of the command
//
// ── What is deliberately NOT claimed ────────────────────────────────────────
//
// Two places where the notation is ambiguous, and where inventing an answer
// would be worse than leaving the field off, because a machine cannot tell an
// invented answer from a documented one:
//
//   - `choices` only for an UNBRACKETED alternation (`vcard|json`). In
//     `<file|->` the `file` is a placeholder and the `-` is a literal, so the
//     set is not closed and none is claimed.
//   - `required` on a flag only where the form has no top-level alternation, so
//     `init --base <url>` is required and neither half of `agent serve --config
//     …|--fleet …` is claimed to be. Positionals still take requiredness from
//     their brackets, which alternation does not make ambiguous.
//
// Everything derived here about a flag the Go CLI actually parses is
// cross-checked against that parser's AST by
// internal/cmd/parsergrammar_test.go — the derivation is verified, not trusted.

import "strings"

// enrich fills in the derived surface. It never removes or rewrites anything.
func enrich(s Spec) Spec {
	globals := optionsFromFlags(s.GlobalOptions)
	s.Options = globals
	globalOpts := optionIndex(globals)

	for i := range s.Commands {
		c := &s.Commands[i]

		// The command's own flag list is the only place a per-command
		// description exists, so it seeds the set and supplies the join.
		set := newOptionSet()
		for _, o := range optionsFromFlags(c.Flags) {
			set.add(o)
		}
		localOpts := optionIndex(set.slice())

		// The synopsis adds the flags the prose list omits — `contacts` and
		// `calendar` document none at all and are written entirely in synopses —
		// and, where it can be claimed, requiredness.
		cmdArgs, cmdOpts := fromSynopsis([]string{"bullmoose", c.Name}, c.Synopsis)

		for j := range c.Subcommands {
			sc := &c.Subcommands[j]
			prefix := append([]string{c.Name}, strings.Fields(sc.Name)...)
			subArgs, subOpts := fromSynopsis(prefix, sc.Synopsis)
			sc.Arguments = subArgs
			sc.Options = inherit(subOpts, localOpts, globalOpts)
			// A subcommand's flags are the command's flags too, but its
			// requiredness is its own: `--kind` is required for `creds set` and
			// meaningless for `creds list`.
			for _, o := range subOpts {
				o.Required = false
				set.add(o)
			}
		}

		for _, o := range cmdOpts {
			if len(c.Subcommands) > 0 {
				o.Required = false
			}
			set.add(o)
		}

		if len(c.Subcommands) > 0 {
			// The first positional is the verb, and its closed set is the
			// subcommand list itself — no notation to read. A name may be a
			// multi-word path (`event create`), which is what argv wants.
			names := make([]string, 0, len(c.Subcommands))
			for _, sc := range c.Subcommands {
				names = append(names, sc.Name)
			}
			cmdArgs = []Argument{{Name: "subcommand", Required: true, Choices: names}}
		}

		c.Arguments = cmdArgs
		c.Options = inherit(set.slice(), localOpts, globalOpts)
	}
	return s
}

// ───────────────────────────── flag prose ───────────────────────────────────

// optionsFromFlags parses a `flags` / `globalOptions` list into Options.
func optionsFromFlags(flags []Flag) []Option {
	set := newOptionSet()
	for _, f := range flags {
		for _, o := range parseFlagEntry(f.Flag) {
			o.Desc = f.Desc
			set.add(o)
		}
	}
	return set.slice()
}

// parseFlagEntry reads one `flag` string. The " / " separator means "these are
// several flags with one description", and a placeholder written after the last
// of them belongs to all of them — `--to / --cc / --bcc <addr>` is three flags
// that each take an address, which is exactly what main.ts's parseArgs spec
// declares and what internal/cmd/parsergrammar_test.go re-checks against it.
func parseFlagEntry(entry string) []Option {
	var opts []Option
	valueless := []int{} // indices still waiting for a shared placeholder

	for _, alt := range strings.Split(entry, " / ") {
		toks := tokenize(alt)
		var names []string
		i := 0
		for ; i < len(toks); i++ {
			t := strings.TrimSuffix(toks[i], ",")
			if !isFlagToken(t) {
				break
			}
			names = append(names, flagName(t))
		}
		if len(names) == 0 {
			continue
		}
		o := Option{Name: names[0]}
		// The long spelling is the name; single letters are alternate spellings.
		for _, n := range names {
			if len(n) > 1 {
				o.Name = n
			}
		}
		for _, n := range names {
			if n != o.Name && len(n) == 1 {
				o.Short = append(o.Short, n)
			}
		}
		if rest := strings.Join(toks[i:], " "); rest != "" {
			o.TakesValue = true
			o.Value, o.Choices, o.List = parseValue(rest)
			for _, idx := range valueless {
				opts[idx].TakesValue = true
				opts[idx].Value, opts[idx].Choices, opts[idx].List = o.Value, o.Choices, o.List
			}
			valueless = nil
		} else {
			valueless = append(valueless, len(opts))
		}
		opts = append(opts, o)
	}
	return opts
}

// ───────────────────────────── synopsis ─────────────────────────────────────

// fromSynopsis reads one command or subcommand form. prefix is the literal
// words the synopsis opens with ("bullmoose", "mailbox") and is dropped.
func fromSynopsis(prefix []string, synopsis string) ([]Argument, []Option) {
	toks := expandBars(tokenize(synopsis))
	for _, want := range prefix {
		if len(toks) > 0 && toks[0] == want {
			toks = toks[1:]
		}
	}

	forms := splitOn(toks, "|")
	if len(forms) > 1 {
		if verbs, ok := verbAlternation(forms); ok {
			// `admin tenant create … | list | rename … | delete …`: a nested verb.
			// Which positional belongs to which verb is not stated at this level,
			// so only the verb set is claimed — but every flag any of the verbs
			// takes is still a flag this command accepts, and `contacts books rm
			// … [--force]` is the only place --force is written down at all.
			_, opts := scanForms(forms)
			for i := range opts {
				opts[i].Required = false
			}
			return []Argument{{Name: "subcommand", Required: true, Choices: verbs}}, opts
		}
	}
	return scanForms(forms)
}

// scanForms reads an alternation of forms of the SAME invocation, such as `rm
// <id…> --force | --dry-run` or `[--json|--ids]`.
//
// Every flag any form mentions is accepted by the CLI, so the options are the
// union — an agent asking "may I pass --ids here?" gets yes, which is the true
// answer. None of them is marked required, because the alternation is exactly
// the statement that you pick one. POSITIONALS are taken from the first form
// only: `<id…>` in one form and nothing in the next does not make the argument
// list ambiguous, it makes the later forms shorthand.
func scanForms(forms [][]string) ([]Argument, []Option) {
	args, opts := scanForm(forms[0])
	if len(forms) == 1 {
		return args, opts
	}
	set := newOptionSet()
	for i := range opts {
		opts[i].Required = false
		set.add(opts[i])
	}
	for _, f := range forms[1:] {
		_, more := scanForm(f)
		for _, o := range more {
			o.Required = false
			set.add(o)
		}
	}
	return args, set.slice()
}

// scanForm walks one alternative-free form.
func scanForm(toks []string) ([]Argument, []Option) {
	var args []Argument
	var opts []Option
	for i := 0; i < len(toks); i++ {
		t := toks[i]
		switch {
		case isGroup(t):
			inner := expandBars(tokenize(t[1 : len(t)-1]))
			ia, io := scanForms(splitOn(inner, "|"))
			for _, a := range ia {
				a.Required = false
				args = append(args, a)
			}
			for _, o := range io {
				o.Required = false
				opts = append(opts, o)
			}
		case isFlagToken(t):
			o := Option{Name: flagName(t), Required: true}
			if i+1 < len(toks) && isValueToken(toks[i+1]) {
				o.TakesValue = true
				o.Value, o.Choices, o.List = parseValue(toks[i+1])
				i++
			}
			opts = append(opts, o)
		case isEllipsis(t):
			// A bare `…` stands for "and more of the same"; it names nothing.
		default:
			args = append(args, parseArgument(t))
		}
	}
	return args, opts
}

// verbAlternation reports the leading literal of every form when every form
// starts with one — the signature of `list | create <name> | rm <id>`.
func verbAlternation(forms [][]string) ([]string, bool) {
	verbs := make([]string, 0, len(forms))
	for _, f := range forms {
		if len(f) == 0 || !isLiteralWord(f[0]) {
			return nil, false
		}
		verbs = append(verbs, f[0])
	}
	return verbs, true
}

// ───────────────────────────── token shapes ─────────────────────────────────

// tokenize splits on whitespace that is not inside <…>, […] or "…", so that
// `[--header "Name: …{}…"]` is one token and `--kind <kind>` is two.
func tokenize(s string) []string {
	var out []string
	var cur strings.Builder
	angle, square, quoted := 0, 0, false
	flush := func() {
		if cur.Len() > 0 {
			out = append(out, cur.String())
			cur.Reset()
		}
	}
	for _, r := range s {
		switch {
		case r == '"':
			quoted = !quoted
		case quoted:
		case r == '<':
			angle++
		case r == '>':
			if angle > 0 {
				angle--
			}
		case r == '[':
			square++
		case r == ']':
			if square > 0 {
				square--
			}
		}
		if (r == ' ' || r == '\t') && angle == 0 && square == 0 && !quoted {
			flush()
			continue
		}
		cur.WriteRune(r)
	}
	flush()
	return out
}

// expandBars splits a token that packs an alternation against a flag with no
// spaces — `<agent.json>|--fleet` — into separate tokens around an explicit
// "|". A token whose alternatives are all literals (`on|off|status`) is a
// closed value set, not an alternation of forms, and is left whole.
func expandBars(toks []string) []string {
	out := make([]string, 0, len(toks))
	for _, t := range toks {
		parts := splitBarsAtDepth0(t)
		hasFlag := false
		for _, p := range parts {
			if isFlagToken(p) {
				hasFlag = true
			}
		}
		if len(parts) == 1 || !hasFlag {
			out = append(out, t)
			continue
		}
		for i, p := range parts {
			if i > 0 {
				out = append(out, "|")
			}
			out = append(out, p)
		}
	}
	return out
}

func splitBarsAtDepth0(t string) []string {
	var parts []string
	var cur strings.Builder
	angle, square, quoted := 0, 0, false
	for _, r := range t {
		switch {
		case r == '"':
			quoted = !quoted
		case quoted:
		case r == '<':
			angle++
		case r == '>':
			if angle > 0 {
				angle--
			}
		case r == '[':
			square++
		case r == ']':
			if square > 0 {
				square--
			}
		}
		if r == '|' && angle == 0 && square == 0 && !quoted {
			parts = append(parts, cur.String())
			cur.Reset()
			continue
		}
		cur.WriteRune(r)
	}
	parts = append(parts, cur.String())
	return parts
}

func splitOn(toks []string, sep string) [][]string {
	out := [][]string{{}}
	for _, t := range toks {
		if t == sep {
			out = append(out, []string{})
			continue
		}
		out[len(out)-1] = append(out[len(out)-1], t)
	}
	return out
}

func isGroup(t string) bool {
	return len(t) > 2 && strings.HasPrefix(t, "[") && strings.HasSuffix(t, "]")
}

// isFlagToken: `-x` and longer. A bare `-` is the stdin marker (arch.md §1.4),
// never a flag.
func isFlagToken(t string) bool { return len(t) > 1 && strings.HasPrefix(t, "-") }

// isValueToken: whatever follows a flag and is not itself a flag or a form
// separator is that flag's value.
func isValueToken(t string) bool { return t != "|" && !isFlagToken(t) && !isGroup(t) }

func isEllipsis(t string) bool { return t == "…" || t == "..." }

// isLiteralWord: a bare verb — no dashes, brackets, placeholders or alternation.
func isLiteralWord(t string) bool {
	if t == "" || strings.HasPrefix(t, "-") {
		return false
	}
	return !strings.ContainsAny(t, "<>[]|\"")
}

func flagName(t string) string {
	t = strings.TrimSuffix(t, ",")
	t = strings.TrimPrefix(t, "--")
	return strings.TrimPrefix(t, "-")
}

// parseArgument reads one positional token.
func parseArgument(t string) Argument {
	a := Argument{Required: true}
	inner := t
	if strings.HasPrefix(inner, "<") && strings.HasSuffix(inner, ">") {
		inner = inner[1 : len(inner)-1]
	}
	for _, e := range []string{"…", "..."} {
		if strings.HasSuffix(inner, e) {
			inner = strings.TrimSuffix(inner, e)
			a.Repeatable = true
		}
	}
	if strings.Contains(inner, "|") {
		parts := splitBarsAtDepth0(inner)
		if !strings.Contains(inner, "<") {
			// `on|off|status` — every alternative is a literal, so this is a
			// closed set.
			a.Choices = parts
			a.Name = inner
			return a
		}
		// `<file.vcf>|-` — a placeholder OR the stdin marker. Name it for the
		// placeholder and claim no set.
		inner = strings.Trim(parts[0], "<>")
	}
	a.Name = inner
	return a
}

// parseValue reads a flag's placeholder.
func parseValue(t string) (value string, choices []string, list bool) {
	if strings.HasPrefix(t, `"`) && strings.HasSuffix(t, `"`) && len(t) > 1 {
		return strings.Trim(t, `"`), nil, false
	}
	if isEllipsis(t) {
		// `[--title …]` — the placeholder is elided upstream, not absent.
		return "", nil, false
	}
	if strings.HasPrefix(t, "<") {
		if end := strings.Index(t, ">"); end > 0 {
			value = t[1:end]
			// `<addr>[,<addr>]` — the repetition marker lives outside the
			// placeholder.
			list = strings.HasPrefix(t[end+1:], "[,")
		} else {
			value = strings.TrimPrefix(t, "<")
		}
	} else {
		value = t
		if strings.Contains(t, "|") && !strings.Contains(t, "<") {
			choices = splitBarsAtDepth0(t)
		}
	}
	if strings.Contains(value, ",") {
		list = true
	}
	return value, choices, list
}

// ───────────────────────────── merging ──────────────────────────────────────

// optionSet accumulates Options by name in first-seen order, so the emitted
// list is a deterministic function of the spec and a regeneration that changed
// nothing produces no diff.
type optionSet struct {
	order []string
	by    map[string]*Option
}

func newOptionSet() *optionSet { return &optionSet{by: map[string]*Option{}} }

func (s *optionSet) add(o Option) {
	cur, seen := s.by[o.Name]
	if !seen {
		copied := o
		s.by[o.Name] = &copied
		s.order = append(s.order, o.Name)
		return
	}
	// One flag documented twice: keep what is already stated and fill the gaps.
	// Never downgrade a value-taking flag to a boolean — the synopsis sometimes
	// elides a placeholder the flag list gives.
	cur.TakesValue = cur.TakesValue || o.TakesValue
	cur.List = cur.List || o.List
	cur.Required = cur.Required || o.Required
	if cur.Value == "" {
		cur.Value = o.Value
	}
	if len(cur.Choices) == 0 && len(o.Choices) > 0 {
		cur.Choices = o.Choices
		// `contacts import [--as vcard]` writes one literal where `contacts
		// create [--as vcard|json]` writes the set. A "placeholder" that is
		// itself one of the choices was never a placeholder, so the fuller
		// spelling replaces it.
		if contains(o.Choices, cur.Value) {
			cur.Value = o.Value
		}
	}
	if cur.Desc == "" {
		cur.Desc = o.Desc
	}
	for _, sh := range o.Short {
		if !contains(cur.Short, sh) {
			cur.Short = append(cur.Short, sh)
		}
	}
}

func (s *optionSet) slice() []Option {
	out := make([]Option, 0, len(s.order))
	for _, n := range s.order {
		out = append(out, *s.by[n])
	}
	return out
}

// inherit fills a synopsis-derived option's gaps from the fuller write-up the
// same name gets in the command's own flag list, and failing that in the global
// options: `creds set --kind <kind>` learns its closed set from `--kind
// api-key|oauth-refresh|…`, and `contacts rm --if-state <s>` learns what
// --if-state means from the one place it is explained.
//
// Only GAPS are filled. A flag that appears in a synopsis and is written up
// nowhere keeps an empty desc rather than borrowing a plausible one, and
// requiredness is never inherited — it belongs to the form, not to the flag.
func inherit(opts []Option, local, global map[string]Option) []Option {
	for i := range opts {
		if src, ok := local[opts[i].Name]; ok {
			fill(&opts[i], src)
		}
		if src, ok := global[opts[i].Name]; ok {
			fill(&opts[i], src)
		}
	}
	return opts
}

func fill(dst *Option, src Option) {
	if dst.Desc == "" {
		dst.Desc = src.Desc
	}
	dst.TakesValue = dst.TakesValue || src.TakesValue
	dst.List = dst.List || src.List
	if dst.Value == "" {
		dst.Value = src.Value
	}
	if len(dst.Choices) == 0 {
		dst.Choices = src.Choices
	}
	for _, sh := range src.Short {
		if !contains(dst.Short, sh) {
			dst.Short = append(dst.Short, sh)
		}
	}
}

func optionIndex(opts []Option) map[string]Option {
	m := make(map[string]Option, len(opts))
	for _, o := range opts {
		m[o.Name] = o
	}
	return m
}

func contains(hay []string, needle string) bool {
	for _, s := range hay {
		if s == needle {
			return true
		}
	}
	return false
}
