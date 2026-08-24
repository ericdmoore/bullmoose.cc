package cloud

// The PROBE — read-only, and the whole of what `cloud plan` is allowed to
// do to an account. It answers three questions: is the token alive, is the
// zone yours, and what bullmoose-shaped things already exist. A 403 on any
// surface is not an error here — it is a FINDING, recorded with the token
// scope by NAME (the s46 risk register: "your token lacks X" must name the
// scope, not the HTTP code), and the plan renders it as blocked work.

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// DefaultAPIBase is Cloudflare's v4 API. Overridable via the
// CLOUDFLARE_API_BASE_URL environment variable — wrangler's own spelling,
// so one habit covers both tools (and it is the test seam).
const DefaultAPIBase = "https://api.cloudflare.com/client/v4"

// CF is a minimal read-only Cloudflare API client. The token travels in the
// Authorization header only — never in a URL, never in argv.
type CF struct {
	Base  string
	Token string
	HTTP  *http.Client
}

func NewCF(base, token string, client *http.Client) *CF {
	if base == "" {
		base = DefaultAPIBase
	}
	if client == nil {
		client = http.DefaultClient
	}
	return &CF{Base: strings.TrimSuffix(base, "/"), Token: token, HTTP: client}
}

// Denial is one probe surface the token could not read, with the scope a
// custom-token recipe would name.
type Denial struct {
	Surface string `json:"surface"`
	Scope   string `json:"scope"`
}

// DNSRecord is the slice of a zone record the plan compares against.
type DNSRecord struct {
	Name    string `json:"name"`
	Type    string `json:"type"`
	Content string `json:"content"`
}

// ZoneInfo identifies the target zone and, through it, the account —
// deliberately derived rather than asked for: token + --zone is the whole
// required input surface.
type ZoneInfo struct {
	ID        string
	Name      string
	AccountID string
}

// D1Database / KVNamespace carry the id alongside the name: the PLAN keys
// on names only, but apply must bind EXISTING resources by the id the
// account actually assigned (never the built account's ids in the shipped
// configs), and re-listing mid-apply would race the probe it just showed
// the user.
type D1Database struct {
	Name string `json:"name"`
	UUID string `json:"uuid"`
}

type KVNamespace struct {
	Title string `json:"title"`
	ID    string `json:"id"`
}

// ProbeResult is everything the plan may know about the account.
type ProbeResult struct {
	Zone    *ZoneInfo // nil: the token sees no such zone
	Workers []string
	D1      []D1Database
	R2      []string
	KV      []KVNamespace
	// Pages is READ but no longer required: the webmail moved to R2 behind
	// services/webhost, so `Cloudflare Pages: Edit` left the token recipe.
	// The field stays so an install that still HAS a Pages project can say
	// so rather than pretending the account is empty.
	Pages  []string
	DNS    []DNSRecord
	Denied []Denial
}

// D1Names / KVTitles are the name views the plan compares against.
func (p *ProbeResult) D1Names() []string {
	out := make([]string, len(p.D1))
	for i, d := range p.D1 {
		out[i] = d.Name
	}
	return out
}

func (p *ProbeResult) KVTitles() []string {
	out := make([]string, len(p.KV))
	for i, k := range p.KV {
		out[i] = k.Title
	}
	return out
}

type cfEnvelope struct {
	Success bool `json:"success"`
	Errors  []struct {
		Message string `json:"message"`
	} `json:"errors"`
	Result json.RawMessage `json:"result"`
}

// errDenied marks a 403 so callers can turn it into a Denial finding.
type errDenied struct{ path string }

func (e errDenied) Error() string { return "403 on " + e.path }

func (c *CF) getJSON(path string, into any) error {
	req, err := http.NewRequest(http.MethodGet, c.Base+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	res, err := c.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("GET %s: %w", path, err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		return err
	}
	if res.StatusCode == http.StatusForbidden || res.StatusCode == http.StatusUnauthorized {
		return errDenied{path: path}
	}
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("GET %s: HTTP %d", path, res.StatusCode)
	}
	var env cfEnvelope
	if err := json.Unmarshal(body, &env); err != nil {
		return fmt.Errorf("GET %s: not a Cloudflare envelope: %w", path, err)
	}
	if !env.Success {
		msg := "unknown error"
		if len(env.Errors) > 0 {
			msg = env.Errors[0].Message
		}
		return fmt.Errorf("GET %s: %s", path, msg)
	}
	return json.Unmarshal(env.Result, into)
}

