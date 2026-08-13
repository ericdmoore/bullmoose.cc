package cmd

// `bullmoose agents` — the agent CONFIGURATION surface (s10 T4), driven from the
// terminal. GO-NATIVE with no Node counterpart, like `approvals`: the contract
// suite is not measured against it, and it gets its own Go tests against a fake
// server.
//
// ── The one framing that shapes every verb (s10 readme) ──
//
// "agents" is TWO surfaces. This command owns exactly one of them:
//
//	configuration — what an agent IS      → here (list/show/edit/create/remove)
//	activity      — what it is DOING      → /approvals + the s03.E console
//
// `show` is the tell. It prints the config and then a POINTER at the activity
// surface; it does not reimplement the dossier. Merging the two is the mistake
// the plan names first.
//
// ── Which plane it talks to, and why that is not internal/jmap ──
//
// `agent_bindings` is a CONTROL-PLANE row. There is no `AgentBinding/*` JMAP
// collection (services/jmap/src/methods/agent.ts serves AgentInvocation only)
// and the `/console/*` routes the WebUI console wants are requested, not served.
// The one server surface that can read or write a binding is the provision
// worker's admin API, so this command is a client of internal/provision the way
// `approvals` is a client of internal/jmap. It mints no authority: every write
// below is a route that already exists, behind the gate it already has.
//
// ── The outbound bound is a BOOK, and it is fail-closed ──
//
// s10 T1 made `allowedRecipients` a governed address book
// (`agent_bindings.recipients_book_id`), not a config array. The runtime
// resolves it server-side and REFUSES the send when it is unset
// (services/agent/src/outbound.ts `outboundRefusal`), mirroring the Bureau's
// invariant 5. Two consequences this command must never soften:
//
//   - no book ⇒ the binding cannot send. That is a legitimate, safe state, and
//     it is printed as such — never as "unrestricted".
//   - there is NO value meaning "send anywhere". `--recipients-book` refuses
//     every spelling of unbounded (`*`, `all`, `any`, `none`, empty …) before
//     it goes anywhere near the wire — see checkOutboundBound.
//
// ── What is a POINTER and what is a REFUSAL ──
//
// The typed-core promotion was DEFERRED (s10 status block): only
// `recipients_book_id` became a column; `replyMode` and `allowedSenders` are
// still keys inside `config_json`. Neither has an update surface on ANY server
// — the provision worker exposes create, enable, disable and delete, and there
// is no `PATCH /agent-bindings/{id}`. So `edit` writes the one field it can
// (`enabled`, through the two kill-switch verbs) and REFUSES the rest with the
// gap named out loud, rather than pretending or reaching into D1.

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/provision"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/store"
)

const agentsUsage = "bullmoose agents <list|show|edit|create|remove> [name] " +
	"[--kind analyst|photos|newsletters|custom] [--email addr] [--name n] " +
	"[--reply-mode send|draft] [--allow-sender a@b] [--recipients-book id] " +
	"[--enabled true|false] [--sla s] [--destroy --yes] [--dry-run] [--json|--ids]"

// runAgents is the front door for the five verbs.
func runAgents(s *bmio.Streams, argv []string) int {
	a := parseAgents(argv)
	switch agPositional(a, 1) {
	case "list":
		return agList(s, a)
	case "show":
		return agShow(s, a)
	case "edit":
		return agEdit(s, a)
	case "create":
		return agCreate(s, a)
	case "remove":
		return agRemove(s, a)
	case "":
		return die(s, bmio.Usage(agentsUsage))
	default:
		return die(s, bmio.Usage(fmt.Sprintf("unknown agents verb %q\n%s", agPositional(a, 1), agentsUsage)))
	}
}

// ---- the fail-closed guard ------------------------------------------------

// unboundedSpellings are the values an operator reaches for when they mean "no
// limit". Every one of them is refused, because the outbound bound has no such
// value: the book is the bound, and its absence means CANNOT SEND rather than
// MAY SEND ANYWHERE. An empty string is in the set for the same reason it is in
// s10 T1's rule — "empty-but-present" is the shape that reads as unrestricted
// and must never be writable from a config surface.
var unboundedSpellings = map[string]bool{
	"":             true,
	"*":            true,
	"-":            true,
	"all":          true,
	"any":          true,
	"anyone":       true,
	"everyone":     true,
	"none":         true,
	"null":         true,
	"nil":          true,
	"unrestricted": true,
	"unbounded":    true,
}

// checkOutboundBound is THE fail-closed guard, shared by `edit` and `create` so
// there is one place to get it right and one place a mutation breaks two tests.
//
// It cannot verify that the named book is actually `write_policy = 'governed'`:
// the policy is not exposed on any wire today (AddressBook/set can neither set
// nor see it — s10 status block; wire exposure is T5). So the guard is honest
// about what it checks — shape, not governance — and says who does check.
func checkOutboundBound(value string) error {
	if unboundedSpellings[strings.ToLower(strings.TrimSpace(value))] {
		return bmio.Usage(
			"--recipients-book " + strconv.Quote(value) + " is not a book id.\n" +
				"  The outbound bound is a GOVERNING BOOK and it is fail-closed: there is no value\n" +
				"  that means \"send anywhere\", and clearing the book from a config surface is not\n" +
				"  offered — a half-edited binding that reads as unrestricted is the confused-deputy\n" +
				"  shape s10 T1 exists to close.\n" +
				"  To stop an agent sending:  bullmoose agents remove <name>        (reversible)\n" +
				"  To widen its reach:        add contacts to its book (an agent asks with a\n" +
				"                             grant-request proposal — bullmoose approvals)")
	}
	return nil
}

