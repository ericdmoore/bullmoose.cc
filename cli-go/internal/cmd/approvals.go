package cmd

// `bullmoose approvals` — the human review surface for agent-proposed work
// (s03.D T1), driven from the terminal. This command is GO-NATIVE: there is no
// Node counterpart, so it is not measured against the byte-identity contract; it
// is the first bullmoose command that is strictly more capable in Go.
//
// It is also the first command that talks to the LIVE server rather than the
// local mirror, because ActionProposal is a server-side read model over
// agent_invocations (s03.D/arch.md §1) and is not synced into the mirror. It
// reaches the server through internal/jmap (base + token read from the SAME
// mirror config, via internal/store), and keeps every honesty rule the surface
// demands:
//
//   - the two clocks stay distinct (proposal.Clocks): `expires-in` is the
//     pre-decision deadline, `holdUntil` the tier-2 retraction window;
//   - a tier-2 approve reports HELD with NOTHING SENT (the server returns the row
//     `held`; committing out of the tray is s03.D T2, not built);
//   - a tier-3 approve lets the server's capability wall decide — an insufficient
//     token's `forbidden` is surfaced verbatim with its own exit code;
//   - `edit` writes editedPayload and NEVER payload, and a no-op edit sends no
//     editedPayload at all;
//   - `needs-info` is an ACTION, not a decline (s10 T3, decline-taxonomy.md): it
//     carries only the required human question, records NO decision, and an
//     `info-requested` row renders as waiting-on-the-agent with NO deadline —
//     the server banked the remaining window and nulled `expiresAt`, so any
//     countdown here would be invented and "expired" would be a lie.
//
// The verbs: list · show · approve · decline · needs-info · edit.

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"golang.org/x/term"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/account"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/jmap"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/proposal"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/store"
)

const approvalsUsage = "bullmoose approvals <list|show|approve|decline|needs-info|edit> [id] " +
	"[--status s] [--agent name] [--reason r] [--note t] [--question t] [--body t|--file p] " +
	"[--subject s] [--account sel] [--json|--ids]"

// rejectReasons mirrors REJECT_REASONS (actionProposal.ts). Checked client-side
// only to fail a typo fast with a usage code; the server remains the authority
// (a valid-but-unknown value would still be refused there).
//
// The sets AGREE. The revision in `.plans/s03.D-coexistence/decline-taxonomy.md`
// — retire `notNow`, add `unsafe` — has landed on the server, in webmail's
// `RejectReason`, and here, together. `TestRejectReasons_NeedsInfoIsNeverAReason`
// pins that agreement in both directions, so a set that moves on one side alone
// is a red build rather than a CLI that refuses a reason the server accepts or
// offers one it rejects. The enum is the contract; the three move as one.
//
// What each reason steers (decline-taxonomy.md): `wrongContent` fixes
// GENERATION, `wrongAction` fixes SELECTION, `unintendedInvocation` steers
// NOTHING (the human mis-clicked; the record is evidence about the click, not
// the agent, and a learning pipeline must exclude it), and `unsafe` — private
// information
// leaked, or a commitment made on the human's behalf — is the categorically
// separate HARD negative, not a stronger way of saying no.
//
// `notNow` is retired from this set, which narrows only what may be WRITTEN.
// Rows already decided under it are never migrated, and `proposal.ReasonLabel`
// renders such a reason as itself, marked retired, wherever a decision prints.
//
// ⚠️ `needsInfo` is deliberately absent and must STAY absent. It is an ACTION
// (`needs-info`, status `info-requested`), never a reject reason — the taxonomy's
// invariant is that it never lands in a rejection record, and this set is where
// the invariant is enforced on the client write path. `--reason needsInfo` is
// refused in apDecline with a pointer at the verb.
var rejectReasons = map[string]bool{"wrongContent": true, "wrongAction": true, "unsafe": true, "unintendedInvocation": true}

// rejectReasonList is the one place the enum is spelled for humans, so a usage
// message can never drift from the set it describes.
const rejectReasonList = "wrongContent, wrongAction, unsafe, unintendedInvocation"

// runApprovals is the front door for the six verbs. It is registered
// Go-native-only (registry.go), so Dispatch routes here regardless of flags.
func runApprovals(s *bmio.Streams, argv []string) int {
	a := parseApprovals(argv)
	verb := positionalAt(a, 1)
	// `--question` belongs to exactly one verb. Dropping it silently on any other
	// would let a human believe they had asked the agent something when nothing
	// was asked — the same reason needs-info refuses --reason/--note.
	if a.Question != "" && verb != proposal.NeedsInfoVerb {
		return die(s, bmio.Usage(fmt.Sprintf(
			"--question is the needsInfo ask and belongs to `approvals %s` alone — "+
				"%q would have ignored it.\n%s",
			proposal.NeedsInfoVerb, verb, needsInfoUsage(positionalAt(a, 2)))))
	}
	switch verb {
	case "list":
		return apList(s, a)
	case "show":
		return apShow(s, a)
	case "approve":
		return apApprove(s, a)
	case "decline":
		return apDecline(s, a)
	case proposal.NeedsInfoVerb: // "needs-info"
		return apNeedsInfo(s, a)
	case "edit":
		return apEdit(s, a)
	case "":
		return die(s, bmio.Usage(approvalsUsage))
	default:
		return die(s, bmio.Usage(fmt.Sprintf("unknown approvals verb %q\n%s", positionalAt(a, 1), approvalsUsage)))
	}
}

// ---- verbs ----------------------------------------------------------------

