package cmd

// `bullmoose agent enable|disable|budget --set|model --set|backfill` — s43
// step 3, the dossier's write half. Two planes, two temperaments:
//
//	KILL SWITCH  `AgentBinding/set` on the session — the ONE mutation a
//	             session token can make (s26 T2 / #198). Refusals are printed
//	             as the server wrote them: "insufficient scope", "not your
//	             account" and "state moved under this call" each say something
//	             different, and re-wording any into a guess is how a CLI
//	             teaches the wrong mental model.
//
//	RE-PROVISION `POST /extractor` on the operator plane — the SANCTIONED
//	             model/budget write, which REWRITES the whole config from its
//	             arguments. Two consequences this module refuses to let a
//	             caller walk into blind:
//
//	             1. every field not re-sent is LOST, so budget --set and
//	                model --set are read-modify-writes: menu, arms, rate,
//	                maxTokens and budget are read back and re-sent unchanged;
//	             2. it RE-ENABLES a disabled binding, so a re-provision of a
//	                disabled binding is refused (exit 5) unless --yes says the
//	                re-enable is intended. The kill switch outranks a knob.
//
//	BACKFILL     `POST /agent-bindings/{id}/backfill`. --since is REQUIRED:
//	             the route assumes 90 days when nobody names a window, and
//	             how far into an archive an agent reads is not a default this
//	             CLI will pick for you. A 409 is not flattened: a window
//	             behind the floor is an APPROVAL question (--request-floor
//	             mints the tier-1 proposal and queues NO work), a disabled
//	             binding is the kill switch doing its job — the server's
//	             sentence carries both, verbatim.
//
// Under --json a refusal is a RECORD (the doors block rides it), so a script
// gets the same answer the text gives — and every refusal above costs zero
// writes, stated in its own sentence ("Nothing was written." / "Nothing was
// queued.").

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	bmio "github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/jmap"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/jsobj"
)

// operatorCall is the dossier module's operator-plane caller: unlike
// adminAPI.call it hands back status AND parsed body on non-2xx, because the
// write verbs read refusals structurally (a 409's requestedStartMs decides
// whether a --request-floor hint rides the message). Transport failure is the
// only error.
func operatorCall(ctx context.Context, api *adminAPI, method, path string, body any) (int, *jsobj.Object, error) {
	var reader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return 0, nil, err
		}
		reader = strings.NewReader(string(b))
	}
	req, err := http.NewRequestWithContext(ctx, method, api.base+path, reader)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Authorization", "Bearer "+api.token)
	req.Header.Set("content-type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	parsed, perr := jsobj.Parse(raw)
	if perr != nil {
		// Not JSON — the raw body is the best we have, as `{error: text}`.
		parsed = jsobj.New()
		parsed.SetRaw("error", json.RawMessage(strconv.Quote(strings.TrimSpace(string(raw)))))
	}
	return res.StatusCode, parsed, nil
}

// errorOf renders the operator plane's own sentence: `body.error` when it is
// a string, the whole body otherwise.
func errorOf(body *jsobj.Object) string {
	if e, ok := body.Str("error"); ok {
		return e
	}
	rendered, err := json.Marshal(body)
	if err != nil {
		return "(unrenderable body)"
	}
	return string(rendered)
}

// refuseWith is Node's refuse(): under --json the refusal is a RECORD plus
// the message as chrome; otherwise the one exit path.
func refuseWith(s *bmio.Streams, a agentArgs, message string, code bmio.ExitCode, record map[string]any) int {
	if !a.JSON {
		return die(s, &bmio.CliError{Msg: message, Code: code})
	}
	s.Note(message)
	if err := s.EmitJSON(record); err != nil {
		return die(s, err)
	}
	return int(code)
}

// ── enable / disable ────────────────────────────────────────────────────────

