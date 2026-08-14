package cmd

// The email triage verbs (s08 T6 wave 2 "email read/triage"), a port of
// packages/cli/src/triage.ts — the unit sVOL 019 delivered:
//
//	flag    <id…> --add <kw> [--remove <kw>]     Email/set update  keywords/*
//	seen    <id…> [--unset]                       sugar over flag  keywords/$seen
//	move    <id…> --role <r> | --mailbox <box>    Email/set update  mailboxIds (replace)
//	label   <id…> --add <box> [--remove <box>]    Email/set update  mailboxIds (add/remove)
//	archive <id…>                                 sugar: move --role archive
//	junk    <id…>                                 sugar: move --role junk
//	trash   <id…>                                 sugar: move --role trash
//	rm      <id…> --force                         Email/set destroy  (HARD delete)
//	delete  <id…> --force                         alias for rm
//
// Every one has a TypeScript twin the contract suite drives, so byte-identity is
// the contract: the same stdout (the ids acted on, so verbs chain through xargs),
// the same stderr sentences, the same exit codes, and the same REFUSALS at the
// same points.
//
// Three disciplines the TypeScript turns on, each of which a fresh port loses by
// default:
//
//  1. **Per-verb scope, flat-set** (`.feedback/fromClaude/common/027`). Email/set
//     charges scopes from its arguments: a keywords-only patch is `annotate`, a
//     mailboxIds patch is `move`, a destroy is `delete`. hasScope is a flat set,
//     not the lattice the docs draw, so `move` does NOT imply `annotate`. Each
//     verb therefore builds a SINGLE-operation patch — `flag` never touches
//     mailboxIds, `move` never touches keywords — and a token scoped to exactly
//     that verb gets a clean exit 4 rather than a refusal of one bundled half.
//  2. **Reconcile the mirror after the write**, and only for the ids the server
//     confirmed. `search`/`log`/`mailboxes` read the local mirror, so a verb that
//     wrote over JMAP and returned would leave every second stage of a pipeline
//     describing the old world.
//  3. **Refuse before the round trip.** No ids, `rm` without --force, and a
//     `label --remove` that would empty a message's mailbox set all cost ZERO
//     requests. A refusal that had already written something is not a refusal.

import (
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"os"
	"strconv"
	"strings"

	"golang.org/x/term"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/jmap"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/mirror"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/store"
)

// seenKeyword is the RFC 8621 system keyword `seen` sugars over — triage.ts:74.
const seenKeyword = "$seen"

// updateVerbs is triage.ts:76 — the verbs that patch, as opposed to `rm`, which
// destroys.
var updateVerbs = map[string]bool{
	"flag": true, "seen": true, "move": true, "label": true,
	"archive": true, "junk": true, "trash": true,
}

// failure is one id the verb did not apply, with the reason the SERVER gave (or,
// for the empty-mailbox guard, the reason the CLI gave in the server's
// vocabulary).
type failure struct {
	id          string
	typ         string
	description string
}

// outcome is triage.ts:78 Outcome — what the verb did, reported as a whole so
// partial failure is honest: the successes are printed, the failures are named,
// and the exit code is non-zero.
type outcome struct {
	verb      string
	succeeded []string
	failed    []failure
	newState  string
}