// apList runs ActionProposal/query (default filter `pending`) then get-after-query
// off a back-reference in ONE round trip (webmail api.ts:23). Urgency ordering is
// a CLIENT concern (the server's query only knows created_at DESC), so the rows
// are re-ordered by proposal.OrderQueue.
func apList(s *bmio.Streams, a approvalsArgs) int {
	db, client, accounts, err := apConn(a)
	if err != nil {
		return die(s, err)
	}
	defer db.Close()

	filter := func(args map[string]any) map[string]any {
		switch a.Status {
		case "": // default queue: pending only
			args["filter"] = map[string]any{"status": "pending"}
		case "all": // no filter — the server's default is everything, newest first
		default:
			args["filter"] = map[string]any{"status": a.Status}
		}
		return args
	}

	// 2N invocations, ONE round trip: query→get per account, each get
	// back-referencing its own query by call id (s10 T7).
	calls := make([]jmap.Invocation, 0, 2*len(accounts))
	for i, acc := range accounts {
		q := fmt.Sprintf("q%d", i)
		calls = append(calls,
			jmap.Invocation{
				Name:   "ActionProposal/query",
				Args:   filter(map[string]any{"accountId": acc.AccountID}),
				CallID: q,
			},
			jmap.Invocation{
				Name: "ActionProposal/get",
				Args: map[string]any{
					"accountId": acc.AccountID,
					"#ids":      jmap.Ref(q, "ActionProposal/query", "/ids"),
				},
				CallID: fmt.Sprintf("g%d", i),
			})
	}
	resps, err := client.Call(context.Background(), jmap.AgentUsing, calls)
	if err != nil {
		return die(s, err)
	}

	proposals := make([]*proposal.Proposal, 0, 8)
	refused := 0
	for i, acc := range accounts {
		// A query-side refusal (e.g. unsupportedFilter) must surface, not be
		// masked by a downstream invalidResultReference.
		var accErr error
		if q, ok := jmap.Find(resps, fmt.Sprintf("q%d", i)); ok {
			_, accErr = q.Result("ActionProposal/query")
		}
		g, ok := jmap.Find(resps, fmt.Sprintf("g%d", i))
		if accErr == nil && !ok {
			accErr = &bmio.CliError{Msg: "no ActionProposal/get response", Code: bmio.ExitFail}
		}
		var raw json.RawMessage
		if accErr == nil {
			raw, accErr = g.Result("ActionProposal/get")
		}
		if accErr != nil {
			// ONE account's refusal must not take the queue down — a revoked
			// grant would otherwise hide every other agent's work. Reported on
			// stderr (chrome), not swallowed: silence here is the original bug.
			refused++
			s.Note("(" + acc.Name + ": " + accErr.Error() + ")")
			continue
		}
		var got struct {
			List []json.RawMessage `json:"list"`
		}
		if err := json.Unmarshal(raw, &got); err != nil {
			return die(s, err)
		}
		for _, rp := range got.List {
			p, ok := proposal.Parse(rp)
			if !ok {
				continue
			}
			if p.AccountID == "" { // pre-T7 server: stamp what we asked for
				p.AccountID = acc.AccountID
			}
			proposals = append(proposals, p)
		}
	}
	if refused == len(accounts) && refused > 0 {
		return die(s, &bmio.CliError{Msg: "every account refused the approvals queue", Code: bmio.ExitFail})
	}
	// `--agent` is filtered CLIENT-SIDE, and deliberately so: ActionProposal/query
	// refuses every filter key but `status` (actionProposal.ts:166 —
	// unsupportedFilter), so asking the server would be a hard error, not a
	// narrower query. This is the filter `bullmoose agents show <name>` points at,
	// so the pointer names a flag that exists (s10 T4).
	if a.Agent != "" {
		kept := proposals[:0]
		for _, p := range proposals {
			if p.Agent == a.Agent {
				kept = append(kept, p)
			}
		}
		proposals = kept
	}
	proposals = proposal.OrderQueue(proposals)

	if a.IDs { // §1.8 — the xargs shape outranks everything
		for _, p := range proposals {
			s.Out(p.ID)
		}
		return 0
	}
	if a.JSON { // §1.3 — one raw proposal per line, exactly as the server served it
		for _, p := range proposals {
			s.Out(compactLine(p.Raw))
		}
		return 0
	}
	if len(proposals) == 0 {
		label := "pending"
		if a.Status != "" {
			label = a.Status
		}
		if a.Agent != "" {
			label += " " + a.Agent
		}
		s.Note("(no " + label + " proposals)") // chrome → stderr, so `| wc -l` is 0
		return 0
	}
	// Header + legend are chrome (stderr); rows are data (stdout, §1.1).
	s.Note("clocks: WAITED grows (sat on you) · exp/hold SHRINK — exp is the decision deadline, hold is the tier-2 retraction window (nothing sent)")
	// The needsInfo legend is printed only when such a row is on screen: it
	// explains an ABSENCE (no clock at all), which is only confusing if it is
	// there to be seen.
	for _, p := range proposals {
		if p.Status == "info-requested" {
			s.Note("info-requested: " + proposal.WaitingOnAgentNote + " — no deadline is shown because none is running")
			break
		}
	}
	// The [ro] legend, on the same "explain an absence" rule: it appears only
	// when a watch-only account has a row on screen (s10 T7).
	labels := accountLabels(accounts)
	for _, p := range proposals {
		if strings.HasPrefix(labels[p.AccountID], roMark) {
			s.Note(roMark + " accounts are visible to you but NOT decidable — " +
				"the grant that shares them carries read, not the deciding scope")
			break
		}
	}
	s.Note(apHeader())
	now := time.Now().UnixMilli()
	for _, p := range proposals {
		s.Out(renderRow(p, labels[p.AccountID], now))
	}
	return 0
}

// roMark flags a watch-only account in the ACCOUNT column. Short on purpose —
// it rides inside a fixed-width column — and always explained by a legend when
// it is on screen. It is never truncated away: `truncAccount` elides the
// account NAME instead, because the mark is the honesty signal.
const roMark = "[ro]"

// accountWidth is the ACCOUNT column. Wide enough for an ordinary
// localpart@domain, and the mark survives whatever is left.
const accountWidth = 22

