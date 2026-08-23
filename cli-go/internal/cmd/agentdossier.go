package cmd

// `bullmoose agent show|budget|model` (reads) — s43 step 2, the dossier's read
// half. Step 3 adds the writes (enable/disable, budget/model --set, backfill);
// until the registry flip those verbs stay with Node at runtime either way.
//
// The discriminator the plan fixes: these are verbs on ONE named binding — the
// dossier — never a config file and never a global preference. Eric: "the CLI
// is the claimant" — the terminal that runs `agent serve` must be able to read
// the agent it is running.
//
// ── The planes, and what a READ must never do ───────────────────────────────
//
//	READ   `GET {base}/console/agents/{accountId}` — the console projection, on
//	       the login's own mail token (`read` scope, owner-only, refused to
//	       agent-marked tokens). Every read verb here is that one document,
//	       sliced. The refusal body is surfaced VERBATIM: the console answers a
//	       scope failure, an agent token and a non-owned account with three
//	       different sentences, and re-wording any of them into "forbidden"
//	       throws away the only part a human needs.
//
//	FLOOR  The history floor is NOT on the projection, so `show` reads it from
//	       the operator plane (adminUrl/adminToken, as `admin init` stored
//	       them) when that is configured — and a read-only enrichment must
//	       NEVER fail the read it decorates: an unreachable operator plane
//	       becomes a note, not an exit.
//
//	DOORS  A door the configured credentials cannot open is REPORTED, with the
//	       exact call that would work — never attempted-and-swallowed. `--json`
//	       carries the same answer as a `doors` block so a script can decide
//	       before it tries. `POST /extractor` provisions the binding literally
//	       named "extractor" and nothing else, so any other binding's budget
//	       and menu have NO door, and the block says so in those words.
//
// Money honesty, twice: µUSD render keeps SIX places sub-cent (a 2100µ
// invocation is $0.002100; $0.00 is the failure), and a NULL cost renders
// "not recorded" — null is undetermined, never a flattering zero. "No cap
// configured" and "zero remaining" must never render the same.

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/account"
	bmio "github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/jsobj"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/store"
)

// ── the wire shapes we consume ──────────────────────────────────────────────
//
// Typed where the logic reads a field; RAW where the payload is re-emitted
// (menu entries, invocations) so a field this CLI predates survives to the
// consumer — the same rule `agent invocations --json` follows.

type dossierBindingConfig struct {
	Pipeline          *string         `json:"pipeline"`
	ReplyMode         *string         `json:"replyMode"`
	HasPersona        *bool           `json:"hasPersona"`
	SenderAllowlist   json.RawMessage `json:"senderAllowlist"`
	ConfigUnparseable bool            `json:"configUnparseable"`
}

type dossierEconomics struct {
	BudgetMicros *int64            `json:"budgetMicros"`
	DefaultModel *string           `json:"defaultModel"`
	ModelMenu    []json.RawMessage `json:"modelMenu"`
	ExploreRate  *float64          `json:"exploreRate"`
}

type dossierBinding struct {
	BindingID string               `json:"bindingId"`
	Name      string               `json:"name"`
	TriggerOn string               `json:"triggerOn"`
	SLASecs   *float64             `json:"slaSeconds"`
	Enabled   bool                 `json:"enabled"`
	Config    dossierBindingConfig `json:"config"`
	Economics dossierEconomics     `json:"economics"`
}

type dossierLedger struct {
	BindingID          string `json:"bindingId"`
	Pending            int64  `json:"pending"`
	Running            int64  `json:"running"`
	Done               int64  `json:"done"`
	Failed             int64  `json:"failed"`
	OldestPendingAt    *int64 `json:"oldestPendingAt"`
	MonthSpendMicros   int64  `json:"monthSpendMicros"`
	MonthOverageMicros int64  `json:"monthOverageMicros"`
}

