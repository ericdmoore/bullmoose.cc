package cmd

// `bullmoose read` — print one message, newest if no id (s08 T6 wave 2,
// devPlan.md:146 "email read/triage"). A straight port of main.ts:959 cmdRead,
// and unlike wave 1 it is a LIVE command: `read` deliberately queries the server
// rather than the mirror, so it works without a prior sync (main.ts:967). The
// mirror is consulted for exactly one thing — which account an id belongs to.
//
// It has a TypeScript twin, so byte-identity is the contract: the same three
// output shapes (--ids, --json, human), the same body-part selection, and the
// same two refusals with the same exit codes.

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/jmap"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/store"
)

// readProperties is main.ts:1000's property list, in that order — the server
// echoes the requested properties in this order, and --json re-emits them as
// received, so the ORDER is part of the output contract.
var readProperties = []string{
	"id", "from", "to", "cc", "subject", "receivedAt", "bodyValues", "textBody",
}

// The request shapes, as STRUCTS rather than maps so the field order on the wire
// is the TypeScript's (jmap.Invocation's note explains why that is worth caring
// about).

// emailGetArgs is RFC 8621 §4.2 Email/get, in main.ts:1000's key order.
type emailGetArgs struct {
	AccountID           string   `json:"accountId"`
	IDs                 []string `json:"ids"`
	Properties          []string `json:"properties"`
	FetchTextBodyValues bool     `json:"fetchTextBodyValues,omitempty"`
}

// emailQueryArgs is Email/query as `read` asks it — main.ts:978.
type emailQueryArgs struct {
	AccountID string           `json:"accountId"`
	Sort      []sortComparator `json:"sort"`
	Limit     int              `json:"limit"`
}

// sortComparator is RFC 8620 §5.5's Comparator.
type sortComparator struct {
	Property    string `json:"property"`
	IsAscending bool   `json:"isAscending"`
}

// runRead serves `bullmoose read [emailId] [--raw] [--json|--ids] [--account s]`.
func runRead(s *bmio.Streams, argv []string) int {
	a := parse(argv)

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
	accountID := acc.AccountID

	client := jmap.NewSessionClient(settings.Base, settings.Token)
	ctx := context.Background()

	// main.ts:969 — an explicit id with NO --account is looked up in the mirror
	// to find its owner, so an id pasted out of a multi-account `log` reads back
	// from the account it actually lives in. With --account the selector wins:
	// the user named the account, and silently overriding them would make the
	// flag a suggestion.
	id := a.at(1)
	if id != "" && a.Account == "" {
		if owner := store.OwnerOf(db, id); owner != "" {
			accountID = owner
		}
	}

	// No id → the newest message, queried live (main.ts:978) so `read` works on
	// a mirror that has never synced.
	if id == "" {
		raw, err := client.One(ctx, "Email/query", emailQueryArgs{
			AccountID: accountID,
			Sort:      []sortComparator{{Property: "receivedAt", IsAscending: false}},
			Limit:     1,
		}, jmap.MailUsing)
		if err != nil {
			return die(s, err)
		}
		var q struct {
			IDs []string `json:"ids"`
		}
		if err := json.Unmarshal(raw, &q); err != nil {
			return die(s, err)
		}
		if len(q.IDs) > 0 {
			id = q.IDs[0]
		}
		if id == "" {
			return die(s, bmio.NotFound("mailbox is empty — nothing to read"))
		}
	}

	// --raw is the RFC 5322 source, straight from the blob store. It short-
	// circuits BEFORE the body fetch (main.ts:986): raw means raw, so neither
	// --json nor --ids applies and nothing is rendered.
	if a.Raw {
		meta, err := client.One(ctx, "Email/get", emailGetArgs{
			AccountID:  accountID,
			IDs:        []string{id},
			Properties: []string{"blobId"},
		}, jmap.MailUsing)
		if err != nil {
			return die(s, err)
		}
		var got struct {
			List []struct {
				BlobID string `json:"blobId"`
			} `json:"list"`
		}
		if err := json.Unmarshal(meta, &got); err != nil {
			return die(s, err)
		}
		if len(got.List) == 0 || got.List[0].BlobID == "" {
			return die(s, bmio.NotFound(id+" not found"))
		}
		body, err := client.DownloadBlob(ctx, accountID, got.List[0].BlobID)
		if err != nil {
			return die(s, err)
		}
		s.OutRaw(string(body))
		return 0
	}

	raw, err := client.One(ctx, "Email/get", emailGetArgs{
		AccountID:           accountID,
		IDs:                 []string{id},
		Properties:          readProperties,
		FetchTextBodyValues: true,
	}, jmap.MailUsing)
	if err != nil {
		return die(s, err)
	}
	var got struct {
		List []json.RawMessage `json:"list"`
	}
	if err := json.Unmarshal(raw, &got); err != nil {
		return die(s, err)
	}
	if len(got.List) == 0 {
		return die(s, bmio.NotFound(id+" not found"))
	}
	email := got.List[0]

	fields, err := objectFields(email)
	if err != nil {
		return die(s, err)
	}

	// main.ts:1008 — the FIRST bodyValue in document order, not a part-id
	// lookup. `fetchTextBodyValues: true` means the server fills bodyValues for
	// the text parts only, so "the first one" IS the text body; an HTML-only
	// message therefore reads "(no text body)" rather than a tag soup, and
	// `--raw` is the documented way to see it (help.ts:250).
	text := firstBodyValue(fields["bodyValues"])

	if a.IDs { // §1.8 — the xargs shape outranks everything
		s.EmitIDs([]string{jsStringOr(fields["id"], id)})
		return 0
	}
	if a.JSON {
		// §1.3: a `show`-shaped command emits exactly ONE object on ONE line.
		// The object is the server's, key order and all, with bodyValues dropped
		// and `body` appended — `{...email, body, bodyValues: undefined}`
		// (main.ts:1016), where JSON.stringify omits the undefined.
		line, err := emailJSONLine(email, text)
		if err != nil {
			return die(s, err)
		}
		s.Out(line)
		return 0
	}

	s.Out("From:    " + formatAddrs(fields["from"]))
	s.Out("To:      " + formatAddrs(fields["to"]))
	if cc := formatAddrs(fields["cc"]); cc != "" {
		// Cc is printed only when there is one — main.ts:1021.
		s.Out("Cc:      " + cc)
	}
	s.Out("Subject: " + jsStringOr(fields["subject"], ""))
	s.Out("Date:    " + jsStringOf(fields["receivedAt"]))
	s.Out("")
	s.Out(text)
	return 0
}