// accountLabels is accountId → what the ACCOUNT column prints: the account's
// name, prefixed when the queue may only WATCH it. Telling Emily's ask from
// Allen's is the point of a merged queue, and the binding name alone does not
// say which account it ran on.
func accountLabels(accounts []jmap.AgentAccount) map[string]string {
	out := make(map[string]string, len(accounts))
	for _, a := range accounts {
		if a.MayDecide {
			out[a.AccountID] = a.Name
			continue
		}
		out[a.AccountID] = roMark + " " + a.Name
	}
	return out
}

// apShow runs ActionProposal/get for one id and prints the whole proposal:
// rationale, evidence, payload, subject, both clocks (each only when it applies),
// any decision, and the retained edit diff. `--json` emits the raw proposal.
func apShow(s *bmio.Streams, a approvalsArgs) int {
	id := positionalAt(a, 2)
	if id == "" {
		return die(s, bmio.Usage("bullmoose approvals show <id> [--json]"))
	}
	db, client, accounts, err := apConn(a)
	if err != nil {
		return die(s, err)
	}
	defer db.Close()

	// The id is looked UP across the queue's reach — a human reading their
	// agent's proposal should not have to know which account it lives on.
	acc, p, raw, err := apLocate(client, accounts, id)
	if err != nil {
		return die(s, err)
	}
	if a.JSON {
		s.Out(compactLine(raw))
		return 0
	}
	s.Note("account:   " + accountLabels(accounts)[acc.AccountID])
	renderShow(s, p)
	return 0
}

// apApprove writes status=approved. It NEVER assumes the outcome: the server
// decides (tier-1 applies, tier-2 holds, tier-3 needs the send capability), and
// the result is re-read and reported honestly.
func apApprove(s *bmio.Streams, a approvalsArgs) int {
	id := positionalAt(a, 2)
	if id == "" {
		return die(s, bmio.Usage("bullmoose approvals approve <id> [--note t]"))
	}
	db, client, accounts, err := apConn(a)
	if err != nil {
		return die(s, err)
	}
	defer db.Close()

	acc, _, _, err := apLocate(client, accounts, id)
	if err != nil {
		return die(s, err)
	}
	if err := apDecidable(acc, "approve"); err != nil {
		return die(s, err)
	}

	patch := map[string]any{"status": "approved"}
	if a.Note != "" {
		patch["decision"] = map[string]any{"note": a.Note}
	}
	return decideAndReport(s, client, acc.AccountID, "approve", id, patch, false, a)
}

// apDecline writes status=rejected plus the no-thanks signal (arch.md §3).
func apDecline(s *bmio.Streams, a approvalsArgs) int {
	id := positionalAt(a, 2)
	if id == "" {
		return die(s, bmio.Usage("bullmoose approvals decline <id> [--reason "+
			strings.ReplaceAll(rejectReasonList, ", ", "|")+"] [--note t]"))
	}
	// needsInfo reached for as a REASON is the taxonomy's one forbidden move: it
	// is an action, and letting it through as a reason would write it into a
	// rejection record — the exact thing a learning pipeline must never read as
	// negative feedback. Refused here, before any round trip, with the verb that
	// does what the human meant.
	if isNeedsInfoReason(a.Reason) {
		return die(s, bmio.Usage(fmt.Sprintf(
			"needsInfo is not a reject reason — it is its own verb (decline-taxonomy.md):\n"+
				"    bullmoose approvals %s %s --question \"why do you need this?\"\n"+
				"%s\n"+
				"Reject reasons are: %s.",
			proposal.NeedsInfoVerb, id, proposal.NeedsInfoHint, rejectReasonList)))
	}
	if a.Reason != "" && !rejectReasons[a.Reason] {
		return die(s, bmio.Usage("--reason must be one of: "+rejectReasonList))
	}
	db, client, accounts, err := apConn(a)
	if err != nil {
		return die(s, err)
	}
	defer db.Close()

	acc, _, _, err := apLocate(client, accounts, id)
	if err != nil {
		return die(s, err)
	}
	if err := apDecidable(acc, "decline"); err != nil {
		return die(s, err)
	}

	decision := map[string]any{}
	if a.Reason != "" {
		decision["reason"] = a.Reason
	}
	if a.Note != "" {
		decision["note"] = a.Note
	}
	patch := map[string]any{"status": "rejected"}
	if len(decision) > 0 {
		patch["decision"] = decision
	}
	return decideAndReport(s, client, acc.AccountID, "decline", id, patch, false, a)
}

// isNeedsInfoReason recognises the taxonomy's action being reached for as a
// reject reason, in the spellings a human would actually type. Recognising the
// near-misses is the point: the refusal only teaches if it fires.
func isNeedsInfoReason(reason string) bool {
	switch strings.ToLower(strings.TrimSpace(reason)) {
	case "needsinfo", "needs-info", "needs_info", "needinfo", "info-requested":
		return true
	}
	return false
}

// apNeedsInfo is the THIRD verb (s10 T3, decline-taxonomy.md): "I'm not ardently
// opposed — help me understand why you need this."
//
// It writes {status: "info-requested", question} and NOTHING else. No decision
// rides along, because it is not a reject: the server refuses a `decision` on
// this verb, the row keeps `decision_json` NULL, and a learning pipeline can
// therefore never mistake the round for negative feedback. The question is
// required — an empty one is "a decline in disguise" — and is refused HERE, so a
// blank ask costs a keystroke rather than a round trip.
func apNeedsInfo(s *bmio.Streams, a approvalsArgs) int {
	id := positionalAt(a, 2)
	if id == "" {
		return die(s, bmio.Usage(needsInfoUsage("<id>")))
	}
	// A reason or a note would make this look like a decline, and it is not one.
	// Silently dropping them would be worse than refusing: the human would think
	// they had recorded something.
	if a.Reason != "" || a.Note != "" {
		return die(s, bmio.Usage(fmt.Sprintf(
			"needs-info takes only --question: it is an ACTION, not a decline, so there is no "+
				"--reason and no --note to record (decline-taxonomy.md).\n"+
				"To reject instead: bullmoose approvals decline %s --reason <%s>\n%s",
			id, strings.ReplaceAll(rejectReasonList, ", ", "|"), needsInfoUsage(id))))
	}
	if problem := proposal.QuestionProblem(a.Question); problem != "" {
		return die(s, bmio.Usage(problem+"\n"+needsInfoUsage(id)))
	}
	db, client, accounts, err := apConn(a)
	if err != nil {
		return die(s, err)
	}
	defer db.Close()

	acc, _, _, err := apLocate(client, accounts, id)
	if err != nil {
		return die(s, err)
	}
	if err := apDecidable(acc, proposal.NeedsInfoVerb); err != nil {
		return die(s, err)
	}

	// The whole patch. The server trims the question too; sending it trimmed
	// keeps what the CLI displays and what the row stores the same bytes.
	patch := map[string]any{
		"status":   "info-requested",
		"question": strings.TrimSpace(a.Question),
	}
	return decideAndReport(s, client, acc.AccountID, proposal.NeedsInfoVerb, id, patch, false, a)
}