// ---- verbs ----------------------------------------------------------------

// agList shows every binding the admin token can see, with the two bounds side
// by side: the INBOUND allowlist (config.allowedSenders) and the OUTBOUND
// governing book. Seeing them together is the whole point of the row.
func agList(s *bmio.Streams, a agentsArgs) int {
	db, client, err := agConn(a)
	if err != nil {
		return die(s, err)
	}
	defer db.Close()

	bindings, err := fetchBindings(client, a.Email)
	if err != nil {
		return die(s, err)
	}
	sort.Slice(bindings, func(i, j int) bool {
		if bindings[i].Name != bindings[j].Name {
			return bindings[i].Name < bindings[j].Name
		}
		return bindings[i].ID < bindings[j].ID
	})

	if a.IDs { // §1.8 — the xargs shape outranks everything
		for _, b := range bindings {
			s.Out(b.ID)
		}
		return 0
	}
	if a.JSON { // §1.3 — NDJSON, one binding per line
		for _, b := range bindings {
			if err := s.EmitJSON(b.toJSON()); err != nil {
				return die(s, err)
			}
		}
		return 0
	}
	if len(bindings) == 0 {
		s.Note("(no agent bindings)") // chrome → stderr, so `| wc -l` is 0
		return 0
	}
	s.Note("OUTBOUND is the governing book (s10 T1): none ⇒ this binding CANNOT SEND (fail-closed), never \"anywhere\"")
	s.Note(agHeader())
	for _, b := range bindings {
		s.Out(agRow(b))
	}
	return 0
}

// agShow prints the config core, then the read-only remainder, then a POINTER
// at the activity surface. It deliberately fetches NOTHING from the proposal
// queue: the dossier lives in `approvals` and the s03.E console, and a second
// half-built copy here is how the two drift.
func agShow(s *bmio.Streams, a agentsArgs) int {
	sel := agPositional(a, 2)
	if sel == "" {
		return die(s, bmio.Usage("bullmoose agents show <name|binding-id> [--email addr] [--json]"))
	}
	db, client, err := agConn(a)
	if err != nil {
		return die(s, err)
	}
	defer db.Close()

	b, err := resolveBinding(client, a.Email, sel)
	if err != nil {
		return die(s, err)
	}
	if a.JSON {
		v := b.toJSON()
		// The pointer is part of the ANSWER, not decoration: an agent reading
		// --json must be told where activity lives just as a human is.
		v["activity"] = map[string]any{
			"surface": "approvals",
			"pointer": activityPointer(b.Name),
			"note":    "not rendered here — the queue/dossier is /approvals (s07 T4) and the s03.E console",
		}
		if err := s.EmitJSON(v); err != nil {
			return die(s, err)
		}
		return 0
	}

	s.Out(fmt.Sprintf("%s  [%s]  %s  on account %s", b.Name, enabledWord(b.Enabled), b.ID, b.AccountID))
	s.Out("")
	s.Out("config core — what this agent IS:")
	s.Out("  enabled:          " + enabledWord(b.Enabled))
	s.Out("  replyMode:        " + orDash(b.ReplyMode) + "   (send = it mails; draft = it only drafts)")
	s.Out("  allowedSenders:   " + agSenders(b) + "   (INBOUND: who may talk to it)")
	s.Out("  governing book:   " + b.boundLabel() + "   (OUTBOUND: who it may email)")
	for _, line := range boundExplanation(b) {
		s.Out("                    " + line)
	}
	s.Out("  trigger:          " + orDash(b.TriggerOn))
	s.Out("  sla:              " + agSLA(b))
	s.Out("")
	s.Out("read-only remainder — config_json, not editable from this surface:")
	if rest := b.remainder(); len(rest) == 0 {
		s.Out("  (none)")
	} else {
		for _, k := range sortedKeys(rest) {
			s.Out("  " + k + ": " + trunc(jsonCompact(rest[k]), 96))
		}
	}
	s.Out("")
	s.Out("for activity: " + activityPointer(b.Name))
	s.Note("(activity is a POINTER, not a panel — the queue, history and score live in /approvals and the console)")
	return 0
}