// runTriage serves every verb in the table above; the verb is positionals[0].
func runTriage(s *bmio.Streams, argv []string) int {
	a := parse(argv)
	verb := a.at(0)
	// `delete` is an alias for `rm`: both name the same hard destroy. `rm` is the
	// canonical spelling; `delete` exists because it is the word a human reaches
	// for (triage.ts:94).
	if verb == "delete" {
		verb = "rm"
	}

	// Ids first, and BEFORE the mirror is opened or a client is built: a verb with
	// no target must cost zero requests, and saying so early is what makes that
	// true rather than merely likely (triage.ts:96).
	ids, err := collectIDs(a.Positionals[1:])
	if err != nil {
		return die(s, err)
	}
	if len(ids) == 0 {
		return die(s, bmio.Usage("bullmoose "+verb+" <id…>   (ids as arguments, or piped on stdin)"))
	}

	db, err := store.Open(store.DBPath(a.DB))
	if err != nil {
		return die(s, err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1) // the reconcile writes; same reason as watch/sync
	settings, err := store.RequireSettings(db)
	if err != nil {
		return die(s, err)
	}
	accountID, err := triageAccount(db, settings, a, ids[0])
	if err != nil {
		return die(s, err)
	}
	client := jmap.NewSessionClient(settings.Base, settings.Token)
	ctx := context.Background()

	if verb == "rm" {
		return runDestroy(ctx, s, db, client, accountID, ids, a)
	}
	if updateVerbs[verb] {
		return runUpdate(ctx, s, db, client, accountID, verb, ids, a)
	}
	return die(s, bmio.Usage("unknown triage verb: "+verb))
}

// ---- the update verbs ------------------------------------------------------

func runUpdate(ctx context.Context, s *bmio.Streams, db *sql.DB, client *jmap.Client,
	accountID, verb string, ids []string, a args) int {
	// Build the SINGLE-operation patch for this verb, plus the --json extras and
	// the human description of what it will do. For the mailbox verbs the
	// destination is resolved HERE, above the dry-run branch, because a dry run
	// that did not resolve its target would be evidence of nothing.
	var patch ordered
	var extra ordered
	destDesc := ""
	// clientFailed holds the ids the empty-mailbox guard rejected before any
	// write; workIds is what is left to send.
	var clientFailed []failure
	workIDs := ids

	switch verb {
	case "flag":
		patch = keywordPatch(a.Add, a.Remove)
		if len(patch) == 0 {
			return die(s, bmio.Usage("bullmoose flag <id…> --add <keyword> [--remove <keyword>]  (e.g. --add '$flagged')"))
		}
		extra = ordered{{"keywords", patch}}
		destDesc = " (" + describeKeywords(a.Add, a.Remove) + ")"

	case "seen":
		// Sugar over flag: set $seen, or clear it with --unset.
		if a.Unset {
			patch = keywordPatch(nil, []string{seenKeyword})
			destDesc = " (mark unread)"
		} else {
			patch = keywordPatch([]string{seenKeyword}, nil)
			destDesc = " (mark read)"
		}
		extra = ordered{{"keywords", patch}}

	case "move", "archive", "junk", "trash":
		selector, err := moveSelector(verb, a)
		if err != nil {
			return die(s, err)
		}
		dest, err := resolveDestMailbox(ctx, db, client, accountID, selector)
		if err != nil {
			return die(s, err)
		}
		// Full-property replacement: the message ends up in exactly this one
		// mailbox. A mailboxIds-ONLY patch, so the server charges `move` alone.
		patch = replacePatch(dest.ID)
		extra = ordered{{"mailbox", dest.ID}, {"mailboxName", dest.Name}}
		destDesc = " → " + dest.Name + " (" + dest.ID + ")"

	case "label":
		adds, err := resolveMany(ctx, db, client, accountID, a.Add)
		if err != nil {
			return die(s, err)
		}
		removes, err := resolveMany(ctx, db, client, accountID, a.Remove)
		if err != nil {
			return die(s, err)
		}
		if len(adds) == 0 && len(removes) == 0 {
			return die(s, bmio.Usage("bullmoose label <id…> --add <mailbox> [--remove <mailbox>]"))
		}
		// Per-key add/remove — NOT a full replace, so a labelled message keeps its
		// other mailboxes. Still mailboxIds-only, so `label` charges `move` and
		// never `annotate`.
		patch = labelPatch(adds, removes)
		extra = ordered{{"add", adds}, {"remove", removes}}
		if len(adds) > 0 {
			destDesc += " +[" + strings.Join(adds, ", ") + "]"
		}
		if len(removes) > 0 {
			destDesc += " -[" + strings.Join(removes, ", ") + "]"
		}
		// The empty-mailbox guard (email.ts:403): a remove that would leave a
		// message in zero mailboxes is an error, not an archive. Caught here,
		// naming `move`, rather than surfacing a bare invalidProperties.
		if len(removes) > 0 {
			keep, rejected, err := guardEmptyRemove(ctx, client, accountID, ids, adds, removes)
			if err != nil {
				return die(s, err)
			}
			workIDs, clientFailed = keep, rejected
		}

	default:
		// Unreachable: runTriage routes only updateVerbs here. Kept because the
		// alternative is a nil patch travelling on to Email/set as `{}`, which the
		// server would accept as a no-op update — a new verb added to the map and
		// not to this switch would then look like it worked (triage.ts:192).
		return die(s, bmio.Usage("unknown triage verb: "+verb))
	}

	if a.DryRun {
		return reportDryRun(s, a, verb, ids, destDesc, extra)
	}

	out := outcome{verb: verb, failed: append([]failure{}, clientFailed...)}

	if len(workIDs) > 0 {
		update := make(ordered, len(workIDs))
		for i, id := range workIDs {
			update[i] = member{id, patch}
		}
		raw, err := client.One(ctx, "Email/set", emailSetUpdateArgs{
			AccountID: accountID,
			IfInState: a.IfState,
			Update:    update,
		}, jmap.MailUsing)
		if err != nil {
			// A method-level refusal — a stale --if-state is the one this command
			// exists to make survivable — and NOTHING was written (email.ts:234
			// throws before touching anything). `stateMismatch` maps to exit 5.
			return die(s, err)
		}
		var res struct {
			Updated    json.RawMessage `json:"updated"`
			NotUpdated json.RawMessage `json:"notUpdated"`
			NewState   *string         `json:"newState"`
		}
		if err := json.Unmarshal(raw, &res); err != nil {
			return die(s, err)
		}
		out.succeeded = objectKeys(res.Updated)
		out.failed = append(out.failed, setErrors(res.NotUpdated)...)
		if res.NewState != nil {
			out.newState = *res.NewState
		}
		// Reconcile ONLY the ids the server actually updated, and only now that
		// the write has returned.
		if !a.NoSync && len(out.succeeded) > 0 {
			if err := mirror.ReconcileEmails(ctx, db, client, accountID, out.succeeded, nil); err != nil {
				return die(s, err)
			}
		}
	}

	return report(s, a, out, extra)
}

// ---- rm --------------------------------------------------------------------

func runDestroy(ctx context.Context, s *bmio.Streams, db *sql.DB, client *jmap.Client,
	accountID string, ids []string, a args) int {
	// The hard-delete gate. store.destroyEmail removes the rows and ORPHANS the
	// R2 blob — no tombstone, nothing recoverable — so refuse unless the caller
	// says --force (or is only rehearsing with --dry-run). The gesture a human
	// means by "delete this" is `bullmoose trash`.
	if !a.Force && !a.DryRun {
		return die(s, bmio.Fail(
			"rm permanently destroys mail — there is no Trash and no undo. "+
				"Pass --force to confirm, --dry-run to rehearse, or use `bullmoose trash` to move to Trash.",
			bmio.ExitUsage))
	}
	if a.DryRun {
		return reportDryRun(s, a, "rm", ids, " — PERMANENT, no undo", nil)
	}

	raw, err := client.One(ctx, "Email/set", emailSetDestroyArgs{
		AccountID: accountID,
		IfInState: a.IfState,
		Destroy:   ids,
	}, jmap.MailUsing)
	if err != nil {
		return die(s, err)
	}
	var res struct {
		Destroyed    []string        `json:"destroyed"`
		NotDestroyed json.RawMessage `json:"notDestroyed"`
		NewState     *string         `json:"newState"`
	}
	if err := json.Unmarshal(raw, &res); err != nil {
		return die(s, err)
	}
	out := outcome{verb: "rm", succeeded: res.Destroyed, failed: setErrors(res.NotDestroyed)}
	if res.NewState != nil {
		out.newState = *res.NewState
	}
	if !a.NoSync && len(out.succeeded) > 0 {
		if err := mirror.ReconcileEmails(ctx, db, client, accountID, nil, out.succeeded); err != nil {
			return die(s, err)
		}
	}
	return report(s, a, out, ordered{{"destroyed", true}})
}

// ---- request shapes --------------------------------------------------------

// emailSetUpdateArgs is Email/set with a patch per id, in triage.ts:207's key
// order. `ifInState` is omitted entirely when there is no --if-state, exactly as
// the TypeScript's `...(opts.ifState ? {ifInState} : {})` spread is.
type emailSetUpdateArgs struct {
	AccountID string  `json:"accountId"`
	IfInState string  `json:"ifInState,omitempty"`
	Update    ordered `json:"update"`
}

// emailSetDestroyArgs is Email/set destroy (triage.ts:254).
type emailSetDestroyArgs struct {
	AccountID string   `json:"accountId"`
	IfInState string   `json:"ifInState,omitempty"`
	Destroy   []string `json:"destroy"`
}

// ---- patches ---------------------------------------------------------------

// keywordPatch is a keywords-ONLY patch — no mailboxIds key, ever. That is what
// makes `flag` and `seen` charge `annotate` alone (requiredScopesForEmailSet,
// email.ts:241): a token scoped to annotate can flag without also needing `move`.
func keywordPatch(add, remove []string) ordered {
	patch := ordered{}
	for _, kw := range add {
		patch = append(patch, member{"keywords/" + kw, true})
	}
	for _, kw := range remove {
		patch = append(patch, member{"keywords/" + kw, nil})
	}
	return patch
}

// replacePatch is a whole-property mailboxIds replacement — the message ends up
// in EXACTLY this mailbox. This is the set-REPLACE `move` means, as against
// labelPatch's per-key add.
func replacePatch(mailboxID string) ordered {
	return ordered{{"mailboxIds", ordered{{mailboxID, true}}}}
}

// labelPatch is a per-key mailboxIds add/remove — the message KEEPS its other
// mailboxes. Still mailboxIds-only, so `label` charges `move` and never
// `annotate`.
func labelPatch(adds, removes []string) ordered {
	patch := ordered{}
	for _, id := range adds {
		patch = append(patch, member{"mailboxIds/" + id, true})
	}
	for _, id := range removes {
		patch = append(patch, member{"mailboxIds/" + id, nil})
	}
	return patch
}

// wouldEmpty answers the question applyEmailPatch asks server-side
// (email.ts:403): would these adds/removes leave the message in NO mailbox?
func wouldEmpty(current, adds, removes []string) bool {
	set := map[string]bool{}
	for _, id := range current {
		set[id] = true
	}
	for _, id := range adds {
		set[id] = true
	}
	for _, id := range removes {
		delete(set, id)
	}
	return len(set) == 0
}

func describeKeywords(add, remove []string) string {
	bits := make([]string, 0, len(add)+len(remove))
	for _, k := range add {
		bits = append(bits, "+"+k)
	}
	for _, k := range remove {
		bits = append(bits, "-"+k)
	}
	return strings.Join(bits, " ")
}

// ---- targets ---------------------------------------------------------------

// collectIDs is triage.ts:289. Ids arrive as positional arguments (the
// `| xargs bullmoose archive` shape) or, when there are none, on stdin. Explicit
// arguments beat implicit stdin — the same rule `send`/readInput follow
// (arch.md §1.4) — and the split is on ANY whitespace, so a newline- or
// space-delimited stream both work.
func collectIDs(positionals []string) ([]string, error) {
	if len(positionals) > 0 {
		return positionals, nil
	}
	if term.IsTerminal(int(os.Stdin.Fd())) {
		return nil, nil
	}
	piped, err := io.ReadAll(os.Stdin)
	if err != nil {
		return nil, err
	}
	return strings.Fields(string(piped)), nil
}

// triageAccount is triage.ts:296. An explicit --account wins and is checked for
// ambiguity (the cli/009 rule, account.One); otherwise the owning account of the
// FIRST id is read from the local mirror, as `read` does, falling back to the
// default. Every id in one Email/set must share an account, so this resolves once.
func triageAccount(db *sql.DB, settings *store.Settings, a args, firstID string) (string, error) {
	if a.Account != "" {
		acc, err := resolveAccount(settings, a.Account)
		if err != nil {
			return "", err
		}
		return acc.AccountID, nil
	}
	if owner := store.OwnerOf(db, firstID); owner != "" {
		return owner, nil
	}
	return settings.AccountID, nil
}

// moveSelector is triage.ts:312: the sugar verbs name their role, plain `move`
// takes --role OR --mailbox and refuses both.
func moveSelector(verb string, a args) (string, error) {
	switch verb {
	case "archive", "junk", "trash":
		return verb, nil
	}
	if a.Role != "" && a.Mailbox != "" {
		return "", bmio.Usage("bullmoose move <id…> takes --role OR --mailbox, not both")
	}
	selector := a.Role
	if selector == "" {
		selector = a.Mailbox
	}
	if selector == "" {
		return "", bmio.Usage("bullmoose move <id…> --role <role> | --mailbox <id-or-name>")
	}
	return selector, nil
}

// box is one mailbox, as both the mirror and Mailbox/get describe it.
type box struct {
	ID   string  `json:"id"`
	Name string  `json:"name"`
	Role *string `json:"role"`
}

// accountMailboxes is triage.ts:388 — the LOCAL MIRROR first (019's bread-crumb:
// resolve `--role archive` from the mirror, not a round trip), falling back to a
// live Mailbox/get when the mirror is empty, e.g. before the first sync.
func accountMailboxes(ctx context.Context, db *sql.DB, client *jmap.Client, accountID string) ([]box, error) {
	rows, err := db.QueryContext(ctx, "SELECT id, name, role FROM mailboxes WHERE account_id = ?", accountID)
	if err == nil {
		var mirrored []box
		for rows.Next() {
			var b box
			var role sql.NullString
			if err := rows.Scan(&b.ID, &b.Name, &role); err != nil {
				rows.Close()
				return nil, err
			}
			if role.Valid {
				v := role.String
				b.Role = &v
			}
			mirrored = append(mirrored, b)
		}
		closeErr := rows.Err()
		rows.Close()
		if closeErr != nil {
			return nil, closeErr
		}
		if len(mirrored) > 0 {
			return mirrored, nil
		}
	}
	raw, err := client.One(ctx, "Mailbox/get",
		map[string]any{"accountId": accountID, "ids": nil}, jmap.MailUsing)
	if err != nil {
		return nil, err
	}
	var got struct {
		List []box `json:"list"`
	}
	if err := json.Unmarshal(raw, &got); err != nil {
		return nil, err
	}
	return got.List, nil
}

func resolveDestMailbox(ctx context.Context, db *sql.DB, client *jmap.Client, accountID, selector string) (box, error) {
	boxes, err := accountMailboxes(ctx, db, client, accountID)
	if err != nil {
		return box{}, err
	}
	return resolveMailbox(boxes, selector)
}

// resolveMany resolves each selector to a mailbox id — triage.ts:412. The empty
// case returns an EMPTY slice rather than nil, because `label --add x`'s --json
// record carries `"remove":[]` and a nil slice would marshal to `null`: a
// different record for the same event, and one `jq '.remove | length'` cannot
// read.
func resolveMany(ctx context.Context, db *sql.DB, client *jmap.Client, accountID string, selectors []string) ([]string, error) {
	if len(selectors) == 0 {
		return []string{}, nil
	}
	boxes, err := accountMailboxes(ctx, db, client, accountID)
	if err != nil {
		return nil, err
	}
	out := make([]string, len(selectors))
	for i, sel := range selectors {
		b, err := resolveMailbox(boxes, sel)
		if err != nil {
			return nil, err
		}
		out[i] = b.ID
	}
	return out, nil
}

// resolveMailbox is mailbox.ts:183: accept an id, a role, or a name — a human
// types "Receipts", not "mb_9f3c…". Exact id wins, then exact role, then
// case-insensitive name; an AMBIGUOUS name is an error rather than a coin flip.
func resolveMailbox(boxes []box, selector string) (box, error) {
	for _, b := range boxes {
		if b.ID == selector {
			return b, nil
		}
	}
	// The role compare lower-cases the SELECTOR only, as the TypeScript does.
	// arch.md §5's Turkish-i divergence is the login salt's problem, not this
	// one: a mailbox role is ASCII and this is a convenience match, not a
	// credential.
	lower := strings.ToLower(selector)
	for _, b := range boxes {
		if b.Role != nil && *b.Role == lower {
			return b, nil
		}
	}
	var byName []box
	for _, b := range boxes {
		if strings.ToLower(b.Name) == lower {
			byName = append(byName, b)
		}
	}
	if len(byName) == 1 {
		return byName[0], nil
	}
	if len(byName) > 1 {
		ids := make([]string, len(byName))
		for i, b := range byName {
			ids[i] = b.ID
		}
		return box{}, bmio.Usage("\"" + selector + "\" matches " + strconv.Itoa(len(byName)) +
			" mailboxes; use an id: " + strings.Join(ids, ", "))
	}
	return box{}, bmio.NotFound("no such mailbox: " + selector)
}

// guardEmptyRemove is triage.ts:429. applyEmailPatch refuses to leave a message
// in zero mailboxes, so for `label --remove` this fetches each id's current
// membership and rejects — client-side, naming `move` — any whose set would go
// empty. The rest still go through; partial failure is honest.
func guardEmptyRemove(ctx context.Context, client *jmap.Client, accountID string,
	ids, adds, removes []string) (keep []string, rejected []failure, err error) {
	raw, err := client.One(ctx, "Email/get", emailGetArgs{
		AccountID:  accountID,
		IDs:        ids,
		Properties: []string{"id", "mailboxIds"},
	}, jmap.MailUsing)
	if err != nil {
		return nil, nil, err
	}
	var got struct {
		List []struct {
			ID         string          `json:"id"`
			MailboxIDs map[string]bool `json:"mailboxIds"`
		} `json:"list"`
	}
	if err := json.Unmarshal(raw, &got); err != nil {
		return nil, nil, err
	}
	current := make(map[string][]string, len(got.List))
	for _, e := range got.List {
		members := make([]string, 0, len(e.MailboxIDs))
		for id := range e.MailboxIDs {
			members = append(members, id)
		}
		current[e.ID] = members
	}
	for _, id := range ids {
		members, known := current[id]
		if !known {
			// Unknown id: let the SERVER report it as notFound in the write below,
			// so one vocabulary describes the failure.
			keep = append(keep, id)
			continue
		}
		if wouldEmpty(members, adds, removes) {
			rejected = append(rejected, failure{
				id:          id,
				typ:         "invalidProperties",
				description: "remove would leave it in no mailbox — use `move` to relocate instead",
			})
			continue
		}
		keep = append(keep, id)
	}
	return keep, rejected, nil
}

// ---- reporting -------------------------------------------------------------

func reportDryRun(s *bmio.Streams, a args, verb string, ids []string, destDesc string, extra ordered) int {
	s.Note("dry run: would " + verb + " " + strconv.Itoa(len(ids)) + " message(s)" + destDesc +
		"; nothing was written")
	if a.JSON {
		record := append(ordered{{"dryRun", true}, {"action", verb}, {"ids", ids}}, extra...)
		if err := s.EmitJSON(record); err != nil {
			return die(s, err)
		}
	}
	return 0
}

// report is triage.ts:491. stdout is the ids the verb acted on, so verbs chain
// (`bullmoose archive $(…) | xargs bullmoose flag --add '$seen'`, arch.md §1.1).
// Failures go to stderr and a non-zero exit — but the successes are NOT
// swallowed: an archive of 40 ids where 1 does not exist still prints the 39 it
// moved and reports the 1.
func report(s *bmio.Streams, a args, out outcome, extra ordered) int {
	for _, f := range out.failed {
		line := out.verb + ": " + f.id + " failed: " + f.typ
		if f.description != "" {
			line += " — " + f.description
		}
		s.Note(line)
	}

	if a.JSON {
		for _, id := range out.succeeded {
			record := append(ordered{{"id", id}, {"action", out.verb}}, extra...)
			record = append(record, member{"state", nullableString(out.newState)})
			if err := s.EmitJSON(record); err != nil {
				return die(s, err)
			}
		}
	} else {
		// Default AND --ids: bare ids, one per line. A triage verb's result IS its
		// ids, so there is no separate human list.
		s.EmitIDs(out.succeeded)
	}

	total := len(out.succeeded) + len(out.failed)
	s.Note(out.verb + ": " + strconv.Itoa(len(out.succeeded)) + "/" + strconv.Itoa(total) + " ok")
	if out.newState != "" {
		s.Note("state " + out.newState + "  (pass to --if-state on the next write)")
	}

	if len(out.failed) > 0 {
		// Non-zero if ANY id failed (019 done-when #7). The code comes from the
		// FIRST failure's type — notFound → 3, forbidden → 4 — so a single-cause
		// batch reports its true cause rather than a generic 1.
		return die(s, bmio.Fail(
			out.verb+": "+strconv.Itoa(len(out.failed))+" of "+strconv.Itoa(total)+" failed",
			bmio.ExitCodeForJMAPType(out.failed[0].typ)))
	}
	return 0
}

// nullableString renders "" as JSON null — `newState ?? null` (triage.ts:216),
// which is what a client-side-only refusal reports, since no write happened.
func nullableString(v string) any {
	if v == "" {
		return nil
	}
	return v
}

// ---- ordered JSON ----------------------------------------------------------

// ordered is a JSON object that marshals its members IN THE ORDER WRITTEN.
//
// It is needed in both directions. On the wire, `update` is keyed by email id and
// its insertion order is the order the ids were given — a Go map would sort them,
// so the server would process a different order than Node's request asks for. On
// stdout, `--json` records are compared byte for byte against the TypeScript's,
// and JavaScript object literals preserve insertion order.
type ordered []member

// member is one key/value pair of an ordered object.
type member struct {
	key   string
	value any
}

// MarshalJSON writes the members in order, with HTML escaping OFF so `<`, `>` and
// `&` match JSON.stringify byte for byte (jsonValue, read.go).
func (o ordered) MarshalJSON() ([]byte, error) {
	var b strings.Builder
	b.WriteByte('{')
	for i, m := range o {
		if i > 0 {
			b.WriteByte(',')
		}
		key, err := jsonValue(m.key)
		if err != nil {
			return nil, err
		}
		value, err := jsonValue(m.value)
		if err != nil {
			return nil, err
		}
		b.WriteString(key)
		b.WriteByte(':')
		b.WriteString(value)
	}
	b.WriteByte('}')
	return []byte(b.String()), nil
}

// objectKeys is `Object.keys(x ?? {})` — the keys of a JSON object in DOCUMENT
// order. `updated` is read this way rather than into a map because its order is
// the order the ids are printed on stdout, and a Go map iteration would shuffle
// the output of a multi-id verb from one run to the next.
func objectKeys(raw json.RawMessage) []string {
	entries, err := objectEntries(raw)
	if err != nil {
		return nil
	}
	keys := make([]string, len(entries))
	for i, e := range entries {
		keys[i] = e.key
	}
	return keys
}

// setErrors reads a notUpdated/notDestroyed map into failures, in document order,
// defaulting an absent type to "unknown" exactly as triage.ts:214 does.
func setErrors(raw json.RawMessage) []failure {
	entries, err := objectEntries(raw)
	if err != nil {
		return nil
	}
	out := make([]failure, 0, len(entries))
	for _, e := range entries {
		var se setErr
		_ = json.Unmarshal(e.value, &se)
		typ := se.Type
		if typ == "" {
			typ = "unknown"
		}
		out = append(out, failure{id: e.key, typ: typ, description: se.Description})
	}
	return out
}

// entry is one key/value pair read back out of a JSON object.
type entry struct {
	key   string
	value json.RawMessage
}

// objectEntries walks a JSON object keeping key order. An absent or non-object
// value is the empty set, which is `?? {}`.
func objectEntries(raw json.RawMessage) ([]entry, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	if tok != json.Delim('{') {
		return nil, nil
	}
	var out []entry
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return nil, err
		}
		key, _ := keyTok.(string)
		var value json.RawMessage
		if err := dec.Decode(&value); err != nil {
			return nil, err
		}
		out = append(out, entry{key: key, value: value})
	}
	return out, nil
}