func needsInfoUsage(id string) string {
	if id == "" {
		id = "<id>"
	}
	return fmt.Sprintf("usage: bullmoose approvals %s %s --question \"<text>\"",
		proposal.NeedsInfoVerb, id)
}

// apEdit is the load-bearing verb: amend a reply-draft payload and approve the
// amended thing. The edit lands in editedPayload (the server COALESCEs it beside
// the retained payload); a no-op edit sends no editedPayload, so "approved clean"
// is never faked into "approved after edit".
func apEdit(s *bmio.Streams, a approvalsArgs) int {
	id := positionalAt(a, 2)
	if id == "" {
		return die(s, bmio.Usage("bullmoose approvals edit <id> [--body t|--file p] [--subject s] [--note t]"))
	}
	db, client, accounts, err := apConn(a)
	if err != nil {
		return die(s, err)
	}
	defer db.Close()

	acc, p, _, err := apLocate(client, accounts, id)
	if err != nil {
		return die(s, err)
	}
	if err := apDecidable(acc, "edit"); err != nil {
		return die(s, err)
	}
	if p.Status != "pending" {
		return die(s, &bmio.CliError{
			Msg:  fmt.Sprintf("proposal %s is %s, not pending — only a pending proposal can be edited", id, p.Status),
			Code: bmio.ExitConflict,
		})
	}
	form, editable := proposal.EditorFor(p.Kind, p.Payload)
	if !editable {
		return die(s, &bmio.CliError{
			Msg:  fmt.Sprintf("a %s proposal is not editable — approve or decline it as asked (arch.md §1)", p.Kind),
			Code: bmio.ExitUsage,
		})
	}

	body, err := readEditBody(a)
	if err != nil {
		return die(s, err)
	}
	if form.Shape == "reply" {
		form.Text = body // the reply body is what a human rewrites
		if a.Subject != "" {
			form.Subject = a.Subject
		}
	} else {
		form.JSON = body // a whole-payload JSON edit for non-reply kinds
	}

	edited, problem := proposal.ApplyEdit(p.Payload, form)
	if problem != "" {
		return die(s, &bmio.CliError{Msg: problem, Code: bmio.ExitUsage})
	}

	patch := map[string]any{"status": "approved"}
	didEdit := edited != nil
	if didEdit {
		// editedPayload ONLY — payload is left untouched; the server coalesces so
		// the agent's original survives as the diff (actionProposal.ts:222-243).
		patch["editedPayload"] = edited
	} else {
		s.Note("no changes — approving clean (no editedPayload sent)")
	}
	if a.Note != "" {
		patch["decision"] = map[string]any{"note": a.Note}
	}
	return decideAndReport(s, client, acc.AccountID, "approve", id, patch, didEdit, a)
}

// ---- decision plumbing ----------------------------------------------------

// setErr is one per-object SetError from notUpdated (RFC 8620 §5.3).
type setErr struct {
	Type        string   `json:"type"`
	Description string   `json:"description"`
	Properties  []string `json:"properties"`
}

// setResult is the slice of ActionProposal/set we read: whether the update landed
// (updated) or was refused per-object (notUpdated). A method-level refusal
// (stateMismatch, base-gate forbidden) is not here — it arrives as an error from
// client.One.
type setResult struct {
	Updated    map[string]json.RawMessage `json:"updated"`
	NotUpdated map[string]setErr          `json:"notUpdated"`
}

// decideAndReport writes the decision, then RE-READS the row so the outcome is the
// server's authoritative status, not a guess. This is what keeps tier-2/tier-3
// honesty: the CLI never claims "sent" — it reports what the server did.
func decideAndReport(
	s *bmio.Streams, client *jmap.Client, accountID, verb, id string,
	patch map[string]any, edited bool, a approvalsArgs,
) int {
	args := map[string]any{"accountId": accountID, "update": map[string]any{id: patch}}
	if a.IfState != "" {
		args["ifInState"] = a.IfState // optimistic concurrency (→ stateMismatch, exit 5)
	}
	raw, err := client.One(context.Background(), "ActionProposal/set", args, jmap.AgentUsing)
	if err != nil {
		return die(s, err) // method-level refusal, exit code from its type
	}
	var sr setResult
	if err := json.Unmarshal(raw, &sr); err != nil {
		return die(s, err)
	}
	if _, ok := sr.Updated[id]; !ok {
		// Per-object refusal. The tier-3 capability wall lands HERE for an
		// insufficient token: surface the server's sentence verbatim, with the
		// exit code its type maps to (forbidden → 4) rather than a generic 1.
		e := sr.NotUpdated[id]
		msg := verb + " " + id + " refused: " + e.Type
		if e.Description != "" {
			msg += " — " + e.Description
		}
		return die(s, &bmio.ServerError{Msg: msg, JMAPType: e.Type})
	}

	p, _, err := fetchProposal(client, accountID, id)
	if err != nil {
		return die(s, err)
	}
	return reportOutcome(s, verb, p, edited, a.JSON)
}