func runAgentKill(s *bmio.Streams, a agentArgs, enable bool) int {
	verb := "disable"
	if enable {
		verb = "enable"
	}
	ctx := context.Background()
	conn, code, ok := openDossier(ctx, s, a)
	if !ok {
		return code
	}
	defer func() { _ = conn.db.Close() }()
	b := conn.binding

	if a.DryRun {
		state := "disabled"
		if b.Enabled {
			state = "enabled"
		}
		s.Note("dry run: would " + verb + " " + b.Name + " (" + b.BindingID + "); it is currently " +
			state + ". Nothing was written.")
		if a.JSON {
			return emitOr(s, s.EmitJSON(map[string]any{"dryRun": true, "bindingId": b.BindingID, "enabled": enable}))
		}
		return 0
	}

	client := jmap.NewSessionClient(conn.settings.Base, conn.settings.Token)
	raw, err := client.One(ctx, "AgentBinding/set", map[string]any{
		"accountId": conn.doc.AccountID,
		"update":    map[string]any{b.BindingID: map[string]any{"enabled": enable}},
	}, jmap.MailUsing)
	if err != nil {
		return die(s, err)
	}
	var res struct {
		Updated map[string]struct {
			Enabled *bool `json:"enabled"`
		} `json:"updated"`
		NotUpdated map[string]setErr `json:"notUpdated"`
	}
	if err := json.Unmarshal(raw, &res); err != nil {
		return die(s, err)
	}
	upd, updated := res.Updated[b.BindingID]
	if !updated {
		return die(s, failSetErrorOf(verb+" "+b.Name, res.NotUpdated[b.BindingID]))
	}

	if a.JSON {
		now := enable
		if upd.Enabled != nil {
			now = *upd.Enabled
		}
		return emitOr(s, s.EmitJSON(map[string]any{
			"accountId":  conn.doc.AccountID,
			"bindingId":  b.BindingID,
			"name":       b.Name,
			"enabled":    now,
			"wasEnabled": b.Enabled,
		}))
	}
	state := "DISABLED"
	if enable {
		state = "ENABLED"
	}
	s.Out(b.Name + " (" + b.BindingID + ") is now " + state)
	switch {
	case b.Enabled == enable:
		s.Note("(already in that state — nothing was written and no audit row was added)")
	case !enable:
		s.Note("queued invocations are HELD, not cancelled — they resume on enable")
	}
	return 0
}

// ── the shared re-provision (budget --set + model --set) ────────────────────

type extractorCandidate struct {
	Provider string `json:"provider"`
	Model    string `json:"model"`
}

// extractorBody is POST /extractor's request — field order is Node's.
type extractorBody struct {
	Email         string               `json:"email"`
	Provider      string               `json:"provider"`
	Model         string               `json:"model"`
	BudgetMicros  int64                `json:"budgetMicros"`
	ExploreModels []extractorCandidate `json:"exploreModels,omitempty"`
	ExploreRate   *float64             `json:"exploreRate,omitempty"`
	MaxTokens     *float64             `json:"maxTokens,omitempty"`
}

type reprovisionPatch struct {
	budgetMicros *int64
	primary      *extractorCandidate
	arms         []extractorCandidate
	hasArms      bool
}

func runAgentBudgetSet(s *bmio.Streams, a agentArgs) int {
	micros, err := parseMicros(a.Set, "--set")
	if err != nil {
		return die(s, err)
	}
	return reprovision(s, a, reprovisionPatch{budgetMicros: &micros}, func(conn *dossierConn, body extractorBody, res *jsobj.Object) int {
		if a.JSON {
			record := map[string]any{
				"bindingId":    conn.binding.BindingID,
				"name":         conn.binding.Name,
				"budgetMicros": micros,
				"via":          "POST /extractor (re-provision-in-place)",
			}
			mergeObj(record, res)
			return emitOr(s, s.EmitJSON(record))
		}
		s.Out("budget for " + conn.binding.Name + " set to " + usd(&micros) + "/month")
		return 0
	})
}

func runAgentModelSet(s *bmio.Streams, a agentArgs) int {
	patch := reprovisionPatch{}
	if a.HasSet {
		primary, err := parseCandidate(a.Set, "--set")
		if err != nil {
			return die(s, err)
		}
		patch.primary = &primary
	}
	if len(a.Explore) > 0 {
		patch.hasArms = true
		for _, raw := range a.Explore {
			arm, err := parseCandidate(raw, "--explore")
			if err != nil {
				return die(s, err)
			}
			patch.arms = append(patch.arms, arm)
		}
	}
	return reprovision(s, a, patch, func(conn *dossierConn, body extractorBody, res *jsobj.Object) int {
		if a.JSON {
			explore := make([]string, len(body.ExploreModels))
			for i, m := range body.ExploreModels {
				explore[i] = m.Provider + "/" + m.Model
			}
			record := map[string]any{
				"bindingId":     conn.binding.BindingID,
				"name":          conn.binding.Name,
				"model":         body.Provider + "/" + body.Model,
				"exploreModels": explore,
			}
			mergeObj(record, res)
			return emitOr(s, s.EmitJSON(record))
		}
		s.Out("model for " + conn.binding.Name + ": " + body.Provider + "/" + body.Model)
		for _, m := range body.ExploreModels {
			s.Out("  explore → " + m.Provider + "/" + m.Model)
		}
		return 0
	})
}

