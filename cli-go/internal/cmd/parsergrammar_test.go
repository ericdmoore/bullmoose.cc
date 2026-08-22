package cmd

// ── Does the documentation describe the CLI that exists? ────────────────────
//
// Everything else in this repo checks the help surface against ITSELF: the
// artifact still matches help.ts, the renderers still produce these bytes, the
// registry still owns --json where it claims --json. Nothing checked the one
// thing an agent actually depends on — that the flags the help spec describes
// are the flags the parser accepts, with the arity it accepts them at.
//
// A wrong answer there is not a missing feature, it is a LIE told to a machine
// that cannot check it. `bullmoose help --json` says `--role` takes a value; if
// parse() had it as a boolean, an agent building `--role inbox` would silently
// send `inbox` as a positional message id.
//
// ── Where the grammar is read from ──────────────────────────────────────────
//
// From the AST, not from a regex and not from a second hand-kept list. Every
// parser in this package has the same shape — a `switch name` over the flag,
// with `value()` called in the arms that consume the following token — so the
// two facts this test needs are structural:
//
//	case "role":            → the parser accepts --role
//	    a.Role = value()    → and it takes a value
//
// go/ast rather than a regex because the regex reads a `case "x":` inside a
// comment or a string as real, and — worse in the other direction — misses one
// whose body is formatted unusually. The AST is the grammar the compiler sees.
//
// ── Coverage boundary, stated rather than implied ───────────────────────────
//
// TestSelfParsingCommandsAreCovered is the honest half. Three commands parse
// their own argv (registry.go's selfParses, plus the two goNative ones), and
// two of them — `agents` and `approvals` — have NO entry in the help spec at
// all, because they have no TypeScript twin to have been documented alongside.
// They are therefore checked against a DIFFERENT oracle (delegate's own flag
// tables, which argv_test.go already diffs against main.ts's parseArgs spec),
// and the exclusions are enumerated in this file rather than skipped quietly.

import (
	"go/ast"
	"go/parser"
	"go/token"
	"sort"
	"strconv"
	"testing"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/help"
)

// grammar is one parser's flag table: name (no dashes) → does it consume the
// following token.
type grammar map[string]bool

// parserGrammar reads `switch name { case "x": … }` out of one function.
//
// It fails rather than returning nothing when the shape it expects is absent:
// an empty grammar would make every check below pass vacuously, which is the
// one failure mode a drift test must not have.
func parserGrammar(t *testing.T, file, fn string) grammar {
	t.Helper()
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, file, nil, 0)
	if err != nil {
		t.Fatalf("parse %s: %v", file, err)
	}

	var decl *ast.FuncDecl
	ast.Inspect(f, func(n ast.Node) bool {
		if d, ok := n.(*ast.FuncDecl); ok && d.Name.Name == fn {
			decl = d
		}
		return decl == nil
	})
	if decl == nil {
		t.Fatalf("%s: no func %s — this test no longer knows where the flag grammar lives", file, fn)
	}

	g := grammar{}
	ast.Inspect(decl, func(n ast.Node) bool {
		sw, ok := n.(*ast.SwitchStmt)
		if !ok {
			return true
		}
		// The flag switch is the one over the parsed flag name. The outer
		// `switch { case strings.HasPrefix(…) }` has no tag and is skipped.
		if id, ok := sw.Tag.(*ast.Ident); !ok || id.Name != "name" {
			return true
		}
		for _, stmt := range sw.Body.List {
			clause, ok := stmt.(*ast.CaseClause)
			if !ok {
				continue
			}
			takesValue := false
			for _, s := range clause.Body {
				ast.Inspect(s, func(n ast.Node) bool {
					call, ok := n.(*ast.CallExpr)
					if !ok {
						return true
					}
					if id, ok := call.Fun.(*ast.Ident); ok && id.Name == "value" {
						takesValue = true
					}
					return true
				})
			}
			for _, expr := range clause.List {
				lit, ok := expr.(*ast.BasicLit)
				if !ok || lit.Kind != token.STRING {
					continue
				}
				name, err := strconv.Unquote(lit.Value)
				if err != nil {
					continue
				}
				g[name] = takesValue
			}
		}
		return false
	})

	if len(g) == 0 {
		t.Fatalf("%s: found no `switch name` cases in %s — the parser was restructured and "+
			"this test would now pass without checking anything", file, fn)
	}
	return g
}

// sharedGrammar is cmd.parse's — the grammar every command that is not
// selfParses is dispatched through.
func sharedGrammar(t *testing.T) grammar { return parserGrammar(t, "args.go", "parse") }