type dossierDoc struct {
	AccountID        string            `json:"accountId"`
	Principal        string            `json:"principal"`
	Bindings         []dossierBinding  `json:"bindings"`
	Invocations      []json.RawMessage `json:"invocations"`
	Ledgers          []dossierLedger   `json:"ledgers"`
	LedgerMonthStart int64             `json:"ledgerMonthStart"`
}

// ── reads: one document, sliced ─────────────────────────────────────────────

// dossierHref is the console dossier's URL — also the `_self` every `--json`
// payload carries.
func dossierHref(base, accountID string) string {
	return strings.TrimRight(base, "/") + "/console/agents/" + url.PathEscape(accountID)
}

func fetchDossier(ctx context.Context, base, token, accountID string) (*dossierDoc, error) {
	href := dossierHref(base, accountID)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, href, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusOK {
		// The server's own sentence, verbatim — three refusals, three
		// different sentences, and the sentence is the useful part.
		detail := strings.TrimSpace(string(raw))
		var parsed struct {
			Error *string `json:"error"`
		}
		if json.Unmarshal(raw, &parsed) == nil && parsed.Error != nil {
			detail = *parsed.Error
		}
		return nil, &bmio.ServerError{
			Msg:        fmt.Sprintf("GET /console/agents/%s → HTTP %d: %s", accountID, res.StatusCode, detail),
			HTTPStatus: res.StatusCode,
		}
	}
	var d dossierDoc
	if err := json.Unmarshal(raw, &d); err != nil {
		return nil, err
	}
	return &d, nil
}

// findBinding resolves `<binding>` — id first, then exact name, then
// case-insensitive name, ON ONE ACCOUNT (cli/009: this verb acts on one agent,
// so it never fans out). Two bindings sharing a name is refused rather than
// picked from: silently choosing by enumeration order is the cli/009 bug in a
// different noun.
func findBinding(d *dossierDoc, selector string) (*dossierBinding, error) {
	for i := range d.Bindings {
		if d.Bindings[i].BindingID == selector {
			return &d.Bindings[i], nil
		}
	}
	var matches []*dossierBinding
	for i := range d.Bindings {
		if d.Bindings[i].Name == selector {
			matches = append(matches, &d.Bindings[i])
		}
	}
	if len(matches) == 0 {
		for i := range d.Bindings {
			if strings.EqualFold(d.Bindings[i].Name, selector) {
				matches = append(matches, &d.Bindings[i])
			}
		}
	}
	if len(matches) > 1 {
		lines := make([]string, len(matches))
		for i, b := range matches {
			lines[i] = "  " + b.BindingID + "  " + b.Name
		}
		return nil, &bmio.CliError{
			Msg:  fmt.Sprintf("%q matches %d bindings on %s; name one by id:\n%s", selector, len(matches), d.AccountID, strings.Join(lines, "\n")),
			Code: bmio.ExitUsage,
		}
	}
	if len(matches) == 0 {
		carries := "(none)"
		if len(d.Bindings) > 0 {
			names := make([]string, len(d.Bindings))
			for i, b := range d.Bindings {
				names[i] = b.Name + " (" + b.BindingID + ")"
			}
			carries = strings.Join(names, ", ")
		}
		return nil, &bmio.CliError{
			Msg: fmt.Sprintf("no binding %q on %s. This account carries: %s\nAnother account's agent needs --account <selector>.",
				selector, d.AccountID, carries),
			Code: bmio.ExitNotFound,
		}
	}
	return matches[0], nil
}

// ledgerFor: absent means all-zero, NOT unknown — the projection omits a
// binding that has never been invoked.
func ledgerFor(d *dossierDoc, bindingID string) dossierLedger {
	for _, l := range d.Ledgers {
		if l.BindingID == bindingID {
			return l
		}
	}
	return dossierLedger{BindingID: bindingID}
}

