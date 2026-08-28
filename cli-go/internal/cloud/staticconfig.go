package cloud

// `_redirects` and `_headers` — Cloudflare Pages' conventions, kept as the
// INTERFACE after Pages itself left the stack.
//
// Keeping the file format means a static build that worked on Pages works
// here unchanged, and nobody has to learn a bullmoose-specific way to say
// "301 this path". The files stay where Astro/Vite already put them
// (`public/`, copied into the build), and this compiles them.
//
// ## Compiled at PUSH time, not read per request
//
// The worker could parse these itself on every request, but then a typo is a
// silent runtime behaviour change discovered by a user, and every request
// pays for the parse. Instead the CLI parses once, fails the deploy loudly if
// the syntax is wrong, and writes a compiled RoutingConfig into the bucket
// that the worker loads once per isolate.
//
// ## Unsupported syntax is REFUSED, never ignored
//
// Pages supports more than this does — `:placeholder` captures, status-200
// proxy rewrites, per-rule query matching. The tempting thing is to skip
// lines we do not understand. That is the worst option available: a redirect
// that silently does not exist looks exactly like a redirect that works until
// someone follows the old link. So an unknown construct fails the push, names
// the file and LINE, and says what to do instead.

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// RoutingKey is where the compiled rules live in the bucket. Dotted and
// namespaced so it cannot collide with a build's own output, and the workers
// refuse to serve it — it is configuration, not content.
const RoutingKey = ".bullmoose/routing.json"

// maxRules bounds both lists. Pages' own limit is ~2100; this is lower on
// purpose, because the worker evaluates redirects in order on every request
// and a list long enough to matter is a sign someone generated it by accident.
const maxRules = 500

// Redirect is one compiled `_redirects` line.
type Redirect struct {
	From   string `json:"from"`   // "/old" or "/old/*" (Splat true)
	To     string `json:"to"`     // path or absolute URL; may end in ":splat"
	Status int    `json:"status"` // 301/302/303/307/308/404/410
	Splat  bool   `json:"splat"`
}

// HeaderRule is one compiled `_headers` block.
type HeaderRule struct {
	Path  string            `json:"path"`
	Splat bool              `json:"splat"`
	Set   map[string]string `json:"set,omitempty"`
	Unset []string          `json:"unset,omitempty"`
}

// RoutingConfig is what the worker loads.
type RoutingConfig struct {
	Redirects []Redirect   `json:"redirects,omitempty"`
	Headers   []HeaderRule `json:"headers,omitempty"`
}

func (r *RoutingConfig) empty() bool { return len(r.Redirects) == 0 && len(r.Headers) == 0 }

// redirectStatuses is the closed set. 200 is deliberately absent — see
// parseRedirects for why it gets its own refusal rather than "unknown status".
var redirectStatuses = map[int]bool{301: true, 302: true, 303: true, 307: true, 308: true, 404: true, 410: true}

/**
 * ParseRedirects compiles a `_redirects` file.
 *
 * Supported, which is the subset a static site actually uses:
 *
 *	/old            /new                  # 302 by default
 *	/old            /new              301
 *	/old/*          /new/:splat       301  # trailing wildcard only
 *	/gone           https://elsewhere/x    # absolute destinations are fine
 *	/dead           /                  410
 */
func ParseRedirects(body string) ([]Redirect, error) {
	var out []Redirect
	for i, raw := range strings.Split(body, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		lineNo := i + 1
		fields := strings.Fields(line)
		if len(fields) < 2 {
			return nil, fmt.Errorf("_redirects line %d: %q needs at least a source and a destination", lineNo, line)
		}
		if len(fields) > 3 {
			return nil, fmt.Errorf("_redirects line %d: %q has %d fields — this supports `from to [status]` only", lineNo, line, len(fields))
		}
		from, to := fields[0], fields[1]

		if !strings.HasPrefix(from, "/") {
			return nil, fmt.Errorf("_redirects line %d: source %q must start with / (this does not match on hostname)", lineNo, from)
		}
		if strings.Contains(from, ":") {
			return nil, fmt.Errorf(
				"_redirects line %d: %q uses a :placeholder capture, which is not supported — "+
					"use a trailing /* with :splat, or write the paths out", lineNo, from)
		}
		splat := strings.HasSuffix(from, "/*")
		if star := strings.Index(from, "*"); star >= 0 && !(splat && star == len(from)-1) {
			return nil, fmt.Errorf(
				"_redirects line %d: %q has a wildcard that is not a trailing /* — "+
					"only a trailing wildcard is supported", lineNo, from)
		}
		if strings.Contains(to, ":") && !strings.HasSuffix(to, ":splat") {
			// `https://host/x` contains a colon legitimately; catch the
			// placeholder case without banning URLs.
			if !strings.Contains(to, "://") {
				return nil, fmt.Errorf(
					"_redirects line %d: destination %q uses a :placeholder, which is not supported "+
						"(only :splat, at the end)", lineNo, to)
			}
		}
		if strings.HasSuffix(to, ":splat") && !splat {
			return nil, fmt.Errorf("_redirects line %d: destination uses :splat but the source %q has no trailing /*", lineNo, from)
		}

		status := 302
		if len(fields) == 3 {
			n, err := strconv.Atoi(fields[2])
			if err != nil {
				return nil, fmt.Errorf("_redirects line %d: %q is not a status code", lineNo, fields[2])
			}
			if n == 200 {
				return nil, fmt.Errorf(
					"_redirects line %d: status 200 is a REWRITE (serve another path under this URL), which is not "+
						"supported. If this is an SPA catch-all, the worker does that natively — set `spa: true` in "+
						"its config instead of a rule here", lineNo)
			}
			if !redirectStatuses[n] {
				return nil, fmt.Errorf("_redirects line %d: status %d is not one this supports (301, 302, 303, 307, 308, 404, 410)", lineNo, n)
			}
			status = n
		}
		out = append(out, Redirect{From: strings.TrimSuffix(from, "/*"), To: to, Status: status, Splat: splat})
		if len(out) > maxRules {
			return nil, fmt.Errorf("_redirects has more than %d rules — that is past what belongs in a per-request list", maxRules)
		}
	}
	return out, nil
}

