package cmd

// `bullmoose agent invoke|invocations|rm` — s43 step 1, the on-demand
// AgentInvocation trigger (sVOL 007). The request-response third of the
// `agent` family: `serve` runs the queue; these three drive it from outside.
//
// This runs on the account's OWN mail bearer token, NOT the operator
// ADMIN_TOKEN: creating an invocation is a per-principal action behind the
// `draft` scope, distinct from `admin agent bind|disable|unbind` (control
// plane) and from the Go-native `agents` family (configuration surface). The
// lanes are auth-model, not name.
//
// Invariants carried over exactly (s43 readme #11):
//
//   - `invoke` is routed through AgentInvocation/set CREATE, which refuses a
//     DISABLED binding server-side (the 008 kill switch) — you cannot fire an
//     agent whose off switch is pulled. Each distinct SetError type arrives
//     as its distinct exit code (forbidden 4, notFound 3, …): the refusal is
//     the server's judgement, never a generic 1.
//   - `--ids` answers from the QUERY alone — no AgentInvocation/get. An id
//     listing that fetched the objects would pay for data it throws away.
//   - `invocations --json` re-emits the SERVER's rows verbatim (NDJSON), so a
//     field this CLI predates — an alert kind, a facet — survives to the
//     consumer instead of being narrowed away by a struct.
//   - the alert marker rides the human row too (`[alert: …]`, s11 T3): a
//     past-due invocation nobody may claim is not allowed to sit silently,
//     and this listing is where a human meets it.
//
// NOTE (s43 order of work): `runAgent` is NOT in the registry yet. Until the
// flip — LAST, after serve and the dossier verbs land — every `agent`
// invocation still delegates to Node, and this code meets only its tests.

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	bmio "github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/jmap"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/jsobj"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/store"
)

// agentArgs is self-parsed (the watch/approvals convention): the grammar is
// held to delegate's front-door tables by TestSelfParsingCommandsAreCovered,
// and grows verb-family by verb-family as s43's steps land.
type agentArgs struct {
	DB      string
	Account string
	Email   string
	Note    string
	// The dossier family (s43 step 2+). HasSet distinguishes read mode from
	// `--set ""`, which must refuse as a bad value, not fall back to a read.
	Set          string
	HasSet       bool
	Explore      []string
	Since        string
	Budget       string
	RequestFloor bool
	Yes          bool
	// serve (s43 step 4+).
	Config string
	Fleet  string
	Once   bool
	JSON   bool
	IDs    bool
	DryRun bool

	Positionals []string
}

func (a agentArgs) at(i int) string {
	if i < len(a.Positionals) {
		return a.Positionals[i]
	}
	return ""
}

func parseAgent(argv []string) agentArgs {
	var a agentArgs
	endOpts := false
	for i := 0; i < len(argv); i++ {
		arg := argv[i]
		switch {
		case endOpts:
			a.Positionals = append(a.Positionals, arg)
		case arg == "--":
			endOpts = true
		case strings.HasPrefix(arg, "--"):
			name, inlineVal, inline := strings.Cut(strings.TrimPrefix(arg, "--"), "=")
			value := func() string {
				if inline {
					return inlineVal
				}
				if i+1 < len(argv) {
					i++
					return argv[i]
				}
				return ""
			}
			switch name {
			case "json":
				a.JSON = true
			case "ids":
				a.IDs = true
			case "dry-run":
				a.DryRun = true
			case "request-floor":
				a.RequestFloor = true
			case "yes":
				a.Yes = true
			case "db":
				a.DB = value()
			case "account":
				a.Account = value()
			case "email":
				a.Email = value()
			case "note":
				a.Note = value()
			case "set":
				a.Set = value()
				a.HasSet = true
			case "explore":
				a.Explore = append(a.Explore, value())
			case "since":
				a.Since = value()
			case "budget":
				a.Budget = value()
			case "config":
				a.Config = value()
			case "fleet":
				a.Fleet = value()
			case "once":
				a.Once = true
			}
		default:
			a.Positionals = append(a.Positionals, arg)
		}
	}
	return a
}