// agEdit sets the typed core. Today exactly one field of that core has a server
// surface — `enabled`, through the two explicit kill-switch verbs — so that is
// the only thing this verb writes. The rest are refused with the gap named, in
// this order:
//
//  1. the fail-closed guard runs FIRST (exit 2), so an operator who types
//     `--recipients-book none` gets the invariant, not a capability complaint;
//  2. then the missing-surface refusal (exit 1).
//
// Both are refusals. Neither is a blind edit of the blob: there is no flag here
// that writes `persona`, `modelAliases` or any other untyped key, because a
// form over an untyped blob is the structural mistake s10 opens by naming.
func agEdit(s *bmio.Streams, a agentsArgs) int {
	sel := agPositional(a, 2)
	if sel == "" {
		return die(s, bmio.Usage(
			"bullmoose agents edit <name|binding-id> [--enabled true|false] [--reply-mode send|draft]\n"+
				"                     [--allow-sender a@b] [--recipients-book <bookId>] [--email addr]"))
	}

	// (1) The invariant, before anything else and before any network call.
	if a.HasBook {
		if err := checkOutboundBound(a.RecipientsBook); err != nil {
			return die(s, err)
		}
	}
	if a.ReplyMode != "" && a.ReplyMode != "send" && a.ReplyMode != "draft" {
		return die(s, bmio.Usage("--reply-mode must be send or draft"))
	}
	if a.Enabled != "" {
		if _, ok := parseBool(a.Enabled); !ok {
			return die(s, bmio.Usage("--enabled must be true or false"))
		}
	}
	if a.Enabled == "" && a.ReplyMode == "" && len(a.AllowSenders) == 0 && !a.HasBook {
		return die(s, bmio.Usage(
			"nothing to edit — pass --enabled, and see `bullmoose agents edit` for the fields\n"+
				"that have no server surface yet"))
	}

	// (2) The fields with no server surface. Named before the write, so a
	// mixed invocation cannot half-apply and report success.
	if a.ReplyMode != "" || len(a.AllowSenders) > 0 || a.HasBook {
		return die(s, noUpdateSurface(a))
	}

	db, client, err := agConn(a)
	if err != nil {
		return die(s, err)
	}
	defer db.Close()

	b, err := resolveBinding(client, a.Email, sel)
	if err != nil {
		return die(s, err)
	}
	want, _ := parseBool(a.Enabled)
	return agSetEnabled(s, client, b, want, a)
}

// agCreate is provisioning-from-a-kind, not a blank insert. It is honest about
// its own boundary in both directions:
//
//   - it does NOT mint an identity or scopes. `POST /agent-bindings` binds a
//     runtime to an account that must already exist; minting the account is
//     `POST /accounts`, a different provisioning call with a different blast
//     radius. The plan is printed before the write and the pointer is attached
//     to the server's 404, so nobody discovers this from a stack trace.
//   - EVERY kind produces a fail-closed outbound bound. Either --recipients-book
//     names a governing book, or the column is left NULL and the binding cannot
//     send at all. There is no third option and no wildcard.
func agCreate(s *bmio.Streams, a agentsArgs) int {
	kind, ok := agentKinds[a.Kind]
	if !ok {
		return die(s, bmio.Usage(
			"bullmoose agents create --kind <analyst|photos|newsletters|custom> --email <account-address>\n"+
				"                        [--name <binding>] [--recipients-book <bookId>] [--reply-mode send|draft]\n"+
				"                        [--allow-sender a@b] [--sla <seconds>] [--dry-run]\n"+
				"  --kind is required: a blank config_json editor cannot express the shapes\n"+
				"  (analyst@ is a digest pipeline, photos@ is social) — s10 readme gotcha 1"))
	}
	if a.Email == "" {
		return die(s, bmio.Usage("bullmoose agents create --kind "+a.Kind+" --email <account-address>"))
	}
	name := a.Name
	if name == "" {
		name = kind.DefaultName
	}
	if name == "" {
		return die(s, bmio.Usage("--kind custom is the blank case — it needs an explicit --name <binding>"))
	}
	// The invariant, before the plan is even printed.
	if a.HasBook {
		if err := checkOutboundBound(a.RecipientsBook); err != nil {
			return die(s, err)
		}
	}
	replyMode := kind.ReplyMode
	if a.ReplyMode != "" {
		if a.ReplyMode != "send" && a.ReplyMode != "draft" {
			return die(s, bmio.Usage("--reply-mode must be send or draft"))
		}
		replyMode = a.ReplyMode
	}

	config := map[string]any{}
	for k, v := range kind.Config {
		config[k] = v
	}
	config["replyMode"] = replyMode
	senders := append([]string{}, kind.AllowedSenders...)
	senders = append(senders, a.AllowSenders...)
	if len(senders) > 0 {
		config["allowedSenders"] = senders
	}

	body := map[string]any{"email": a.Email, "name": name, "config": config}
	if a.SLA != "" {
		n, err := strconv.Atoi(a.SLA)
		if err != nil || n <= 0 {
			return die(s, bmio.Usage("--sla must be a positive number of seconds"))
		}
		body["slaSeconds"] = n
	}
	// Fail-closed: the key is present ONLY when a book was named. An absent
	// recipientsBookId leaves the column NULL, which the runtime reads as
	// "cannot send" — the safe half of the invariant, not a gap in it.
	if a.HasBook {
		body["recipientsBookId"] = a.RecipientsBook
	}

	// The plan, always — `create` says what it will do before it does it.
	s.Note("plan: POST /agent-bindings on the provision worker")
	s.Note("  kind:            " + a.Kind + " — " + kind.Summary)
	s.Note("  binding:         " + name + " on " + a.Email + " (the account must ALREADY exist)")
	s.Note("  replyMode:       " + replyMode)
	if len(senders) > 0 {
		s.Note("  allowedSenders:  " + strings.Join(senders, ", "))
	} else {
		s.Note("  allowedSenders:  (none) — the inbound gate is open; anyone who can reach the mailbox can invoke it")
	}
	if a.HasBook {
		s.Note("  governing book:  " + a.RecipientsBook + " — " + kind.BookPurpose)
		s.Note("                   NOT verified as write_policy='governed': no wire exposes it yet (s10 T5)")
	} else {
		s.Note("  governing book:  (none) — FAIL-CLOSED: this binding CANNOT SEND until a book is seeded")
		s.Note("                   " + kind.BookPurpose)
	}
	s.Note("  NOT done here:   no identity, no address, no scopes are minted. `POST /accounts` is a")
	s.Note("                   separate provisioning call: bullmoose admin account create --tenant <t> \\")
	s.Note("                     --domain <d> --name <localpart>")
	if a.DryRun {
		s.Note("--dry-run: nothing written")
		if a.JSON {
			if err := s.EmitJSON(map[string]any{"dryRun": true, "kind": a.Kind, "request": body}); err != nil {
				return die(s, err)
			}
		}
		return 0
	}

	db, client, err := agConn(a)
	if err != nil {
		return die(s, err)
	}
	defer db.Close()

	raw, err := client.Call(context.Background(), "POST", "/agent-bindings", body)
	if err != nil {
		return die(s, withAccountHint(err, a.Email))
	}
	var res struct {
		BindingID string `json:"bindingId"`
		AccountID string `json:"accountId"`
		Watchdog  bool   `json:"watchdog"`
	}
	if err := json.Unmarshal(raw, &res); err != nil {
		return die(s, err)
	}

	if a.JSON {
		out := map[string]any{
			"id": res.BindingID, "accountId": res.AccountID, "name": name,
			"kind": a.Kind, "replyMode": replyMode, "allowedSenders": senders,
			"watchdog": res.Watchdog,
			"outbound": outboundJSON(a.HasBook, a.RecipientsBook, true),
		}
		if err := s.EmitJSON(out); err != nil {
			return die(s, err)
		}
		return 0
	}
	s.Out(fmt.Sprintf("%s (%s) created on %s as kind %s", res.BindingID, name, a.Email, a.Kind))
	if res.Watchdog {
		s.Note("a watchdog responder was armed for this binding (--sla)")
	}
	if a.HasBook {
		s.Note("outbound bound: book " + a.RecipientsBook)
	} else {
		s.Note("outbound bound: NONE — this binding cannot send. Seed a governing book before it needs to.")
	}
	s.Note("for activity, once it runs: " + activityPointer(name))
	return 0
}