/**
 * ParseHeaders compiles a `_headers` file.
 *
 *	/build/*
 *	  Cache-Control: public, max-age=31536000, immutable
 *	/admin/*
 *	  X-Frame-Options: DENY
 *	  ! X-Powered-By
 *
 * A path line starts at column 0; its header lines are indented. `! Name`
 * removes a header the host would otherwise set.
 */
func ParseHeaders(body string) ([]HeaderRule, error) {
	var out []HeaderRule
	var cur *HeaderRule
	flush := func() {
		if cur != nil && (len(cur.Set) > 0 || len(cur.Unset) > 0) {
			out = append(out, *cur)
		}
		cur = nil
	}
	for i, raw := range strings.Split(body, "\n") {
		lineNo := i + 1
		if strings.TrimSpace(raw) == "" || strings.HasPrefix(strings.TrimSpace(raw), "#") {
			continue
		}
		indented := raw[0] == ' ' || raw[0] == '\t'
		line := strings.TrimSpace(raw)

		if !indented {
			flush()
			// Colon first: an un-indented header line is far and away the
			// common mistake, and "you forgot to indent this" is a better
			// answer than "that is not a path".
			if strings.Contains(line, ":") {
				return nil, fmt.Errorf("_headers line %d: %q looks like a header but is not indented — indent it under a path", lineNo, line)
			}
			if !strings.HasPrefix(line, "/") {
				return nil, fmt.Errorf("_headers line %d: %q should be a path starting with / (header lines must be indented)", lineNo, line)
			}
			splat := strings.HasSuffix(line, "/*")
			if star := strings.Index(line, "*"); star >= 0 && !(splat && star == len(line)-1) {
				return nil, fmt.Errorf("_headers line %d: %q has a wildcard that is not a trailing /*", lineNo, line)
			}
			cur = &HeaderRule{Path: strings.TrimSuffix(line, "/*"), Splat: splat, Set: map[string]string{}}
			continue
		}

		if cur == nil {
			return nil, fmt.Errorf("_headers line %d: %q is indented but no path precedes it", lineNo, line)
		}
		if strings.HasPrefix(line, "!") {
			name := strings.TrimSpace(strings.TrimPrefix(line, "!"))
			if name == "" {
				return nil, fmt.Errorf("_headers line %d: `!` needs the name of a header to remove", lineNo)
			}
			cur.Unset = append(cur.Unset, strings.ToLower(name))
			continue
		}
		name, value, ok := strings.Cut(line, ":")
		if !ok {
			return nil, fmt.Errorf("_headers line %d: %q is not `Name: value`", lineNo, line)
		}
		name, value = strings.TrimSpace(name), strings.TrimSpace(value)
		if name == "" || value == "" {
			return nil, fmt.Errorf("_headers line %d: %q has an empty name or value", lineNo, line)
		}
		cur.Set[strings.ToLower(name)] = value
		if len(out) > maxRules {
			return nil, fmt.Errorf("_headers has more than %d rules", maxRules)
		}
	}
	flush()
	return out, nil
}

/**
 * compileRouting pulls `_redirects`/`_headers` OUT of the asset list and
 * returns them compiled.
 *
 * Removing them is the point, not a side effect: Pages consumes these files
 * and never serves them, and uploading them as ordinary objects would publish
 * `/_redirects` — which is not secret, but does hand a reader the list of
 * paths you thought were retired.
 */
func compileRouting(assets []Asset) ([]Asset, *RoutingConfig, error) {
	cfg := &RoutingConfig{}
	kept := assets[:0:0] // new backing array; assets is reused by callers
	for _, a := range assets {
		switch a.Key {
		case "_redirects":
			rs, err := ParseRedirects(string(a.Body))
			if err != nil {
				return nil, nil, err
			}
			cfg.Redirects = rs
		case "_headers":
			hs, err := ParseHeaders(string(a.Body))
			if err != nil {
				return nil, nil, err
			}
			cfg.Headers = hs
		default:
			kept = append(kept, a)
		}
	}
	// Longest path first, so `/guides/deep/*` wins over `/guides/*` regardless
	// of the order someone wrote them in. Pages resolves by file order, which
	// makes a correct file depend on remembering to put specific rules above
	// general ones — a rule that silently never fires is exactly what this
	// package refuses to ship elsewhere.
	sort.SliceStable(cfg.Redirects, func(i, j int) bool {
		return len(cfg.Redirects[i].From) > len(cfg.Redirects[j].From)
	})
	sort.SliceStable(cfg.Headers, func(i, j int) bool {
		return len(cfg.Headers[i].Path) < len(cfg.Headers[j].Path) // general first; specific overrides
	})
	return kept, cfg, nil
}