// budgetViewT is the budget envelope, in the SAME arithmetic the claim gate
// enforces: completed spend this cycle, plus approved overage headroom,
// against the cap. RemainingMicros is null when no cap is configured —
// "unbounded" and "zero left" must never render the same.
type budgetViewT struct {
	Currency        string `json:"currency"`
	CapMicros       *int64 `json:"capMicros"`
	SpentMicros     int64  `json:"spentMicros"`
	OverageMicros   int64  `json:"overageMicros"`
	RemainingMicros *int64 `json:"remainingMicros"`
	MonthStartMs    int64  `json:"monthStartMs"`
}

func budgetViewOf(b *dossierBinding, l dossierLedger, monthStartMs int64) budgetViewT {
	v := budgetViewT{
		Currency:      "USD",
		CapMicros:     b.Economics.BudgetMicros,
		SpentMicros:   l.MonthSpendMicros,
		OverageMicros: l.MonthOverageMicros,
		MonthStartMs:  monthStartMs,
	}
	if b.Economics.BudgetMicros != nil {
		r := *b.Economics.BudgetMicros + l.MonthOverageMicros - l.MonthSpendMicros
		v.RemainingMicros = &r
	}
	return v
}

// effectiveFloor mirrors provision's effectiveHistoryFloor (s26 T3), kept in
// sync by intent: an APPROVED widening (historyFloor) wins over the binding's
// birth (createdAt); neither means UNKNOWN, and unknown is not "unbounded".
func effectiveFloor(config map[string]any) (floorMs *int64, source string) {
	if f, ok := config["historyFloor"].(float64); ok {
		ms := int64(f)
		return &ms, "historyFloor"
	}
	if f, ok := config["createdAt"].(float64); ok {
		ms := int64(f)
		return &ms, "createdAt"
	}
	return nil, ""
}

// ── the doors table: what this credential can actually open ─────────────────

type dossierDoor struct {
	// Door is the exact call behind the verb.
	Door  string `json:"door"`
	Plane string `json:"plane"`
	// Requires is what the door itself gates on, in the server's vocabulary.
	Requires string `json:"requires"`
	// Configured: whether the CLI HOLDS a credential for that plane — a
	// statement about configuration, not a prediction of the server's answer.
	Configured bool `json:"configured"`
	// Unavailable is present when this verb cannot reach this binding at all.
	Unavailable string `json:"unavailable,omitempty"`
}

// reprovisionBinding: POST /extractor provisions the binding literally named
// "extractor"; it is the only config-write door that exists.
const reprovisionBinding = "extractor"

func noConfigDoor(bindingName string) string {
	return fmt.Sprintf("no door writes config for binding %q: AgentBinding/set v1 writes only `enabled`, "+
		"PATCH /agent-bindings refuses config_json by design, and POST /extractor provisions the %q binding only",
		bindingName, reprovisionBinding)
}

func doorsFor(b *dossierBinding, adminConfigured bool) map[string]dossierDoor {
	configDoor := dossierDoor{
		Door:       "POST {adminUrl}/extractor (re-provision-in-place)",
		Plane:      "operator",
		Requires:   "ADMIN_TOKEN",
		Configured: adminConfigured,
	}
	if b.Name != reprovisionBinding {
		configDoor.Unavailable = noConfigDoor(b.Name)
	}
	killDoor := dossierDoor{
		Door:       "AgentBinding/set { update: { <id>: { enabled } } }",
		Plane:      "session",
		Requires:   "send scope (supervisory grants and agent tokens lack it)",
		Configured: true,
	}
	return map[string]dossierDoor{
		"show": {
			Door:       "GET {base}/console/agents/{accountId}",
			Plane:      "session",
			Requires:   "read scope, account owner",
			Configured: true,
		},
		"enable":  killDoor,
		"disable": killDoor,
		"budget":  configDoor,
		"model":   configDoor,
		"backfill": {
			Door:       "POST {adminUrl}/agent-bindings/{id}/backfill",
			Plane:      "operator",
			Requires:   "ADMIN_TOKEN",
			Configured: adminConfigured,
		},
	}
}