// agRemove is disable-by-default. `--destroy` is the irreversible half and says
// what happens to the agent's outstanding work BEFORE it asks for confirmation
// — devPlan decision 3: the proposals are audit and they are kept.
func agRemove(s *bmio.Streams, a agentsArgs) int {
	sel := agPositional(a, 2)
	if sel == "" {
		return die(s, bmio.Usage(
			"bullmoose agents remove <name|binding-id> [--destroy --yes] [--email addr]\n"+
				"  default: DISABLE (enabled=0) — reversible, queued work is held, nothing is lost"))
	}
	if !a.Destroy && a.Yes {
		s.Note("--yes has no effect on the default (disable) — it is reversible")
	}
	// Explicit intent: the destructive direction needs BOTH the flag that names
	// it and the confirmation every irreversible admin verb takes (admin.ts
	// IRREVERSIBLE). Refused BEFORE the network, so a missing --yes cannot race.
	if a.Destroy && !a.Yes {
		return die(s, bmio.Usage(
			"agents remove --destroy is irreversible — re-run with --yes.\n"+
				"  It hard-deletes the binding row and its watchdog responder.\n"+
				"  "+proposalDisposition+"\n"+
				"  The reversible verb is the default: bullmoose agents remove "+sel))
	}

	db, client, err := agConn(a)
	if err != nil {
		return die(s, err)
	}
	defer db.Close()

	b, err := resolveBinding(client, a.Email, sel)
	if err != nil {
		return die(s, err)
	}
	if !a.Destroy {
		return agSetEnabled(s, client, b, false, a)
	}

	raw, err := client.Call(context.Background(), "DELETE",
		"/agent-bindings/"+b.ID+provision.Query(a.Email), nil)
	if err != nil {
		// The server REFUSES a destroy while invocations are pending or running
		// (409) precisely so they are never stranded — surface that verbatim and
		// point at the reversible verb.
		return die(s, withDestroyHint(err, b.Name))
	}
	var res struct {
		Deleted bool `json:"deleted"`
		Steps   []struct {
			Step   string `json:"step"`
			OK     bool   `json:"ok"`
			Detail string `json:"detail"`
		} `json:"steps"`
	}
	if err := json.Unmarshal(raw, &res); err != nil {
		return die(s, err)
	}
	if a.JSON {
		if err := s.EmitJSON(map[string]any{
			"id": b.ID, "name": b.Name, "accountId": b.AccountID,
			"verb": "destroy", "destroyed": res.Deleted,
			"proposals": map[string]any{
				"disposition": "kept",
				"note":        proposalDisposition,
			},
		}); err != nil {
			return die(s, err)
		}
		return 0
	}
	for _, st := range res.Steps {
		line := "  " + st.Step
		if st.Detail != "" {
			line += ": " + st.Detail
		}
		s.Note(line)
	}
	s.Out(b.ID + " (" + b.Name + ") destroyed — the binding row is gone.")
	s.Note(proposalDisposition)
	return 0
}

