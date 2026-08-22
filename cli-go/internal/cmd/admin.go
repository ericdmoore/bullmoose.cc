package cmd

// `bullmoose admin` — the operator plane against the provision worker
// (Authorization: Bearer ADMIN_TOKEN). A port of packages/cli/src/admin.ts.
//
// The safety shape, kept exactly:
//
//	IRREVERSIBLE verbs (tenant/domain/account delete, agent unbind) demand
//	--yes; --dry-run is EXEMPT, because a preview that itself demands the
//	confirmation flag is a preview nobody uses. The reversible verbs — the
//	kill switch above all — deliberately need nothing: making disable harder
//	to pull than it has to be defeats the point of having one.
//
//	The BYOK key is NEVER a flag: --key-env names a variable,
//	$BULLMOOSE_PROVIDER_KEY is the fallback, the hidden prompt is the floor.
//	A key in argv is in shell history, in `ps`, and in whatever CI log echoed
//	the invocation — for a credential the platform is built so nothing can
//	read back, which would make disclosure permanent AND unverifiable.
//
//	`admin password` derives the login key CLIENT-side (authkey, PBKDF2), so
//	the server and the wire only ever see the derived key.
//
//	`admin token create` prints the secret ALONE on stdout, chrome on stderr,
//	so `T=$(bullmoose admin token create …)` is the whole capture.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/authkey"
	bmio "github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/scopes"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/store"
)

// irreversible is admin.ts:86 — the verbs that demand --yes.
var irreversible = map[string]bool{
	"tenant delete":  true,
	"domain delete":  true,
	"account delete": true,
	"agent unbind":   true,
}

type adminDeps struct {
	promptSecret func(msg string) (string, error)
}

func runAdmin(s *bmio.Streams, argv []string) int {
	return runAdminWith(s, argv, adminDeps{})
}

