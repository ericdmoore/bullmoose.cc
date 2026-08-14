package cmd

// `bullmoose contacts` — the read AND write surface over the JSContact core
// (s08 T6 wave 3; a port of packages/cli/src/contacts.ts, specced by sVOL 017).
//
//	contacts import <file.vcf> [--book …]        idempotent bulk seed
//	contacts list [--book …] [-n N]              browse cards
//	contacts show <id>                           one card, in full
//	contacts books list|create|rename|rm         address-book lifecycle
//	contacts create|edit|rm [-] [--as vcard|json]  one card from stdin
//	contacts export [--book …]                   the inverse of import
//
// Subcommand dispatch follows agents.go: ONE front door switching on the first
// positional, a `usage` default that names the whole verb set, and each verb a
// function of its own. `books` nests the same shape one level down.
//
// ── Three live realities this command must not paper over ───────────────────
//
// 1. CONTACT SEARCH IS UNINDEXED. `ContactCard/query` has no index behind it:
//    every query reads every card in the account (the WebUI says so on screen).
//    The paging below is therefore transcribed from the TypeScript rather than
//    improved — PAGE=256, the same loop shapes, the same break conditions. On a
//    3,559-card book a "better" page size is a different contract, and the two
//    implementations would issue different request counts against the same verb.
//
// 2. GOVERNED BOOKS REFUSE WRITES, SERVER-SIDE. s10 T1 made an agent's outbound
//    bound a governed address book, so a card write into a `governed` or
//    `propose` book is refused at the mailstore chokepoint
//    (packages/mailstore/src/governance.ts refusedDirectWrite) and surfaces as a
//    per-object `forbidden` SetError carrying the server's own sentence — which
//    names the path that IS allowed, a grant-request proposal. That reaches the
//    user through failSetErrorOf: type `forbidden` → EXIT 4 via the §1.5 table,
//    description quoted verbatim, no stack trace. The CLI adds nothing and
//    invents nothing; the refusal is legible because it is the server's, and
//    because the exit code says "not permitted" rather than "something failed".
//
// 3. BOOK MANAGEMENT IS OWNER-ONLY. `AddressBook/set` throws a method-level
//    `forbidden` on delegated access (services/jmap/src/methods/contacts.ts:123,
//    "only the account owner manages address books"), so `books create|rename|rm`
//    works for the owner and exits 4 for an agent reaching the account through a
//    grant. Correct behaviour, not a misconfiguration — sVOL 017 asked for it to
//    be visible rather than surprising.

import (
	"bytes"
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/jmap"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/jsobj"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/store"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/vcard"
)

// Set-request chunking — contacts.ts:63. Small enough that the worker's JSON
// handling of a photo-heavy chunk stays inside its per-request CPU budget
// (inline photos make single cards MB-scale); a chunk that still trips it is
// split and retried down to single cards.
const (
	createChunk      = 20
	createChunkBytes = 600_000
	contactsPage     = 256
)

// contactsRunner is everything the verbs share, so each one reads as its
// TypeScript twin does rather than threading five parameters.
type contactsRunner struct {
	s         *bmio.Streams
	a         args
	client    *jmap.Client
	accountID string
	ctx       context.Context
}

func runContacts(s *bmio.Streams, argv []string) int {
	a := parse(argv)

	// The order is contacts.ts:73's: settings, then the account, then the client
	// — all BEFORE the verb switch, so an unknown verb and a missing argument
	// both refuse having sent zero requests.
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
	r := &contactsRunner{
		s: s, a: a, accountID: acc.AccountID, ctx: context.Background(),
		client: jmap.NewSessionClient(settings.Base, settings.Token),
	}

	sub, arg, arg2 := a.at(1), a.at(2), a.at(3)
	switch sub {
	case "import":
		// §1.4: the path is optional and `-` is explicit stdin, so
		// `cat a.vcf | bullmoose contacts import -` works like any Unix filter.
		return r.imports(arg)
	case "list":
		return r.list()
	case "show":
		if arg == "" {
			return die(s, bmio.Usage("bullmoose contacts show <cardId>"))
		}
		return r.show(arg)
	case "books":
		return r.books(arg, arg2, a.at(4))
	case "create":
		// A single card (or a small batch) from stdin or a path, WITHOUT
		// import's dedup — `create` means "make this", not "reconcile".
		return r.create(arg)
	case "edit":
		if arg == "" {
			return die(s, bmio.Usage("bullmoose contacts edit <cardId> [<file>|-] [--as vcard|json]"))
		}
		return r.edit(arg, arg2)
	case "rm":
		if arg == "" {
			return die(s, bmio.Usage("bullmoose contacts rm <cardId> [--dry-run]"))
		}
		return r.remove(arg)
	case "export":
		return r.export()
	default:
		named := sub
		if named == "" {
			named = "(none)"
		}
		return die(s, bmio.Usage("unknown contacts subcommand: "+named+
			" (import|list|show|books|create|edit|rm|export)"))
	}
}

// ---- request shapes ---------------------------------------------------------
//
// Structs, not maps, so the key order on the wire is the TypeScript's (see
// jmap.Invocation's note). The dynamic ones — anything with an `ifInState` spread
// or a create map keyed `c0…cN` — use jmap.Object, because a Go map marshals its
// keys sorted and would reorder both.

type inBookFilter struct {
	InAddressBook string `json:"inAddressBook"`
}

type bookGetArgs struct {
	AccountID string   `json:"accountId"`
	IDs       []string `json:"ids"` // always nil → `null`, i.e. "every book"
}