// ── formatting ──────────────────────────────────────────────────────────────

// usd renders µUSD as dollars. Sub-cent amounts keep SIX places: a
// per-invocation cost of 2100µ is $0.002100, and rounding it to $0.00 is the
// money-honesty failure.
func usd(micros *int64) string {
	if micros == nil {
		return "—"
	}
	m := *micros
	places := 2
	if m != 0 && m < 10_000 && m > -10_000 {
		places = 6
	}
	return "$" + strconv.FormatFloat(float64(m)/1_000_000, 'f', places, 64)
}

func stamp(ms *int64) string {
	if ms == nil {
		return "—"
	}
	return time.UnixMilli(*ms).UTC().Format("2006-01-02 15:04")
}

func fieldLine(s *bmio.Streams, label, value string) {
	s.Out(padEnd(label, 12) + value)
}

// ── the dossier connection (shared by every read verb) ──────────────────────

type dossierConn struct {
	settings *store.Settings
	acc      account.Account
	doc      *dossierDoc
	binding  *dossierBinding
	// admin is non-nil when `admin init` stored operator credentials.
	admin *adminAPI
	db    *sql.DB
}

const dossierSynopsis = "usage: bullmoose agent show <binding> | budget <binding> [--set <µUSD>] | " +
	"model <binding> [--set <host>/<model>] [--explore <host>/<model>]… | " +
	"backfill <binding> --since <date> [--budget <µUSD>] [--request-floor] | enable|disable <binding>"

// openDossier is the shared preamble: settings → ONE account (cli/009's
// pickAccount rule) → the projection → the named binding → the operator
// credentials if any. The selector refusal costs zero requests.
func openDossier(ctx context.Context, s *bmio.Streams, a agentArgs) (*dossierConn, int, bool) {
	selector := a.at(2)
	if selector == "" {
		s.Note(dossierSynopsis)
		return nil, 2, false
	}
	db, err := store.Open(store.DBPath(a.DB))
	if err != nil {
		return nil, die(s, err), false
	}
	settings, err := store.RequireSettings(db)
	if err != nil {
		_ = db.Close()
		return nil, die(s, err), false
	}
	acc, err := resolveAccount(settings, a.Account)
	if err != nil {
		_ = db.Close()
		return nil, die(s, err), false
	}
	doc, err := fetchDossier(ctx, settings.Base, settings.Token, acc.AccountID)
	if err != nil {
		_ = db.Close()
		return nil, die(s, err), false
	}
	binding, err := findBinding(doc, selector)
	if err != nil {
		_ = db.Close()
		return nil, die(s, err), false
	}
	conn := &dossierConn{settings: settings, acc: acc, doc: doc, binding: binding, db: db}
	if u, t := store.GetConfig(db, "adminUrl"), store.GetConfig(db, "adminToken"); u != "" && t != "" {
		conn.admin = &adminAPI{base: strings.TrimRight(u, "/"), token: t}
	}
	return conn, 0, true
}

// ── agent show ──────────────────────────────────────────────────────────────