// proposalDisposition is the sentence `--destroy` must say, in every mode. It
// is the devPlan decision 3 stance stated as fact rather than intent, and it is
// checked against what the server actually does: `deleteAgentBinding` removes
// the binding row and the watchdog responder ONLY, and refuses outright while
// anything is still queued.
const proposalDisposition = "outstanding proposals are KEPT as audit: agent_proposals and " +
	"agent_invocations carry no FK to the binding, so history outlives it (each invocation keeps " +
	"binding_name, so it stays attributable). The server refuses the destroy outright while any " +
	"invocation is pending or running, so nothing is stranded mid-flight."

// ---- the shared enabled write ---------------------------------------------

// agSetEnabled is the ONE write this command performs, through the two explicit
// kill-switch verbs (`POST /agent-bindings/{id}/{enable,disable}`) rather than a
// general boolean PATCH — mid-incident the dangerous direction must be
// impossible to typo into its opposite (provision index.ts:150).
func agSetEnabled(s *bmio.Streams, client *provision.Client, b binding, enable bool, a agentsArgs) int {
	verb := "disable"
	if enable {
		verb = "enable"
	}
	raw, err := client.Call(context.Background(), "POST",
		"/agent-bindings/"+b.ID+"/"+verb+provision.Query(a.Email), nil)
	if err != nil {
		return die(s, err)
	}
	var res struct {
		Name               string `json:"name"`
		AccountID          string `json:"accountId"`
		Enabled            bool   `json:"enabled"`
		Changed            bool   `json:"changed"`
		PendingInvocations int    `json:"pendingInvocations"`
		Note               string `json:"note"`
	}
	if err := json.Unmarshal(raw, &res); err != nil {
		return die(s, err)
	}
	if a.JSON {
		if err := s.EmitJSON(map[string]any{
			"id": b.ID, "name": res.Name, "accountId": res.AccountID,
			"verb": verb, "enabled": res.Enabled, "changed": res.Changed,
			"pendingInvocations": res.PendingInvocations,
			"reversible":         true,
		}); err != nil {
			return die(s, err)
		}
		return 0
	}
	state := "DISABLED"
	if res.Enabled {
		state = "ENABLED"
	}
	s.Out(fmt.Sprintf("%s (%s) is now %s", b.ID, res.Name, state))
	if res.Note != "" {
		s.Note(res.Note)
	}
	if !res.Enabled {
		s.Note("reversible — re-enable with: bullmoose agents edit " + b.Name + " --enabled true")
	}
	return 0
}

// ---- the missing-surface refusal ------------------------------------------

// noUpdateSurface is the honest answer to "edit the rest of the typed core".
// It is a REPORTED GAP, not a limitation of this command: nothing anywhere can
// write these fields after creation.
func noUpdateSurface(a agentsArgs) error {
	var asked []string
	if a.ReplyMode != "" {
		asked = append(asked, "--reply-mode")
	}
	if len(a.AllowSenders) > 0 {
		asked = append(asked, "--allow-sender")
	}
	if a.HasBook {
		asked = append(asked, "--recipients-book")
	}
	return &bmio.CliError{
		Code: bmio.ExitFail,
		Msg: strings.Join(asked, ", ") + ": no server surface exists for this write.\n" +
			"  agent_bindings.config_json (replyMode, allowedSenders) and .recipients_book_id have NO\n" +
			"  update route: the provision worker serves POST /agent-bindings (create), the two\n" +
			"  enable/disable verbs and DELETE — there is no PATCH /agent-bindings/{id} — and there is\n" +
			"  no AgentBinding/* JMAP collection. Writing D1 from a client is not on the table: s10 T1's\n" +
			"  whole point is that the bound is resolved and enforced server-side.\n" +
			"  What does work today:\n" +
			"    enabled:        bullmoose agents edit <name> --enabled true|false\n" +
			"    a new shape:    bullmoose agents create --kind <k> ...   (a NEW binding)\n" +
			"    the book's MEMBERS: edit the book in /contacts; an agent widens it by filing a\n" +
			"                    grant-request proposal (bullmoose approvals), never by writing it.\n" +
			"  GAP (reported, not worked around): re-pointing recipients_book_id is a widening-class\n" +
			"  write — a bare PATCH that skipped the s10 T2 provenance row would put a hole in the\n" +
			"  chain exactly where T2 forbids one, so the route is a server task, not a CLI one.",
	}
}