type cardQueryArgs struct {
	AccountID string           `json:"accountId"`
	Filter    *inBookFilter    `json:"filter,omitempty"`
	Sort      []sortComparator `json:"sort,omitempty"`
	Position  int              `json:"position"`
	Limit     float64          `json:"limit"`
}

type cardGetArgs struct {
	AccountID  string   `json:"accountId"`
	IDs        []string `json:"ids"`
	Properties []string `json:"properties,omitempty"`
}

// bookRef is contacts.ts:373 BookRef.
type bookRef struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	IsDefault bool   `json:"isDefault"`
}

// ---- import -----------------------------------------------------------------

func (r *contactsRunner) imports(file string) int {
	input, err := readSource(file, r.a.As, r.a.HasAs, true, "vCard")
	if err != nil {
		return die(r.s, err)
	}
	if input.Type != typeVCard {
		return die(r.s, bmio.Fail(input.From+" looks like "+string(input.Type)+
			", not vCard — pass --as vcard to force it", bmio.ExitUsage))
	}
	parsed := vcard.ParseVCF(input.Text)
	for _, w := range parsed.Warnings {
		r.s.Warn(w)
	}
	if len(parsed.Cards) == 0 {
		return die(r.s, bmio.NotFound("no vCards found in "+input.From))
	}
	source := input.From

	book, err := r.resolveBook(r.a.Book, true)
	if err != nil {
		return die(r.s, err)
	}

	// uid → id of what is already there, so a re-import creates only what is new.
	existing := map[string]bool{}
	all, err := r.listAllCards([]string{"id", "uid"}, "")
	if err != nil {
		return die(r.s, err)
	}
	for _, c := range all {
		existing[c.JSString("uid")] = true
	}

	if r.a.DryRun {
		// §1.7: a --dry-run write performs zero mutations. Everything to here is
		// a read, so the report is REAL — it names the book the cards would land
		// in and what would be skipped, then stops before the first /set.
		wouldSkip := 0
		for _, c := range parsed.Cards {
			if existing[c.JSString("uid")] {
				wouldSkip++
			}
		}
		if r.a.JSON {
			out := jsobj.New()
			_ = out.Set("dryRun", true)
			_ = out.Set("source", source)
			_ = out.Set("book", bookJSON(book))
			_ = out.Set("parsed", len(parsed.Cards))
			_ = out.Set("wouldCreate", len(parsed.Cards)-wouldSkip)
			_ = out.Set("wouldSkip", wouldSkip)
			if err := r.s.EmitJSON(out); err != nil {
				return die(r.s, err)
			}
			return 0
		}
		r.s.Note("dry run: " + source + " would create " +
			strconv.Itoa(len(parsed.Cards)-wouldSkip) + " of " + strconv.Itoa(len(parsed.Cards)) +
			` card(s) in "` + book.Name + `" (` + strconv.Itoa(wouldSkip) +
			" already on server); nothing was written")
		return 0
	}

	var toCreate []*vcard.Card
	skippedExisting, duplicatesInFile := 0, 0
	seenInFile := map[string]bool{}
	for _, card := range parsed.Cards {
		uid := card.JSString("uid")
		if seenInFile[uid] {
			duplicatesInFile++
			continue
		}
		seenInFile[uid] = true
		if existing[uid] {
			skippedExisting++
			continue
		}
		books := jsobj.New()
		_ = books.Set(book.ID, true)
		_ = card.Set("addressBookIds", books)
		toCreate = append(toCreate, card)
	}

	imp := &importRun{r: r, total: len(toCreate)}
	for _, chunk := range chunkBySize(toCreate) {
		imp.sendChunk(chunk)
	}
	if len(toCreate) > createChunk && !r.a.JSON {
		r.s.NoteRaw("\n")
	}

	if r.a.JSON {
		out := jsobj.New()
		_ = out.Set("source", source)
		_ = out.Set("book", bookJSON(book))
		_ = out.Set("parsed", len(parsed.Cards))
		_ = out.Set("created", imp.created)
		_ = out.Set("skippedExisting", skippedExisting)
		_ = out.Set("duplicatesInFile", duplicatesInFile)
		_ = out.Set("failed", imp.failedJSON())
		if err := r.s.EmitJSON(out); err != nil {
			return die(r.s, err)
		}
	} else {
		parts := []string{"created " + strconv.Itoa(imp.created)}
		if skippedExisting > 0 {
			parts = append(parts, strconv.Itoa(skippedExisting)+" already on server")
		}
		if duplicatesInFile > 0 {
			parts = append(parts, strconv.Itoa(duplicatesInFile)+" duplicates within the file")
		}
		plural := "s"
		if len(parsed.Cards) == 1 {
			plural = ""
		}
		r.s.Out(source + ": parsed " + strconv.Itoa(len(parsed.Cards)) + " card" + plural +
			" → " + strings.Join(parts, ", ") + ` → "` + book.Name + `"`)
		for _, f := range imp.failed {
			r.s.Note("failed: " + f.uid + ": " + f.err)
		}
	}
	if len(imp.failed) > 0 {
		return int(bmio.ExitFail)
	}
	return 0
}

func bookJSON(b bookRef) *jsobj.Object {
	out := jsobj.New()
	_ = out.Set("id", b.ID)
	_ = out.Set("name", b.Name)
	return out
}

// importFailure is one card the server refused, uid-first so a human can find it.
type importFailure struct{ uid, err string }

// importRun carries the chunked-create state contacts.ts holds in closures.
type importRun struct {
	r       *contactsRunner
	total   int
	created int
	done    int
	failed  []importFailure
}