func mergeObj(record map[string]any, res *jsobj.Object) {
	for _, k := range res.Keys() {
		if _, taken := record[k]; !taken {
			raw, _ := res.Raw(k)
			record[k] = raw
		}
	}
}

func reprovision(s *bmio.Streams, a agentArgs, patch reprovisionPatch,
	report func(*dossierConn, extractorBody, *jsobj.Object) int) int {
	ctx := context.Background()
	conn, code, ok := openDossier(ctx, s, a)
	if !ok {
		return code
	}
	defer func() { _ = conn.db.Close() }()
	b := conn.binding
	doorName := "model"
	if patch.budgetMicros != nil {
		doorName = "budget"
	}
	door := doorsFor(b, conn.admin != nil)[doorName]

	if door.Unavailable != "" {
		return refuseWith(s, a, door.Unavailable, bmio.ExitUsage,
			map[string]any{"bindingId": b.BindingID, "name": b.Name, "written": false, "door": door})
	}
	if conn.admin == nil {
		return refuseWith(s, a,
			door.Door+" is operator-plane (ADMIN_TOKEN) and this CLI holds no provision credential. "+
				"What would work: bullmoose admin init --url <provision-url> --token <admin-token>, then re-run. "+
				"Nothing was written.",
			bmio.ExitAuth,
			map[string]any{"bindingId": b.BindingID, "name": b.Name, "written": false, "door": door})
	}
	address := conn.acc.Address
	if address == "" {
		return die(s, &bmio.CliError{
			Msg: "POST /extractor addresses an account by EMAIL and this login stored none for " +
				conn.acc.AccountID + " (re-run `bullmoose login` to refresh it). Nothing was written.",
			Code: bmio.ExitFail,
		})
	}

	// The kill switch outranks a tuning knob: POST /extractor sets enabled=1,
	// so re-provisioning a DISABLED binding would quietly un-pull the switch
	// somebody deliberately pulled.
	if !b.Enabled && !a.Yes {
		return refuseWith(s, a,
			b.Name+" is DISABLED, and the only budget/model door ("+door.Door+") re-enables a binding as a "+
				"side effect of writing its config. Re-run with --yes to accept the re-enable, or leave it off and "+
				"nothing changes. Nothing was written.",
			bmio.ExitConflict,
			map[string]any{"bindingId": b.BindingID, "name": b.Name, "written": false, "enabled": false, "door": door})
	}

	row, err := operatorBindingRow(ctx, conn.admin, address, b)
	if err != nil {
		return die(s, err)
	}
	config, _ := jsobj.Parse([]byte(row.ConfigJSON))
	if config == nil {
		config = jsobj.New()
	}

	// The read-modify-write: everything the caller did not name is read back
	// and re-sent unchanged, so a budget change cannot silently reset the
	// menu (or vice versa).
	aliases := config.Obj("modelAliases")
	aliasName, _ := config.Str("defaultModel")
	if aliasName == "" && aliases != nil && len(aliases.Keys()) > 0 {
		aliasName = aliases.Keys()[0]
	}
	var current []extractorCandidate
	if aliases != nil && aliasName != "" {
		for _, rawC := range aliases.Arr(aliasName) {
			var c extractorCandidate
			if json.Unmarshal(rawC, &c) == nil && c.Provider != "" && c.Model != "" {
				current = append(current, c)
			}
		}
	}

	primary := patch.primary
	if primary == nil && len(current) > 0 {
		primary = &current[0]
	}
	if primary == nil {
		return die(s, &bmio.CliError{
			Msg: b.Name + " has no primary model candidate to preserve, and a re-provision that names none takes the " +
				"server's paid default — a spend decision this command will not make for you. Name it: " +
				"bullmoose agent model " + b.Name + " --set <host>/<model>. Nothing was written.",
			Code: bmio.ExitUsage,
		})
	}
	budgetMicros := patch.budgetMicros
	if budgetMicros == nil {
		if budgets := config.Obj("budgets"); budgets != nil {
			if v, ok := budgets.Num("spendPerMonth"); ok {
				if raw, has := budgets.Raw("spendPerMonth"); has && string(raw) != "null" {
					m := int64(v)
					budgetMicros = &m
				}
			}
		}
	}
	if budgetMicros == nil {
		return die(s, &bmio.CliError{
			Msg: b.Name + " has no monthly budget to preserve, and a re-provision that names none takes the server's " +
				"$2.00 default — a spend decision this command will not make for you. Set it first: " +
				"bullmoose agent budget " + b.Name + " --set <µUSD>. Nothing was written.",
			Code: bmio.ExitUsage,
		})
	}
	arms := patch.arms
	if !patch.hasArms && len(current) > 1 {
		arms = current[1:]
	}

	body := extractorBody{
		Email:        address,
		Provider:     primary.Provider,
		Model:        primary.Model,
		BudgetMicros: *budgetMicros,
	}
	if len(arms) > 0 {
		body.ExploreModels = arms
		if frontier := config.Obj("frontier"); frontier != nil {
			if raw, has := frontier.Raw("exploreRate"); has && string(raw) != "null" {
				if v, ok := frontier.Num("exploreRate"); ok {
					body.ExploreRate = &v
				}
			}
		}
	}
	if raw, has := config.Raw("maxTokens"); has && string(raw) != "null" {
		if v, ok := config.Num("maxTokens"); ok {
			body.MaxTokens = &v
		}
	}

	if a.DryRun {
		s.Note("dry run: would POST " + conn.admin.base + "/extractor; nothing was written")
		if a.JSON {
			return emitOr(s, s.EmitJSON(map[string]any{
				"dryRun": true, "bindingId": b.BindingID, "request": body, "door": door}))
		}
		rendered, err := json.Marshal(body)
		if err != nil {
			return die(s, err)
		}
		s.Out(string(rendered))
		return 0
	}

	status, res, err := operatorCall(ctx, conn.admin, http.MethodPost, "/extractor", body)
	if err != nil {
		return die(s, err)
	}
	if status != http.StatusOK {
		// The provision worker's sentence, verbatim — it names the account,
		// the binding and the reason far better than a status code does.
		return die(s, &bmio.ServerError{
			Msg:        fmt.Sprintf("POST %s/extractor → HTTP %d: %s", conn.admin.base, status, errorOf(res)),
			HTTPStatus: status,
		})
	}
	code = report(conn, body, res)
	if !a.JSON {
		s.Note("via " + conn.admin.base + "/extractor — the sanctioned re-provision-in-place path")
		if !b.Enabled {
			s.Note(b.Name + " was disabled and is now ENABLED again (the door's side effect)")
		}
	}
	return code
}

