package cmd

// `bullmoose mailbox` — the WRITE half of the folder surface (s08 T6 wave 5; a
// port of packages/cli/src/mailbox.ts, specced by sVOL 004):
//
//	mailbox create <name> [--parent <id-or-name>] [--sort <n>]
//	mailbox rename <id-or-name> <new-name>
//	mailbox move   <id-or-name> --parent <id-or-name|->
//	mailbox rm     <id-or-name> [--force]
//
// `bullmoose mailboxes` (plural, mailboxes.go) stays what it was: a read of the
// LOCAL mirror. These four verbs go over JMAP, so every one of them refreshes the
// mirror on the way out — otherwise a create would not show up until the next
// `bullmoose sync` and the two commands would disagree about which folders exist,
// which reads as a bug no matter how well documented (mailbox.ts:25).
//
// Three things a fresh port loses by default, each of which the TypeScript pays
// for deliberately:
//
//  1. **The selector is resolved LIVE, then reported by its resolved name.**
//     Every verb issues `Mailbox/get` first, so `mailbox rm Receipts` refuses an
//     unknown folder with exit 3 having written nothing — and `--dry-run` says
//     which folder it WOULD have touched. A dry run that did not resolve would be
//     evidence of nothing (mailbox.ts:117).
//  2. **Role DISPLAY NAMES are never hardcoded.** The tree prints the server's
//     `name` with the server's `role` in brackets. s12 moved held mail from an
//     invented `quarantine` role to the IANA-registered `junk` DISPLAYED
//     "Quarantined" (infra/migrations.mjs:575), and the only reason that rename
//     needed no CLI change is that the CLI never spelled a display name itself.
//  3. **--json re-emits the server's mailbox objects VERBATIM.** `mailboxes:
//     boxes` is `Mailbox/get`'s own list, so key order — and any property this
//     CLI does not model — survives. mirror.RefreshMailboxesRaw exists for that;
//     a Go map would sort the keys and a struct would drop the extras.

import (
	"context"
	"database/sql"
	"encoding/json"
	"math"
	"sort"
	"strconv"
	"strings"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/jmap"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/mirror"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/store"
)

// mailboxGetArgs is `Mailbox/get` as mailbox.ts:174 asks it: every mailbox in the
// account. A nil IDs slice marshals to `null`, which is the `ids: null` the
// TypeScript sends and the RFC 8620 §5.1 spelling of "all of them".
type mailboxGetArgs struct {
	AccountID string   `json:"accountId"`
	IDs       []string `json:"ids"`
}

// mailboxSetArgs is `Mailbox/set` in mailbox.ts:166's key order: accountId, the
// conditional ifInState, then whichever of create/update/destroy this verb
// carries. `create` and `update` are keyed by client id and mailbox id
// respectively, so they are `ordered` rather than maps — a Go map would sort
// those keys and the request would differ from Node's for no reason.
type mailboxSetArgs struct {
	AccountID string  `json:"accountId"`
	IfInState string  `json:"ifInState,omitempty"`
	Create    ordered `json:"create,omitempty"`
	Update    ordered `json:"update,omitempty"`
	// Destroy is a slice so `omitempty` drops it for the non-destroy verbs.
	Destroy []string `json:"destroy,omitempty"`
	// OnDestroyRemoveEmails is `--force`, and only ever true — the TypeScript
	// spreads `...(opts.force ? { onDestroyRemoveEmails: true } : {})`, so the
	// key is ABSENT rather than false when the flag is not given. Without it the
	// server refuses a folder that holds mail, which is the RFC 8621 default and
	// the right one (mailbox.ts:125).
	OnDestroyRemoveEmails bool `json:"onDestroyRemoveEmails,omitempty"`
}