func runAdminWith(s *bmio.Streams, argv []string, deps adminDeps) int {
	a := parse(argv)
	noun, verb, arg := a.at(1), a.at(2), a.at(3)

	db, err := store.Open(store.DBPath(a.DB))
	if err != nil {
		return die(s, err)
	}
	defer db.Close()

	if noun == "init" {
		adminURL, token := a.URL, a.Token
		if isFileURL(adminURL) {
			boot, err := loadBootstrap(adminURL)
			if err != nil {
				return die(s, err)
			}
			adminURL = firstNonEmpty(boot.URL, boot.Base)
			if !a.HasToken {
				token = boot.Token
			}
		}
		if adminURL == "" || token == "" {
			s.Note("usage: bullmoose admin init --url <provision-url> --token <admin-token>")
			return 2
		}
		if err := store.SetConfig(db, "adminUrl", adminURL); err != nil {
			return die(s, err)
		}
		if err := store.SetConfig(db, "adminToken", token); err != nil {
			return die(s, err)
		}
		if a.JSON {
			return emitOr(s, s.EmitJSON(map[string]string{"adminUrl": adminURL}))
		}
		s.Out("admin configured: " + adminURL)
		return 0
	}

	adminURL := store.GetConfig(db, "adminUrl")
	adminToken := store.GetConfig(db, "adminToken")
	if adminURL == "" || adminToken == "" {
		s.Note("usage: admin not configured — run: bullmoose admin init --url <provision-url> --token <admin-token>")
		return 2
	}
	api := adminAPI{base: adminURL, token: adminToken}
	ctx := context.Background()
	command := strings.TrimSpace(noun + " " + verb)

	// The confirmation gate, before ANY request.
	if irreversible[command] && !a.Yes && !a.DryRun {
		s.Note("usage: bullmoose admin " + command + " cannot be undone — re-run with --yes\n" +
			"       (or --dry-run to see what it would do first)")
		return 2
	}

	usageErr := func(text string) int {
		s.Note("usage: " + text)
		return 2
	}
	preview := func(what string) bool {
		if !a.DryRun {
			return false
		}
		s.Note("dry run: would " + what + "; nothing was written")
		if a.JSON {
			_ = s.EmitJSON(map[string]any{"dryRun": true})
		}
		return true
	}

	switch command {
	case "tenant create":
		if arg == "" {
			return usageErr("bullmoose admin tenant create <tenantId> --name <name>")
		}
		name := a.Name
		if name == "" {
			name = arg
		}
		res, err := api.call(ctx, "POST", "/tenants", map[string]any{"tenantId": arg, "name": name})
		if err != nil {
			return die(s, err)
		}
		return adminReport(s, a, res, "tenant "+arg+" created")

	case "tenant list":
		return adminCollection(s, a, api, ctx, "/tenants", "tenants", "id", func(rows []map[string]any) {
			for _, t := range rows {
				s.Out(fmt.Sprintf("%v  %v  %v", t["id"], t["status"], t["name"]))
			}
			if len(rows) == 0 {
				s.Note("(no tenants)")
			}
		})

	case "tenant rename":
		if arg == "" || a.Name == "" {
			return usageErr("bullmoose admin tenant rename <tenantId> --name <new name>")
		}
		res, err := api.call(ctx, "PATCH", "/tenants/"+url.PathEscape(arg), map[string]any{"name": a.Name})
		if err != nil {
			return die(s, err)
		}
		return adminReport(s, a, res, `tenant `+arg+` renamed to "`+a.Name+`"`)

	case "tenant delete":
		if arg == "" {
			return usageErr("bullmoose admin tenant delete <tenantId> --yes")
		}
		if preview("delete tenant " + arg) {
			return 0
		}
		res, err := api.call(ctx, "DELETE", "/tenants/"+url.PathEscape(arg), nil)
		if err != nil {
			return die(s, err)
		}
		return adminReport(s, a, res, "tenant "+arg+" deleted")

	case "domain add":
		if arg == "" || a.Tenant == "" {
			return usageErr("bullmoose admin domain add <domain> --tenant <tenantId>")
		}
		res, err := api.call(ctx, "POST", "/domains", map[string]any{"tenantId": a.Tenant, "domain": arg})
		if err != nil {
			return die(s, err)
		}
		if a.JSON {
			return emitOr(s, s.EmitJSON(json.RawMessage(res)))
		}
		var d struct {
			OK    bool        `json:"ok"`
			Steps []adminStep `json:"steps"`
		}
		_ = json.Unmarshal(res, &d)
		printSteps(s, d.Steps)
		if d.OK {
			s.Note(arg + " wired — poll: admin domain status " + arg)
		} else {
			s.Note("some steps failed — re-run after fixing")
		}
		return 0

	case "domain status":
		if arg == "" {
			return usageErr("bullmoose admin domain status <domain>")
		}
		res, err := api.call(ctx, "GET", "/domains/"+arg, nil)
		if err != nil {
			return die(s, err)
		}
		if a.JSON {
			return emitOr(s, s.EmitJSON(json.RawMessage(res)))
		}
		var d map[string]any
		_ = json.Unmarshal(res, &d)
		s.Out(fmt.Sprintf("%s: %v (sending verified: %v, dkim: %v)", arg, d["status"], d["verifiedForSending"], d["dkimStatus"]))
		return 0

	case "domain list":
		return adminCollection(s, a, api, ctx, "/domains", "domains", "domain", func(rows []map[string]any) {
			for _, d := range rows {
				s.Out(fmt.Sprintf("%v  %v  tenant=%v", d["domain"], d["status"], d["tenant_id"]))
			}
			if len(rows) == 0 {
				s.Note("(no domains)")
			}
		})

	case "domain suspend", "domain resume":
		status := "active"
		if verb == "suspend" {
			status = "suspended"
		}
		if arg == "" {
			return usageErr("bullmoose admin domain " + verb + " <domain>")
		}
		if preview("set " + arg + " to " + status) {
			return 0
		}
		res, err := api.call(ctx, "PATCH", "/domains/"+url.PathEscape(arg), map[string]any{"status": status})
		if err != nil {
			return die(s, err)
		}
		if a.JSON {
			return emitOr(s, s.EmitJSON(json.RawMessage(res)))
		}
		var d struct {
			Steps []adminStep `json:"steps"`
		}
		_ = json.Unmarshal(res, &d)
		printSteps(s, d.Steps)
		if status == "suspended" {
			s.Note(arg + " suspended — mail to it now bounces 550 5.1.1; undo with: admin domain resume " + arg)
		} else {
			s.Note(arg + " active again")
		}
		return 0

	case "domain delete":
		if arg == "" {
			return usageErr("bullmoose admin domain delete <domain> --yes")
		}
		if preview("delete domain " + arg) {
			return 0
		}
		res, err := api.call(ctx, "DELETE", "/domains/"+url.PathEscape(arg), nil)
		if err != nil {
			return die(s, err)
		}
		if a.JSON {
			return emitOr(s, s.EmitJSON(json.RawMessage(res)))
		}
		var d struct {
			OK    bool        `json:"ok"`
			Steps []adminStep `json:"steps"`
		}
		_ = json.Unmarshal(res, &d)
		printSteps(s, d.Steps)
		if d.OK {
			s.Note(arg + " deleted")
		} else {
			s.Note(arg + " deleted from bullmoose, but some external teardown failed — see the ✗ steps above")
		}
		return 0

	case "account create":
		localpart, domain, okAt := strings.Cut(arg, "@")
		if arg == "" || !okAt || localpart == "" || domain == "" || a.Tenant == "" {
			return usageErr("bullmoose admin account create <local@domain> --tenant <tenantId> [--name <display>]")
		}
		display := a.Name
		if display == "" {
			display = localpart
		}
		body := map[string]any{"tenantId": a.Tenant, "domain": domain, "localpart": localpart, "displayName": display}
		if a.Principal != "" {
			body["principalEmail"] = a.Principal
		}
		res, err := api.call(ctx, "POST", "/accounts", body)
		if err != nil {
			return die(s, err)
		}
		if a.JSON {
			return emitOr(s, s.EmitJSON(json.RawMessage(res)))
		}
		var acc struct {
			AccountID string `json:"accountId"`
			Address   string `json:"address"`
			Created   bool   `json:"created"`
		}
		_ = json.Unmarshal(res, &acc)
		// Idempotent since common/024 — printing "created" unconditionally told
		// an operator a second account had been built.
		if acc.Created {
			s.Out("account " + acc.AccountID + " created for " + acc.Address)
		} else {
			s.Out("account " + acc.AccountID + " already exists for " + acc.Address + " — nothing was created")
		}
		return 0

	case "account list":
		params := url.Values{}
		if a.Tenant != "" {
			params.Set("tenant", a.Tenant)
		}
		if a.IncludeDeleted {
			params.Set("includeDeleted", "1")
		}
		qs := ""
		if len(params) > 0 {
			qs = "?" + params.Encode()
		}
		return adminCollection(s, a, api, ctx, "/accounts"+qs, "accounts", "id", func(rows []map[string]any) {
			for _, acc := range rows {
				tomb := ""
				if ts, ok := acc["deleted_at"].(float64); ok && ts > 0 {
					tomb = "  DELETED " + time.UnixMilli(int64(ts)).UTC().Format("2006-01-02")
				}
				addr := acc["addresses"]
				if addr == nil {
					addr = "(no identity)"
				}
				s.Out(fmt.Sprintf("%v  %v  %q  shard=%v%s", acc["id"], addr, acc["display_name"], acc["shard"], tomb))
			}
			if len(rows) == 0 {
				s.Note("(no accounts)")
			}
		})

	case "account rename":
		if arg == "" || a.Name == "" {
			return usageErr("bullmoose admin account rename <accountId> --name <display>")
		}
		res, err := api.call(ctx, "PATCH", "/accounts/"+url.PathEscape(arg), map[string]any{"displayName": a.Name})
		if err != nil {
			return die(s, err)
		}
		return adminReport(s, a, res, `account `+arg+` renamed to "`+a.Name+`"`)

	case "account delete":
		if arg == "" {
			return usageErr("bullmoose admin account delete <accountId> --yes")
		}
		if preview("delete account " + arg) {
			return 0
		}
		res, err := api.call(ctx, "DELETE", "/accounts/"+url.PathEscape(arg), nil)
		if err != nil {
			return die(s, err)
		}
		if a.JSON {
			return emitOr(s, s.EmitJSON(json.RawMessage(res)))
		}
		var d struct {
			Deleted   bool        `json:"deleted"`
			Addresses []string    `json:"addresses"`
			Steps     []adminStep `json:"steps"`
			Retained  []string    `json:"retained"`
			Note      string      `json:"note"`
		}
		_ = json.Unmarshal(res, &d)
		if !d.Deleted {
			if d.Note != "" {
				s.Note(d.Note)
			} else {
				s.Note(arg + " was already deleted")
			}
			return 0
		}
		printSteps(s, d.Steps)
		addrs := strings.Join(d.Addresses, ", ")
		if addrs == "" {
			addrs = "no addresses"
		}
		s.Out("account " + arg + " deleted (" + addrs + ")")
		// What a delete does NOT do is the part an operator has to know.
		for _, line := range d.Retained {
			s.Note("  retained: " + line)
		}
		if d.Note != "" {
			s.Note(d.Note)
		}
		return 0

	case "extractor on":
		if arg == "" {
			return usageErr("bullmoose admin extractor on <account-email> [--provider <host>] [--model <slug>]\n" +
				"                       [--budget <micro-USD>] [--explore <host>/<model>]…")
		}
		type candidate struct {
			Provider string `json:"provider"`
			Model    string `json:"model"`
		}
		var arms []candidate
		for _, raw := range a.Explore {
			host, model, okSlash := strings.Cut(raw, "/")
			if !okSlash || host == "" || model == "" {
				return usageErr("--explore takes <host>/<model>. Got: " + raw)
			}
			arms = append(arms, candidate{Provider: host, Model: model})
		}
		what := "provision the extractor on " + arg
		if len(arms) > 0 {
			what += fmt.Sprintf(" with %d explore arm(s)", len(arms))
		}
		if preview(what) {
			return 0
		}
		body := map[string]any{"email": arg}
		if a.Provider != "" {
			body["provider"] = a.Provider
		}
		if a.Model != "" {
			body["model"] = a.Model
		}
		if a.Budget != "" {
			micros, err := strconv.Atoi(strings.TrimSpace(a.Budget))
			if err != nil || micros < 0 {
				return usageErr("--budget takes micro-USD as a whole number. Got: " + a.Budget)
			}
			body["budgetMicros"] = micros
		}
		if len(arms) > 0 {
			body["exploreModels"] = arms
		}
		res, err := api.call(ctx, "POST", "/extractor", body)
		if err != nil {
			return die(s, err)
		}
		if a.JSON {
			return emitOr(s, s.EmitJSON(json.RawMessage(res)))
		}
		var ex struct {
			Created   bool   `json:"created"`
			BindingID string `json:"bindingId"`
			Model     string `json:"model"`
		}
		_ = json.Unmarshal(res, &ex)
		word := "extractor re-provisioned (model swapped in place)"
		if ex.Created {
			word = "extractor provisioned"
		}
		s.Out(word + " on " + arg + " — binding " + ex.BindingID + ", model " + ex.Model)
		if a.Budget == "" {
			s.Note("  budget: the route's $2.00/month default (--budget to change; 0 refuses every paid claim)")
		} else {
			s.Note("  budget: " + a.Budget + " µUSD/month")
		}
		s.Note("  it reads mail delivered from now on — the history floor is the binding's birth")
		return 0

	case "byok seal":
		if arg == "" {
			return usageErr("bullmoose admin byok seal <account-email> [--provider openrouter] [--allow <origin>]\n" +
				"                       [--name <binding>] [--expires <days>] [--key-env <VAR>]\n" +
				"       the key comes from --key-env, $BULLMOOSE_PROVIDER_KEY or a hidden prompt — never argv")
		}
		key := ""
		if a.KeyEnv != "" {
			key = os.Getenv(a.KeyEnv)
			if key == "" {
				s.Note("$" + a.KeyEnv + " is empty — --key-env names a variable, not a key")
				return 2
			}
		}
		if key == "" {
			key = os.Getenv("BULLMOOSE_PROVIDER_KEY")
		}
		if key == "" {
			promptFn := deps.promptSecret
			if promptFn == nil {
				promptFn = promptHidden
			}
			v, err := promptFn("provider key for " + arg + " (not echoed): ")
			if err != nil {
				return die(s, err)
			}
			key = v
		}
		if key == "" {
			s.Note("no key given")
			return 2
		}
		// Validated rather than coerced — a silently-never-expiring grant is
		// the opposite of what was asked.
		if a.Expires != "" && !regexp.MustCompile(`^\d+$`).MatchString(strings.TrimSpace(a.Expires)) {
			return usageErr(`--expires takes a whole number of days. Got: "` + a.Expires + `"`)
		}
		body := map[string]any{"email": arg, "key": key}
		if a.Provider != "" {
			body["provider"] = a.Provider
		}
		if a.Allow != "" {
			body["allow"] = a.Allow
		}
		if a.Name != "" {
			body["bindingName"] = a.Name
		}
		if a.Expires != "" {
			n, _ := strconv.Atoi(strings.TrimSpace(a.Expires))
			body["expiresDays"] = n
		}
		res, err := api.call(ctx, "POST", "/provider-keys", body)
		if err != nil {
			return die(s, err)
		}
		if a.JSON {
			return emitOr(s, s.EmitJSON(json.RawMessage(res)))
		}
		var sealed struct {
			Rotated  bool   `json:"rotated"`
			CredRef  string `json:"credRef"`
			Provider string `json:"provider"`
			Allow    string `json:"allow"`
			Bindings []struct {
				ID   string `json:"id"`
				Name string `json:"name"`
			} `json:"bindings"`
			Note string `json:"note"`
		}
		_ = json.Unmarshal(res, &sealed)
		word := "sealed"
		if sealed.Rotated {
			word = "rotated"
		}
		s.Out(word + " the " + sealed.Provider + " key for " + arg + ` as "` + sealed.CredRef + `" — spendable only at ` + sealed.Allow)
		for _, b := range sealed.Bindings {
			s.Out("  attached to " + b.Name + " (" + b.ID + ")")
		}
		// The empty case looks like success and is not.
		if sealed.Note != "" {
			s.Note("  " + sealed.Note)
		}
		return 0

	case "agent bind":
		if arg == "" || a.Name == "" {
			return usageErr("bullmoose admin agent bind <account-email> --name <binding> [--sla <seconds>]\n" +
				"                       [--allow a@b,c@d] [--reply-mode send|draft] [--config file.json]")
		}
		config := map[string]any{}
		if a.Config != "" {
			raw, err := os.ReadFile(a.Config)
			if err != nil {
				return die(s, &bmio.CliError{Msg: nodeFsMessage(err, a.Config), Code: bmio.ExitFail})
			}
			if err := json.Unmarshal(raw, &config); err != nil {
				return die(s, err)
			}
		}
		if a.Allow != "" {
			var senders []string
			for _, v := range strings.Split(a.Allow, ",") {
				senders = append(senders, strings.TrimSpace(v))
			}
			config["allowedSenders"] = senders
		}
		if a.ReplyMode != "" {
			if a.ReplyMode != "send" && a.ReplyMode != "draft" {
				return usageErr("--reply-mode must be send or draft")
			}
			config["replyMode"] = a.ReplyMode
		}
		body := map[string]any{"email": arg, "name": a.Name}
		if a.SLA != "" {
			n, err := strconv.Atoi(a.SLA)
			if err != nil {
				return usageErr("--sla takes seconds as a whole number. Got: " + a.SLA)
			}
			body["slaSeconds"] = n
		}
		if len(config) > 0 {
			body["config"] = config
		}
		res, err := api.call(ctx, "POST", "/agent-bindings", body)
		if err != nil {
			return die(s, err)
		}
		if a.JSON {
			return emitOr(s, s.EmitJSON(json.RawMessage(res)))
		}
		var bound struct {
			BindingID string `json:"bindingId"`
			Watchdog  bool   `json:"watchdog"`
		}
		_ = json.Unmarshal(res, &bound)
		line := "binding " + bound.BindingID + " (" + a.Name + ") on " + arg
		if bound.Watchdog {
			line += " + watchdog responder"
		}
		s.Out(line)
		return 0

	case "agent list":
		qs := ""
		if arg != "" {
			qs = "?email=" + url.QueryEscape(arg)
		}
		return adminCollection(s, a, api, ctx, "/agent-bindings"+qs, "bindings", "id", func(rows []map[string]any) {
			for _, b := range rows {
				sla := "-"
				if v, ok := b["sla_seconds"].(float64); ok {
					sla = strconv.Itoa(int(v))
				}
				state := "disabled"
				if on, ok := b["enabled"].(float64); ok && on != 0 {
					state = "enabled"
				} else if on, ok := b["enabled"].(bool); ok && on {
					state = "enabled"
				}
				s.Out(fmt.Sprintf("%v  %v  trigger=%v  sla=%s  %s", b["id"], b["name"], b["trigger_on"], sla, state))
			}
			if len(rows) == 0 {
				s.Note("(no bindings)")
			}
		})

	case "agent disable", "agent enable":
		enable := verb == "enable"
		if arg == "" {
			return usageErr("bullmoose admin agent " + verb + " <binding-id> [--account <account-email>]\n" +
				"                       (binding ids come from: bullmoose admin agent list)")
		}
		if preview(verb + " agent binding " + arg) {
			return 0
		}
		qs := ""
		if a.Account != "" {
			qs = "?email=" + url.QueryEscape(a.Account)
		}
		res, err := api.call(ctx, "POST", "/agent-bindings/"+url.PathEscape(arg)+"/"+verb+qs, nil)
		if err != nil {
			return die(s, err)
		}
		if a.JSON {
			return emitOr(s, s.EmitJSON(json.RawMessage(res)))
		}
		var sw struct {
			Name      string `json:"name"`
			AccountID string `json:"accountId"`
			Note      string `json:"note"`
		}
		_ = json.Unmarshal(res, &sw)
		state := "DISABLED"
		if enable {
			state = "ENABLED"
		}
		s.Out("binding " + arg + " (" + sw.Name + ") on " + sw.AccountID + " is now " + state)
		// Queued work is held, never cancelled — the count keeps that visible.
		s.Note(sw.Note)
		if !enable {
			s.Note("re-enable with: bullmoose admin agent enable " + arg)
		}
		return 0

	case "agent unbind":
		if arg == "" {
			return usageErr("bullmoose admin agent unbind <binding-id> [--account <account-email>] --yes")
		}
		if preview("unbind agent binding " + arg) {
			return 0
		}
		qs := ""
		if a.Account != "" {
			qs = "?email=" + url.QueryEscape(a.Account)
		}
		res, err := api.call(ctx, "DELETE", "/agent-bindings/"+url.PathEscape(arg)+qs, nil)
		if err != nil {
			return die(s, err)
		}
		if a.JSON {
			return emitOr(s, s.EmitJSON(json.RawMessage(res)))
		}
		var un struct {
			Name  string      `json:"name"`
			Steps []adminStep `json:"steps"`
		}
		_ = json.Unmarshal(res, &un)
		printSteps(s, un.Steps)
		s.Out("binding " + arg + " (" + un.Name + ") removed")
		return 0

	case "grant create":
		target := a.at(4)
		if arg == "" || target == "" {
			return usageErr("bullmoose admin grant create <grantee-email> <target-email> [--scopes read,contacts]\n" +
				"                          [--book <addressBookId>] [--expires <days>]")
		}
		grantScopes := []string{"read"}
		if a.Scopes != "" {
			grantScopes = nil
			for _, v := range strings.Split(a.Scopes, ",") {
				grantScopes = append(grantScopes, strings.TrimSpace(v))
			}
		}
		body := map[string]any{"granteeEmail": arg, "targetEmail": target, "scopes": grantScopes}
		if a.Book != "" {
			body["collection"] = "AddressBook"
			body["collectionId"] = a.Book
		}
		if a.Expires != "" {
			n, err := strconv.Atoi(a.Expires)
			if err != nil {
				return usageErr("--expires takes a whole number of days. Got: " + a.Expires)
			}
			body["expiresDays"] = n
		}
		res, err := api.call(ctx, "POST", "/grants", body)
		if err != nil {
			return die(s, err)
		}
		if a.JSON {
			return emitOr(s, s.EmitJSON(json.RawMessage(res)))
		}
		var g struct {
			GrantID string `json:"grantId"`
		}
		_ = json.Unmarshal(res, &g)
		line := "grant " + g.GrantID + ": " + arg + " → " + target + " [" + strings.Join(grantScopes, ",") + "]"
		if a.Book != "" {
			line += " book=" + a.Book
		} else {
			line += " (whole account)"
		}
		s.Out(line)
		return 0

	case "grant list":
		qs := ""
		if arg != "" {
			qs = "?email=" + url.QueryEscape(arg)
		}
		return adminCollection(s, a, api, ctx, "/grants"+qs, "grants", "id", func(rows []map[string]any) {
			for _, g := range rows {
				var scopeList []string
				if raw, ok := g["scopes"].(string); ok {
					_ = json.Unmarshal([]byte(raw), &scopeList)
				}
				scope := "account"
				if c, ok := g["collection"].(string); ok && c != "" {
					scope = fmt.Sprintf("%s:%v", c, g["collection_id"])
				}
				exp := ""
				if ts, ok := g["expires_at"].(float64); ok && ts > 0 {
					exp = "  expires " + time.UnixMilli(int64(ts)).UTC().Format("2006-01-02")
				}
				grantee := g["grantee_email"]
				if grantee == nil {
					grantee = g["grantee_account_id"]
				}
				tgt := g["target_email"]
				if tgt == nil {
					tgt = g["target_account_id"]
				}
				s.Out(fmt.Sprintf("%v  %v → %v  [%s]  %s%s", g["id"], grantee, tgt, strings.Join(scopeList, ","), scope, exp))
			}
			if len(rows) == 0 {
				s.Note("(no grants)")
			}
		})

	case "grant revoke":
		if arg == "" {
			return usageErr("bullmoose admin grant revoke <grantId>")
		}
		if preview("revoke grant " + arg) {
			return 0
		}
		res, err := api.call(ctx, "DELETE", "/grants/"+arg, nil)
		if err != nil {
			return die(s, err)
		}
		var g struct {
			Revoked bool `json:"revoked"`
		}
		_ = json.Unmarshal(res, &g)
		if a.JSON {
			return emitOr(s, s.EmitJSON(json.RawMessage(res)))
		}
		if g.Revoked {
			s.Out("revoked " + arg)
		} else {
			s.Note(arg + " not found")
		}
		return 0

	case "token create":
		if arg == "" || a.Name == "" {
			return usageErr("bullmoose admin token create <email> --name <n> --scopes <a,b,c>")
		}
		// REQUIRED, in the OPERATOR vocabulary (the only one with `admin`) —
		// a silent ["mail"] default is worst exactly here.
		parsed, err := scopes.ParseFlag(a.scopesFlag(), scopes.Token, true)
		if err != nil {
			return usageErr(err.Error() + "\n\nusage: bullmoose admin token create <email> --name <n> --scopes <a,b,c>")
		}
		res, err := api.call(ctx, "POST", "/tokens", map[string]any{"email": arg, "name": a.Name, "scopes": parsed})
		if err != nil {
			return die(s, err)
		}
		if a.JSON {
			return emitOr(s, s.EmitJSON(json.RawMessage(res)))
		}
		var tk struct {
			Token   string `json:"token"`
			TokenID string `json:"tokenId"`
		}
		_ = json.Unmarshal(res, &tk)
		// The secret ALONE on stdout — `T=$(…)` is the whole capture.
		s.Note("minted " + tk.TokenID + " for " + arg + " [" + strings.Join(parsed, ",") + "]")
		s.Out(tk.Token)
		s.Note("shown once — deliver it to the device/agent now.")
		return 0

	case "token list":
		qs := ""
		if arg != "" {
			qs = "?email=" + url.QueryEscape(arg)
		}
		return adminCollection(s, a, api, ctx, "/tokens"+qs, "tokens", "id", func(rows []map[string]any) {
			for _, t := range rows {
				var scopeList []string
				if raw, ok := t["scopes"].(string); ok {
					_ = json.Unmarshal([]byte(raw), &scopeList)
				}
				s.Out(fmt.Sprintf("%v  %v  [%s]  %v", t["id"], t["login_email"], strings.Join(scopeList, ","), t["name"]))
			}
			if len(rows) == 0 {
				s.Note("(no tokens)")
			}
		})

	case "token revoke":
		if arg == "" {
			return usageErr("bullmoose admin token revoke <tokenId>")
		}
		if preview("revoke token " + arg) {
			return 0
		}
		res, err := api.call(ctx, "DELETE", "/tokens/"+arg, nil)
		if err != nil {
			return die(s, err)
		}
		var t struct {
			Revoked bool `json:"revoked"`
		}
		_ = json.Unmarshal(res, &t)
		if a.JSON {
			return emitOr(s, s.EmitJSON(json.RawMessage(res)))
		}
		if t.Revoked {
			s.Out("revoked " + arg)
		} else {
			s.Note(arg + " not found")
		}
		return 0

	default:
		// `admin password <email>` — a noun with no separate verb.
		if noun == "password" {
			email := verb
			if email == "" {
				return usageErr("bullmoose admin password <email> [--password <pw>]")
			}
			password := a.Password
			if password == "" {
				password = os.Getenv("BULLMOOSE_PASSWORD")
			}
			if password == "" {
				promptFn := deps.promptSecret
				if promptFn == nil {
					promptFn = promptHidden
				}
				v, err := promptFn("new password for " + email + ": ")
				if err != nil {
					return die(s, err)
				}
				password = v
			}
			// Client-side stretching: the server and the wire only ever see the
			// derived key.
			loginKey, err := authkey.DeriveLoginKey(email, password)
			if err != nil {
				return die(s, err)
			}
			res, err := api.call(ctx, "POST", "/principals/password", map[string]any{"email": email, "loginKey": loginKey})
			if err != nil {
				return die(s, err)
			}
			return adminReport(s, a, res, "password set for "+email)
		}
		cmdWords := strings.TrimSpace(noun + " " + verb)
		if cmdWords == "" {
			cmdWords = "(none)"
		}
		return usageErr("unknown admin command: " + cmdWords + "\n" +
			"implemented: tenant create|list|rename|delete | domain add|status|list|suspend|resume|delete | " +
			"account create|list|rename|delete | extractor on | byok seal | " +
			"agent bind|list|enable|disable|unbind | grant create|list|revoke | " +
			"token create|list|revoke | password | init")
	}
}