// agentUsage is main.ts's full family line — every verb, because the reader
// who typo'd one needs the map, not an echo of the typo.
const agentUsage = "usage: bullmoose agent serve --config <agent.json>|--fleet <fleet.json> [--once] | " +
	"invoke <binding> --email <id> | invocations | rm <invId> | show <binding> | " +
	"budget <binding> [--set <µUSD>] | model <binding> [--set <host>/<model>] | " +
	"backfill <binding> --since <date> | enable|disable <binding>"

func runAgent(s *bmio.Streams, argv []string) int {
	return runAgentWith(s, argv, func() int64 { return time.Now().UnixMilli() })
}

// runAgentWith carries the one effect a dossier test cannot have — the clock
// backfill's --since arithmetic reads (the login.go deps pattern).
func runAgentWith(s *bmio.Streams, argv []string, nowMs func() int64) int {
	a := parseAgent(argv)
	switch a.at(1) {
	case "invoke", "invocations", "rm":
		return runAgentInvoke(s, a)
	case "show":
		return runAgentShow(s, a)
	case "budget":
		if a.HasSet {
			return runAgentBudgetSet(s, a)
		}
		return runAgentBudgetRead(s, a)
	case "model":
		if a.HasSet || len(a.Explore) > 0 {
			return runAgentModelSet(s, a)
		}
		return runAgentModelRead(s, a)
	case "enable":
		return runAgentKill(s, a, true)
	case "disable":
		return runAgentKill(s, a, false)
	case "backfill":
		return runAgentBackfill(s, a, nowMs)
	case "serve":
		return runAgentServe(s, a)
	default:
		// serve and the dossier verbs land in s43 steps 2–6; the registry
		// flip is LAST and alone, so until every case above exists, reaching
		// here with a real verb means the flip happened early — which the
		// flip PR's own tests must make impossible.
		s.Note(agentUsage)
		return 2
	}
}