// withAccountHint attaches the identity-minting pointer to the server's 404,
// which is the only place an operator learns that `create` binds rather than
// provisions.
func withAccountHint(err error, email string) error {
	var se *bmio.ServerError
	if !asServerError(err, &se) || se.HTTPStatus != 404 {
		return err
	}
	return &bmio.ServerError{
		HTTPStatus: se.HTTPStatus,
		Msg: se.Msg + "\n" +
			"  `agents create` binds a runtime to an EXISTING account; it does not mint one.\n" +
			"  Mint the identity first (POST /accounts):\n" +
			"    bullmoose admin account create --tenant <tenantId> --domain <domain> --name " +
			localpart(email),
	}
}

// withDestroyHint turns the server's queued-work 409 into the reversible verb.
func withDestroyHint(err error, name string) error {
	var se *bmio.ServerError
	if !asServerError(err, &se) || se.HTTPStatus != 409 {
		return err
	}
	return &bmio.ServerError{
		HTTPStatus: se.HTTPStatus,
		Msg: se.Msg + "\n" +
			"  Nothing was destroyed, and nothing was stranded. Disable it instead — that is the\n" +
			"  reversible verb and it HOLDS the queue rather than cancelling it:\n" +
			"    bullmoose agents remove " + name,
	}
}

// ---- the kinds ------------------------------------------------------------

// agentKind is a template, not a form default: `analyst@` is a digest pipeline
// and `photos@` is social, and a blank config_json editor cannot express the
// difference (s10 readme gotcha 1).
//
// Every kind ships `replyMode: draft`. That is NOT the fail-closed bound — the
// bound is the book — it is the second, independent conservative default: a new
// binding drafts until someone decides it may send.
type agentKind struct {
	DefaultName    string
	Summary        string
	ReplyMode      string
	AllowedSenders []string
	Config         map[string]any
	// BookPurpose names what this kind's governing book is FOR, so the
	// fail-closed warning is specific enough to act on.
	BookPurpose string
}

var agentKinds = map[string]agentKind{
	"analyst": {
		DefaultName: "analyst",
		Summary:     "a digest pipeline over the spend ledger (responder only)",
		ReplyMode:   "draft",
		Config:      map[string]any{"pipeline": "ledger", "requireAuth": true, "chartMinPoints": 10},
		BookPurpose: "its book is the DIGEST RECIPIENTS — analyst@ mails its ledger digests, so an unseeded book means the digests are refused at the relay",
	},
	"photos": {
		DefaultName: "photos",
		Summary:     "a social agent: CC-invited into event folders, receiving from arbitrary external senders",
		ReplyMode:   "draft",
		Config:      map[string]any{"pipeline": "reply"},
		BookPurpose: "its book is the EVENT INVITEES it may email — photos@ is the confused-deputy shape s10 T1 was written for, so this bound is the whole control surface",
	},
	"newsletters": {
		DefaultName: "newsletters",
		Summary:     "an inbox-absorber: forwarded newsletters become searchable, summarised on request",
		ReplyMode:   "draft",
		Config:      map[string]any{"pipeline": "reply"},
		BookPurpose: "its book is whoever receives its summaries — usually just the account owner",
	},
	"custom": {
		DefaultName: "", // deliberately none: custom must be named explicitly
		Summary:     "the blank case — a binding with no pipeline template",
		ReplyMode:   "draft",
		Config:      map[string]any{},
		BookPurpose: "custom still gets a fail-closed bound: with no book it cannot send, whatever its pipeline turns out to be",
	},
}

// ---- the binding view -----------------------------------------------------

// binding is the CLI's view of one `agent_bindings` row as the admin API serves
// it. `BookReported` is load-bearing: a provision worker that does not project
// `recipients_book_id` must read as UNREPORTED, never as "no book" — the two
// have opposite meanings and only one of them is a fail-closed state.
type binding struct {
	ID           string
	AccountID    string
	Name         string
	TriggerOn    string
	SLASeconds   *int
	Enabled      bool
	ReplyMode    string
	Senders      []string
	SendersKnown bool
	BookID       string
	BookReported bool
	Config       map[string]json.RawMessage
}

// typedCoreKeys are the config_json keys this surface treats as the TYPED CORE
// (still in the blob — the s10 promotion was deferred). Everything else is the
// agent-specific remainder and is shown read-only.
var typedCoreKeys = map[string]bool{"replyMode": true, "allowedSenders": true}

func (b binding) remainder() map[string]json.RawMessage {
	out := map[string]json.RawMessage{}
	for k, v := range b.Config {
		if !typedCoreKeys[k] {
			out[k] = v
		}
	}
	return out
}

// boundLabel is the one string that must never lie. Three states, three words.
func (b binding) boundLabel() string {
	switch {
	case !b.BookReported:
		return "unreported"
	case b.BookID == "":
		return "none"
	default:
		return "book:" + b.BookID
	}
}

func (b binding) boundState() string {
	switch {
	case !b.BookReported:
		return "unreported"
	case b.BookID == "":
		return "none"
	default:
		return "book"
	}
}