// Probe runs the read-only sweep. The token being dead and the zone being
// absent are ERRORS (nothing downstream is answerable); a partial-permission
// token is a RESULT, with the gaps in Denied.
func Probe(c *CF, zone string) (*ProbeResult, error) {
	// Alive at all? /user/tokens/verify is readable by every API token.
	var verify struct {
		Status string `json:"status"`
	}
	if err := c.getJSON("/user/tokens/verify", &verify); err != nil {
		return nil, fmt.Errorf("the token does not verify — is CLOUDFLARE_API_TOKEN set to a live API token? (%w)", err)
	}
	if verify.Status != "active" {
		return nil, fmt.Errorf("the token verifies but its status is %q, not active", verify.Status)
	}

	var zones []struct {
		ID      string `json:"id"`
		Name    string `json:"name"`
		Account struct {
			ID string `json:"id"`
		} `json:"account"`
	}
	if err := c.getJSON("/zones?name="+zone, &zones); err != nil {
		if _, denied := err.(errDenied); denied {
			return nil, fmt.Errorf("the token cannot list zones — it needs `Zone > Zone > Read` on %s", zone)
		}
		return nil, err
	}
	if len(zones) == 0 {
		return nil, fmt.Errorf("the token sees no zone named %q — either the domain is not on this Cloudflare account or the token is scoped away from it", zone)
	}
	res := &ProbeResult{Zone: &ZoneInfo{ID: zones[0].ID, Name: zones[0].Name, AccountID: zones[0].Account.ID}}
	acct := res.Zone.AccountID

	// The account surfaces. Each denial is recorded, not fatal: the plan
	// tells the whole truth at once instead of one 403 per run.
	sweep := []struct {
		path    string
		surface string
		scope   string
		collect func(json.RawMessage) error
	}{
		{"/accounts/" + acct + "/workers/scripts", "Workers scripts", "Account > Workers Scripts > Edit",
			collectNames("id", &res.Workers)},
		{"/accounts/" + acct + "/d1/database", "D1 databases", "Account > D1 > Edit",
			func(raw json.RawMessage) error { return json.Unmarshal(raw, &res.D1) }},
		{"/accounts/" + acct + "/r2/buckets", "R2 buckets", "Account > Workers R2 Storage > Edit",
			collectR2(&res.R2)},
		{"/accounts/" + acct + "/storage/kv/namespaces", "KV namespaces", "Account > Workers KV Storage > Edit",
			func(raw json.RawMessage) error { return json.Unmarshal(raw, &res.KV) }},
		{"/zones/" + res.Zone.ID + "/dns_records", "DNS records", "Zone > DNS > Edit",
			collectDNS(&res.DNS)},
	}
	for _, s := range sweep {
		var raw json.RawMessage
		err := c.getJSON(s.path, &raw)
		if _, denied := err.(errDenied); denied {
			res.Denied = append(res.Denied, Denial{Surface: s.surface, Scope: s.scope})
			continue
		}
		if err != nil {
			return nil, err
		}
		if err := s.collect(raw); err != nil {
			return nil, fmt.Errorf("%s: %w", s.path, err)
		}
	}
	return res, nil
}

// collectNames extracts field `key` from each element of a JSON array.
func collectNames(key string, into *[]string) func(json.RawMessage) error {
	return func(raw json.RawMessage) error {
		var items []map[string]any
		if err := json.Unmarshal(raw, &items); err != nil {
			return err
		}
		for _, it := range items {
			if s, ok := it[key].(string); ok {
				*into = append(*into, s)
			}
		}
		return nil
	}
}

// collectR2 — the R2 list nests under {buckets: [...]}, unlike the rest.
func collectR2(into *[]string) func(json.RawMessage) error {
	return func(raw json.RawMessage) error {
		var wrap struct {
			Buckets []struct {
				Name string `json:"name"`
			} `json:"buckets"`
		}
		if err := json.Unmarshal(raw, &wrap); err != nil {
			return err
		}
		for _, b := range wrap.Buckets {
			*into = append(*into, b.Name)
		}
		return nil
	}
}

func collectDNS(into *[]DNSRecord) func(json.RawMessage) error {
	return func(raw json.RawMessage) error {
		return json.Unmarshal(raw, into)
	}
}
