package cmd

// agents budget / agents model — the two economics knobs, on the SESSION plane.
//
// Every other verb in this family drives the provision worker: the operator
// plane, ADMIN_TOKEN, re-provision-in-place. These two are different on
// purpose. AgentBinding/set learned budgetMicros, modelMenu, defaultModel and
// exploreRate on the `send` scope (services/jmap agentBinding.ts — the
// /get-name-equals-/set-name table in its header), so a PLAIN MAIL TOKEN can
// tune a binding's spend and models: no operator credential, no whole-config
// rewrite, and none of the re-provision door's hazards (it re-enables a
// disabled binding as a side effect; this patch touches exactly the named
// knob).
//
// The Node CLI documents this migration as "tracked work, not a design
// position" — and is feature-frozen ("no more node CLI work. Only adding via
// golang"), so the work lands here, born on the right plane rather than
// migrated onto it.
//
// Deliberately NOT here: `backfill`. How far into an archive an agent reads
// is operator work, not a mail-token decision.

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	bmio "github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/jmap"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/store"
)

const agentUsing = "urn:bullmoose:params:jmap:agent"

// menuEntry mirrors economics.modelMenu — alias → provider/model labels in
// fallback order, primary first. The SAME shape /set accepts, so a read can be
// edited and written back without translation.
type menuEntry struct {
	Alias      string   `json:"alias"`
	Candidates []string `json:"candidates"`
}

type sessionEconomics struct {
	BudgetMicros *int64      `json:"budgetMicros"`
	SpentMicros  *int64      `json:"spentMicros"`
	DefaultModel string      `json:"defaultModel"`
	ModelMenu    []menuEntry `json:"modelMenu"`
	ExploreRate  *float64    `json:"exploreRate"`
}

type sessionBinding struct {
	ID        string           `json:"id"`
	Name      string           `json:"name"`
	Enabled   bool             `json:"enabled"`
	Economics sessionEconomics `json:"economics"`
}

// econConn opens the session plane: the mirror's settings, ONE account. These
// verbs tune one binding on one account; "which account" is never guessed.
func econConn(a agentsArgs) (*jmap.Client, string, func(), error) {
	db, err := store.Open(store.DBPath(a.DB))
	if err != nil {
		return nil, "", nil, err
	}
	settings, err := store.RequireSettings(db)
	if err != nil {
		_ = db.Close()
		return nil, "", nil, err
	}
	client := jmap.NewClient(settings.Base, settings.Token)
	accounts, err := apAccounts(client, settings, a.Account)
	if err != nil {
		_ = db.Close()
		return nil, "", nil, err
	}
	if len(accounts) != 1 {
		_ = db.Close()
		return nil, "", nil, fmt.Errorf("budget/model tune ONE account's binding — pick it with --account (matched %d)", len(accounts))
	}
	return client, accounts[0].AccountID, func() { _ = db.Close() }, nil
}

// resolveSessionBinding finds ONE binding by name or id via AgentBinding/get.
// One round trip, and the not-found message names what WAS there.
func resolveSessionBinding(ctx context.Context, client *jmap.Client, accountID, ref string) (*sessionBinding, error) {
	raw, err := client.One(ctx, "AgentBinding/get", map[string]any{"accountId": accountID, "ids": nil}, []string{agentUsing})
	if err != nil {
		return nil, err
	}
	var res struct {
		List []sessionBinding `json:"list"`
	}
	if err := json.Unmarshal(raw, &res); err != nil {
		return nil, fmt.Errorf("AgentBinding/get: unparseable response: %w", err)
	}
	names := make([]string, 0, len(res.List))
	for i := range res.List {
		b := &res.List[i]
		if b.ID == ref || b.Name == ref {
			return b, nil
		}
		names = append(names, b.Name)
	}
	sort.Strings(names)
	return nil, fmt.Errorf("no binding %q on this account — it has: %s", ref, strings.Join(names, ", "))
}

// applySessionPatch sends ONE AgentBinding/set update. A refusal is surfaced
// in the server's own words, never re-worded into a guess.
func applySessionPatch(ctx context.Context, client *jmap.Client, accountID, id string, patch map[string]any) error {
	raw, err := client.One(ctx, "AgentBinding/set", map[string]any{
		"accountId": accountID,
		"update":    map[string]any{id: patch},
	}, []string{agentUsing})
	if err != nil {
		return err
	}
	var res struct {
		Updated    map[string]json.RawMessage `json:"updated"`
		NotUpdated map[string]struct {
			Type        string `json:"type"`
			Description string `json:"description"`
		} `json:"notUpdated"`
	}
	if err := json.Unmarshal(raw, &res); err != nil {
		return fmt.Errorf("AgentBinding/set: unparseable response: %w", err)
	}
	if refusal, ok := res.NotUpdated[id]; ok {
		if refusal.Description != "" {
			return fmt.Errorf("server refused: %s — %s", refusal.Type, refusal.Description)
		}
		return fmt.Errorf("server refused: %s", refusal.Type)
	}
	if _, ok := res.Updated[id]; !ok {
		return fmt.Errorf("AgentBinding/set answered without deciding %s — nothing was written", id)
	}
	return nil
}