func runAgentShow(s *bmio.Streams, a agentArgs) int {
	ctx := context.Background()
	conn, code, ok := openDossier(ctx, s, a)
	if !ok {
		return code
	}
	defer func() { _ = conn.db.Close() }()
	b := conn.binding

	if a.IDs {
		s.EmitIDs([]string{b.BindingID})
		return 0
	}

	// The history floor is NOT on the console projection, so it is read from
	// the operator plane when that is configured and reported as
	// unknown-and-why when it is not. Inventing a floor from the binding's
	// first invocation would be a guess wearing a number.
	var floorMs *int64
	floorSource := ""
	floorNote := "not on the session read surface (the console projection carries no historyFloor/createdAt) — " +
		"configure the operator plane to read it: bullmoose admin init --url <provision-url> --token <admin-token>"
	address := conn.acc.Address
	if address == "" {
		address = conn.doc.Principal
	}
	if conn.admin != nil && address != "" {
		// A read-only enrichment must never fail the read it decorates.
		if config, err := operatorConfigOf(ctx, conn.admin, address, b); err != nil {
			floorNote = "operator plane unreachable: " + err.Error()
		} else {
			floorMs, floorSource = effectiveFloor(config)
			if floorMs == nil {
				floorNote = "no floor stamped (pre-s26 binding): backfill fails closed until a floor-request establishes one"
			} else {
				floorNote = "backfill may reach back to " + time.UnixMilli(*floorMs).UTC().Format(time.RFC3339) +
					" (from " + floorSource + ")"
			}
		}
	}

	view := buildShow(conn, floorMs, floorSource, floorNote, 5)
	if a.JSON {
		if err := s.EmitJSON(view); err != nil {
			return die(s, err)
		}
		return 0
	}
	renderDossierShow(s, view)
	// Backfill PROGRESS is not separable on this surface: minted rows are
	// ordinary pending invocations. Said out loud rather than implied by a
	// number that looks specific.
	s.Note("queue counts cover backfill and live delivery together — the projection does not separate them")
	return 0
}

// operatorBindingRow reads the binding's row off the operator plane — shared
// by `show`'s floor enrichment (which catches the error into a note) and the
// step-3 read-modify-writes (which surface it, hence "nothing was written").
type adminBindingRow struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	ConfigJSON string `json:"config_json"`
}

func operatorBindingRow(ctx context.Context, api *adminAPI, address string, b *dossierBinding) (adminBindingRow, error) {
	raw, err := api.call(ctx, http.MethodGet, "/agent-bindings?email="+url.QueryEscape(address), nil)
	if err != nil {
		return adminBindingRow{}, err
	}
	var res struct {
		Bindings []adminBindingRow `json:"bindings"`
	}
	if err := json.Unmarshal(raw, &res); err != nil {
		return adminBindingRow{}, err
	}
	for _, row := range res.Bindings {
		if row.ID == b.BindingID {
			return row, nil
		}
	}
	for _, row := range res.Bindings {
		if row.Name == b.Name {
			return row, nil
		}
	}
	return adminBindingRow{}, &bmio.CliError{
		Msg: fmt.Sprintf("the operator plane has no binding %s for %s — the console projection and %s disagree "+
			"about this account; nothing was written", b.BindingID, address, api.base),
		Code: bmio.ExitNotFound,
	}
}

// operatorConfigOf parses the row's config_json — the floor's only home.
func operatorConfigOf(ctx context.Context, api *adminAPI, address string, b *dossierBinding) (map[string]any, error) {
	row, err := operatorBindingRow(ctx, api, address, b)
	if err != nil {
		return nil, err
	}
	var config map[string]any
	if json.Unmarshal([]byte(row.ConfigJSON), &config) != nil || config == nil {
		config = map[string]any{}
	}
	return config, nil
}