func (i *importRun) progress() {
	if i.total > createChunk && !i.r.a.JSON {
		i.r.s.NoteRaw("\rimporting… " + strconv.Itoa(i.done) + "/" + strconv.Itoa(i.total))
	}
}

func (i *importRun) failedJSON() []any {
	out := make([]any, 0, len(i.failed))
	for _, f := range i.failed {
		o := jsobj.New()
		_ = o.Set("uid", f.uid)
		_ = o.Set("error", f.err)
		out = append(out, o)
	}
	return out
}

// sendChunk is contacts.ts:200 — one ContactCard/set per chunk; on a
// TRANSPORT/worker failure the chunk halves and retries, and a single card gets
// one more attempt after a pause. A per-object refusal is NOT a transport failure
// and does not retry: it is recorded and reported.
func (i *importRun) sendChunk(chunk []*vcard.Card) {
	create := jmap.Object{}
	for n, card := range chunk {
		create = append(create, jmap.Member{Key: "c" + strconv.Itoa(n), Value: card})
	}
	raw, err := i.r.client.One(i.r.ctx, "ContactCard/set", jmap.Object{
		{Key: "accountId", Value: i.r.accountID},
		{Key: "create", Value: create},
	}, jmap.ContactsUsing)
	if err != nil {
		if len(chunk) > 1 {
			// Halve until it fits the worker's per-request resource budget.
			mid := (len(chunk) + 1) / 2
			i.sendChunk(chunk[:mid])
			i.sendChunk(chunk[mid:])
			return
		}
		// Single card: give a transient failure one more chance.
		time.Sleep(1500 * time.Millisecond)
		if err2 := i.sendOne(chunk[0]); err2 != nil {
			i.failed = append(i.failed, importFailure{uid: chunk[0].JSString("uid"), err: err2.Error()})
			i.done++
			i.progress()
		}
		return
	}
	res := parseSetResponse(raw)
	i.created += len(res.Created)
	for n := range chunk {
		cid := "c" + strconv.Itoa(n)
		e, refused := res.NotCreated[cid]
		if !refused {
			continue
		}
		i.failed = append(i.failed, importFailure{uid: chunk[n].JSString("uid"), err: setErrorText(e)})
	}
	i.done += len(chunk)
	i.progress()
}

func (i *importRun) sendOne(card *vcard.Card) error {
	raw, err := i.r.client.One(i.r.ctx, "ContactCard/set", jmap.Object{
		{Key: "accountId", Value: i.r.accountID},
		{Key: "create", Value: jmap.Object{{Key: "c0", Value: card}}},
	}, jmap.ContactsUsing)
	if err != nil {
		return err
	}
	res := parseSetResponse(raw)
	i.created += len(res.Created)
	if e, refused := res.NotCreated["c0"]; refused {
		i.failed = append(i.failed, importFailure{uid: card.JSString("uid"), err: setErrorText(e)})
	}
	i.done++
	i.progress()
	return nil
}

// setErrorText is contacts.ts:210's `description ?? type ?? "unknown error"`.
func setErrorText(e setErr) string {
	switch {
	case e.Description != "":
		return e.Description
	case e.Type != "":
		return e.Type
	default:
		return "unknown error"
	}
}

// chunkBySize is contacts.ts:271 — greedy chunks bounded by count AND serialized
// size, because photos are big. The size is measured in UTF-16 code units, which
// is what `JSON.stringify(card).length` counts.
func chunkBySize(cards []*vcard.Card) [][]*vcard.Card {
	var chunks [][]*vcard.Card
	var cur []*vcard.Card
	bytes := 0
	for _, card := range cards {
		raw, err := jsobj.Marshal(card)
		size := 0
		if err == nil {
			size = len(utf16.Encode([]rune(string(raw))))
		}
		if len(cur) > 0 && (len(cur) >= createChunk || bytes+size > createChunkBytes) {
			chunks = append(chunks, cur)
			cur = nil
			bytes = 0
		}
		cur = append(cur, card)
		bytes += size
	}
	if len(cur) > 0 {
		chunks = append(chunks, cur)
	}
	return chunks
}

// setResponse is the slice of a `/set` reply every write verb in contacts and
// calendar reads. One shape for both commands and all six verbs, because RFC 8620
// §5 gives them one shape.
type setResponse struct {
	Created    map[string]createdID       `json:"created"`
	NotCreated map[string]setErr          `json:"notCreated"`
	Updated    map[string]json.RawMessage `json:"updated"`
	NotUpdated map[string]setErr          `json:"notUpdated"`
	Destroyed  []string                   `json:"destroyed"`
	NotDestroy map[string]setErr          `json:"notDestroyed"`
	NewState   *string                    `json:"newState"`
}

type createdID struct {
	ID string `json:"id"`
}

func parseSetResponse(raw json.RawMessage) setResponse {
	var res setResponse
	_ = json.Unmarshal(raw, &res)
	return res
}

// state is `res.newState ?? null` rendered as "" for absent, so the caller can
// decide between the chainable-state note and a JSON null.
func (res setResponse) state() string {
	if res.NewState == nil {
		return ""
	}
	return *res.NewState
}

// ---- list / show ------------------------------------------------------------