// selfParsers is every command that reads its own argv instead of parse().
// registry.go marks them; TestSelfParsingCommandsAreCovered checks this list is
// still the whole set, so a fourth one cannot be added and quietly skipped.
var selfParsers = map[string]struct{ file, fn string }{
	"watch":     {"watch.go", "parseWatch"},
	"approvals": {"approvals.go", "parseApprovals"},
	"agents":    {"agents.go", "parseAgents"},
	"version":   {"version.go", "parseVersion"},
	// `agent` is listed BEFORE it is registered (s43: the registry flip is
	// last) so its grammar is held to the scanner tables from step 1 on —
	// the oracle that refuses a typo'd or invented flag at birth.
	"agent": {"agentinvoke.go", "parseAgent"},
}

// undocumentedByDesign is every flag the CLI accepts that the help spec does
// not describe for that command. Each is a LIVE DOCUMENTATION BUG, not an
// exemption: an agent reading `help --json` cannot discover any of them.
//
// They are listed rather than tolerated because the fix is in
// packages/cli/src/help.ts, on the other side of the module boundary, and a
// silent skip would let the list grow. Deleting an entry here is the last step
// of fixing one; a stale entry fails this test too.
var undocumentedByDesign = map[string]string{}

// TestRegistryFlagsAreTheParsersOwn checks the registry against the parser's
// AST rather than against the hand-copied list registry_test.go used to carry.
//
// The old list could only ever be as right as the last person to edit both; a
// flag that changed from value-taking to boolean in parse() left it stale and
// still green. Reading the switch means the two cannot drift by construction.
func TestRegistryFlagsAreTheParsersOwn(t *testing.T) {
	shared := sharedGrammar(t)

	for name, s := range registry {
		if s.goNative {
			continue // no shared parse and no Node twin — covered below
		}
		g := shared
		if sp, ok := selfParsers[name]; ok {
			g = parserGrammar(t, sp.file, sp.fn)
		}
		for _, f := range s.value {
			takesValue, known := g[f]
			switch {
			case !known:
				t.Errorf("%s owns --%s but its parser has no case for it: the native path "+
					"would accept the flag and silently ignore it", name, f)
			case !takesValue:
				t.Errorf("%s declares --%s as value-taking but its parser reads it as a "+
					"boolean: the value would be left in argv as a positional", name, f)
			}
		}
		for _, f := range s.boolean {
			takesValue, known := g[f]
			switch {
			case !known:
				t.Errorf("%s owns --%s but its parser has no case for it: the native path "+
					"would accept the flag and silently ignore it", name, f)
			case takesValue:
				t.Errorf("%s declares --%s as a boolean but its parser consumes the next "+
					"token as its value: the following argument would disappear", name, f)
			}
		}
	}
}

// TestEveryParsedFlagIsOwned closes the other end of the same wiring: a case in
// parse() that no command owns can never fire, because delegate.ownedNatively
// sends any invocation carrying an unowned flag to Node. Dead grammar is not
// harmless — it reads, to the next person, as a supported flag.
func TestEveryParsedFlagIsOwned(t *testing.T) {
	owned := map[string]bool{}
	for name, s := range registry {
		if _, self := selfParsers[name]; self {
			continue
		}
		for _, f := range append(append([]string{}, s.value...), s.boolean...) {
			owned[f] = true
		}
	}
	for _, f := range sortedNames(sharedGrammar(t)) {
		if !owned[f] {
			t.Errorf("cmd.parse reads --%s but no command in the registry owns it, so an "+
				"invocation carrying it always delegates and the case is dead", f)
		}
	}
}