// buildShow assembles the whole dossier as one object (§1.3: `--json` on a
// show-style command is exactly one JSON value). HAL follows the house
// convention: `_self` is the document this was read from, and `_links` are
// DERIVED FROM IDS THE PAYLOAD ALREADY CARRIES, never invented — `lifecycle`
// appears only when the operator plane is configured, because a link nobody
// can follow is worse than no link.
func buildShow(conn *dossierConn, floorMs *int64, floorSource, floorNote string, limit int) map[string]any {
	d, b := conn.doc, conn.binding
	ledger := ledgerFor(d, b.BindingID)
	self := dossierHref(conn.settings.Base, d.AccountID)

	invocations := make([]any, 0, limit)
	for _, raw := range d.Invocations {
		if len(invocations) == cap(invocations) {
			break
		}
		if o, err := jsobj.Parse(raw); err == nil && o.JSStringOr("bindingId", "") == b.BindingID {
			invocations = append(invocations, raw)
		}
	}

	links := map[string]any{
		"account": map[string]any{"href": self, "type": "AgentDossier", "id": d.AccountID},
		"agents": map[string]any{"href": strings.TrimRight(conn.settings.Base, "/") + "/console/agents",
			"type": "AgentDossier", "list": true},
	}
	var adminURL string
	if conn.admin != nil {
		adminURL = conn.admin.base
		links["lifecycle"] = map[string]any{
			"href": adminURL + "/agent-bindings/" + url.QueryEscape(b.BindingID) + "/lifecycle",
			"type": "BindingLifecycle", "id": b.BindingID,
		}
	}

	menu := make([]any, len(b.Economics.ModelMenu))
	for i, m := range b.Economics.ModelMenu {
		menu[i] = m
	}
	var senderAllowlist any
	if len(b.Config.SenderAllowlist) > 0 && string(b.Config.SenderAllowlist) != "null" {
		senderAllowlist = b.Config.SenderAllowlist
	}
	return map[string]any{
		"_self":     self,
		"accountId": d.AccountID,
		"account":   account.Label(conn.acc),
		"address":   orNull(conn.acc.Address),
		"principal": d.Principal,
		"binding": map[string]any{
			"bindingId":         b.BindingID,
			"name":              b.Name,
			"enabled":           b.Enabled,
			"triggerOn":         b.TriggerOn,
			"slaSeconds":        b.SLASecs,
			"pipeline":          b.Config.Pipeline,
			"replyMode":         b.Config.ReplyMode,
			"hasPersona":        b.Config.HasPersona,
			"senderAllowlist":   senderAllowlist,
			"configUnparseable": b.Config.ConfigUnparseable,
		},
		"models": map[string]any{
			"defaultModel": b.Economics.DefaultModel,
			"menu":         menu,
			"exploreRate":  b.Economics.ExploreRate,
		},
		"budget": budgetViewOf(b, ledger, d.LedgerMonthStart),
		"ledger": map[string]any{
			"pending":         ledger.Pending,
			"running":         ledger.Running,
			"done":            ledger.Done,
			"failed":          ledger.Failed,
			"oldestPendingAt": ledger.OldestPendingAt,
		},
		"invocations": invocations,
		"backfill": map[string]any{
			"floorMs":     floorMs,
			"floorSource": orNull(floorSource),
			"note":        floorNote,
		},
		"doors":  doorsFor(b, conn.admin != nil),
		"_links": links,
	}
}

func orNull(v string) any {
	if v == "" {
		return nil
	}
	return v
}

// menuEntryOf parses one modelMenu entry for RENDERING; emission stays raw.
func menuEntryOf(raw json.RawMessage) (alias string, candidates []string) {
	o, err := jsobj.Parse(raw)
	if err != nil {
		return "", nil
	}
	alias, _ = o.Str("alias")
	for _, c := range o.Arr("candidates") {
		var s string
		if json.Unmarshal(c, &s) == nil {
			candidates = append(candidates, s)
		}
	}
	return alias, candidates
}