// outcomeJSON is the --json shape for a decision. `held` and `egressed` are read
// off the re-read row, so they cannot over-claim. `question` is present only
// while a needsInfo round is open (the server NULLs it when the agent answers),
// so it is omitempty rather than a null every other verb has to carry.
type outcomeJSON struct {
	ID       string `json:"id"`
	Verb     string `json:"verb"`
	Status   string `json:"status"`
	Tier     int    `json:"tier"`
	Kind     string `json:"kind"`
	Edited   bool   `json:"edited"`
	Held     bool   `json:"held"`
	Egressed bool   `json:"egressed"`
	Question string `json:"question,omitempty"`
}

// reportOutcome renders the decision honestly from the re-read row.
func reportOutcome(s *bmio.Streams, verb string, p *proposal.Proposal, edited, jsonOut bool) int {
	held := p.Status == "held"
	egressed := p.Status == "approved" && p.Tier == 3 && proposal.IsEgressKind(p.Kind)

	if jsonOut {
		if err := s.EmitJSON(outcomeJSON{
			ID: p.ID, Verb: verb, Status: p.Status, Tier: p.Tier, Kind: p.Kind,
			Edited: edited, Held: held, Egressed: egressed, Question: p.Question,
		}); err != nil {
			return die(s, err)
		}
		return 0
	}

	editMark := ""
	if edited {
		editMark = " (after edit)"
	}
	switch {
	case verb == "decline":
		s.Out(p.ID + " declined" + declineSuffix(p))
	case verb == proposal.NeedsInfoVerb:
		// Never a verdict, and never a clock: the row left the human's queue for
		// the agent's court, and the deadline is banked, not running.
		if p.Status != "info-requested" {
			s.Out(fmt.Sprintf("%s is %s after the question — nothing was rejected.", p.ID, p.Status))
			break
		}
		s.Out(p.ID + " question sent to " + p.Agent + " — " + proposal.WaitingOnAgentNote +
			". Not a decline: no rejection was recorded.")
		if q := p.OpenQuestion(); q != nil {
			s.Note("you asked: " + q.Question)
		}
	case held: // tier-2 → the hold tray; nothing egressed
		s.Out(p.ID + " HELD in the retraction tray" + editMark +
			" — nothing was sent. Committing out of the hold tray is not built yet (s03.D T2).")
		c := p.Clocks(time.Now().UnixMilli())
		if c.HoldRemainingMs != nil {
			s.Note(proposal.HoldLabel(c.HoldRemainingMs))
		}
	case egressed: // tier-3, human-approved, reply-shaped → the irreversible send happened
		s.Out(p.ID + " approved and RELAYED" + editMark + " (tier 3, irreversible egress).")
	case p.Tier == 1:
		s.Out(p.ID + " approved and applied" + editMark + " (tier 1, reversible; undo handle kept).")
	default:
		s.Out(fmt.Sprintf("%s approved%s (tier %d).", p.ID, editMark, p.Tier))
	}
	return 0
}

// declineSuffix echoes back the reason that was recorded. Through ReasonLabel,
// so a row decided under an older taxonomy reads as itself and marked retired
// rather than as a reason nobody chose (proposal/reason.go).
func declineSuffix(p *proposal.Proposal) string {
	if p.Decision == nil || p.Decision.Reason == "" {
		return ""
	}
	return " (reason: " + proposal.ReasonLabel(p.Decision.Reason) + ")"
}

// ---- fetch ----------------------------------------------------------------

// fetchProposal reads one proposal, returning the parsed view and its raw bytes
// (for --json). An absent id is a NotFound (exit 3).
func fetchProposal(client *jmap.Client, accountID, id string) (*proposal.Proposal, json.RawMessage, error) {
	raw, err := client.One(context.Background(), "ActionProposal/get",
		map[string]any{"accountId": accountID, "ids": []string{id}}, jmap.AgentUsing)
	if err != nil {
		return nil, nil, err
	}
	var got struct {
		List []json.RawMessage `json:"list"`
	}
	if err := json.Unmarshal(raw, &got); err != nil {
		return nil, nil, err
	}
	if len(got.List) == 0 {
		return nil, nil, bmio.NotFound("no proposal " + id)
	}
	p, ok := proposal.Parse(got.List[0])
	if !ok {
		return nil, nil, &bmio.CliError{Msg: "unparseable proposal " + id, Code: bmio.ExitFail}
	}
	return p, got.List[0], nil
}

// ---- connection -----------------------------------------------------------

// apConn opens the mirror (for base+token+accounts config only — ActionProposal
// is not in the mirror), builds the live JMAP client, and resolves the accounts
// this decision surface acts over. The caller closes db.
//
// PLURAL since s10 T7. A human's agents are separate PRINCIPALS on separate
// ACCOUNTS by design, so a queue that read one account could never show them
// their agents' work — `/approvals` said "Nothing is waiting on you" while a
// real pending proposal sat on the agent's account. The reach comes from the
// SESSION (every account the server resolves for this token, owned and
// grant-reached), not from the mirror, whose account list is what this login
// synced mail for.
func apConn(a approvalsArgs) (*sql.DB, *jmap.Client, []jmap.AgentAccount, error) {
	db, err := store.Open(store.DBPath(a.DB))
	if err != nil {
		return nil, nil, nil, err
	}
	settings, err := store.RequireSettings(db)
	if err != nil {
		_ = db.Close()
		return nil, nil, nil, err
	}
	client := jmap.NewClient(settings.Base, settings.Token)
	accounts, err := apAccounts(client, settings, a.Account)
	if err != nil {
		_ = db.Close()
		return nil, nil, nil, err
	}
	return db, client, accounts, nil
}