// TestDocumentedFlagsMatchTheParser is the drift check this file exists for: it
// compares the help spec's structured options with the grammar the parser
// actually implements, in both directions.
//
//	→ the parser accepts a flag the spec does not document for that command:
//	  the CLI has a capability nothing can discover.
//	→ the spec documents a flag for a command whose parser has no case for it:
//	  a documented invocation the native path cannot serve.
//
// Both are reported by name, with the command, so the failure says what to fix
// rather than that something is wrong.
func TestDocumentedFlagsMatchTheParser(t *testing.T) {
	spec, ok := help.Structured()
	if !ok {
		t.Fatalf("`help --json` carries no derived structure, so there is nothing to "+
			"compare the parser against\n    fix: %s", help.Regenerate)
	}

	global := map[string]help.Option{}
	for _, o := range spec.Options {
		global[o.Name] = o
	}
	byCommand := map[string]map[string]help.Option{}
	for _, c := range spec.Commands {
		m := map[string]help.Option{}
		for _, o := range c.Options {
			m[o.Name] = o
		}
		for _, sc := range c.Subcommands {
			for _, o := range sc.Options {
				if _, seen := m[o.Name]; !seen {
					m[o.Name] = o
				}
			}
		}
		byCommand[c.Name] = m
	}

	shared := sharedGrammar(t)
	used := map[string]bool{}

	for _, name := range sortedRegistry() {
		s := registry[name]
		if s.goNative {
			continue // not in the spec at all — TestSelfParsingCommandsAreCovered
		}
		doc, documented := byCommand[name]
		if !documented {
			t.Errorf("`%s` is served natively but the help spec has no entry for it", name)
			continue
		}
		// The triage verbs share ONE flag set on purpose (registry.go: a per-verb
		// subset would make `archive --unset` delegate while `seen --unset` did
		// not, for no reason a user could predict), so they are documented as a
		// group and checked as one.
		if isTriageVerb(name) {
			doc = map[string]help.Option{}
			for _, verb := range triageVerbs {
				for k, v := range byCommand[verb] {
					doc[k] = v
				}
			}
		}

		g := shared
		if sp, ok := selfParsers[name]; ok {
			g = parserGrammar(t, sp.file, sp.fn)
		}

		for _, f := range sortedStrings(append(append([]string{}, s.value...), s.boolean...)) {
			key := name + "/" + f
			o, inDoc := doc[f]
			if !inDoc {
				o, inDoc = global[f]
			}
			if !inDoc {
				if _, known := undocumentedByDesign[key]; known {
					used[key] = true
					continue
				}
				t.Errorf("`bullmoose %s --%s` works, and nothing documents it: it is in "+
					"neither %s's flags nor the global options, so `help --json` cannot "+
					"discover it.\n    fix: add it to %s (then %s), or add it to "+
					"undocumentedByDesign here with the reason it cannot be",
					name, f, name, help.SpecPath, help.Regenerate)
				continue
			}
			takesValue, known := g[f]
			if !known {
				continue // reported by TestRegistryFlagsAreTheParsersOwn
			}
			if o.TakesValue != takesValue {
				t.Errorf("`%s --%s`: the parser %s, the help spec says it %s.\n"+
					"    an agent reading the spec would build an invocation this CLI mis-parses\n"+
					"    fix: %s, or the parser in %s",
					name, f, arity(takesValue), arity(o.TakesValue), help.SpecPath, parserFile(name))
			}
		}
	}

	for key, why := range undocumentedByDesign {
		if !used[key] {
			t.Errorf("undocumentedByDesign lists %s, but nothing reported it — either it is "+
				"documented now (delete the entry) or the command no longer owns the flag.\n"+
				"    the entry says: %s", key, why)
		}
	}
}

// TestSelfParsingCommandsAreCovered is the coverage boundary, written down.
//
// `watch`, `approvals` and `agents` do not go through parse(). `watch` has a
// Node twin and a help page, so it is checked against the spec like everything
// else. The other two are Go-native-only: nothing in help.ts describes them,
// because there is nothing on the TypeScript side to describe. Skipping them
// there would make this file's coverage look total when it is not, so they are
// checked against the oracle that DOES cover them — delegate's valueFlags /
// booleanFlags, which argv_test.go diffs against main.ts's parseArgs spec in
// both directions. The chain is therefore parser → front-door scanner →
// TypeScript declaration, and a flag missing anywhere along it breaks something
// real: the scanner has to know a flag's arity to find the command name at all
// (`bullmoose --question "why?" approvals …`).
func TestSelfParsingCommandsAreCovered(t *testing.T) {
	// The list is the whole set: anything that parses its own argv, or has no
	// Node twin, must be in it.
	for name, s := range registry {
		if _, listed := selfParsers[name]; listed {
			continue
		}
		if s.selfParses {
			t.Errorf("%s is marked selfParses but is not in selfParsers, so its grammar is "+
				"checked against cmd.parse — which it does not use", name)
		}
		if s.goNative {
			t.Errorf("%s has no Node twin and no help page; it must be in selfParsers so its "+
				"flags are checked against delegate's tables instead", name)
		}
	}

	// The check itself is deliberately NOT "is it in the help spec": `watch`
	// already gets that from TestDocumentedFlagsMatchTheParser, and the other two
	// cannot get it from anywhere, which is the boundary this test is here to
	// state. What every self-parsed flag CAN be held to is the front door's own
	// table, and that is what is checked.
	scanner := scannerFlags(t)

	used := map[string]bool{}
	for _, name := range sortedNames(selfParsers) {
		sp := selfParsers[name]
		g := parserGrammar(t, sp.file, sp.fn)
		for _, f := range sortedNames(g) {
			takesValue := g[f]
			key := name + "/" + f
			arityKnown, inScanner := scanner[f]
			if !inScanner {
				if _, known := scannerGapsByDesign[key]; known {
					used[key] = true
					continue
				}
				t.Errorf("%s reads --%s but delegate's flag tables do not declare it: the "+
					"front door cannot tell where the flag ends, so `bullmoose --%s X %s …` "+
					"names X as the command.\n    fix: declare it in internal/delegate/argv.go "+
					"AND in main.ts's parseArgs spec (argv_test.go checks both directions)",
					sp.fn, f, f, name)
				continue
			}
			if arityKnown != takesValue {
				if _, known := scannerGapsByDesign[key]; known {
					used[key] = true
					continue
				}
				t.Errorf("%s reads --%s as %s, delegate's tables declare it %s — the front "+
					"door and the command disagree about where the flag ends",
					sp.fn, f, arity(takesValue), arity(arityKnown))
			}
		}
	}

	for key, why := range scannerGapsByDesign {
		if !used[key] {
			t.Errorf("scannerGapsByDesign lists %s, but nothing reported it — the gap was "+
				"closed and the entry should go.\n    the entry says: %s", key, why)
		}
	}
}

