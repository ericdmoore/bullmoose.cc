package cmd

// `bullmoose vacation` — the RFC 8621 §8 vacation responder. One singleton
// object; three verbs (status, on, off); the same MailUsing set the TypeScript
// sends for it.
//
// `--until` is parsed here, client-side, so a garbage date is a usage error
// costing zero requests — the TypeScript passed `new Date(opts.until)` through,
// and an unparseable date became "Invalid Date".toISOString(), a RangeError
// mid-flight. Refusals-before-requests is the rule; this makes one more
// refusal reachable.

import (
	"context"
	"encoding/json"
	"time"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/account"
	bmio "github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/jmap"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/store"
)

func runVacation(s *bmio.Streams, argv []string) int {
	a := parse(argv)
	verb := a.at(1)
	if verb == "" {
		verb = "status"
	}
	if verb != "status" && verb != "on" && verb != "off" {
		s.Note("usage: bullmoose vacation on|off|status [--subject s] [--body text] [--until date]")
		return 2
	}

	// Parse --until BEFORE any request.
	var until string
	if a.Until != "" {
		t, err := parseUntil(a.Until)
		if err != nil {
			s.Note("--until: " + err.Error())
			return 2
		}
		until = t.UTC().Format(time.RFC3339)
	}

	db, err := store.Open(store.DBPath(a.DB))
	if err != nil {
		return die(s, err)
	}
	defer db.Close()
	settings, err := store.RequireSettings(db)
	if err != nil {
		return die(s, err)
	}
	acc, err := resolveAccount(settings, a.Account)
	if err != nil {
		return die(s, err)
	}
	client := jmap.NewSessionClient(settings.Base, settings.Token)
	ctx := context.Background()

	if verb == "status" {
		raw, err := client.One(ctx, "VacationResponse/get",
			map[string]any{"accountId": acc.AccountID}, jmap.MailUsing)
		if err != nil {
			return die(s, err)
		}
		var res struct {
			List []map[string]any `json:"list"`
		}
		if err := json.Unmarshal(raw, &res); err != nil {
			return die(s, err)
		}
		v := map[string]any{}
		if len(res.List) > 0 {
			v = res.List[0]
		}
		if a.JSON {
			row := map[string]any{"account": accountLabelOf(acc)}
			for k, val := range v {
				row[k] = val
			}
			if err := s.EmitJSON(row); err != nil {
				return die(s, err)
			}
			return 0
		}
		state := "off"
		if on, _ := v["isEnabled"].(bool); on {
			state = "ON"
		}
		line := accountLabelOf(acc) + ": " + state
		if subj, _ := v["subject"].(string); subj != "" {
			line += "  subject: " + subj
		}
		if to, _ := v["toDate"].(string); to != "" {
			line += "  until: " + to
		}
		s.Out(line)
		return 0
	}

	patch := map[string]any{"isEnabled": verb == "on"}
	if a.Subject != "" {
		patch["subject"] = a.Subject
	}
	if a.HasBody && a.Body != "" {
		patch["textBody"] = a.Body
	}
	if until != "" {
		patch["toDate"] = until
	}

	if a.DryRun {
		s.Note("dry run: would set vacation " + upper(verb) + " for " + accountLabelOf(acc))
		if a.JSON {
			row := map[string]any{"dryRun": true, "account": accountLabelOf(acc)}
			for k, val := range patch {
				row[k] = val
			}
			if err := s.EmitJSON(row); err != nil {
				return die(s, err)
			}
		}
		return 0
	}

	args := map[string]any{
		"accountId": acc.AccountID,
		"update":    map[string]any{"singleton": patch},
	}
	if a.HasIfState {
		args["ifInState"] = a.IfState
	}
	raw, err := client.One(ctx, "VacationResponse/set", args, jmap.MailUsing)
	if err != nil {
		return die(s, err)
	}
	if a.JSON {
		var res struct {
			NewState *string `json:"newState"`
		}
		_ = json.Unmarshal(raw, &res)
		row := map[string]any{"account": accountLabelOf(acc), "state": res.NewState}
		for k, val := range patch {
			row[k] = val
		}
		if err := s.EmitJSON(row); err != nil {
			return die(s, err)
		}
		return 0
	}
	word := "off"
	if verb == "on" {
		word = "ON"
	}
	s.Out("vacation " + word + " for " + accountLabelOf(acc))
	return 0
}

// parseUntil accepts a date or a full timestamp — the shapes people actually
// type — and nothing else.
func parseUntil(v string) (time.Time, error) {
	for _, layout := range []string{time.RFC3339, "2006-01-02"} {
		if t, err := time.Parse(layout, v); err == nil {
			return t, nil
		}
	}
	return time.Time{}, bmio.Usage("not a date: " + v + " (use YYYY-MM-DD or RFC 3339)")
}

func upper(v string) string {
	if v == "on" {
		return "ON"
	}
	return "OFF"
}

// accountLabelOf is db.ts:260 — address, else name, else the id's tail.
func accountLabelOf(a account.Account) string {
	if a.Address != "" {
		return a.Address
	}
	if a.Name != "" {
		return a.Name
	}
	id := a.AccountID
	if len(id) > 8 {
		id = id[len(id)-8:]
	}
	return id
}