// apAccounts is the queue's reach: every session account advertising the agent
// capability, narrowed by --account when one is given.
//
// Two fallbacks, both deliberate:
//   - a session that cannot be fetched, or that lists no agent-capable account,
//     falls back to the mirror's resolved account — the pre-T7 behaviour, which
//     keeps `approvals` working against an older server and against the
//     contract suite's stub rather than failing with an empty queue;
//   - --account keeps cli/009 semantics (`account.One`): no selector → all;
//     ambiguous → usage error; no match → not found. The mirror's addresses are
//     folded in so `--account @bullmoose.cc` still matches by address, while an
//     agent account the mirror has never seen is still selectable by name or id.
func apAccounts(
	client *jmap.Client, settings *store.Settings, selector string,
) ([]jmap.AgentAccount, error) {
	session, err := client.Session(context.Background())
	var reachable []jmap.AgentAccount
	if err == nil {
		reachable = session.AgentAccounts()
	}
	if len(reachable) == 0 {
		acc, err := resolveAccount(settings, selector)
		if err != nil {
			return nil, err
		}
		// Unreported authority is not "no authority" — the server is the gate.
		return []jmap.AgentAccount{{
			AccountID: acc.AccountID, Name: account.Label(acc),
			IsPersonal: true, MayDecide: true, MayApproveIrreversible: true,
		}}, nil
	}
	if selector == "" {
		return reachable, nil
	}

	addresses := map[string]string{}
	for _, a := range settings.Accounts {
		addresses[a.AccountID] = a.Address
	}
	selectable := make([]account.Account, 0, len(reachable))
	for _, r := range reachable {
		selectable = append(selectable, account.Account{
			AccountID: r.AccountID, Address: addresses[r.AccountID], Name: r.Name,
		})
	}
	picked, err := resolveAccount(&store.Settings{Accounts: selectable, AccountID: settings.AccountID}, selector)
	if err != nil {
		return nil, err
	}
	for _, r := range reachable {
		if r.AccountID == picked.AccountID {
			return []jmap.AgentAccount{r}, nil
		}
	}
	return nil, bmio.NotFound("no account matches \"" + selector + "\"")
}

// apLocate finds the ONE account a proposal id lives on, across the queue's
// reach. With a single account it is free; across several it is one batched
// `ActionProposal/get` per account in ONE round trip, so "which account is this
// id on" never costs the human a flag they should not have to know.
func apLocate(
	client *jmap.Client, accounts []jmap.AgentAccount, id string,
) (jmap.AgentAccount, *proposal.Proposal, json.RawMessage, error) {
	if len(accounts) == 1 {
		p, raw, err := fetchProposal(client, accounts[0].AccountID, id)
		return accounts[0], p, raw, err
	}
	calls := make([]jmap.Invocation, 0, len(accounts))
	for i, acc := range accounts {
		calls = append(calls, jmap.Invocation{
			Name:   "ActionProposal/get",
			Args:   map[string]any{"accountId": acc.AccountID, "ids": []string{id}},
			CallID: fmt.Sprintf("g%d", i),
		})
	}
	resps, err := client.Call(context.Background(), jmap.AgentUsing, calls)
	if err != nil {
		return jmap.AgentAccount{}, nil, nil, err
	}
	for i, acc := range accounts {
		r, ok := jmap.Find(resps, fmt.Sprintf("g%d", i))
		if !ok {
			continue
		}
		raw, err := r.Result("ActionProposal/get")
		if err != nil {
			// One account refusing (a revoked grant mid-flight) must not hide the
			// id on another — keep looking, and report not-found if none has it.
			continue
		}
		var got struct {
			List []json.RawMessage `json:"list"`
		}
		if err := json.Unmarshal(raw, &got); err != nil || len(got.List) == 0 {
			continue
		}
		if p, ok := proposal.Parse(got.List[0]); ok {
			return acc, p, got.List[0], nil
		}
	}
	return jmap.AgentAccount{}, nil, nil, bmio.NotFound("no proposal " + id)
}

// apDecidable refuses locally what the server would refuse remotely — with the
// reason the server cannot know how to phrase: the account is reachable through
// a grant that does not carry the deciding scope. Not a second policy layer:
// the same `authorizeAccount` decision computed it, and it travels in the
// session (services/jmap/src/session.ts).
func apDecidable(acc jmap.AgentAccount, verb string) error {
	if acc.MayDecide {
		return nil
	}
	return &bmio.ServerError{
		Msg: fmt.Sprintf(
			"cannot %s on %s: this account is watch-only for you — the grant that shares it "+
				"carries read, not the deciding scope. Ask its owner to widen the grant.",
			verb, acc.Name),
		JMAPType: "forbidden",
	}
}

// resolveAccount picks the single account a command acts on — account.One, the
// cli/009 rule (db.ts:221 pickAccount): no selector → the default; an ambiguous
// selector is a usage error (exit 2); no match is not found (exit 3).
//
// Shared by `approvals`, `read` and `send`, which is the whole point of cli/009:
// one resolver, so a selector means the same thing whichever command is typed.
// The exit-code mapping lives here rather than in the account package so the
// sentence stays byte-identical to the TypeScript's, which `read`/`send` are held
// to and `approvals` inherits for free.
func resolveAccount(settings *store.Settings, selector string) (account.Account, error) {
	acc, err := account.One(settings.Accounts, settings.AccountID, selector)
	if err == nil {
		return acc, nil
	}
	if errors.Is(err, account.ErrAmbiguous) {
		// bmio.Usage adds the `usage: ` prefix io.ts:409 adds, which is how
		// db.ts:225 renders this refusal.
		return account.Account{}, bmio.Usage(err.Error())
	}
	return account.Account{}, &bmio.CliError{Msg: err.Error(), Code: bmio.ExitNotFound}
}