func (b binding) toJSON() map[string]any {
	var senders any
	if b.SendersKnown {
		senders = b.Senders
	}
	return map[string]any{
		"id":         b.ID,
		"accountId":  b.AccountID,
		"name":       b.Name,
		"enabled":    b.Enabled,
		"triggerOn":  b.TriggerOn,
		"slaSeconds": b.SLASeconds,
		"replyMode":  nilIfEmpty(b.ReplyMode),
		// INBOUND. null (not []) when the key is absent: "no allowlist" and
		// "an empty allowlist" are the same fail-OPEN state here, and saying
		// which one it is beats inventing an empty array.
		"allowedSenders": senders,
		// OUTBOUND — the governing book.
		"outbound": outboundJSON(b.BookReported && b.BookID != "", b.BookID, b.BookReported),
		"config":   b.Config,
	}
}

// outboundJSON is the stable `--json` shape of the outbound bound. `state` is
// the whole vocabulary, and it has exactly three values:
//
//	book        — bounded by governingBookId; per-recipient membership is
//	              resolved server-side on every send
//	none        — no governing book ⇒ the server refuses EVERY send
//	unreported  — this provision worker does not project the column; the CLI
//	              does not know, and says so rather than guessing "none"
func outboundJSON(hasBook bool, bookID string, reported bool) map[string]any {
	state := "unreported"
	switch {
	case hasBook:
		state = "book"
	case reported:
		state = "none"
	}
	var id any
	if state == "book" {
		id = bookID
	}
	return map[string]any{
		"state":           state,
		"governingBookId": id,
		"failClosed":      state == "none",
	}
}

// ---- fetch / resolve ------------------------------------------------------

func fetchBindings(client *provision.Client, email string) ([]binding, error) {
	raw, err := client.Call(context.Background(), "GET", "/agent-bindings"+provision.Query(email), nil)
	if err != nil {
		return nil, err
	}
	var got struct {
		Bindings []map[string]json.RawMessage `json:"bindings"`
	}
	if err := json.Unmarshal(raw, &got); err != nil {
		return nil, err
	}
	out := make([]binding, 0, len(got.Bindings))
	for _, row := range got.Bindings {
		out = append(out, parseBinding(row))
	}
	return out, nil
}

// parseBinding reads one row, feature-detecting `recipients_book_id` by KEY
// PRESENCE rather than by null-ness — see binding.BookReported.
func parseBinding(row map[string]json.RawMessage) binding {
	b := binding{
		ID:        jsonString(row["id"]),
		AccountID: jsonString(row["account_id"]),
		Name:      jsonString(row["name"]),
		TriggerOn: jsonString(row["trigger_on"]),
		Enabled:   jsonNumber(row["enabled"]) == 1,
	}
	if v, ok := row["sla_seconds"]; ok && string(v) != "null" {
		n := int(jsonNumber(v))
		b.SLASeconds = &n
	}
	if v, ok := row["recipients_book_id"]; ok {
		b.BookReported = true
		b.BookID = jsonString(v)
	}
	b.Config = map[string]json.RawMessage{}
	if v, ok := row["config_json"]; ok {
		// config_json arrives as a JSON *string* holding JSON (the column is
		// TEXT). A malformed blob is not fatal: the rest of the row is still
		// worth showing, and `show` renders the remainder verbatim anyway.
		if s := jsonString(v); s != "" {
			_ = json.Unmarshal([]byte(s), &b.Config)
		}
	}
	if v, ok := b.Config["replyMode"]; ok {
		b.ReplyMode = jsonString(v)
	}
	if v, ok := b.Config["allowedSenders"]; ok {
		var list []string
		if json.Unmarshal(v, &list) == nil {
			b.Senders = list
			b.SendersKnown = true
		}
	}
	return b
}

// resolveBinding picks the ONE binding a verb acts on, by name or by bare
// binding id. Ambiguity is a usage error naming the fix, never a silent pick —
// the same stance account.Pick takes (cli/009) and the same one the provision
// worker takes when an id spans two accounts (409, "narrow it with ?email=").
func resolveBinding(client *provision.Client, email, sel string) (binding, error) {
	all, err := fetchBindings(client, email)
	if err != nil {
		return binding{}, err
	}
	var hits []binding
	for _, b := range all {
		if b.ID == sel || b.Name == sel {
			hits = append(hits, b)
		}
	}
	switch len(hits) {
	case 1:
		return hits[0], nil
	case 0:
		msg := "no agent binding named " + strconv.Quote(sel)
		if email != "" {
			msg += " on " + email
		}
		return binding{}, bmio.NotFound(msg + " — list them: bullmoose agents list")
	default:
		var where []string
		for _, h := range hits {
			where = append(where, h.ID+" on "+h.AccountID)
		}
		return binding{}, &bmio.CliError{
			Code: bmio.ExitUsage,
			Msg: strconv.Quote(sel) + " matches " + strconv.Itoa(len(hits)) + " bindings (" +
				strings.Join(where, ", ") + ") — narrow it with --email <address>, or name the binding id",
		}
	}
}

// agConn opens the mirror for the ADMIN credential pair only (bindings are not
// in the mirror) and builds the provision client. The caller closes db.
func agConn(a agentsArgs) (*sql.DB, *provision.Client, error) {
	db, err := store.Open(store.DBPath(a.DB))
	if err != nil {
		return nil, nil, err
	}
	admin, err := store.RequireAdmin(db)
	if err != nil {
		_ = db.Close()
		return nil, nil, err
	}
	return db, provision.NewClient(admin.URL, admin.Token), nil
}