// ── argument parsers (pure, unit-tested directly) ───────────────────────────

// parseCandidate splits `host/model` at the FIRST slash, so
// `openrouter/minimax/minimax-m3` keeps its vendor-qualified id.
func parseCandidate(raw, flag string) (extractorCandidate, error) {
	at := strings.Index(raw, "/")
	c := extractorCandidate{}
	if at >= 0 {
		c.Provider = strings.TrimSpace(raw[:at])
		c.Model = strings.TrimSpace(raw[at+1:])
	}
	if c.Provider == "" || c.Model == "" {
		return c, &bmio.CliError{
			Msg: flag + " takes <host>/<model> — the same string the dossier prints, e.g. " +
				"openrouter/minimax/minimax-m3 (host is the first segment; the rest is the model id). Got: \"" + raw + "\"",
			Code: bmio.ExitUsage,
		}
	}
	return c, nil
}

// parseMicros: µUSD, strictly. Dollars are a display format; the wire is
// micro-USD, and guessing which one "2" meant would be a two-orders-of-
// magnitude spend bug.
func parseMicros(raw, flag string) (int64, error) {
	trimmed := strings.TrimSpace(raw)
	if !regexp.MustCompile(`^\d+$`).MatchString(trimmed) {
		return 0, &bmio.CliError{
			Msg:  flag + " takes micro-USD as a whole number (2000000 = $2.00). Got: \"" + raw + "\"",
			Code: bmio.ExitUsage,
		}
	}
	n, err := strconv.ParseInt(trimmed, 10, 64)
	if err != nil {
		return 0, &bmio.CliError{Msg: flag + " out of range: " + raw, Code: bmio.ExitUsage}
	}
	return n, nil
}

const dayMs = 86_400_000