// readEditBody mirrors send's readBody (main.ts:754) over readInput (io.ts:367):
// an explicit --body beats implicit stdin; then --file (path, or "-" for explicit
// stdin); then implicit stdin when it is not a TTY; else a usage error.
func readEditBody(a approvalsArgs) (string, error) {
	if a.HasBody {
		return a.Body, nil
	}
	if a.File == "-" {
		return readAllStdin()
	}
	if a.File != "" {
		b, err := os.ReadFile(a.File)
		if err != nil {
			return "", &bmio.CliError{Msg: "cannot read --file " + a.File + ": " + err.Error(), Code: bmio.ExitFail}
		}
		return string(b), nil
	}
	if !term.IsTerminal(int(os.Stdin.Fd())) {
		b, err := readAllStdin()
		if err != nil {
			return "", err
		}
		if b != "" {
			return b, nil
		}
	}
	return "", bmio.Usage(`no body: pipe it on stdin, pass --file <path> (or -), or pass --body <text>`)
}

func readAllStdin() (string, error) {
	b, err := io.ReadAll(os.Stdin)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// ---- rendering ------------------------------------------------------------

// The STATUS column is 14 wide because `info-requested` is 14 characters: the
// server's own status token is what the row prints (it is also what `--status`
// filters on), so the column has to hold the longest one rather than smear the
// table.
func apHeader() string {
	return fmt.Sprintf("%-14s  %-16s  %-22s  %-13s  %-4s  %-13s  %-16s  %-24s  %s",
		"STATUS", "AGENT", "ACCOUNT", "KIND", "TIER", "WAITED", "CLOCK", "ID", "RATIONALE")
}

// truncAccount fits an account label into the column WITHOUT ever losing the
// watch-only mark: a row that quietly dropped its "[ro]" would offer the human
// a verb the server will refuse, which is the failure this column exists to
// prevent. The account name is elided instead.
func truncAccount(label string) string {
	if !strings.HasPrefix(label, roMark+" ") {
		return trunc(label, accountWidth)
	}
	return roMark + " " + trunc(strings.TrimPrefix(label, roMark+" "), accountWidth-len(roMark)-1)
}

// renderRow prints one queue row. `account` is the label from `accountLabels` —
// empty only when the row came off an account the session no longer lists.
func renderRow(p *proposal.Proposal, account string, now int64) string {
	c := p.Clocks(now)
	clock := "—"
	switch p.Status {
	case "pending":
		clock = compactExpiry(c)
	case "held":
		clock = compactHold(c)
	case "info-requested":
		// NO deadline, in either direction. The server nulled `expiresAt` and
		// banked the remainder, so there is nothing counting down — and printing
		// "exp:OVERDUE" for a paused clock would be a lie about a row nobody is
		// late on. What the column says instead is WHO the ball is with.
		clock = "waiting:agent"
	}
	// The last column is the row's one line. For every kind it is the rationale
	// (the agent's "why", first line only); for s11 T9's `budget-overrun` it is
	// the numbers-first summary, because the numbers ARE the why there and a
	// truncated prose sentence would bury them (proposal.RowSummary).
	if account == "" {
		account = p.AccountID
	}
	return fmt.Sprintf("%-14s  %-16s  %-22s  %-13s  T%-3d  %-13s  %-16s  %-24s  %s",
		p.Status, trunc(p.Agent, 16), truncAccount(account), trunc(p.Kind, 13), p.Tier,
		proposal.FormatDuration(c.WaitedMs), trunc(clock, 16),
		trunc(p.ID, 24), trunc(proposal.RowSummary(p), 60))
}

// compactExpiry / compactHold are the table's short forms of the two clocks. They
// stay LABELLED and DISTINCT so a pending deadline and a tier-2 hold window can
// never be read as the same thing; the full honesty wording is in `show`.
func compactExpiry(c proposal.RowClocks) string {
	if c.ExpiresInMs == nil {
		return "exp:none"
	}
	if *c.ExpiresInMs <= 0 {
		return "exp:OVERDUE"
	}
	return "exp:" + proposal.FormatDuration(*c.ExpiresInMs)
}

func compactHold(c proposal.RowClocks) string {
	if c.HoldRemainingMs == nil {
		return "hold:?"
	}
	if *c.HoldRemainingMs <= 0 {
		return "hold:lapsed"
	}
	return "hold:" + proposal.FormatDuration(*c.HoldRemainingMs)
}

func renderShow(s *bmio.Streams, p *proposal.Proposal) {
	c := p.Clocks(time.Now().UnixMilli())
	s.Out(fmt.Sprintf("%s  [%s]  tier %d  agent %s  kind %s", p.ID, p.Status, p.Tier, p.Agent, p.Kind))
	if p.Subject.Realm != "" || p.Subject.ObjectID != "" {
		s.Out("subject:   " + strings.TrimSpace(p.Subject.Realm+" "+p.Subject.ObjectID))
	}
	// s11 T9 — the numbers, above the prose. A `budget-overrun` is decided from
	// four figures (waiting, spent/ceiling, cost to clear, the bound being
	// asked for), so `show` states them on their own line before the rationale
	// that explains them. Every other kind is unchanged: no summary line, the
	// rationale leads.
	if proposal.IsBudgetOverrun(p.Kind) {
		b := proposal.ParseBudgetOverrun(p.Payload)
		s.Out("summary:   " + b.Summary(p.Subject.ObjectID))
		if b.PeriodKey != "" {
			s.Out("period:    " + b.PeriodKey + " — the overage applies to this period ONLY; " +
				"the binding's configured cap is not changed")
		}
	}
	s.Out("rationale: " + p.Rationale)
	if len(p.Evidence) > 0 {
		s.Out("evidence:")
		for _, e := range p.Evidence {
			line := "  - " + strings.TrimSpace(e.Realm+" "+e.ObjectID)
			if e.Note != "" {
				line += "  (" + e.Note + ")"
			}
			s.Out(line)
		}
	}
	renderDialogue(s, p)
	// The two clocks — each printed ONLY when it applies, never conflated.
	s.Out("waited:    " + proposal.WaitedLabel(p.Status, c))
	if c.ExpiresInMs != nil {
		s.Out("expires:   " + proposal.ExpiryLabel(c.ExpiresInMs))
	}
	if c.HoldRemainingMs != nil {
		s.Out("hold:      " + proposal.HoldLabel(c.HoldRemainingMs))
	}
	// A paused row says so in place of a clock. Not "no deadline" as an
	// afterthought and never "expired": the window is banked server-side and
	// resumes when the answer lands.
	if p.Status == "info-requested" {
		s.Out("waiting:   " + proposal.WaitingOnAgentNote)
	}
	s.Out("payload:   " + jsonCompact(p.Payload))
	if p.EditedPayload != nil {
		s.Out("edited:    " + jsonCompact(p.EditedPayload))
		if diffs := proposal.PayloadDiff(p.Payload, p.EditedPayload); len(diffs) > 0 {
			s.Out("edited before approval:")
			for _, d := range diffs {
				s.Out("  " + renderDiff(d))
			}
		}
	}
	if p.Decision != nil {
		line := "decision:  by " + p.Decision.By
		// History reads whatever it was recorded with — a retired reason is
		// printed as itself and marked, never migrated (proposal/reason.go).
		if p.Decision.Reason != "" {
			line += "  reason=" + proposal.ReasonLabel(p.Decision.Reason)
		}
		if p.Decision.Note != "" {
			line += "  note=" + p.Decision.Note
		}
		s.Out(line)
	}
}

// renderDialogue prints the needsInfo Q&A (s10 T3) in the order it happened,
// each line attributed: the human who asked, the agent that answered. The
// dialogue travels with the proposal through pending, decided and history —
// a challenged-then-approved grant carrying its question and its answer is the
// strongest "why" the provenance chain can hold (decline-taxonomy.md).
func renderDialogue(s *bmio.Streams, p *proposal.Proposal) {
	if len(p.Amendments) == 0 {
		// Defensive: the server appends a round with every needsInfo, so an open
		// `question` with no dialogue should not happen — but printing the
		// question beats swallowing it.
		if p.Question != "" {
			s.Out("question:  " + jsonCompact(p.Question))
		}
		return
	}
	s.Out("dialogue:")
	for i, am := range p.Amendments {
		asker := am.AskedBy
		if asker == "" {
			asker = "someone"
		}
		s.Out(fmt.Sprintf("  %d. %s asked%s: %s", i+1, asker, atStamp(am.AskedAt), jsonCompact(am.Question)))
		if am.Answered() {
			answerer := p.Agent
			if answerer == "" {
				answerer = "the agent"
			}
			s.Out(fmt.Sprintf("     %s answered%s: %s", answerer, atStamp(am.AnsweredAt), am.AnswerText()))
			continue
		}
		owed := p.Agent
		if owed == "" {
			owed = "the agent"
		}
		s.Out("     (unanswered — still owed by " + owed + ")")
	}
}

// atStamp renders " (<iso>)" for a timestamp the server sent, and nothing at all
// for one it did not — an invented time on the record would be worse than none.
func atStamp(iso string) string {
	if iso == "" {
		return ""
	}
	return " (" + iso + ")"
}

func renderDiff(d proposal.FieldDiff) string {
	switch {
	case d.Added:
		return "+ " + d.Key + ": " + jsonCompact(d.After)
	case d.Removed:
		return "- " + d.Key + ": " + jsonCompact(d.Before)
	default:
		return "~ " + d.Key + ": " + jsonCompact(d.Before) + " -> " + jsonCompact(d.After)
	}
}

// ---- small helpers --------------------------------------------------------

// compactLine renders a raw JSON value on one line, preserving the server's exact
// bytes (json.Compact only strips insignificant whitespace, of which the wire has
// none) — the honest "raw proposal" for --json.
func compactLine(raw json.RawMessage) string {
	var buf bytes.Buffer
	if err := json.Compact(&buf, raw); err != nil {
		return string(raw)
	}
	return buf.String()
}

// jsonCompact marshals a value on one line with HTML escaping OFF, matching bmio
// and JSON.stringify (io.ts:233) so <, > and & are not mangled.
func jsonCompact(v any) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return ""
	}
	return strings.TrimRight(buf.String(), "\n")
}

