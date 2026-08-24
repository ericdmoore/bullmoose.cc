package cloud

// The PLAN — a pure function of (stack, probe, zone), printed whole before
// anything is asked. s46's consent model is popcorn's, third instance: the
// plan is the honest prompt, refusals sit ABOVE it, and idempotence is
// structural — an existing bullmoose resource plans as `reuse`, so a
// half-applied install is a resumable state rather than a broken one.
//
// Rules of construction:
//
//   - Ids never plan. The shipped configs carry the ids of the account the
//     stack was BUILT against; an install creates its own and learns fresh
//     ids at apply. NAMES are the contract (jsonc.go says the same).
//   - The zone rewrite is a suffix swap. Every route in the shipped configs
//     ends in bullmoose.cc; the same route on the target zone is the same
//     subdomain of it. planHost is the ONE place that knows this.
//   - `refuse` beats `create`. A DNS name the install needs that already
//     resolves to something that is not ours is someone's LIVE thing; the
//     installer never overwrites a resource it did not make, so the plan
//     says so before any prompt could.
//   - A denied probe surface plans as `blocked`, carrying the token scope
//     by name. Blocked is not refused: fix the token, re-run, same plan.

import (
	"fmt"
	"sort"
	"strings"
)

// builtZone is the zone the shipped configs were written against.
const builtZone = "bullmoose.cc"

// Action is what apply would do for one resource.
type Action string

const (
	Create  Action = "create"  // does not exist; apply makes it
	Reuse   Action = "reuse"   // exists and is bullmoose-shaped; apply reconciles
	Refuse  Action = "refuse"  // exists and is NOT ours; apply must never touch it
	Blocked Action = "blocked" // unknowable — the token could not read the surface
	Mint    Action = "mint"    // a secret generated locally at apply
	Supply  Action = "supply"  // a secret the operator must provide
)

// Item is one planned resource.
type Item struct {
	Kind   string `json:"kind"` // worker | d1 | r2 | kv | pages | dns | secret
	Name   string `json:"name"`
	Action Action `json:"action"`
	Detail string `json:"detail,omitempty"`
}

// Plan is the whole answer. Refusals and blocks are ALSO in Items, in
// place; the top-level slices exist so callers can rank them first and
// decide exit codes without re-walking.
type Plan struct {
	Version  string   `json:"version"`
	Zone     string   `json:"zone"`
	Items    []Item   `json:"items"`
	Refusals []Item   `json:"refusals"`
	Blocked  []Denial `json:"blocked"`
}

// planHost rewrites one host from the built zone to the target zone:
// app.bullmoose.cc → app.<zone>, bare bullmoose.cc → <zone>.
func planHost(host, zone string) string {
	if host == builtZone {
		return zone
	}
	if strings.HasSuffix(host, "."+builtZone) {
		return strings.TrimSuffix(host, builtZone) + zone
	}
	return host
}

// planPattern rewrites a route pattern's host part, leaving the path alone.
func planPattern(pattern, zone string) string {
	host, path, hasPath := strings.Cut(pattern, "/")
	if !hasPath {
		return planHost(pattern, zone)
	}
	return planHost(host, zone) + "/" + path
}

func has(list []string, name string) bool {
	for _, x := range list {
		if x == name {
			return true
		}
	}
	return false
}