type adminStep struct {
	Step   string `json:"step"`
	OK     bool   `json:"ok"`
	Detail string `json:"detail"`
}

func printSteps(s *bmio.Streams, steps []adminStep) {
	for _, st := range steps {
		mark := "✗"
		if st.OK {
			mark = "✓"
		}
		line := "  " + mark + " " + st.Step
		if st.Detail != "" {
			line += " — " + st.Detail
		}
		s.Out(line)
	}
}

type adminAPI struct {
	base  string
	token string
}

func (v adminAPI) call(ctx context.Context, method, path string, body any) (json.RawMessage, error) {
	var reader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = strings.NewReader(string(b))
	}
	req, err := http.NewRequestWithContext(ctx, method, v.base+path, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+v.token)
	req.Header.Set("content-type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, &bmio.CliError{Msg: "admin API " + method + " " + path + " failed: " + err.Error(), Code: bmio.ExitFail}
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, &bmio.ServerError{
			Msg:        fmt.Sprintf("admin API %s %s → HTTP %d: %s", method, path, res.StatusCode, string(raw)),
			HTTPStatus: res.StatusCode,
		}
	}
	return raw, nil
}

// adminReport: raw JSON under --json, the human line otherwise.
func adminReport(s *bmio.Streams, a args, res json.RawMessage, line string) int {
	if a.JSON {
		return emitOr(s, s.EmitJSON(json.RawMessage(res)))
	}
	s.Out(line)
	return 0
}

// adminCollection: --ids emits the key column, --json emits NDJSON, otherwise
// the human renderer runs.
func adminCollection(s *bmio.Streams, a args, api adminAPI, ctx context.Context,
	path, field, idKey string, human func([]map[string]any)) int {
	res, err := api.call(ctx, "GET", path, nil)
	if err != nil {
		return die(s, err)
	}
	var outer map[string][]map[string]any
	if err := json.Unmarshal(res, &outer); err != nil {
		return die(s, err)
	}
	rows := outer[field]
	if a.IDs {
		ids := make([]string, 0, len(rows))
		for _, r := range rows {
			ids = append(ids, fmt.Sprintf("%v", r[idKey]))
		}
		s.EmitIDs(ids)
		return 0
	}
	if a.JSON {
		out := make([]any, 0, len(rows))
		for _, r := range rows {
			out = append(out, r)
		}
		return emitOr(s, s.EmitNDJSON(out))
	}
	human(rows)
	return 0
}