func trunc(s string, w int) string {
	r := []rune(s)
	if len(r) <= w {
		return s
	}
	if w <= 1 {
		return string(r[:w])
	}
	return string(r[:w-1]) + "…"
}

func positionalAt(a approvalsArgs, n int) string {
	if n < len(a.Positionals) {
		return a.Positionals[n]
	}
	return ""
}

// ---- arg parsing ----------------------------------------------------------

// approvalsArgs is the flag view this command needs. Unlike the wave-1 `parse`
// (args.go), approvals owns its WHOLE grammar because it has no Node twin to
// delegate an unowned flag to — so this parser understands every flag the five
// verbs take.
type approvalsArgs struct {
	JSON, IDs                                              bool
	DB, Account, Status, Reason, Note, Body, File, Subject string
	// Question is the needsInfo ask (s10 T3). Required by that verb, refused on
	// every other one — it is not a note and not a reason.
	Question    string
	IfState     string
	Agent       string // list: narrow the queue to one agent (client-side)
	HasBody     bool   // --body present, even if ""
	Positionals []string
}

func parseApprovals(argv []string) approvalsArgs {
	var a approvalsArgs
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
			case "db":
				a.DB = value()
			case "account":
				a.Account = value()
			case "status":
				a.Status = value()
			case "agent":
				a.Agent = value()
			case "reason":
				a.Reason = value()
			case "note":
				a.Note = value()
			case "question":
				// Mirrored into delegate.valueFlags (and the TypeScript parseArgs
				// spec it is checked against) so the front door knows the next
				// token is this flag's value, not the command.
				a.Question = value()
			case "body":
				a.Body = value()
				a.HasBody = true
			case "file":
				a.File = value()
			case "subject":
				a.Subject = value()
			case "if-state":
				a.IfState = value()
			default:
				// Unknown flag — treat as valueless so it can never swallow the
				// following token (which might be the verb or the id). approvals has
				// no Node twin, so there is nothing to delegate an odd flag to.
			}
		default:
			a.Positionals = append(a.Positionals, arg)
		}
	}
	return a
}