func renderDossierShow(s *bmio.Streams, view map[string]any) {
	b := view["binding"].(map[string]any)
	m := view["models"].(map[string]any)
	bud := view["budget"].(budgetViewT)
	led := view["ledger"].(map[string]any)
	back := view["backfill"].(map[string]any)
	invs := view["invocations"].([]any)

	fieldLine(s, "binding", fmt.Sprintf("%s  (%s)", b["name"], b["bindingId"]))
	fieldLine(s, "account", fmt.Sprintf("%s  (%s)", view["account"], view["accountId"]))
	enabled := "yes"
	if b["enabled"] != true {
		enabled = "NO — disabled (queued work is held, not cancelled)"
	}
	fieldLine(s, "enabled", enabled)
	fieldLine(s, "pipeline", fmt.Sprintf("%s   reply mode: %s   trigger: %s",
		strOrDash(b["pipeline"]), strOrDash(b["replyMode"]), b["triggerOn"]))

	menu := m["menu"].([]any)
	defaultModel := ""
	if dm, ok := m["defaultModel"].(*string); ok && dm != nil {
		defaultModel = *dm
	}
	if len(menu) == 0 {
		fieldLine(s, "model", "— (no menu configured)")
	} else {
		for i, raw := range menu {
			alias, candidates := menuEntryOf(raw.(json.RawMessage))
			primary := "—"
			if len(candidates) > 0 {
				primary = candidates[0]
			}
			mark := " "
			if alias == defaultModel {
				mark = "*"
			}
			label := ""
			if i == 0 {
				label = "model"
			}
			fieldLine(s, label, mark+alias+": "+primary)
			for _, arm := range candidates[min(1, len(candidates)):] {
				fieldLine(s, "", "  explore → "+arm)
			}
		}
		if rate, ok := m["exploreRate"].(*float64); ok && rate != nil {
			fieldLine(s, "", "  explore rate "+strconv.FormatFloat(*rate, 'f', -1, 64))
		}
	}

	if bud.CapMicros == nil {
		spent := bud.SpentMicros
		fieldLine(s, "budget", "no monthly cap configured — spent "+usd(&spent)+" this cycle")
	} else {
		spent, over := bud.SpentMicros, bud.OverageMicros
		fieldLine(s, "budget", usd(bud.CapMicros)+"/month · spent "+usd(&spent)+" · overage "+usd(&over)+
			" · remaining "+usd(bud.RemainingMicros))
	}
	fieldLine(s, "", "cycle from "+stamp(&bud.MonthStartMs)+" UTC")

	queue := fmt.Sprintf("pending %v · running %v · done %v · failed %v",
		led["pending"], led["running"], led["done"], led["failed"])
	if oldest, ok := led["oldestPendingAt"].(*int64); ok && oldest != nil {
		queue += "   oldest pending " + stamp(oldest)
	}
	fieldLine(s, "queue", queue)

	if fm, ok := back["floorMs"].(*int64); ok && fm != nil {
		fieldLine(s, "backfill", fmt.Sprintf("floor %s (%v)", stamp(fm), back["floorSource"]))
	} else {
		fieldLine(s, "backfill", back["note"].(string))
	}

	if len(invs) == 0 {
		fieldLine(s, "recent", "(no invocations)")
		return
	}
	fieldLine(s, "recent", fmt.Sprintf("%d most recent invocation(s)", len(invs)))
	for _, raw := range invs {
		o, err := jsobj.Parse(raw.(json.RawMessage))
		if err != nil {
			continue
		}
		// Raw, not Num: jsobj.Num mirrors JS (Number(null) is 0), and a NULL
		// cost rendered as $0.00 is precisely the money-honesty failure.
		cost := "not recorded"
		if raw, ok := o.Raw("costMicros"); ok && string(raw) != "null" {
			if c, ok := o.Num("costMicros"); ok {
				ci := int64(c)
				cost = usd(&ci)
			}
		}
		var created *int64
		if c, ok := o.Num("createdAt"); ok {
			ci := int64(c)
			created = &ci
		}
		// s45 slice 3 -- the measured pair beside the receipt: which provider
		// answered, and how long the RUN took (claimed->done; created->done
		// would bill queue wait to the model). Absent halves render as an
		// em dash, never a fabricated zero.
		latency := "—"
		if cl, ok := o.Num("claimedAt"); ok {
			if dn, ok2 := o.Num("doneAt"); ok2 && dn >= cl {
				latency = fmt.Sprintf("%.1fs", (dn-cl)/1000)
			}
		}
		s.Out("  " + o.JSString("invocationId") + "  " + padEnd(o.JSString("status"), 7) + "  " +
			padStart(cost, 12) + "  " + padStart(latency, 7) + "  " +
			padEnd(o.JSStringOr("provider", "—")+"/"+o.JSStringOr("model", "—"), 36) + "  " + stamp(created))
	}
}