func runAgentInvoke(s *bmio.Streams, a agentArgs) int {
	verb, arg := a.at(1), a.at(2)

	// Refusals cost zero requests.
	switch verb {
	case "invoke":
		if arg == "" {
			s.Note("usage: bullmoose agent invoke <binding> --email <emailId> [--note <text>]")
			return 2
		}
		if a.Email == "" {
			s.Note("usage: agent invoke requires --email <emailId>")
			return 2
		}
	case "rm":
		if arg == "" {
			s.Note("usage: bullmoose agent rm <invId>")
			return 2
		}
	}

	// Settings and account resolve BEFORE the dry-run exit, as in Node: a
	// machine that is not logged in refuses the preview the same way it would
	// refuse the write. Still zero requests either way.
	db, err := store.Open(store.DBPath(a.DB))
	if err != nil {
		return die(s, err)
	}
	defer func() { _ = db.Close() }()
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

	switch verb {
	case "invoke":
		if a.DryRun {
			s.Note("dry run: would invoke " + arg + " on " + a.Email + "; nothing was queued")
			if a.JSON {
				if err := s.EmitJSON(map[string]any{"dryRun": true, "binding": arg, "emailId": a.Email}); err != nil {
					return die(s, err)
				}
			}
			return 0
		}
		create := map[string]any{"bindingName": arg, "emailId": a.Email}
		if a.Note != "" {
			create["note"] = a.Note
		}
		raw, err := client.One(ctx, "AgentInvocation/set", map[string]any{
			"accountId": acc.AccountID,
			"create":    map[string]any{"c": create},
		}, jmap.MailUsing)
		if err != nil {
			return die(s, err)
		}
		var res struct {
			Created    map[string]json.RawMessage `json:"created"`
			NotCreated map[string]setErr          `json:"notCreated"`
			NewState   *string                    `json:"newState"`
		}
		if err := json.Unmarshal(raw, &res); err != nil {
			return die(s, err)
		}
		created, ok := res.Created["c"]
		if !ok {
			// A disabled binding, a nonexistent binding and a bad emailId each
			// arrive here with a distinct SetError type → distinct exit code.
			return die(s, failSetErrorOf("invoke "+arg, res.NotCreated["c"]))
		}
		inv, err := jsobj.Parse(created)
		if err != nil {
			return die(s, err)
		}
		if a.JSON {
			var state any
			if res.NewState != nil {
				state = *res.NewState
			}
			if err := s.EmitJSON(map[string]any{
				"id":      inv.JSString("id"),
				"binding": arg,
				"emailId": a.Email,
				"status":  inv.JSString("status"),
				"state":   state,
			}); err != nil {
				return die(s, err)
			}
			return 0
		}
		s.Out("queued " + inv.JSString("id") + " on " + arg + " for " + a.Email +
			" (status: " + inv.JSString("status") + ")")
		s.Note("a runtime claims it over the changelog: `bullmoose agent serve`, or the cloud cron.")
		return 0

	case "invocations":
		// The filter is a POSITIONAL (main.ts: `--status` already means watch's
		// boolean; the collision is avoided by grammar, not luck). Default: pending.
		status := arg
		if status == "" {
			status = "pending"
		}
		qraw, err := client.One(ctx, "AgentInvocation/query", map[string]any{
			"accountId": acc.AccountID,
			"status":    status,
		}, jmap.MailUsing)
		if err != nil {
			return die(s, err)
		}
		var q struct {
			IDs []string `json:"ids"`
		}
		if err := json.Unmarshal(qraw, &q); err != nil {
			return die(s, err)
		}
		if a.IDs {
			// From the query alone — fetching objects to print their ids
			// would pay for data the caller asked us to omit.
			s.EmitIDs(q.IDs)
			return 0
		}
		if len(q.IDs) == 0 {
			s.Note("(no " + status + " invocations)")
			return 0
		}
		graw, err := client.One(ctx, "AgentInvocation/get", map[string]any{
			"accountId": acc.AccountID,
			"ids":       q.IDs,
		}, jmap.MailUsing)
		if err != nil {
			return die(s, err)
		}
		var g struct {
			List []json.RawMessage `json:"list"`
		}
		if err := json.Unmarshal(graw, &g); err != nil {
			return die(s, err)
		}
		if a.JSON {
			// The server's rows verbatim: fields this CLI predates survive.
			rows := make([]any, len(g.List))
			for i, r := range g.List {
				rows[i] = r
			}
			if err := s.EmitNDJSON(rows); err != nil {
				return die(s, err)
			}
			return 0
		}
		for _, r := range g.List {
			inv, err := jsobj.Parse(r)
			if err != nil {
				return die(s, err)
			}
			line := inv.JSString("id") + "  " + padEnd(inv.JSString("status"), 7) + "  " +
				inv.JSString("bindingName") + "  " + inv.JSStringOr("emailId", "-") + "  " +
				inv.JSString("createdAt")
			// s11 T3: the watchdog's alert marker, if it raised one — a
			// past-due invocation nobody may claim rides the row it is about.
			if alert := inv.Obj("alert"); alert != nil {
				if kind, ok := alert.Str("kind"); ok {
					line += "  [alert: " + kind + "]"
				}
			}
			s.Out(line)
		}
		return 0

	default: // rm — the verb set was validated by runAgent's dispatch
		if a.DryRun {
			s.Note("dry run: would remove invocation " + arg + "; nothing was written")
			if a.JSON {
				if err := s.EmitJSON(map[string]any{"dryRun": true, "id": arg}); err != nil {
					return die(s, err)
				}
			}
			return 0
		}
		raw, err := client.One(ctx, "AgentInvocation/set", map[string]any{
			"accountId": acc.AccountID,
			"destroy":   []string{arg},
		}, jmap.MailUsing)
		if err != nil {
			return die(s, err)
		}
		var res struct {
			Destroyed    []string          `json:"destroyed"`
			NotDestroyed map[string]setErr `json:"notDestroyed"`
			NewState     *string           `json:"newState"`
		}
		if err := json.Unmarshal(raw, &res); err != nil {
			return die(s, err)
		}
		for _, id := range res.Destroyed {
			if id == arg {
				if a.JSON {
					var state any
					if res.NewState != nil {
						state = *res.NewState
					}
					if err := s.EmitJSON(map[string]any{"id": arg, "destroyed": true, "state": state}); err != nil {
						return die(s, err)
					}
					return 0
				}
				s.Out("removed " + arg)
				return 0
			}
		}
		// A running invocation is refused server-side; its type decides the code.
		return die(s, failSetErrorOf("rm "+arg, res.NotDestroyed[arg]))
	}
}