func (r *contactsRunner) list() int {
	var book *bookRef
	if r.a.Book != "" {
		b, err := r.resolveBook(r.a.Book, false)
		if err != nil {
			return die(r.s, err)
		}
		book = &b
	}
	limit := jsLimit(r.a.N, 20)

	// The paging loop is contacts.ts:295, transcribed. See the file header:
	// ContactCard/query is unindexed, so the request COUNT is part of the
	// contract and must not be "improved" into a different one.
	var ids []string
	position := 0
	for float64(len(ids)) < limit {
		q := cardQueryArgs{
			AccountID: r.accountID,
			Sort:      []sortComparator{{Property: "name", IsAscending: true}},
			Position:  position,
			Limit:     minFloat(contactsPage, limit-float64(len(ids))),
		}
		if book != nil {
			q.Filter = &inBookFilter{InAddressBook: book.ID}
		}
		want := q.Limit
		page, err := r.queryIDs(q)
		if err != nil {
			return die(r.s, err)
		}
		ids = append(ids, page...)
		if float64(len(page)) < want {
			break
		}
		position += len(page)
	}

	cards, err := r.getCards(ids, []string{
		"id", "name", "emails", "phones", "organizations", "addressBookIds",
	})
	if err != nil {
		return die(r.s, err)
	}
	// /get returns store order; present in the query's sort order.
	rank := map[string]int{}
	for i, id := range ids {
		rank[id] = i
	}
	stableSortBy(cards, func(a, b *jsobj.Object) bool {
		return rank[a.JSStringOr("id", "")] < rank[b.JSStringOr("id", "")]
	})

	if r.a.IDs {
		out := make([]string, len(cards))
		for i, c := range cards {
			out[i] = c.JSString("id")
		}
		r.s.EmitIDs(out)
		return 0
	}
	if r.a.JSON {
		// §1.3 — one card per line, so `| jq -r .id | xargs` streams.
		return r.emitCards(cards)
	}
	if len(cards) == 0 {
		if book != nil {
			r.s.Note(`no contacts in "` + book.Name + `"`)
		} else {
			r.s.Note("no contacts")
		}
		return 0
	}
	for _, c := range cards {
		r.s.Out(padRight(displayName(c), 28) + " " + padRight(firstEmail(c), 30) + " " + c.JSString("id"))
	}
	return 0
}

func (r *contactsRunner) show(id string) int {
	cards, err := r.getCards([]string{id}, nil)
	if err != nil {
		return die(r.s, err)
	}
	if len(cards) == 0 {
		return die(r.s, bmio.NotFound("no such contact: "+id))
	}
	card := cards[0]
	if r.a.IDs {
		r.s.EmitIDs([]string{card.JSStringOr("id", id)})
		return 0
	}
	// §1.3: `show` is the single-object case — one JSON object under --json,
	// pretty-printed only for a human. Both re-emit the SERVER's object, key
	// order and all (see internal/jsobj's note).
	raw, err := card.MarshalJSON()
	if err != nil {
		return die(r.s, err)
	}
	if r.a.JSON {
		r.s.Out(string(raw))
		return 0
	}
	pretty, err := jsobj.Indent2(raw)
	if err != nil {
		return die(r.s, err)
	}
	r.s.Out(pretty)
	return 0
}

// ---- shared helpers ---------------------------------------------------------

// resolveBook is contacts.ts:379. `createMissing` is import's behaviour only:
// every other verb refuses an unknown book with exit 3 rather than inventing one.
func (r *contactsRunner) resolveBook(selector string, createMissing bool) (bookRef, error) {
	raw, err := r.client.One(r.ctx, "AddressBook/get",
		bookGetArgs{AccountID: r.accountID}, jmap.ContactsUsing)
	if err != nil {
		return bookRef{}, err
	}
	var res struct {
		List []bookRef `json:"list"`
	}
	if err := json.Unmarshal(raw, &res); err != nil {
		return bookRef{}, err
	}
	books := res.List

	if selector == "" {
		for _, b := range books {
			if b.IsDefault {
				return b, nil
			}
		}
		if len(books) > 0 {
			return books[0], nil
		}
		return bookRef{}, bmio.NotFound("no address book on the account")
	}

	for _, b := range books {
		if b.ID == selector || strings.ToLower(b.Name) == strings.ToLower(selector) {
			return b, nil
		}
	}
	if !createMissing {
		names := make([]string, len(books))
		for i, b := range books {
			names[i] = b.Name
		}
		return bookRef{}, bmio.NotFound(`no address book "` + selector + `"; have: ` +
			strings.Join(names, ", "))
	}
	setRaw, err := r.client.One(r.ctx, "AddressBook/set", jmap.Object{
		{Key: "accountId", Value: r.accountID},
		{Key: "create", Value: jmap.Object{{Key: "b0", Value: map[string]string{"name": selector}}}},
	}, jmap.ContactsUsing)
	if err != nil {
		return bookRef{}, err
	}
	made := parseSetResponse(setRaw)
	created, ok := made.Created["b0"]
	if !ok || created.ID == "" {
		return bookRef{}, failSetErrorOf(`create address book "`+selector+`"`, made.NotCreated["b0"])
	}
	r.s.Note(`created address book "` + selector + `" (` + created.ID + ")")
	return bookRef{ID: created.ID, Name: selector}, nil
}

// listAllCards is contacts.ts:414 — enumerate every id, then fetch in pages of
// contactsPage. With no `properties` the WHOLE card comes back, which is what
// `export` re-serialises.
func (r *contactsRunner) listAllCards(properties []string, bookID string) ([]*jsobj.Object, error) {
	ids, err := r.queryAllIDs(bookID)
	if err != nil {
		return nil, err
	}
	var out []*jsobj.Object
	for i := 0; i < len(ids); i += contactsPage {
		end := i + contactsPage
		if end > len(ids) {
			end = len(ids)
		}
		cards, err := r.getCards(ids[i:end], properties)
		if err != nil {
			return nil, err
		}
		out = append(out, cards...)
	}
	return out, nil
}