// scannerGapsByDesign: flags a self-parsing command reads that internal/delegate
// does not declare, or declares at a different arity. Like undocumentedByDesign
// these are BUGS, not exemptions — but the fix has to land in main.ts's
// parseArgs spec at the same time (argv_test.go diffs delegate against it in
// both directions), which is outside this module.
var scannerGapsByDesign = map[string]string{
	"approvals/status": "parseApprovals reads `--status <state>` as a value; delegate " +
		"declares --status a BOOLEAN (it is `watch --status`), so the two disagree about " +
		"whether the next token belongs to the flag",
}

// ───────────────────────────── helpers ──────────────────────────────────────

// scannerFlags reads internal/delegate/argv.go's own tables — the front door's
// view of every flag in the whole CLI, Go-native commands included.
func scannerFlags(t *testing.T) grammar {
	t.Helper()
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, "../delegate/argv.go", nil, 0)
	if err != nil {
		t.Fatalf("parse delegate/argv.go: %v", err)
	}
	g := grammar{}
	for _, name := range []struct {
		ident      string
		takesValue bool
	}{{"valueFlags", true}, {"booleanFlags", false}} {
		lit := mapLiteral(f, name.ident)
		if lit == nil {
			t.Fatalf("internal/delegate/argv.go no longer declares %s as a map literal — "+
				"this test would silently stop checking the front door", name.ident)
		}
		for _, elt := range lit.Elts {
			kv, ok := elt.(*ast.KeyValueExpr)
			if !ok {
				continue
			}
			key, ok := kv.Key.(*ast.BasicLit)
			if !ok || key.Kind != token.STRING {
				continue
			}
			if s, err := strconv.Unquote(key.Value); err == nil {
				g[s] = name.takesValue
			}
		}
	}
	return g
}

func mapLiteral(f *ast.File, name string) *ast.CompositeLit {
	var lit *ast.CompositeLit
	ast.Inspect(f, func(n ast.Node) bool {
		vs, ok := n.(*ast.ValueSpec)
		if !ok || len(vs.Names) != 1 || vs.Names[0].Name != name || len(vs.Values) != 1 {
			return true
		}
		if cl, ok := vs.Values[0].(*ast.CompositeLit); ok {
			lit = cl
		}
		return false
	})
	return lit
}

func arity(takesValue bool) string {
	if takesValue {
		return "takes a value"
	}
	return "is a boolean"
}

func parserFile(command string) string {
	if sp, ok := selfParsers[command]; ok {
		return "internal/cmd/" + sp.file
	}
	return "internal/cmd/args.go"
}

func isTriageVerb(name string) bool {
	for _, v := range triageVerbs {
		if v == name {
			return true
		}
	}
	return false
}

func sortedRegistry() []string {
	out := make([]string, 0, len(registry))
	for name := range registry {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

func sortedNames[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func sortedStrings(in []string) []string {
	out := append([]string{}, in...)
	sort.Strings(out)
	return uniq(out)
}

func uniq(in []string) []string {
	out := in[:0]
	var last string
	for i, s := range in {
		if i == 0 || s != last {
			out = append(out, s)
		}
		last = s
	}
	return out
}