// ---- rendering ------------------------------------------------------------

func agHeader() string {
	return fmt.Sprintf("%-16s  %-18s  %-8s  %-6s  %-30s  %s",
		"NAME", "BINDING", "ENABLED", "REPLY", "INBOUND (allowedSenders)", "OUTBOUND (governing book)")
}

func agRow(b binding) string {
	return fmt.Sprintf("%-16s  %-18s  %-8s  %-6s  %-30s  %s",
		trunc(b.Name, 16), trunc(b.ID, 18), enabledWord(b.Enabled),
		trunc(orDash(b.ReplyMode), 6), trunc(agSenders(b), 30), b.boundLabel())
}

// agSenders renders the inbound allowlist. "(any)" is the honest word for an
// absent one: services/agent treats an empty allowedSenders as NO GATE, so this
// column must not print "none" and read as closed.
func agSenders(b binding) string {
	if !b.SendersKnown || len(b.Senders) == 0 {
		return "(any — no gate)"
	}
	return strings.Join(b.Senders, ",")
}

func agSLA(b binding) string {
	if b.SLASeconds == nil {
		return "—"
	}
	return strconv.Itoa(*b.SLASeconds) + "s (watchdog responder)"
}

// boundExplanation is the sentence that goes under `show`'s outbound row. It
// changes with the state because the three states mean genuinely different
// things and a single generic caption would blur them.
func boundExplanation(b binding) []string {
	switch b.boundState() {
	case "none":
		return []string{
			"FAIL-CLOSED: with no governing book the server refuses every send",
			"(services/agent outboundRefusal) — this is safe, not unrestricted.",
		}
	case "unreported":
		return []string{
			"this provision worker does not report recipients_book_id, so the CLI",
			"does not know the bound. It is NOT claiming there is none.",
		}
	default:
		return []string{
			"membership is resolved server-side on every send, normalized exact",
			"match; the agent cannot write this book (s10 T1) — it asks with a",
			"grant-request proposal (s10 T3).",
		}
	}
}

// activityPointer is the ONE place the activity surface is named, so the two
// surfaces cannot drift into two different pointers.
func activityPointer(name string) string {
	return "bullmoose approvals list --agent " + name
}

func enabledWord(b bool) string {
	if b {
		return "enabled"
	}
	return "disabled"
}

func orDash(s string) string {
	if s == "" {
		return "—"
	}
	return s
}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func sortedKeys(m map[string]json.RawMessage) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func jsonString(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	return ""
}

func jsonNumber(raw json.RawMessage) float64 {
	if len(raw) == 0 {
		return 0
	}
	var n float64
	if json.Unmarshal(raw, &n) == nil {
		return n
	}
	return 0
}

func parseBool(v string) (bool, bool) {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "true", "yes", "on", "1":
		return true, true
	case "false", "no", "off", "0":
		return false, true
	}
	return false, false
}

func localpart(email string) string {
	if i := strings.IndexByte(email, '@'); i > 0 {
		return email[:i]
	}
	return email
}

// asServerError is errors.As for *bmio.ServerError, kept local so the hint
// helpers read as one line.
func asServerError(err error, target **bmio.ServerError) bool {
	se, ok := err.(*bmio.ServerError)
	if ok {
		*target = se
	}
	return ok
}

// ---- arg parsing ----------------------------------------------------------

// agentsArgs is the whole grammar of this command. Like approvals, `agents` has
// no Node twin, so there is nothing to delegate an unowned flag to and this
// parser owns every flag the five verbs take.
type agentsArgs struct {
	JSON, IDs, Destroy, Yes, DryRun bool
	DB, Email, Name, Kind           string
	ReplyMode, RecipientsBook       string
	Enabled, SLA                    string
	HasBook                         bool // --recipients-book present, even if ""
	AllowSenders                    []string
	Positionals                     []string
}

func parseAgents(argv []string) agentsArgs {
	var a agentsArgs
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
			case "destroy":
				a.Destroy = true
			case "yes":
				a.Yes = true
			case "dry-run":
				a.DryRun = true
			case "db":
				a.DB = value()
			case "email":
				a.Email = value()
			case "name":
				a.Name = value()
			case "kind":
				a.Kind = value()
			case "reply-mode":
				a.ReplyMode = value()
			case "recipients-book":
				a.RecipientsBook = value()
				a.HasBook = true
			case "enabled":
				a.Enabled = value()
			case "sla":
				a.SLA = value()
			case "allow-sender":
				// Repeatable, and comma-splitting inside one value, matching
				// `admin agent bind --allow a@b,c@d`.
				for _, part := range strings.Split(value(), ",") {
					if t := strings.TrimSpace(part); t != "" {
						a.AllowSenders = append(a.AllowSenders, t)
					}
				}
			default:
				// Unknown flag — treated as valueless so it can never swallow the
				// following token (which might be the verb or the name).
			}
		default:
			a.Positionals = append(a.Positionals, arg)
		}
	}
	return a
}

func agPositional(a agentsArgs, n int) string {
	if n < len(a.Positionals) {
		return a.Positionals[n]
	}
	return ""
}