// ---- JSON shaping ----------------------------------------------------------

// objectFields decodes a JSON object into its members without losing the raw
// bytes of each value.
func objectFields(raw json.RawMessage) (map[string]json.RawMessage, error) {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, err
	}
	return m, nil
}

// firstBodyValue is `Object.values(bodyValues)[0]?.value ?? "(no text body)"`
// (main.ts:1009). Document order matters — JS object key order for a parsed
// object is insertion order — so this walks the raw bytes rather than a Go map,
// whose iteration order is randomised.
func firstBodyValue(raw json.RawMessage) string {
	const none = "(no text body)"
	if len(raw) == 0 {
		return none
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	tok, err := dec.Token()
	if err != nil || tok != json.Delim('{') {
		return none
	}
	if !dec.More() {
		return none
	}
	if _, err := dec.Token(); err != nil { // the part id, which nothing reads
		return none
	}
	var part struct {
		Value *string `json:"value"`
	}
	if err := dec.Decode(&part); err != nil || part.Value == nil {
		return none
	}
	return *part.Value
}

// emailJSONLine renders the --json object: the server's own bytes, in the
// server's own key order, minus bodyValues, plus `body` at the end.
//
// Re-emitting the RAW value bytes (rather than decode → re-encode) is the same
// choice `approvals --json` makes: the server said it, so the CLI repeats it.
func emailJSONLine(email json.RawMessage, body string) (string, error) {
	dec := json.NewDecoder(bytes.NewReader(email))
	tok, err := dec.Token()
	if err != nil {
		return "", err
	}
	if tok != json.Delim('{') {
		return "", errNotObject
	}
	var b strings.Builder
	b.WriteByte('{')
	first := true
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return "", err
		}
		key, _ := keyTok.(string)
		var value json.RawMessage
		if err := dec.Decode(&value); err != nil {
			return "", err
		}
		if key == "bodyValues" {
			continue // `bodyValues: undefined` — JSON.stringify drops it
		}
		if !first {
			b.WriteByte(',')
		}
		first = false
		encoded, err := jsonValue(key)
		if err != nil {
			return "", err
		}
		b.WriteString(encoded)
		b.WriteByte(':')
		var compact bytes.Buffer
		if err := json.Compact(&compact, value); err != nil {
			return "", err
		}
		b.Write(compact.Bytes())
	}
	if !first {
		b.WriteByte(',')
	}
	encoded, err := jsonValue(body)
	if err != nil {
		return "", err
	}
	b.WriteString(`"body":`)
	b.WriteString(encoded)
	b.WriteByte('}')
	return b.String(), nil
}

var errNotObject = &bmio.CliError{Msg: "jmap: Email/get returned a non-object", Code: bmio.ExitFail}

// jsonValue encodes one value with HTML escaping OFF, so `<`, `>` and `&` match
// JSON.stringify byte for byte (bmio's own note on marshalCompact).
func jsonValue(v any) (string, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return "", err
	}
	return strings.TrimRight(buf.String(), "\n"), nil
}

// ---- human rendering -------------------------------------------------------

// formatAddrs is main.ts:1029: a non-array is "", and each address renders as
// `Name <addr>` when it has a name, else the bare address.
func formatAddrs(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var list []struct {
		Name  *string `json:"name"`
		Email string  `json:"email"`
	}
	if err := json.Unmarshal(raw, &list); err != nil {
		return "" // not an array → "" (`if (!Array.isArray(value)) return ""`)
	}
	parts := make([]string, 0, len(list))
	for _, a := range list {
		if a.Name != nil && *a.Name != "" {
			parts = append(parts, *a.Name+" <"+a.Email+">")
			continue
		}
		parts = append(parts, a.Email)
	}
	return strings.Join(parts, ", ")
}

// jsStringOr is `String(x ?? fallback)`: `??` catches BOTH undefined and null,
// so a missing key and an explicit JSON null both take the fallback.
// main.ts:1023 (`subject ?? ""`) and main.ts:1013 (`email.id ?? id`).
func jsStringOr(raw json.RawMessage, fallback string) string {
	if len(raw) == 0 || string(raw) == "null" {
		return fallback
	}
	return jsStringOf(raw)
}

// jsStringOf is bare `String(x)` — main.ts:1024's `String(email.receivedAt)`,
// which has no `??`, so an absent property really does print "undefined" and a
// null really does print "null". Faithful rather than tidy: a message with no
// receivedAt is a server bug, and printing "undefined" is how the TypeScript CLI
// says so.
func jsStringOf(raw json.RawMessage) string {
	if len(raw) == 0 {
		return "undefined"
	}
	var str string
	if err := json.Unmarshal(raw, &str); err == nil {
		return str
	}
	return string(raw) // null, a number or a boolean prints as its literal
}
