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
//     editedPayload at all.
//
// The verbs: list · show · approve · decline · edit.

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

const approvalsUsage = "bullmoose approvals <list|show|approve|decline|edit> [id] " +
	"[--status s] [--reason r] [--note t] [--body t|--file p] [--subject s] [--account sel] [--json|--ids]"

// rejectReasons mirrors REJECT_REASONS (actionProposal.ts:53). Checked
// client-side only to fail a typo fast with a usage code; the server remains the
// authority (a valid-but-unknown value would still be refused there).
var rejectReasons = map[string]bool{"wrongContent": true, "wrongAction": true, "notNow": true}

// runApprovals is the front door for the five verbs. It is registered
// Go-native-only (registry.go), so Dispatch routes here regardless of flags.
func runApprovals(s *bmio.Streams, argv []string) int {
	a := parseApprovals(argv)
	switch positionalAt(a, 1) {
	case "list":
		return apList(s, a)
	case "show":
		return apShow(s, a)
	case "approve":
		return apApprove(s, a)
	case "decline":
		return apDecline(s, a)
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
	db, client, acc, err := apConn(a)
	if err != nil {
		return die(s, err)
	}
	defer db.Close()

	queryArgs := map[string]any{"accountId": acc.AccountID}
	switch a.Status {
	case "": // default queue: pending only
		queryArgs["filter"] = map[string]any{"status": "pending"}
	case "all": // no filter — the server's default is everything, newest first
	default:
		queryArgs["filter"] = map[string]any{"status": a.Status}
	}

	resps, err := client.Call(context.Background(), jmap.AgentUsing, []jmap.Invocation{
		{Name: "ActionProposal/query", Args: queryArgs, CallID: "q0"},
		{Name: "ActionProposal/get", Args: map[string]any{
			"accountId": acc.AccountID,
			"#ids":      jmap.Ref("q0", "ActionProposal/query", "/ids"),
		}, CallID: "g0"},
	})
	if err != nil {
		return die(s, err)
	}
	// A query-side refusal (e.g. unsupportedFilter) must surface, not be masked
	// by a downstream invalidResultReference.
	if q, ok := jmap.Find(resps, "q0"); ok {
		if _, err := q.Result("ActionProposal/query"); err != nil {
			return die(s, err)
		}
	}
	g, ok := jmap.Find(resps, "g0")
	if !ok {
		return die(s, &bmio.CliError{Msg: "no ActionProposal/get response", Code: bmio.ExitFail})
	}
	raw, err := g.Result("ActionProposal/get")
	if err != nil {
		return die(s, err)
	}
	var got struct {
		List []json.RawMessage `json:"list"`
	}
	if err := json.Unmarshal(raw, &got); err != nil {
		return die(s, err)
	}

	proposals := make([]*proposal.Proposal, 0, len(got.List))
	for _, rp := range got.List {
		if p, ok := proposal.Parse(rp); ok {
			proposals = append(proposals, p)
		}
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
		s.Note("(no " + label + " proposals)") // chrome → stderr, so `| wc -l` is 0
		return 0
	}
	// Header + legend are chrome (stderr); rows are data (stdout, §1.1).
	s.Note("clocks: WAITED grows (sat on you) · exp/hold SHRINK — exp is the decision deadline, hold is the tier-2 retraction window (nothing sent)")
	s.Note(apHeader())
	now := time.Now().UnixMilli()
	for _, p := range proposals {
		s.Out(renderRow(p, now))
	}
	return 0
}

// apShow runs ActionProposal/get for one id and prints the whole proposal:
// rationale, evidence, payload, subject, both clocks (each only when it applies),
// any decision, and the retained edit diff. `--json` emits the raw proposal.
func apShow(s *bmio.Streams, a approvalsArgs) int {
	id := positionalAt(a, 2)
	if id == "" {
		return die(s, bmio.Usage("bullmoose approvals show <id> [--json]"))
	}
	db, client, acc, err := apConn(a)
	if err != nil {
		return die(s, err)
	}
	defer db.Close()

	p, raw, err := fetchProposal(client, acc.AccountID, id)
	if err != nil {
		return die(s, err)
	}
	if a.JSON {
		s.Out(compactLine(raw))
		return 0
	}
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
	db, client, acc, err := apConn(a)
	if err != nil {
		return die(s, err)
	}
	defer db.Close()

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
		return die(s, bmio.Usage("bullmoose approvals decline <id> [--reason wrongContent|wrongAction|notNow] [--note t]"))
	}
	if a.Reason != "" && !rejectReasons[a.Reason] {
		return die(s, bmio.Usage("--reason must be one of: wrongContent, wrongAction, notNow"))
	}
	db, client, acc, err := apConn(a)
	if err != nil {
		return die(s, err)
	}
	defer db.Close()

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

// apEdit is the load-bearing verb: amend a reply-draft payload and approve the
// amended thing. The edit lands in editedPayload (the server COALESCEs it beside
// the retained payload); a no-op edit sends no editedPayload, so "approved clean"
// is never faked into "approved after edit".
func apEdit(s *bmio.Streams, a approvalsArgs) int {
	id := positionalAt(a, 2)
	if id == "" {
		return die(s, bmio.Usage("bullmoose approvals edit <id> [--body t|--file p] [--subject s] [--note t]"))
	}
	db, client, acc, err := apConn(a)
	if err != nil {
		return die(s, err)
	}
	defer db.Close()

	p, _, err := fetchProposal(client, acc.AccountID, id)
	if err != nil {
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
// off the re-read row, so they cannot over-claim.
type outcomeJSON struct {
	ID       string `json:"id"`
	Verb     string `json:"verb"`
	Status   string `json:"status"`
	Tier     int    `json:"tier"`
	Kind     string `json:"kind"`
	Edited   bool   `json:"edited"`
	Held     bool   `json:"held"`
	Egressed bool   `json:"egressed"`
}

// reportOutcome renders the decision honestly from the re-read row.
func reportOutcome(s *bmio.Streams, verb string, p *proposal.Proposal, edited, jsonOut bool) int {
	held := p.Status == "held"
	egressed := p.Status == "approved" && p.Tier == 3 && proposal.IsEgressKind(p.Kind)

	if jsonOut {
		if err := s.EmitJSON(outcomeJSON{
			ID: p.ID, Verb: verb, Status: p.Status, Tier: p.Tier, Kind: p.Kind,
			Edited: edited, Held: held, Egressed: egressed,
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

func declineSuffix(p *proposal.Proposal) string {
	if p.Decision == nil || p.Decision.Reason == "" {
		return ""
	}
	return " (reason: " + p.Decision.Reason + ")"
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
// is not in the mirror), builds the live JMAP client, and resolves the ONE
// account this decision surface acts on. The caller closes db.
func apConn(a approvalsArgs) (*sql.DB, *jmap.Client, account.Account, error) {
	db, err := store.Open(store.DBPath(a.DB))
	if err != nil {
		return nil, nil, account.Account{}, err
	}
	settings, err := store.RequireSettings(db)
	if err != nil {
		_ = db.Close()
		return nil, nil, account.Account{}, err
	}
	acc, err := resolveAccount(settings, a.Account)
	if err != nil {
		_ = db.Close()
		return nil, nil, account.Account{}, err
	}
	return db, jmap.NewClient(settings.Base, settings.Token), acc, nil
}

// resolveAccount picks the single account approvals acts on: the default when no
// selector is given (db.ts:222), else account.Pick — the cli/009 single-account
// rule, where an ambiguous selector is a usage error (exit 2) and no match is not
// found (exit 3).
func resolveAccount(settings *store.Settings, selector string) (account.Account, error) {
	if selector == "" || selector == "default" {
		for _, x := range settings.Accounts {
			if x.AccountID == settings.AccountID {
				return x, nil
			}
		}
		return account.Account{AccountID: settings.AccountID}, nil
	}
	acc, err := account.Pick(settings.Accounts, selector)
	if err != nil {
		if errors.Is(err, account.ErrAmbiguous) {
			return account.Account{}, &bmio.CliError{Msg: err.Error(), Code: bmio.ExitUsage}
		}
		return account.Account{}, &bmio.CliError{Msg: err.Error(), Code: bmio.ExitNotFound}
	}
	return acc, nil
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

func apHeader() string {
	return fmt.Sprintf("%-8s  %-16s  %-13s  %-4s  %-13s  %-16s  %-24s  %s",
		"STATUS", "AGENT", "KIND", "TIER", "WAITED", "CLOCK", "ID", "RATIONALE")
}

func renderRow(p *proposal.Proposal, now int64) string {
	c := p.Clocks(now)
	clock := "—"
	switch p.Status {
	case "pending":
		clock = compactExpiry(c)
	case "held":
		clock = compactHold(c)
	}
	return fmt.Sprintf("%-8s  %-16s  %-13s  T%-3d  %-13s  %-16s  %-24s  %s",
		p.Status, trunc(p.Agent, 16), trunc(p.Kind, 13), p.Tier,
		proposal.FormatDuration(c.WaitedMs), trunc(clock, 16),
		trunc(p.ID, 24), trunc(firstLine(p.Rationale), 60))
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
	// The two clocks — each printed ONLY when it applies, never conflated.
	s.Out("waited:    " + proposal.WaitedLabel(p.Status, c))
	if c.ExpiresInMs != nil {
		s.Out("expires:   " + proposal.ExpiryLabel(c.ExpiresInMs))
	}
	if c.HoldRemainingMs != nil {
		s.Out("hold:      " + proposal.HoldLabel(c.HoldRemainingMs))
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
		if p.Decision.Reason != "" {
			line += "  reason=" + p.Decision.Reason
		}
		if p.Decision.Note != "" {
			line += "  note=" + p.Decision.Note
		}
		s.Out(line)
	}
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

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
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
	IfState                                                string
	HasBody                                                bool // --body present, even if ""
	Positionals                                            []string
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
			case "reason":
				a.Reason = value()
			case "note":
				a.Note = value()
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