// queryAllIDs is the shared enumerate loop of listAllCards and queryIdsInBook.
func (r *contactsRunner) queryAllIDs(bookID string) ([]string, error) {
	var ids []string
	position := 0
	for {
		q := cardQueryArgs{AccountID: r.accountID, Position: position, Limit: contactsPage}
		if bookID != "" {
			q.Filter = &inBookFilter{InAddressBook: bookID}
		}
		page, err := r.queryIDs(q)
		if err != nil {
			return nil, err
		}
		ids = append(ids, page...)
		if len(page) < contactsPage {
			break
		}
		position += len(page)
	}
	return ids, nil
}

func (r *contactsRunner) queryIDs(q cardQueryArgs) ([]string, error) {
	raw, err := r.client.One(r.ctx, "ContactCard/query", q, jmap.ContactsUsing)
	if err != nil {
		return nil, err
	}
	var res struct {
		IDs []string `json:"ids"`
	}
	if err := json.Unmarshal(raw, &res); err != nil {
		return nil, err
	}
	return res.IDs, nil
}

// getCards fetches cards, keeping each one's RAW bytes and key order.
func (r *contactsRunner) getCards(ids []string, properties []string) ([]*jsobj.Object, error) {
	if len(ids) == 0 {
		// contacts.ts still issues no request in this shape: cmdList's fetch loop
		// does not run for an empty id list, and cmdShow always has one id.
		return nil, nil
	}
	raw, err := r.client.One(r.ctx, "ContactCard/get", cardGetArgs{
		AccountID: r.accountID, IDs: ids, Properties: properties,
	}, jmap.ContactsUsing)
	if err != nil {
		return nil, err
	}
	var res struct {
		List []json.RawMessage `json:"list"`
	}
	if err := json.Unmarshal(raw, &res); err != nil {
		return nil, err
	}
	out := make([]*jsobj.Object, 0, len(res.List))
	for _, item := range res.List {
		card, err := jsobj.Parse(item)
		if err != nil {
			continue
		}
		out = append(out, card)
	}
	return out, nil
}

func (r *contactsRunner) emitCards(cards []*jsobj.Object) int {
	for _, c := range cards {
		raw, err := c.MarshalJSON()
		if err != nil {
			return die(r.s, err)
		}
		r.s.Out(string(raw))
	}
	return 0
}

// displayName is contacts.ts:450 — the full name, else the first organization,
// else the first email, else "(unnamed)".
func displayName(c *jsobj.Object) string {
	if name := c.Obj("name"); name != nil {
		if full, ok := name.Str("full"); ok && full != "" {
			return full
		}
	}
	for _, org := range c.Obj("organizations").Values() {
		if n, ok := org.Str("name"); ok && n != "" {
			return n
		}
		break // `orgs[0]?.name` — only the first is consulted
	}
	if e := firstEmail(c); e != "" {
		return e
	}
	return "(unnamed)"
}

// firstEmail is contacts.ts:458 — `Object.values(emails)[0]?.address ?? ""`.
func firstEmail(c *jsobj.Object) string {
	for _, e := range c.Obj("emails").Values() {
		return e.StrOr("address", "")
	}
	return ""
}

// ---- books: address-book lifecycle (owner-only) -----------------------------

func (r *contactsRunner) books(verb, arg, arg2 string) int {
	switch verb {
	case "list":
		return r.booksList()
	case "create":
		if arg == "" {
			return die(r.s, bmio.Usage("bullmoose contacts books create <name>"))
		}
		return r.booksCreate(arg)
	case "rename":
		if arg == "" || arg2 == "" {
			return die(r.s, bmio.Usage("bullmoose contacts books rename <name-or-id> <new-name>"))
		}
		return r.booksRename(arg, arg2)
	case "rm":
		if arg == "" {
			return die(r.s, bmio.Usage("bullmoose contacts books rm <name-or-id> [--force] [--dry-run]"))
		}
		return r.booksRemove(arg)
	default:
		named := verb
		if named == "" {
			named = "(none)"
		}
		return die(r.s, bmio.Usage("unknown contacts books subcommand: "+named+" (list|create|rename|rm)"))
	}
}

func (r *contactsRunner) booksList() int {
	raw, err := r.client.One(r.ctx, "AddressBook/get",
		bookGetArgs{AccountID: r.accountID}, jmap.ContactsUsing)
	if err != nil {
		return die(r.s, err)
	}
	var res struct {
		List []json.RawMessage `json:"list"`
	}
	if err := json.Unmarshal(raw, &res); err != nil {
		return die(r.s, err)
	}
	books := make([]*jsobj.Object, 0, len(res.List))
	for _, item := range res.List {
		b, err := jsobj.Parse(item)
		if err != nil {
			continue
		}
		books = append(books, b)
	}
	if r.a.IDs {
		ids := make([]string, len(books))
		for i, b := range books {
			ids[i] = b.JSString("id")
		}
		r.s.EmitIDs(ids)
		return 0
	}
	if r.a.JSON {
		return r.emitCards(books)
	}
	if len(books) == 0 {
		r.s.Note("no address books")
		return 0
	}
	for _, b := range books {
		star := " "
		if b.Bool("isDefault") {
			star = "★"
		}
		r.s.Out(padRight(b.JSStringOr("name", ""), 28) + " " + star + "  " + b.JSString("id"))
	}
	return 0
}