// BuildPlan computes the plan. Pure: no I/O, no clock — everything it may
// know arrives in its arguments, which is what makes it testable the way
// popcorn's plan_test.go is.
func BuildPlan(st *Stack, probe *ProbeResult, zone string) *Plan {
	p := &Plan{Version: st.Manifest.Version, Zone: zone}
	denied := make(map[string]bool, len(probe.Denied))
	for _, d := range probe.Denied {
		denied[d.Surface] = true
		p.Blocked = append(p.Blocked, d)
	}
	add := func(it Item) {
		p.Items = append(p.Items, it)
		if it.Action == Refuse {
			p.Refusals = append(p.Refusals, it)
		}
	}
	// existence answers three ways: yes / no / unknowable — and unknowable
	// must not masquerade as "create" (the confidently-wrong rendering).
	presence := func(surface string, known []string, name string) Action {
		switch {
		case denied[surface]:
			return Blocked
		case has(known, name):
			return Reuse
		default:
			return Create
		}
	}

	// Workers, in deploy order — the order IS the binding graph.
	d1Names, r2Names, kvBindings := map[string]bool{}, map[string]bool{}, map[string]bool{}
	dnsWanted := map[string]string{} // host → why
	for _, name := range st.Manifest.DeployOrder {
		cfg := st.Configs[name]
		var notes []string
		for _, d := range cfg.D1 {
			d1Names[d.DatabaseName] = true
		}
		for _, r := range cfg.R2 {
			r2Names[r.BucketName] = true
		}
		for _, k := range cfg.KV {
			kvBindings[k.Binding] = true
		}
		for _, s := range cfg.Services {
			notes = append(notes, "binds "+s.Service)
		}
		for _, do := range cfg.DurableObjects.Bindings {
			if do.ScriptName != "" && do.ScriptName != cfg.Name {
				notes = append(notes, "DO "+do.ClassName+" in "+do.ScriptName)
			}
		}
		for _, r := range cfg.Routes {
			if r.Pattern == "" {
				continue
			}
			rewritten := planPattern(r.Pattern, zone)
			notes = append(notes, "route "+rewritten)
			host, _, _ := strings.Cut(rewritten, "/")
			if r.CustomDomain {
				dnsWanted[host] = "custom domain of " + cfg.Name
			} else {
				dnsWanted[host] = "route host for " + cfg.Name
			}
		}
		add(Item{Kind: "worker", Name: cfg.Name,
			Action: presence("Workers scripts", probe.Workers, cfg.Name),
			Detail: strings.Join(notes, "; ")})
	}

	for _, name := range sortedKeys(d1Names) {
		detail := fmt.Sprintf("apply %s, then %d migrations", strings.Join(st.Manifest.Schema, " + "), st.Manifest.Migrations.Count)
		add(Item{Kind: "d1", Name: name, Action: presence("D1 databases", probe.D1Names(), name), Detail: detail})
	}
	for _, name := range sortedKeys(r2Names) {
		add(Item{Kind: "r2", Name: name, Action: presence("R2 buckets", probe.R2, name)})
	}
	for _, binding := range sortedKeys(kvBindings) {
		// KV namespaces are found by TITLE; the shipped id is the built
		// account's and does not travel (see jsonc.go).
		add(Item{Kind: "kv", Name: binding, Action: presence("KV namespaces", probe.KVTitles(), binding),
			Detail: "id assigned at apply"})
	}

	// The webmail app — a Pages project plus the app hostname.
	add(Item{Kind: "pages", Name: "bullmoose-app", Action: presence("Pages projects", probe.Pages, "bullmoose-app"),
		Detail: "upload " + st.Manifest.Webmail + "; custom domain app." + zone})
	dnsWanted["app."+zone] = "custom domain of bullmoose-app (Pages)"

	// DNS — the one class where `exists` can mean REFUSE: a name that
	// already resolves to something not ours is someone's live thing. But a
	// record whose content PROVES it serves this platform (a Worker or
	// Pages edge target — what our own custom-domain attach writes) is a
	// prior install's, and reusing it is what lets `cloud update` and a
	// resumed install re-run on the zone they installed. Proof, not
	// pattern-matching on hope: anything else still refuses.
	for _, host := range sortedKeysS(dnsWanted) {
		why := dnsWanted[host]
		switch {
		case denied["DNS records"]:
			add(Item{Kind: "dns", Name: host, Action: Blocked, Detail: why})
		case dnsOurs(probe.DNS, host):
			add(Item{Kind: "dns", Name: host, Action: Reuse, Detail: why + " — the existing record already targets this platform"})
		case dnsTaken(probe.DNS, host):
			add(Item{Kind: "dns", Name: host, Action: Refuse,
				Detail: why + " — a record already exists here and the installer never overwrites a resource it did not make; remove or rename it, then re-run"})
		default:
			add(Item{Kind: "dns", Name: host, Action: Create, Detail: why})
		}
	}

	// Secrets — minted locally (the custody rule: generated values land
	// only in the user's account and config; the project sees nothing) or
	// supplied by the operator, note attached.
	for _, name := range sortedKeysGenerated(st) {
		spec := st.Manifest.Secrets.Generated[name]
		add(Item{Kind: "secret", Name: name, Action: Mint,
			Detail: fmt.Sprintf("%d random bytes, minted locally → %s", spec.Bytes, strings.Join(spec.Workers, ", "))})
	}
	for _, name := range sortedKeysExternal(st) {
		spec := st.Manifest.Secrets.External[name]
		detail := "→ " + strings.Join(spec.Workers, ", ")
		if spec.Note != "" {
			detail += " (" + spec.Note + ")"
		}
		if !spec.Required {
			detail += " [optional]"
		}
		add(Item{Kind: "secret", Name: name, Action: Supply, Detail: detail})
	}
	return p
}

// dnsTaken: does any record already claim this exact host?
func dnsTaken(records []DNSRecord, host string) bool {
	for _, r := range records {
		if strings.EqualFold(r.Name, host) {
			return true
		}
	}
	return false
}

// dnsOurs: every record on this host provably targets this platform's edge
// — the shapes our own attach calls write, VERIFIED against production
// rather than assumed: a Worker custom domain is a proxied placeholder
// (`AAAA 100::`, the IPv6 discard prefix — `A 192.0.2.1` is its v4 twin;
// neither can be anyone's real server), a Pages custom domain is a CNAME
// to *.pages.dev, Email Routing is MX to *.mx.cloudflare.net. One foreign
// record among them and the host is NOT ours.
func dnsOurs(records []DNSRecord, host string) bool {
	found := false
	for _, r := range records {
		if !strings.EqualFold(r.Name, host) {
			continue
		}
		found = true
		content := strings.ToLower(strings.TrimSuffix(r.Content, "."))
		switch {
		case r.Type == "AAAA" && content == "100::":
		case r.Type == "A" && content == "192.0.2.1":
		case r.Type == "CNAME" && (strings.HasSuffix(content, ".pages.dev") || strings.HasSuffix(content, ".workers.dev")):
		case r.Type == "MX" && strings.HasSuffix(content, "mx.cloudflare.net"):
		default:
			return false
		}
	}
	return found
}

func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func sortedKeysS(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func sortedKeysGenerated(st *Stack) []string {
	out := make([]string, 0, len(st.Manifest.Secrets.Generated))
	for k := range st.Manifest.Secrets.Generated {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func sortedKeysExternal(st *Stack) []string {
	out := make([]string, 0, len(st.Manifest.Secrets.External))
	for k := range st.Manifest.Secrets.External {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