func microsLabel(m *int64) string {
	if m == nil {
		return "not set"
	}
	return fmt.Sprintf("$%.2f (%dµ)", float64(*m)/1e6, *m)
}

func agBudget(s *bmio.Streams, a agentsArgs) int {
	ref := agPositional(a, 2)
	if ref == "" {
		return die(s, bmio.Usage("bullmoose agents budget <binding> [--set <µUSD>] [--account sel] [--json]"))
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	client, accountID, done, err := econConn(a)
	if err != nil {
		return die(s, err)
	}
	defer done()
	b, err := resolveSessionBinding(ctx, client, accountID, ref)
	if err != nil {
		return die(s, err)
	}

	if a.Set != "" {
		micros, perr := strconv.ParseInt(a.Set, 10, 64)
		if perr != nil || micros < 0 {
			return die(s, fmt.Errorf("--set takes µUSD as a non-negative integer (2000000 = $2.00), got %q", a.Set))
		}
		if err := applySessionPatch(ctx, client, accountID, b.ID, map[string]any{"budgetMicros": micros}); err != nil {
			return die(s, err)
		}
		b.Economics.BudgetMicros = &micros
	}

	if a.JSON {
		if err := s.EmitJSON(map[string]any{
			"_self":        "jmap:AgentBinding/get#" + b.ID,
			"id":           b.ID,
			"name":         b.Name,
			"budgetMicros": b.Economics.BudgetMicros,
			"spentMicros":  b.Economics.SpentMicros,
		}); err != nil {
			return die(s, err)
		}
		return 0
	}
	s.Out(fmt.Sprintf("%s  budget %s", b.Name, microsLabel(b.Economics.BudgetMicros)))
	if b.Economics.SpentMicros != nil {
		s.Out(fmt.Sprintf("  spent this cycle %s", microsLabel(b.Economics.SpentMicros)))
	}
	return 0
}

func agModel(s *bmio.Streams, a agentsArgs) int {
	ref := agPositional(a, 2)
	if ref == "" {
		return die(s, bmio.Usage("bullmoose agents model <binding> [--set <provider>/<model>] [--explore <p>/<m>,…] [--rate <0..1>] [--default <alias>] [--account sel] [--json]"))
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	client, accountID, done, err := econConn(a)
	if err != nil {
		return die(s, err)
	}
	defer done()
	b, err := resolveSessionBinding(ctx, client, accountID, ref)
	if err != nil {
		return die(s, err)
	}

	patch := map[string]any{}
	if a.Set != "" {
		// --set names the PRIMARY; explore arms follow in candidate order —
		// chooseArm treats position 0 as the head and 1+ as the arms.
		candidates := []string{a.Set}
		for _, arm := range strings.Split(a.Explore, ",") {
			if arm = strings.TrimSpace(arm); arm != "" {
				candidates = append(candidates, arm)
			}
		}
		alias := b.Economics.DefaultModel
		if alias == "" {
			alias = "primary"
		}
		patch["modelMenu"] = []menuEntry{{Alias: alias, Candidates: candidates}}
		patch["defaultModel"] = alias
	} else if a.Explore != "" {
		// Arms without a primary would silently drop the menu's head — refuse
		// rather than guess which model the arms are exploring AGAINST.
		return die(s, fmt.Errorf("--explore needs --set: arms are explored against a named primary"))
	}
	if a.Rate != "" {
		rate, perr := strconv.ParseFloat(a.Rate, 64)
		if perr != nil || rate < 0 || rate > 1 {
			return die(s, fmt.Errorf("--rate is a probability in [0,1]; 0 turns exploration off, got %q", a.Rate))
		}
		patch["exploreRate"] = rate
	}
	if a.Default != "" {
		patch["defaultModel"] = a.Default
	}

	if len(patch) > 0 {
		if err := applySessionPatch(ctx, client, accountID, b.ID, patch); err != nil {
			return die(s, err)
		}
		// Re-read rather than merge locally: the server normalises (and
		// carries BYOK credRefs forward invisibly), so echoing our own patch
		// would report a shape the server may not have stored.
		b, err = resolveSessionBinding(ctx, client, accountID, b.ID)
		if err != nil {
			return die(s, err)
		}
	}

	if a.JSON {
		if err := s.EmitJSON(map[string]any{
			"_self":        "jmap:AgentBinding/get#" + b.ID,
			"id":           b.ID,
			"name":         b.Name,
			"defaultModel": b.Economics.DefaultModel,
			"modelMenu":    b.Economics.ModelMenu,
			"exploreRate":  b.Economics.ExploreRate,
		}); err != nil {
			return die(s, err)
		}
		return 0
	}
	s.Out(fmt.Sprintf("%s  default %s", b.Name, orDashE(b.Economics.DefaultModel)))
	for _, e := range b.Economics.ModelMenu {
		s.Out(fmt.Sprintf("  %s: %s", e.Alias, strings.Join(e.Candidates, " -> ")))
	}
	if b.Economics.ExploreRate != nil {
		s.Out(fmt.Sprintf("  explore rate %.0f%%", *b.Economics.ExploreRate*100))
	}
	return 0
}

func orDashE(v string) string {
	if v == "" {
		return "-"
	}
	return v
}