func (r *contactsRunner) booksCreate(name string) int {
	if r.dryRun("create book", name) {
		return 0
	}
	raw, err := r.client.One(r.ctx, "AddressBook/set", r.setArgs(jmap.Member{
		Key: "create", Value: jmap.Object{{Key: "b0", Value: map[string]string{"name": name}}},
	}), jmap.ContactsUsing)
	if err != nil {
		return die(r.s, err)
	}
	res := parseSetResponse(raw)
	made, ok := res.Created["b0"]
	if !ok || made.ID == "" {
		return die(r.s, failSetErrorOf("create book", res.NotCreated["b0"]))
	}
	return r.reportWrite("created book", made.ID, name, res.state())
}

func (r *contactsRunner) booksRename(selector, newName string) int {
	book, err := r.resolveBook(selector, false)
	if err != nil {
		return die(r.s, err)
	}
	if r.dryRun("rename book", book.Name+" → "+newName) {
		return 0
	}
	raw, err := r.client.One(r.ctx, "AddressBook/set", r.setArgs(jmap.Member{
		Key:   "update",
		Value: jmap.Object{{Key: book.ID, Value: map[string]string{"name": newName}}},
	}), jmap.ContactsUsing)
	if err != nil {
		return die(r.s, err)
	}
	res := parseSetResponse(raw)
	if _, ok := res.Updated[book.ID]; !ok {
		return die(r.s, failSetErrorOf("rename book", res.NotUpdated[book.ID]))
	}
	return r.reportWrite("renamed book", book.ID, newName, res.state())
}

func (r *contactsRunner) booksRemove(selector string) int {
	// Destructive: resolve for real, then COUNT what it holds — both so the
	// dry-run report is evidence of something and so a non-empty book earns a
	// clean exit-5 refusal rather than the server's generic set error.
	book, err := r.resolveBook(selector, false)
	if err != nil {
		return die(r.s, err)
	}
	contents, err := r.queryAllIDs(book.ID)
	if err != nil {
		return die(r.s, err)
	}
	detail := book.Name + " (" + book.ID + ")"
	switch {
	case len(contents) == 0:
	case r.a.Force:
		detail = book.Name + " and its " + strconv.Itoa(len(contents)) + " contact(s)"
	default:
		detail = book.Name + " — holds " + strconv.Itoa(len(contents)) + " contact(s), needs --force"
	}
	if r.dryRun("remove book", detail) {
		return 0
	}
	if len(contents) > 0 && !r.a.Force {
		return die(r.s, bmio.Conflict(`address book "`+book.Name+`" holds `+
			strconv.Itoa(len(contents))+" contact(s); pass --force to remove them too"))
	}
	members := []jmap.Member{{Key: "destroy", Value: []string{book.ID}}}
	if r.a.Force {
		members = append(members, jmap.Member{Key: "onDestroyRemoveContents", Value: true})
	}
	raw, err := r.client.One(r.ctx, "AddressBook/set", r.setArgs(members...), jmap.ContactsUsing)
	if err != nil {
		return die(r.s, err)
	}
	res := parseSetResponse(raw)
	if !containsString(res.Destroyed, book.ID) {
		return die(r.s, failSetErrorOf("remove book", res.NotDestroy[book.ID]))
	}
	return r.reportWrite("removed book", book.ID, book.Name, res.state())
}

// ---- card writes: create / edit / rm ----------------------------------------

func (r *contactsRunner) create(file string) int {
	input, err := readSource(file, r.a.As, r.a.HasAs, true, "vCard or JSON")
	if err != nil {
		return die(r.s, err)
	}
	cards, err := r.cardsFromInput(input)
	if err != nil {
		return die(r.s, err)
	}
	if len(cards) == 0 {
		return die(r.s, bmio.NotFound("no contact found in "+input.From))
	}
	var book *bookRef
	if r.a.Book != "" {
		b, err := r.resolveBook(r.a.Book, false)
		if err != nil {
			return die(r.s, err)
		}
		book = &b
	}

	what := strconv.Itoa(len(cards)) + " contact(s)"
	if book != nil {
		what += ` in "` + book.Name + `"`
	}
	if r.dryRun("create", what) {
		return 0
	}

	create := jmap.Object{}
	keys := make([]string, len(cards))
	uids := make([]json.RawMessage, len(cards))
	for i, card := range cards {
		card.Delete("id") // id is server-set
		if book != nil {
			books := jsobj.New()
			_ = books.Set(book.ID, true)
			_ = card.Set("addressBookIds", books)
		}
		keys[i] = "c" + strconv.Itoa(i)
		create = append(create, jmap.Member{Key: keys[i], Value: card})
		if raw, ok := card.Raw("uid"); ok {
			uids[i] = raw
		} else {
			uids[i] = json.RawMessage("null")
		}
	}
	raw, err := r.client.One(r.ctx, "ContactCard/set",
		r.setArgs(jmap.Member{Key: "create", Value: create}), jmap.ContactsUsing)
	if err != nil {
		return die(r.s, err)
	}
	res := parseSetResponse(raw)

	var madeIDs []string
	var fails []int
	for i, k := range keys {
		if made, ok := res.Created[k]; ok {
			madeIDs = append(madeIDs, made.ID)
			continue
		}
		if _, refused := res.NotCreated[k]; refused {
			fails = append(fails, i)
		}
	}
	// Nothing landed → surface the FIRST SetError with its mapped exit code. This
	// is the governed-book path: `forbidden` → exit 4, the server's sentence
	// verbatim (see the file header, reality 2).
	if len(madeIDs) == 0 && len(fails) > 0 {
		return die(r.s, failSetErrorOf("create", res.NotCreated[keys[fails[0]]]))
	}

	switch {
	case r.a.IDs:
		r.s.EmitIDs(madeIDs)
	case r.a.JSON:
		for i, k := range keys {
			row := jsobj.New()
			if made, ok := res.Created[k]; ok {
				_ = row.Set("id", made.ID)
				row.SetRaw("uid", uids[i])
				_ = row.Set("created", true)
			} else {
				row.SetRaw("uid", uids[i])
				_ = row.Set("created", false)
				typ := res.NotCreated[k].Type
				if typ == "" {
					typ = "unknown"
				}
				_ = row.Set("error", typ)
			}
			if err := r.s.EmitJSON(row); err != nil {
				return die(r.s, err)
			}
		}
	default:
		for _, id := range madeIDs {
			r.s.Out("created " + id)
		}
		for _, i := range fails {
			e := res.NotCreated[keys[i]]
			reason := e.Description
			if reason == "" {
				reason = e.Type
			}
			if reason == "" {
				reason = "unknown"
			}
			named := jsobj.JSStringOf(uids[i])
			if string(uids[i]) == "null" {
				named = keys[i] // `create[k].uid ?? k`
			}
			r.s.Note("failed to create " + named + ": " + reason)
		}
		if state := res.state(); state != "" && len(madeIDs) > 0 {
			r.s.Note("state " + state + "  (pass to --if-state on the next write)")
		}
	}
	// A partial failure is still a failure.
	if len(fails) > 0 {
		return int(bmio.ExitFail)
	}
	return 0
}