// runMailbox serves all four verbs; the verb is positionals[1].
func runMailbox(s *bmio.Streams, argv []string) int {
	a := parse(argv)

	db, err := store.Open(store.DBPath(a.DB))
	if err != nil {
		return die(s, err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1) // the mirror refresh writes; same reason as sync/watch
	settings, err := store.RequireSettings(db)
	if err != nil {
		return die(s, err)
	}
	// pickAccountId (db.ts:224) — the cli/009 single-account rule, so an
	// ambiguous selector is refused rather than resolved to the first match.
	// Resolved BEFORE the verb switch, exactly as mailbox.ts:53 does, so an
	// unresolvable account costs zero requests on every verb alike.
	acc, err := resolveAccount(settings, a.Account)
	if err != nil {
		return die(s, err)
	}
	accountID := acc.AccountID
	client := jmap.NewSessionClient(settings.Base, settings.Token)
	ctx := context.Background()

	sub, arg, arg2 := a.at(1), a.at(2), a.at(3)
	switch sub {
	case "create":
		return mailboxCreate(ctx, s, db, client, accountID, a, arg)
	case "rename":
		return mailboxRename(ctx, s, db, client, accountID, a, arg, arg2)
	case "move":
		return mailboxMove(ctx, s, db, client, accountID, a, arg)
	case "rm":
		return mailboxRemove(ctx, s, db, client, accountID, a, arg)
	default:
		named := sub
		if named == "" {
			named = "(none)"
		}
		return die(s, bmio.Usage("unknown mailbox subcommand: "+named+" (create|rename|move|rm)"))
	}
}

func mailboxCreate(ctx context.Context, s *bmio.Streams, db *sql.DB, client *jmap.Client,
	accountID string, a args, name string) int {
	if name == "" {
		return die(s, bmio.Usage("bullmoose mailbox create <name> [--parent <id-or-name>] [--sort <n>]"))
	}
	boxes, err := listMailboxes(ctx, client, accountID)
	if err != nil {
		return die(s, err)
	}
	// The spec's key order is mailbox.ts:61's: name, then parentId, then
	// sortOrder, each present only when its flag was given.
	spec := ordered{{"name", name}}
	if a.HasParent {
		parent, err := resolveMailbox(boxes, a.Parent)
		if err != nil {
			return die(s, err)
		}
		spec = append(spec, member{"parentId", parent.ID})
	}
	if a.HasSort {
		order, err := parseSort(a.Sort)
		if err != nil {
			return die(s, err)
		}
		spec = append(spec, member{"sortOrder", order})
	}
	if mailboxDryRun(s, a, "create", name) {
		return 0
	}
	res, err := setMailbox(ctx, client, accountID, a, mailboxSetArgs{Create: ordered{{"c1", spec}}})
	if err != nil {
		return die(s, err)
	}
	made := res.created("c1")
	if made == "" {
		return die(s, failSetErrorOf("create", res.notCreated("c1")))
	}
	return reportMailbox(ctx, s, db, client, accountID, a, res, "created", made, name)
}

func mailboxRename(ctx context.Context, s *bmio.Streams, db *sql.DB, client *jmap.Client,
	accountID string, a args, selector, newName string) int {
	if selector == "" || newName == "" {
		return die(s, bmio.Usage("bullmoose mailbox rename <id-or-name> <new-name>"))
	}
	target, err := resolveTarget(ctx, client, accountID, selector)
	if err != nil {
		return die(s, err)
	}
	if mailboxDryRun(s, a, "rename", target.Name+" → "+newName) {
		return 0
	}
	res, err := setMailbox(ctx, client, accountID, a, mailboxSetArgs{
		Update: ordered{{target.ID, ordered{{"name", newName}}}},
	})
	if err != nil {
		return die(s, err)
	}
	if !res.updated(target.ID) {
		return die(s, failSetErrorOf("rename", res.notUpdated(target.ID)))
	}
	return reportMailbox(ctx, s, db, client, accountID, a, res, "renamed", target.ID, newName)
}

func mailboxMove(ctx context.Context, s *bmio.Streams, db *sql.DB, client *jmap.Client,
	accountID string, a args, selector string) int {
	// PRESENCE, not truthiness: `--parent ""` is an explicit (unresolvable)
	// answer, where a missing --parent is the usage error.
	if selector == "" || !a.HasParent {
		return die(s, bmio.Usage("bullmoose mailbox move <id-or-name> --parent <id-or-name|->"))
	}
	boxes, err := listMailboxes(ctx, client, accountID)
	if err != nil {
		return die(s, err)
	}
	target, err := resolveMailbox(boxes, selector)
	if err != nil {
		return die(s, err)
	}
	// "-" is the only way to say "top level" on a command line: an empty
	// --parent is indistinguishable from a missing one (mailbox.ts:95).
	var parentID any // nil → JSON null
	where := "(top level)"
	if a.Parent != "-" {
		parent, err := resolveMailbox(boxes, a.Parent)
		if err != nil {
			return die(s, err)
		}
		parentID, where = parent.ID, parent.ID
	}
	if mailboxDryRun(s, a, "move", target.Name+" → parent "+where) {
		return 0
	}
	res, err := setMailbox(ctx, client, accountID, a, mailboxSetArgs{
		Update: ordered{{target.ID, ordered{{"parentId", parentID}}}},
	})
	if err != nil {
		return die(s, err)
	}
	if !res.updated(target.ID) {
		return die(s, failSetErrorOf("move", res.notUpdated(target.ID)))
	}
	return reportMailbox(ctx, s, db, client, accountID, a, res, "moved", target.ID, target.Name)
}

func mailboxRemove(ctx context.Context, s *bmio.Streams, db *sql.DB, client *jmap.Client,
	accountID string, a args, selector string) int {
	if selector == "" {
		return die(s, bmio.Usage("bullmoose mailbox rm <id-or-name> [--force] [--dry-run]"))
	}
	target, err := resolveTarget(ctx, client, accountID, selector)
	if err != nil {
		return die(s, err)
	}
	// The destructive verb, so this is the one --dry-run exists for: the
	// selector is resolved for real (an unknown folder still exits 3) and then
	// nothing is written.
	what := target.Name + " (" + target.ID + ")"
	if a.Force {
		what += " and its mail"
	}
	if mailboxDryRun(s, a, "rm", what) {
		return 0
	}
	res, err := setMailbox(ctx, client, accountID, a, mailboxSetArgs{
		Destroy:               []string{target.ID},
		OnDestroyRemoveEmails: a.Force,
	})
	if err != nil {
		return die(s, err)
	}
	if !res.destroyed(target.ID) {
		return die(s, failSetErrorOf("rm", res.notDestroyed(target.ID)))
	}
	return reportMailbox(ctx, s, db, client, accountID, a, res, "destroyed", target.ID, target.Name)
}

// ---- the JMAP calls ---------------------------------------------------------

// listMailboxes is mailbox.ts:173 — a LIVE `Mailbox/get`, not the mirror. The
// triage verbs read the mirror first (triage.ts:388) because they resolve a
// destination on a read path; these verbs are about to WRITE the folder tree, so
// they resolve against what the server currently holds.
func listMailboxes(ctx context.Context, client *jmap.Client, accountID string) ([]box, error) {
	raw, err := client.One(ctx, "Mailbox/get", mailboxGetArgs{AccountID: accountID}, jmap.MailUsing)
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

// resolveTarget is the get-then-resolve every verb but `create` opens with.
func resolveTarget(ctx context.Context, client *jmap.Client, accountID, selector string) (box, error) {
	boxes, err := listMailboxes(ctx, client, accountID)
	if err != nil {
		return box{}, err
	}
	return resolveMailbox(boxes, selector)
}

// setMailbox is mailbox.ts:156. §1.7: --if-state becomes JMAP's ifInState, and
// the server answers a mismatch with a method-level `stateMismatch` — which
// reaches exit 5 through the ordinary error path with nothing written.
func setMailbox(ctx context.Context, client *jmap.Client, accountID string, a args,
	set mailboxSetArgs) (*mailboxSetResult, error) {
	set.AccountID = accountID
	set.IfInState = a.IfState
	raw, err := client.One(ctx, "Mailbox/set", set, jmap.MailUsing)
	if err != nil {
		return nil, err
	}
	var res mailboxSetResult
	if err := json.Unmarshal(raw, &res); err != nil {
		return nil, err
	}
	return &res, nil
}

// mailboxSetResult is the reply, read in DOCUMENT order where it is keyed by id.
type mailboxSetResult struct {
	Created      json.RawMessage `json:"created"`
	NotCreated   json.RawMessage `json:"notCreated"`
	Updated      json.RawMessage `json:"updated"`
	NotUpdated   json.RawMessage `json:"notUpdated"`
	Destroyed    []string        `json:"destroyed"`
	NotDestroyed json.RawMessage `json:"notDestroyed"`
	NewState     *string         `json:"newState"`
}

// created returns the id the server minted for a creation key, or "".
func (r *mailboxSetResult) created(key string) string {
	for _, e := range mustEntries(r.Created) {
		if e.key == key {
			var made struct {
				ID string `json:"id"`
			}
			_ = json.Unmarshal(e.value, &made)
			return made.ID
		}
	}
	return ""
}

// updated is `target.id in res.updated` — PRESENCE, since a successful update's
// value is null (mailbox.ts:79).
func (r *mailboxSetResult) updated(id string) bool { return hasKey(r.Updated, id) }

func (r *mailboxSetResult) destroyed(id string) bool {
	for _, d := range r.Destroyed {
		if d == id {
			return true
		}
	}
	return false
}

func (r *mailboxSetResult) notCreated(key string) setErr  { return setErrorAt(r.NotCreated, key) }
func (r *mailboxSetResult) notUpdated(id string) setErr   { return setErrorAt(r.NotUpdated, id) }
func (r *mailboxSetResult) notDestroyed(id string) setErr { return setErrorAt(r.NotDestroyed, id) }

func (r *mailboxSetResult) state() any {
	if r.NewState == nil {
		return nil // `res.newState ?? null` (mailbox.ts:221)
	}
	return *r.NewState
}

func hasKey(raw json.RawMessage, key string) bool {
	for _, e := range mustEntries(raw) {
		if e.key == key {
			return true
		}
	}
	return false
}

// setErrorAt reads one SetError out of a notCreated/notUpdated/notDestroyed map.
// An absent entry is the zero setErr, which failSetErrorOf renders "unknown" —
// io.ts:430's `(err ?? {})`.
func setErrorAt(raw json.RawMessage, key string) setErr {
	for _, e := range mustEntries(raw) {
		if e.key == key {
			var se setErr
			_ = json.Unmarshal(e.value, &se)
			return se
		}
	}
	return setErr{}
}

func mustEntries(raw json.RawMessage) []entry {
	entries, err := objectEntries(raw)
	if err != nil {
		return nil
	}
	return entries
}

// ---- reporting --------------------------------------------------------------

// mailboxDryRun is mailbox.ts:149 (arch.md §1.7, invariant 4). It returns true
// when the caller must stop. Everything before the call is a READ, so the report
// names the RESOLVED target rather than the string that was typed.
func mailboxDryRun(s *bmio.Streams, a args, verb, what string) bool {
	if !a.DryRun {
		return false
	}
	s.Note("dry run: would " + verb + " " + what + "; nothing was written")
	if a.JSON {
		_ = s.EmitJSON(ordered{{"dryRun", true}, {"action", verb}, {"target", what}})
	}
	return true
}

// reportMailbox is mailbox.ts:210. It refreshes the mirror FIRST — that is the
// whole reason these verbs are not fire-and-forget — then reports the write in
// whichever of the three shapes was asked for.
func reportMailbox(ctx context.Context, s *bmio.Streams, db *sql.DB, client *jmap.Client,
	accountID string, a args, res *mailboxSetResult, action, id, name string) int {
	rawBoxes, boxes, _, err := mirror.RefreshMailboxesRaw(ctx, db, client, accountID)
	if err != nil {
		return die(s, err)
	}
	if rawBoxes == nil {
		rawBoxes = []json.RawMessage{} // `?? []` — an empty ARRAY, never null
	}

	if a.IDs { // §1.8 — the xargs shape outranks everything
		s.EmitIDs([]string{id})
		return 0
	}
	if a.JSON {
		// The state the write LANDED on. Without it `--if-state` is half a
		// feature: a script has to read the new state to pass it to the next
		// write. `mailboxes` is the server's own list, key order and all.
		if err := s.EmitJSON(ordered{
			{"action", action}, {"id", id}, {"name", name},
			{"state", res.state()}, {"mailboxes", rawBoxes},
		}); err != nil {
			return die(s, err)
		}
		return 0
	}
	s.Out(action + " " + name + " (" + id + ")")
	if state, ok := res.state().(string); ok && state != "" {
		s.Note("state " + state + "  (pass to --if-state on the next write)")
	}
	// The tree is decoration: useful to a human, noise in a pipeline.
	s.Note(renderTree(boxes))
	return 0
}

// renderTree is mailbox.ts:237 — the point of the whole unit: a human can see the
// hierarchy they made. Children sort by sortOrder, ties by name.
func renderTree(boxes []mirror.Mailbox) string {
	var lines []string
	var walk func(parentID *string, indent string)
	walk = func(parentID *string, indent string) {
		children := make([]mirror.Mailbox, 0, len(boxes))
		for _, m := range boxes {
			if sameParent(m.ParentID, parentID) {
				children = append(children, m)
			}
		}
		sort.SliceStable(children, func(i, j int) bool {
			if children[i].SortOrder != children[j].SortOrder {
				return children[i].SortOrder < children[j].SortOrder
			}
			return jsLocaleCompare(children[i].Name, children[j].Name) < 0
		})
		for _, m := range children {
			role := ""
			if m.Role != nil && *m.Role != "" {
				// The DISPLAY name is the server's `name`; the bracket is the
				// server's `role`. Neither is spelled here — see the header's
				// note on s12's `junk` → "Quarantined".
				role = "  [" + *m.Role + "]"
			}
			lines = append(lines, indent+m.Name+role)
			id := m.ID
			walk(&id, indent+"  ")
		}
	}
	walk(nil, "  ")
	return strings.Join(lines, "\n")
}

// sameParent is JavaScript's `m.parentId === parentId` over `string | null`.
func sameParent(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

// jsLocaleCompare stands in for `String.prototype.localeCompare`, which
// renderTree uses to break sortOrder ties.
//
// Node's default collator is ICU root, NOT byte order: "apple" sorts before
// "Banana" there and after it under a Go string compare. Reproducing ICU is out
// of scope for a folder listing, so this implements the two levels that decide
// real mailbox names — primary: case-insensitive comparison; tertiary:
// lowercase before uppercase on an otherwise equal pair — and is honest about
// being an approximation for names that differ only by accent or punctuation
// class. It is reached ONLY when two sibling folders share a sortOrder, and its
// output is stderr decoration (mailbox.ts:233 sends the tree through note()).
func jsLocaleCompare(a, b string) int {
	lowerA, lowerB := strings.ToLower(a), strings.ToLower(b)
	if lowerA != lowerB {
		return strings.Compare(lowerA, lowerB)
	}
	if a == b {
		return 0
	}
	ra, rb := []rune(a), []rune(b)
	for i := 0; i < len(ra) && i < len(rb); i++ {
		if ra[i] == rb[i] {
			continue
		}
		// Same letter, different case: ICU's tertiary level puts lowercase first.
		lowerFirstA := ra[i] == []rune(strings.ToLower(string(ra[i])))[0]
		if lowerFirstA {
			return -1
		}
		return 1
	}
	return len(ra) - len(rb)
}

// parseSort is mailbox.ts:202: `--sort` must be a non-negative INTEGER, and the
// refusal is a usage error naming what was typed.
//
// `Number(raw)` is not `strconv.Atoi`: it trims whitespace, reads "" as 0, and
// accepts "0x10", "1e3" and "Infinity". jsNumber reproduces it, so the same
// strings are accepted and refused on both sides.
func parseSort(raw string) (float64, error) {
	n := jsNumber(raw)
	if !jsIsInteger(n) || n < 0 {
		return 0, bmio.Fail(`--sort must be a non-negative integer, got "`+raw+`"`, bmio.ExitUsage)
	}
	return n, nil
}

// jsIsInteger is `Number.isInteger`: finite, and equal to its own truncation.
func jsIsInteger(n float64) bool {
	return !math.IsNaN(n) && !math.IsInf(n, 0) && n == math.Trunc(n)
}

// jsNumber is JavaScript's `Number(string)` — ECMA-262 §7.1.4.1 StringToNumber.
// The empty (or all-whitespace) string is 0, the radix prefixes are honoured, and
// anything unparseable is NaN. Go's ParseFloat differs on every one of those.
func jsNumber(raw string) float64 {
	s := strings.TrimFunc(raw, isJSWhitespace)
	if s == "" {
		return 0 // Number("") === 0, and Number("   ") === 0
	}
	if len(s) > 2 && s[0] == '0' {
		base := 0
		switch s[1] {
		case 'x', 'X':
			base = 16
		case 'o', 'O':
			base = 8
		case 'b', 'B':
			base = 2
		}
		if base != 0 {
			n, err := strconv.ParseUint(s[2:], base, 64)
			if err != nil {
				return math.NaN()
			}
			return float64(n)
		}
	}
	switch s {
	case "Infinity", "+Infinity":
		return math.Inf(1)
	case "-Infinity":
		return math.Inf(-1)
	}
	// ParseFloat accepts "inf"/"nan"/"0x1p-2", which Number() does not.
	if strings.ContainsAny(s, "nN") && !strings.ContainsAny(s, "0123456789") {
		return math.NaN()
	}
	if strings.ContainsAny(s, "xXpP") {
		return math.NaN()
	}
	n, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return math.NaN()
	}
	return n
}