func strOrDash(v any) string {
	if p, ok := v.(*string); ok && p != nil {
		return *p
	}
	return "—"
}

func padStart(s string, width int) string {
	for len([]rune(s)) < width {
		s = " " + s
	}
	return s
}

// ── agent budget / agent model (read modes) ─────────────────────────────────

func runAgentBudgetRead(s *bmio.Streams, a agentArgs) int {
	ctx := context.Background()
	conn, code, ok := openDossier(ctx, s, a)
	if !ok {
		return code
	}
	defer func() { _ = conn.db.Close() }()
	b := conn.binding
	view := budgetViewOf(b, ledgerFor(conn.doc, b.BindingID), conn.doc.LedgerMonthStart)

	if a.JSON {
		return emitOr(s, s.EmitJSON(map[string]any{
			"_self":           dossierHref(conn.settings.Base, conn.doc.AccountID),
			"accountId":       conn.doc.AccountID,
			"bindingId":       b.BindingID,
			"name":            b.Name,
			"currency":        view.Currency,
			"capMicros":       view.CapMicros,
			"spentMicros":     view.SpentMicros,
			"overageMicros":   view.OverageMicros,
			"remainingMicros": view.RemainingMicros,
			"monthStartMs":    view.MonthStartMs,
			"door":            doorsFor(b, conn.admin != nil)["budget"],
		}))
	}
	fieldLine(s, "binding", fmt.Sprintf("%s  (%s)", b.Name, b.BindingID))
	if view.CapMicros == nil {
		fieldLine(s, "budget", "no monthly cap configured")
	} else {
		spent, over := view.SpentMicros, view.OverageMicros
		fieldLine(s, "budget", usd(view.CapMicros)+"/month · spent "+usd(&spent)+" · overage "+usd(&over)+
			" · remaining "+usd(view.RemainingMicros))
	}
	fieldLine(s, "", "cycle from "+stamp(&view.MonthStartMs)+" UTC")
	return 0
}

func runAgentModelRead(s *bmio.Streams, a agentArgs) int {
	ctx := context.Background()
	conn, code, ok := openDossier(ctx, s, a)
	if !ok {
		return code
	}
	defer func() { _ = conn.db.Close() }()
	b := conn.binding

	if a.JSON {
		menu := make([]any, len(b.Economics.ModelMenu))
		for i, m := range b.Economics.ModelMenu {
			menu[i] = m
		}
		return emitOr(s, s.EmitJSON(map[string]any{
			"_self":        dossierHref(conn.settings.Base, conn.doc.AccountID),
			"accountId":    conn.doc.AccountID,
			"bindingId":    b.BindingID,
			"name":         b.Name,
			"defaultModel": b.Economics.DefaultModel,
			"menu":         menu,
			"exploreRate":  b.Economics.ExploreRate,
			"door":         doorsFor(b, conn.admin != nil)["model"],
		}))
	}
	fieldLine(s, "binding", fmt.Sprintf("%s  (%s)", b.Name, b.BindingID))
	if len(b.Economics.ModelMenu) == 0 {
		fieldLine(s, "model", "— (no menu configured)")
	}
	defaultModel := ""
	if b.Economics.DefaultModel != nil {
		defaultModel = *b.Economics.DefaultModel
	}
	for _, raw := range b.Economics.ModelMenu {
		alias, candidates := menuEntryOf(raw)
		mark := " "
		if alias == defaultModel {
			mark = "*"
		}
		fieldLine(s, "menu", mark+alias)
		for i, c := range candidates {
			kind := "explore"
			if i == 0 {
				kind = "primary"
			}
			fieldLine(s, "", "  "+kind+" → "+c)
		}
	}
	if b.Economics.ExploreRate != nil {
		fieldLine(s, "", "  explore rate "+strconv.FormatFloat(*b.Economics.ExploreRate, 'f', -1, 64))
	}
	return 0
}