func (r *contactsRunner) edit(id, file string) int {
	input, err := readSource(file, r.a.As, r.a.HasAs, true, "vCard or JSON")
	if err != nil {
		return die(r.s, err)
	}
	cards, err := r.cardsFromInput(input)
	if err != nil {
		return die(r.s, err)
	}
	if len(cards) != 1 {
		return die(r.s, bmio.Usage("contacts edit takes exactly one card, got "+
			strconv.Itoa(len(cards))+" in "+input.From))
	}
	patch := cards[0]
	patch.Delete("id") // the id is the target, not a settable property
	if r.a.Book != "" {
		book, err := r.resolveBook(r.a.Book, false)
		if err != nil {
			return die(r.s, err)
		}
		books := jsobj.New()
		_ = books.Set(book.ID, true)
		_ = patch.Set("addressBookIds", books)
	}
	if r.dryRun("edit", id) {
		return 0
	}
	raw, err := r.client.One(r.ctx, "ContactCard/set", r.setArgs(jmap.Member{
		Key: "update", Value: jmap.Object{{Key: id, Value: patch}},
	}), jmap.ContactsUsing)
	if err != nil {
		return die(r.s, err)
	}
	res := parseSetResponse(raw)
	if _, ok := res.Updated[id]; !ok {
		return die(r.s, failSetErrorOf("edit", res.NotUpdated[id]))
	}
	return r.reportWrite("edited", id, displayName(patch), res.state())
}

func (r *contactsRunner) remove(id string) int {
	cards, err := r.getCards([]string{id}, []string{"id", "name", "organizations", "emails"})
	if err != nil {
		return die(r.s, err)
	}
	if len(cards) == 0 {
		return die(r.s, bmio.NotFound("no such contact: "+id))
	}
	name := displayName(cards[0])
	if r.dryRun("remove", name+" ("+id+")") {
		return 0
	}
	raw, err := r.client.One(r.ctx, "ContactCard/set", r.setArgs(jmap.Member{
		Key: "destroy", Value: []string{id},
	}), jmap.ContactsUsing)
	if err != nil {
		return die(r.s, err)
	}
	res := parseSetResponse(raw)
	if !containsString(res.Destroyed, id) {
		return die(r.s, failSetErrorOf("remove", res.NotDestroy[id]))
	}
	return r.reportWrite("removed", id, name, res.state())
}

// ---- export: the inverse of import ------------------------------------------

func (r *contactsRunner) export() int {
	var book *bookRef
	bookID := ""
	if r.a.Book != "" {
		b, err := r.resolveBook(r.a.Book, false)
		if err != nil {
			return die(r.s, err)
		}
		book, bookID = &b, b.ID
	}
	cards, err := r.listAllCards(nil, bookID)
	if err != nil {
		return die(r.s, err)
	}
	if r.a.IDs {
		ids := make([]string, len(cards))
		for i, c := range cards {
			ids[i] = c.JSString("id")
		}
		r.s.EmitIDs(ids)
		return 0
	}
	if r.a.JSON {
		return r.emitCards(cards)
	}
	if len(cards) == 0 {
		if book != nil {
			r.s.Note(`no contacts in "` + book.Name + `"`)
		} else {
			r.s.Note("no contacts")
		}
		return 0
	}
	// The DATA is vCard: 3.0 blocks concatenated, each already CRLF-terminated,
	// so `export | import` round-trips a book.
	for _, c := range cards {
		r.s.OutRaw(vcard.Serialize(c))
	}
	return 0
}

// ---- write-path helpers -----------------------------------------------------