// parseSince: `YYYY-MM-DD`, any ISO datetime, or `<n>d`. There is
// deliberately NO default: the backfill route happily assumes 90 days when
// the caller names none, and a CLI that silently inherits that has chosen how
// far into someone's archive an agent reads.
func parseSince(raw string, nowMs int64) (startMs int64, sinceDays float64, err error) {
	trimmed := strings.TrimSpace(raw)
	bad := &bmio.CliError{
		Msg:  "--since takes YYYY-MM-DD, an ISO datetime, or <n>d (e.g. 30d). Got: \"" + raw + "\"",
		Code: bmio.ExitUsage,
	}
	if m := regexp.MustCompile(`^(\d+)d$`).FindStringSubmatch(trimmed); m != nil {
		n, perr := strconv.ParseInt(m[1], 10, 64)
		if perr != nil {
			return 0, 0, bad
		}
		startMs = nowMs - n*dayMs
	} else {
		layout := trimmed
		if regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`).MatchString(trimmed) {
			layout = trimmed + "T00:00:00Z"
		}
		t, perr := time.Parse(time.RFC3339, layout)
		if perr != nil {
			return 0, 0, bad
		}
		startMs = t.UnixMilli()
	}
	if startMs >= nowMs {
		return 0, 0, &bmio.CliError{
			Msg:  "--since " + raw + " is not in the past — a backfill window bounds history",
			Code: bmio.ExitUsage,
		}
	}
	return startMs, float64(nowMs-startMs) / dayMs, nil
}

// ── backfill ────────────────────────────────────────────────────────────────

func runAgentBackfill(s *bmio.Streams, a agentArgs, nowMs func() int64) int {
	ctx := context.Background()
	if a.Since == "" {
		s.Note("usage: bullmoose agent backfill <binding> --since <YYYY-MM-DD|ISO|Nd> [--budget <µUSD>] [--request-floor]\n" +
			"--since is required: the route defaults to 90 days when nobody names a window, and how far into an " +
			"archive an agent reads is not a default this CLI will pick for you.")
		return 2
	}
	conn, code, ok := openDossier(ctx, s, a)
	if !ok {
		return code
	}
	defer func() { _ = conn.db.Close() }()
	b := conn.binding

	startMs, sinceDays, err := parseSince(a.Since, nowMs())
	if err != nil {
		return die(s, err)
	}
	var budgetMicros *int64
	if a.Budget != "" {
		m, err := parseMicros(a.Budget, "--budget")
		if err != nil {
			return die(s, err)
		}
		budgetMicros = &m
	}
	door := doorsFor(b, conn.admin != nil)["backfill"]
	if conn.admin == nil {
		return refuseWith(s, a,
			door.Door+" is operator-plane (ADMIN_TOKEN) and this CLI holds no provision credential. "+
				"What would work: bullmoose admin init --url <provision-url> --token <admin-token>, then re-run. "+
				"Nothing was queued.",
			bmio.ExitAuth,
			map[string]any{"bindingId": b.BindingID, "name": b.Name, "minted": 0, "queued": false, "door": door})
	}

	// The floor-request is the APPROVAL, not a louder backfill: it mints a
	// tier-1 proposal and queues no work at all. Opt-in only — a command that
	// escalated to it on its own would be asking for archive access nobody
	// typed.
	if a.RequestFloor {
		if a.DryRun {
			s.Note("dry run: would ask to move " + b.Name + "'s history floor back to " +
				time.UnixMilli(startMs).UTC().Format(time.RFC3339))
			if a.JSON {
				return emitOr(s, s.EmitJSON(map[string]any{"dryRun": true, "bindingId": b.BindingID, "toEpochMs": startMs}))
			}
			return 0
		}
		status, res, err := operatorCall(ctx, conn.admin, http.MethodPost,
			"/agent-bindings/"+url.PathEscape(b.BindingID)+"/floor-request", map[string]any{"toEpochMs": startMs})
		if err != nil {
			return die(s, err)
		}
		if status != http.StatusOK {
			code := bmio.ExitFail
			if status == 409 {
				code = bmio.ExitConflict
			} else if status == 400 {
				code = bmio.ExitUsage
			}
			return die(s, &bmio.CliError{
				Msg: fmt.Sprintf("POST %s/agent-bindings/%s/floor-request → HTTP %d: %s",
					conn.admin.base, b.BindingID, status, errorOf(res)),
				Code: code,
			})
		}
		if a.JSON {
			record := map[string]any{"bindingId": b.BindingID, "name": b.Name, "backfilled": false}
			mergeObj(record, res)
			return emitOr(s, s.EmitJSON(record))
		}
		disposition := "pending a human"
		if raw, has := res.Raw("minted"); has && string(raw) == "false" {
			disposition = "already pending"
		}
		s.Out("floor-request " + res.JSString("proposalId") + " — " + disposition)
		s.Note("no backfill ran: this is the approval. Decide it in approvals, then re-run the backfill.")
		return 0
	}

	if a.DryRun {
		budgetPart := ""
		if budgetMicros != nil {
			budgetPart = fmt.Sprintf(", budgetMicros: %d", *budgetMicros)
		}
		s.Note(fmt.Sprintf("dry run: would POST %s/agent-bindings/%s/backfill {sinceDays: %.3f%s}; nothing was queued",
			conn.admin.base, b.BindingID, sinceDays, budgetPart))
		if a.JSON {
			var bm any
			if budgetMicros != nil {
				bm = *budgetMicros
			}
			return emitOr(s, s.EmitJSON(map[string]any{
				"dryRun": true, "bindingId": b.BindingID, "sinceDays": sinceDays, "budgetMicros": bm}))
		}
		return 0
	}

	if budgetMicros == nil {
		s.Note("no --budget: minted rows carry no envelope, so paid claims draw on the binding's MONTHLY budget " +
			"(a free @local claimant still eats them at $0)")
	}
	reqBody := map[string]any{"sinceDays": sinceDays}
	if budgetMicros != nil {
		reqBody["budgetMicros"] = *budgetMicros
	}
	status, res, err := operatorCall(ctx, conn.admin, http.MethodPost,
		"/agent-bindings/"+url.PathEscape(b.BindingID)+"/backfill", reqBody)
	if err != nil {
		return die(s, err)
	}

	if status == http.StatusConflict {
		// The two 409s that matter read differently and must not be
		// flattened: a window behind the floor is an APPROVAL question, a
		// disabled binding is the kill switch doing its job. The server's
		// sentence carries both.
		message := "refused"
		if e, ok := res.Str("error"); ok {
			message = e
		}
		askable := false
		if raw, has := res.Raw("requestedStartMs"); has && string(raw) != "null" && len(raw) > 0 && raw[0] != '"' {
			askable = true
		}
		full := message + "\n\nNothing was queued."
		if askable {
			full += "\nTo ask for the floor move: bullmoose agent backfill " + b.Name + " --since " + a.Since + " --request-floor"
		}
		record := map[string]any{"bindingId": b.BindingID, "name": b.Name, "minted": 0, "queued": false}
		mergeObj(record, res)
		return refuseWith(s, a, full, bmio.ExitConflict, record)
	}
	if status != http.StatusOK {
		return die(s, &bmio.ServerError{
			Msg: fmt.Sprintf("POST %s/agent-bindings/%s/backfill → HTTP %d: %s",
				conn.admin.base, b.BindingID, status, errorOf(res)),
			HTTPStatus: status,
		})
	}

	if a.JSON {
		record := map[string]any{
			"bindingId": b.BindingID,
			"name":      b.Name,
			"since":     time.UnixMilli(startMs).UTC().Format(time.RFC3339),
		}
		mergeObj(record, res)
		return emitOr(s, s.EmitJSON(record))
	}
	s.Out(fmt.Sprintf("backfill %s: minted %s invocation(s), skipped %s already covered",
		b.Name, res.JSStringOr("minted", "0"), res.JSStringOr("skipped", "0")))
	fieldLine(s, "window", msStamp(res, "windowStartMs")+" → "+msStamp(res, "windowEndMs")+" UTC")
	clamped := ""
	if raw, has := res.Raw("floorClamped"); has && string(raw) == "true" {
		clamped = " — window CLAMPED to it"
	}
	fieldLine(s, "floor", msStamp(res, "floorMs")+" ("+res.JSStringOr("floorSource", "null")+")"+clamped)
	envelope := "none (draws on the monthly budget)"
	if budgetMicros != nil {
		envelope = usd(budgetMicros)
	}
	fieldLine(s, "envelope", envelope)
	if raw, has := res.Raw("capped"); has && string(raw) == "true" {
		s.Note("the mint cap was reached — the window's far edge was NOT reached; re-run to walk further back")
	}
	s.Note(res.JSStringOr("note", ""))
	return 0
}

// msStamp renders a millisecond field of an operator answer as a UTC minute
// stamp, "—" when absent or unparseable.
func msStamp(o *jsobj.Object, key string) string {
	if raw, has := o.Raw(key); !has || string(raw) == "null" {
		_ = raw
		return "—"
	}
	if v, ok := o.Num(key); ok {
		ms := int64(v)
		return stamp(&ms)
	}
	return "—"
}