// cardsFromInput is contacts.ts:761 — vCard through the parser, JSON as one card
// object or an array of them, anything else a usage error naming the fix.
func (r *contactsRunner) cardsFromInput(input *sourceInput) ([]*jsobj.Object, error) {
	switch input.Type {
	case typeVCard:
		parsed := vcard.ParseVCF(input.Text)
		for _, w := range parsed.Warnings {
			r.s.Warn(w)
		}
		return parsed.Cards, nil
	case typeJSON:
		var value json.RawMessage
		if err := json.Unmarshal([]byte(input.Text), &value); err != nil {
			return nil, bmio.Fail(input.From+" is not valid JSON: "+jsJSONError(err), bmio.ExitUsage)
		}
		// `Array.isArray(parsed) ? parsed : [parsed]` — decided from the parsed
		// VALUE, not the source text, so leading whitespace or a BOM cannot make
		// a single card look like a batch.
		items := []json.RawMessage{value}
		if trimmed := bytes.TrimSpace(value); len(trimmed) > 0 && trimmed[0] == '[' {
			if err := json.Unmarshal(value, &items); err != nil {
				return nil, bmio.Fail(input.From+" is not valid JSON: "+jsJSONError(err), bmio.ExitUsage)
			}
		}
		out := make([]*jsobj.Object, 0, len(items))
		for _, item := range items {
			card, err := jsobj.Parse(item)
			if err != nil {
				return nil, bmio.Fail(input.From+": each contact must be a JSON object", bmio.ExitUsage)
			}
			out = append(out, card)
		}
		return out, nil
	default:
		return nil, bmio.Fail(input.From+" looks like "+string(input.Type)+
			", not a contact — pass --as vcard or --as json to force it", bmio.ExitUsage)
	}
}

// setArgs is the `{accountId, ...ifInState(opts), …}` spread every /set performs
// — §1.7: `--if-state` maps straight onto JMAP's `ifInState`, so a scripted
// read-modify-write cannot silently clobber a concurrent change. A mismatch comes
// back as a method-level `stateMismatch` → exit 5, and nothing is written.
func (r *contactsRunner) setArgs(rest ...jmap.Member) jmap.Object {
	args := jmap.Object{{Key: "accountId", Value: r.accountID}}
	if r.a.HasIfState && r.a.IfState != "" {
		args = append(args, jmap.Member{Key: "ifInState", Value: r.a.IfState})
	}
	return append(args, rest...)
}

// dryRun is contacts.ts:799 (§1.7, invariant 4). Everything before the call is a
// read, so the report names the RESOLVED target rather than the string typed.
func (r *contactsRunner) dryRun(verb, what string) bool {
	if !r.a.DryRun {
		return false
	}
	r.s.Note("dry run: would " + verb + " " + what + "; nothing was written")
	if r.a.JSON {
		out := jsobj.New()
		_ = out.Set("dryRun", true)
		_ = out.Set("action", verb)
		_ = out.Set("target", what)
		_ = r.s.EmitJSON(out)
	}
	return true
}

// reportWrite is the single-target write report, mirroring `mailbox`'s: the id
// for --ids, one object for --json, a line plus the chainable state for a human.
func (r *contactsRunner) reportWrite(action, id, name, state string) int {
	if r.a.IDs {
		r.s.EmitIDs([]string{id})
		return 0
	}
	if r.a.JSON {
		out := jsobj.New()
		_ = out.Set("action", action)
		_ = out.Set("id", id)
		_ = out.Set("name", name)
		if state == "" {
			out.SetRaw("state", json.RawMessage("null"))
		} else {
			_ = out.Set("state", state)
		}
		if err := r.s.EmitJSON(out); err != nil {
			return die(r.s, err)
		}
		return 0
	}
	r.s.Out(action + " " + name + " (" + id + ")")
	if state != "" {
		r.s.Note("state " + state + "  (pass to --if-state on the next write)")
	}
	return 0
}

// ---- small shared utilities -------------------------------------------------

// jsLimit is `Math.max(1, Number(raw) || fallback)` — the `||` matters: "0" and
// junk both fall to the default, a negative clamps to 1.
func jsLimit(raw string, fallback float64) float64 {
	n, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
	if err != nil || n == 0 || n != n {
		n = fallback
	}
	if n < 1 {
		return 1
	}
	return n
}

func minFloat(a, b float64) float64 {
	if a < b {
		return a
	}
	return b
}

func containsString(list []string, want string) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}

// padRight is JavaScript's String.padEnd — it counts UTF-16 code units, which is
// what keeps a column of names aligned identically in both implementations.
func padRight(s string, width int) string {
	n := len(utf16.Encode([]rune(s)))
	if n >= width {
		return s
	}
	return s + strings.Repeat(" ", width-n)
}

// stableSortBy is an insertion sort, which is stable — Array.prototype.sort is
// required to be stable since ES2019, and `contacts list` relies on it to keep
// the query's order for cards whose rank ties.
func stableSortBy(list []*jsobj.Object, less func(a, b *jsobj.Object) bool) {
	for i := 1; i < len(list); i++ {
		for j := i; j > 0 && less(list[j], list[j-1]); j-- {
			list[j], list[j-1] = list[j-1], list[j]
		}
	}
}

// jsJSONError renders a JSON parse failure.
//
// ⚠️ THE ONE KNOWN BYTE DIVERGENCE in this command, recorded rather than hidden.
// The TypeScript interpolates `(e as Error).message`, which is V8's own syntax
// diagnostic — "Expected property name or '}' in JSON at position 2 (line 1
// column 3)". Go's encoding/json says "invalid character 'n' looking for
// beginning of object key string" instead. Reproducing V8's wording would mean
// reimplementing its parser's diagnostics, which is a large amount of fragile
// code to make one already-failing invocation's TAIL match.
//
// What DOES match, and is what a script reads: the stream (stderr), the exit
// code (2, usage), and the sentence up to the colon — `<source> is not valid
// JSON: `. Verified against both binaries on a malformed body.
func jsJSONError(err error) string { return err.Error() }
