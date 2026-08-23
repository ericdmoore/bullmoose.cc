package cmd

// The fake mail server `read`, `send`, the triage verbs, `mailbox`, `show` and
// `blobs` are tested against, plus the mirror seed they read their base/token/
// accounts from.
//
// It records every method call VERBATIM, in order, because for `send` the call
// SEQUENCE is the thing under test: create the draft, then submit it, with the
// Drafts → Sent move riding on the submission. A test that only checked the exit
// code would pass against a port that submitted first and never noticed.
//
// It serves the session resource too, and deliberately advertises an apiUrl that
// is NOT `<base>/api/jmap`, so a client that hardcoded the path fails here — the
// same trap the contract suite's own stub sets (session.go).

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/jsobj"
)

// recordedCall is one method invocation the CLI sent.
type recordedCall struct {
	Name string
	Args json.RawMessage
}

// restCall is one request to a NON-JMAP endpoint. `blobs` reaches
// `/api/blobs/…` rather than a method (jmap.ts:218 records why there is no
// session template to resolve), so its "which request did we send" assertions —
// and its zero-request refusals — need their own log.
type uploadCall struct {
	BlobID string
	Type   string
	Body   []byte
}

type restCall struct {
	Method string
	Path   string
}

type mailFake struct {
	mu    sync.Mutex
	calls []recordedCall
	rest  []restCall
	// downloads records blob-download paths (the `read --raw` path).
	downloads []string

	// Fixtures, held as RAW JSON so a test can pin exactly what the server said
	// — which is what `read --json` re-emits.
	mailboxes  string
	identities string
	emails     map[string]string // id → raw email object
	queryIDs   []string

	// boxes is the MUTABLE mailbox list, as ordered raw JSON objects — the
	// `mailbox` verbs' subject. Nil means "serve the static `mailboxes` fixture
	// instead", which is what the read/send tests want. Raw strings rather than
	// structs because `mailbox --json` re-emits each object VERBATIM, so a test
	// has to be able to pin an unusual key order and watch it survive.
	boxes        []string
	mailboxState string
	// mailboxFull names the mailboxes that hold mail, so a destroy without
	// onDestroyRemoveEmails is refused with `mailboxHasEmail` exactly as
	// services/jmap/src/methods/mailbox.ts and smoke/server.mjs:168 do.
	mailboxFull map[string]bool
	newBoxes    int

	// blobList is `GET /api/blobs/{accountId}`'s body, raw for the same reason.
	blobList string
	// blobRefusals maps a blobId to the status + body a DELETE answers with,
	// mirroring smoke/server.mjs:457: `b_0` is a 409 whose reason word is in no
	// JMAP vocabulary, `b_boom` a 500.
	blobRefusals map[string]restRefusal
	// uploads records POST /api/upload bodies so a test can parse an imported
	// message BACK — the assertion that actually matters for buildMime.
	uploads  []uploadCall
	shares   []string
	emailSeq int
	// shareListing is GET /api/shares/{accountId}'s body, raw for the same
	// reason blobList is.
	shareListing string
	// vacation is VacationResponse/get's reply body; empty → a disabled one.
	vacation string

	// AgentInvocation fixtures (s43), raw for the same reason: `invocations
	// --json` re-emits the server's rows verbatim, so a test must be able to
	// pin a field the CLI predates and watch it survive.
	invocationIDs  string // AgentInvocation/query's ids array, e.g. `["inv_1"]`
	invocationList string // AgentInvocation/get's list array
	// refuseInvocation, when set, is the raw SetError EVERY AgentInvocation/set
	// create or destroy answers with — the disabled-binding / running-rm knob.
	refuseInvocation string
	// dossier is GET /console/agents/{accountId}'s body (s43 step 2), raw so a
	// test can pin projection fields the CLI predates and watch them survive.
	// dossierRefusal, when status≠0, answers instead — the console's three
	// different refusal sentences are the fixture's point.
	dossier        string
	dossierRefusal restRefusal
	// refuseBinding, when set, is the raw SetError every AgentBinding/set
	// update answers with — the kill switch's server-side refusals (s43 step 3).
	refuseBinding string

	// Refusal knobs.
	refuseSubmission string // "method" | "seterror" | ""
	// httpStatus, when non-zero, is the status EVERY JMAP POST and REST request
	// answers — the rejected-token / no-access fixture.
	httpStatus   int
	emptyMailbox bool

	// created holds the drafts Email/set made, so EmailSubmission/set can echo
	// the right emailId back.
	created map[string]string
	seq     int
	// state is the account's Email state, advanced by every MUTATING Email/set —
	// the axis --if-state and --dry-run turn on (sVOL 019 done-when #4/#5).
	state string
	// base is the httptest server's URL, filled in by start so the session
	// resource can advertise absolute apiUrl/downloadUrl.
	base string
}

// restRefusal is one canned non-2xx answer from the REST surface.
type restRefusal struct {
	status int
	body   string
}

func newMailFake() *mailFake {
	return &mailFake{
		mailboxes: `[{"id":"mb_inbox","name":"Inbox","role":"inbox"},` +
			`{"id":"mb_drafts","name":"Drafts","role":"drafts"},` +
			`{"id":"mb_sent","name":"Sent","role":"sent"}]`,
		identities: `[{"id":"id_1","email":"you@stub.test","name":"You","textSignature":"Eric\nbullmoose"},` +
			`{"id":"id_2","email":"alias@stub.test","name":"","textSignature":""}]`,
		emails:       map[string]string{},
		created:      map[string]string{},
		state:        "emstate-1",
		mailboxState: "mbstate-1",
		mailboxFull:  map[string]bool{},
		blobRefusals: map[string]restRefusal{},
	}
}

// withMailboxTree turns on the MUTABLE mailbox fixture the `mailbox` verbs need.
// The key order below is deliberately NOT the CLI's own struct order — id last,
// an extra property the CLI does not model — because `mailbox --json` re-emits
// these objects and the test that matters is that they come back unchanged.
func (f *mailFake) withMailboxTree() *mailFake {
	f.boxes = []string{
		`{"sortOrder":0,"name":"Inbox","role":"inbox","id":"mb_inbox","parentId":null,"totalEmails":3}`,
		`{"sortOrder":1,"name":"Full","role":null,"id":"mb_full","parentId":null,"totalEmails":3}`,
		`{"sortOrder":2,"name":"Empty","role":null,"id":"mb_empty","parentId":null,"totalEmails":0}`,
		`{"sortOrder":3,"name":"Quarantined","role":"junk","id":"mb_junk","parentId":null,"totalEmails":0}`,
	}
	f.mailboxFull["mb_full"] = true
	return f
}

// applySet is the triage half of Email/set: RFC 8620 PatchObject semantics over
// `keywords` and `mailboxIds`, plus destroy, plus the RFC 8621 guard that an
// email must belong to at least one mailbox — the same model
// packages/cli/smoke/server.mjs runs, so a triage test here and the contract
// suite are measuring the same server behaviour.
//
// It MUTATES the fixture, which is what makes the reconcile assertions real: the
// Email/get the CLI issues after a write returns the message as it now is, so a
// mirror row that disagrees is the port's fault and not the fake's.
// updateOrder is the request's key order. A real server answers `updated` in the
// order it processed the request (a JS object preserves insertion order), and the
// CLI echoes that order verbatim to match Node byte for byte. Ranging a Go MAP
// here instead made the fake's answer RANDOM — it passed locally and failed in
// CI, which is the whole reason this parameter exists.
func (f *mailFake) applySet(update map[string]json.RawMessage, updateOrder []string, destroy []string) string {
	updated, notUpdated, destroyed, notDestroyed := []string{}, []string{}, []string{}, []string{}
	mutated := false

	for _, id := range updateOrder {
		rawPatch := update[id]
		raw, ok := f.emails[id]
		if !ok {
			notUpdated = append(notUpdated, fmt.Sprintf(`%q:{"type":"notFound"}`, id))
			continue
		}
		var email map[string]any
		_ = json.Unmarshal([]byte(raw), &email)
		var patch map[string]any
		_ = json.Unmarshal(rawPatch, &patch)

		keywords := setOf(email["keywords"])
		mailboxes := setOf(email["mailboxIds"])
		touchedMailboxes := false
		bad := ""
		for path, value := range patch {
			head, sub, _ := strings.Cut(path, "/")
			switch head {
			case "keywords":
				applyPatchKey(keywords, sub, value)
			case "mailboxIds":
				touchedMailboxes = true
				applyPatchKey(mailboxes, sub, value)
			default:
				bad = "unknown path " + path
			}
		}
		if bad != "" {
			notUpdated = append(notUpdated,
				fmt.Sprintf(`%q:{"type":"invalidProperties","description":%q}`, id, bad))
			continue
		}
		// email.ts:403 — the guard the CLI is supposed to pre-empt client-side.
		if touchedMailboxes && len(mailboxes) == 0 {
			notUpdated = append(notUpdated, fmt.Sprintf(
				`%q:{"type":"invalidProperties","description":"an email must belong to at least one mailbox"}`, id))
			continue
		}
		email["keywords"] = keywords
		email["mailboxIds"] = mailboxes
		out, _ := json.Marshal(email)
		f.emails[id] = string(out)
		updated = append(updated, fmt.Sprintf(`%q:null`, id))
		mutated = true
	}

	for _, id := range destroy {
		if _, ok := f.emails[id]; !ok {
			notDestroyed = append(notDestroyed, fmt.Sprintf(`%q:{"type":"notFound"}`, id))
			continue
		}
		delete(f.emails, id)
		for i, qid := range f.queryIDs {
			if qid == id {
				f.queryIDs = append(f.queryIDs[:i], f.queryIDs[i+1:]...)
				break
			}
		}
		destroyed = append(destroyed, fmt.Sprintf("%q", id))
		mutated = true
	}

	oldState := f.state
	if mutated {
		f.state = "emstate-" + strconv.Itoa(len(f.calls)+1)
	}
	return fmt.Sprintf(`{"accountId":"a_you","oldState":%q,"newState":%q,`+
		`"created":{},"notCreated":{},"updated":{%s},"notUpdated":{%s},`+
		`"destroyed":[%s],"notDestroyed":{%s}}`,
		oldState, f.state, strings.Join(updated, ","), strings.Join(notUpdated, ","),
		strings.Join(destroyed, ","), strings.Join(notDestroyed, ","))
}

// applyMailboxSet is the Mailbox/set half of the fake — see the call site for
// why it models the server rather than echoing the request.
//
// Both key orders are passed IN because a Go map has none: `create` decides which
// client id is answered first, and `update`'s patch is Object.assign'd in
// insertion order. The same lesson as updateKeyOrder's note — a fake that ranged
// a map here would answer randomly, pass locally, and fail in CI.
func (f *mailFake) applyMailboxSet(create map[string]json.RawMessage, createOrder []string,
	update map[string]json.RawMessage, updateOrder []string, destroy []string, removeEmails bool) string {
	created, notCreated := []string{}, []string{}
	updated, notUpdated := []string{}, []string{}
	destroyed, notDestroyed := []string{}, []string{}
	mutated := false

	find := func(id string) (int, *jsobj.Object) {
		for i, raw := range f.boxes {
			box, err := jsobj.Parse([]byte(raw))
			if err != nil {
				continue
			}
			if got, _ := box.Str("id"); got == id {
				return i, box
			}
		}
		return -1, nil
	}

	for _, cid := range createOrder {
		spec, err := jsobj.Parse(create[cid])
		if err != nil {
			notCreated = append(notCreated, fmt.Sprintf(`%q:{"type":"invalidProperties"}`, cid))
			continue
		}
		f.newBoxes++
		id := fmt.Sprintf("mb_new_%d", f.newBoxes)
		parent := "null"
		if raw, ok := spec.Raw("parentId"); ok {
			parent = string(raw)
		}
		order := "0"
		if raw, ok := spec.Raw("sortOrder"); ok {
			order = string(raw)
		}
		name, _ := spec.Str("name")
		f.boxes = append(f.boxes, fmt.Sprintf(
			`{"id":%q,"parentId":%s,"name":%q,"role":null,"sortOrder":%s}`, id, parent, name, order))
		created = append(created, fmt.Sprintf(`%q:{"id":%q,"role":null,"sortOrder":%s}`, cid, id, order))
		mutated = true
	}

	for _, id := range updateOrder {
		i, box := find(id)
		if box == nil {
			notUpdated = append(notUpdated, fmt.Sprintf(`%q:{"type":"notFound"}`, id))
			continue
		}
		patch, err := jsobj.Parse(update[id])
		if err != nil {
			notUpdated = append(notUpdated, fmt.Sprintf(`%q:{"type":"invalidPatch"}`, id))
			continue
		}
		// Object.assign(box, patch): an existing key keeps its position, a new
		// one lands at the end.
		for _, key := range patch.Keys() {
			raw, _ := patch.Raw(key)
			box.SetRaw(key, raw)
		}
		encoded, err := box.MarshalJSON()
		if err != nil {
			notUpdated = append(notUpdated, fmt.Sprintf(`%q:{"type":"serverFail"}`, id))
			continue
		}
		f.boxes[i] = string(encoded)
		updated = append(updated, fmt.Sprintf(`%q:null`, id))
		mutated = true
	}

	for _, id := range destroy {
		i, box := find(id)
		if box == nil {
			notDestroyed = append(notDestroyed, fmt.Sprintf(`%q:{"type":"notFound"}`, id))
			continue
		}
		if f.mailboxFull[id] && !removeEmails {
			notDestroyed = append(notDestroyed, fmt.Sprintf(
				`%q:{"type":"mailboxHasEmail","description":"3 messages"}`, id))
			continue
		}
		f.boxes = append(f.boxes[:i], f.boxes[i+1:]...)
		destroyed = append(destroyed, fmt.Sprintf("%q", id))
		mutated = true
	}

	oldState := f.mailboxState
	if mutated {
		n, _ := strconv.Atoi(strings.TrimPrefix(f.mailboxState, "mbstate-"))
		f.mailboxState = "mbstate-" + strconv.Itoa(n+1)
	}
	return fmt.Sprintf(`{"accountId":"a_you","oldState":%q,"newState":%q,`+
		`"created":{%s},"notCreated":{%s},"updated":{%s},"notUpdated":{%s},`+
		`"destroyed":[%s],"notDestroyed":{%s}}`,
		oldState, f.mailboxState,
		strings.Join(created, ","), strings.Join(notCreated, ","),
		strings.Join(updated, ","), strings.Join(notUpdated, ","),
		strings.Join(destroyed, ","), strings.Join(notDestroyed, ","))
}

// boxNames is the fake's current mailbox list, by name, for the assertions that
// a refused write changed NOTHING.
func (f *mailFake) boxNames() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, 0, len(f.boxes))
	for _, raw := range f.boxes {
		box, err := jsobj.Parse([]byte(raw))
		if err != nil {
			continue
		}
		name, _ := box.Str("name")
		out = append(out, name)
	}
	return out
}

// setOf reads a JMAP `{id: true}` set out of a decoded email object.
func setOf(v any) map[string]any {
	out := map[string]any{}
	if m, ok := v.(map[string]any); ok {
		for k, on := range m {
			if on == true {
				out[k] = true
			}
		}
	}
	return out
}

// applyPatchKey is RFC 8620 §5.3's PatchObject over one set: no sub-path is a
// whole-property REPLACE, a sub-path with true adds, and null/false removes.
func applyPatchKey(target map[string]any, sub string, value any) {
	if sub == "" {
		for k := range target {
			delete(target, k)
		}
		if m, ok := value.(map[string]any); ok {
			for k, on := range m {
				if on == true {
					target[k] = true
				}
			}
		}
		return
	}
	if value == true {
		target[sub] = true
		return
	}
	delete(target, sub)
}

// addEmail registers a fixture message. The raw JSON is returned by Email/get
// unchanged, so a test controls both the values AND their key order.
func (f *mailFake) addEmail(id, raw string) {
	f.emails[id] = raw
	f.queryIDs = append(f.queryIDs, id)
}

// addTriageEmail registers a message with the FULL mirror property set, so the
// Email/get a triage verb issues to reconcile finds every column sync.ts writes.
// mailboxes/keywords are what the verbs move and flag.
func (f *mailFake) addTriageEmail(id string, mailboxes []string, keywords []string) {
	set := func(keys []string) string {
		parts := make([]string, len(keys))
		for i, k := range keys {
			parts[i] = fmt.Sprintf(`%q:true`, k)
		}
		return "{" + strings.Join(parts, ",") + "}"
	}
	f.addEmail(id, fmt.Sprintf(`{"id":%q,"blobId":"b_%s","threadId":"th_%s",`+
		`"mailboxIds":%s,"keywords":%s,"size":42,`+
		`"receivedAt":"2026-08-01T00:00:00.000Z","messageId":["<%s@stub.test>"],`+
		`"inReplyTo":null,"from":[{"name":"Sender","email":"s@stub.test"}],`+
		`"to":[{"name":null,"email":"you@stub.test"}],"cc":null,"bcc":null,`+
		`"subject":"subject of %s","hasAttachment":false,"preview":"preview","attachments":[]}`,
		id, id, id, set(mailboxes), set(keywords), id, id))
}

// mailboxesOf reads a message's current mailbox membership OUT OF THE FAKE — the
// server's view, as against the mirror's. A triage test that only checked the
// mirror could not tell a real Email/set from a local-only write (019 done-when
// #2, the choreography assertion).
func (f *mailFake) mailboxesOf(id string) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var e struct {
		MailboxIDs map[string]bool `json:"mailboxIds"`
	}
	_ = json.Unmarshal([]byte(f.emails[id]), &e)
	out := make([]string, 0, len(e.MailboxIDs))
	for k := range e.MailboxIDs {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// keywordsOf is mailboxesOf for keywords.
func (f *mailFake) keywordsOf(id string) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var e struct {
		Keywords map[string]bool `json:"keywords"`
	}
	_ = json.Unmarshal([]byte(f.emails[id]), &e)
	out := make([]string, 0, len(e.Keywords))
	for k := range e.Keywords {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// exists reports whether the fake still holds a message — `rm --force`'s subject.
func (f *mailFake) exists(id string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	_, ok := f.emails[id]
	return ok
}

func (f *mailFake) start(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(f.handle))
	t.Cleanup(srv.Close)
	f.base = srv.URL
	return srv
}

func (f *mailFake) handle(w http.ResponseWriter, r *http.Request) {
	if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
		w.WriteHeader(401)
		_, _ = w.Write([]byte(`{"error":"bad token"}`))
		return
	}
	switch {
	case r.URL.Path == "/.well-known/jmap":
		w.Header().Set("content-type", "application/json")
		fmt.Fprintf(w, `{"username":"you@stub.test","accounts":{},"primaryAccounts":{},`+
			`"apiUrl":%q,"downloadUrl":%q}`,
			f.base+"/jmap-endpoint",
			f.base+"/dl/{accountId}/{blobId}/{name}/{type}")
		return
	case strings.HasPrefix(r.URL.Path, "/console/agents/"):
		f.mu.Lock()
		f.rest = append(f.rest, restCall{Method: r.Method, Path: r.URL.EscapedPath()})
		body, refusal := f.dossier, f.dossierRefusal
		f.mu.Unlock()
		w.Header().Set("content-type", "application/json")
		if refusal.status != 0 {
			w.WriteHeader(refusal.status)
			_, _ = w.Write([]byte(refusal.body))
			return
		}
		if body == "" {
			body = `{"accountId":"a_you","principalId":"p_you","principal":"you@stub.test",` +
				`"tokenScopes":["read"],"bindings":[],"invocations":[],"ledgers":[],"ledgerMonthStart":1754006400000}`
		}
		_, _ = w.Write([]byte(body))
		return
	case strings.HasPrefix(r.URL.Path, "/api/shares/"):
		f.mu.Lock()
		f.rest = append(f.rest, restCall{Method: r.Method, Path: r.URL.EscapedPath()})
		body := f.shareListing
		f.mu.Unlock()
		w.Header().Set("content-type", "application/json")
		if r.Method == http.MethodPost {
			segs := strings.Split(r.URL.Path, "/")
			id := segs[len(segs)-2] // .../{shareId}/revoke
			fmt.Fprintf(w, `{"shareId":%q,"alreadyRevoked":false,"note":"revoked; edges may serve it for up to a minute"}`, id)
			return
		}
		if body == "" {
			body = `{"accountId":"a_you","shares":[]}`
		}
		_, _ = w.Write([]byte(body))
		return
	case strings.HasPrefix(r.URL.Path, "/api/upload/"):
		body, _ := io.ReadAll(r.Body)
		f.mu.Lock()
		f.rest = append(f.rest, restCall{Method: r.Method, Path: r.URL.EscapedPath()})
		n := len(f.uploads)
		id := fmt.Sprintf("blob_up_%d", n+1)
		f.uploads = append(f.uploads, uploadCall{BlobID: id, Type: r.Header.Get("Content-Type"), Body: body})
		f.mu.Unlock()
		w.Header().Set("content-type", "application/json")
		fmt.Fprintf(w, `{"blobId":%q,"size":%d}`, id, len(body))
		return
	case strings.HasPrefix(r.URL.Path, "/api/share/"):
		f.mu.Lock()
		f.rest = append(f.rest, restCall{Method: r.Method, Path: r.URL.EscapedPath()})
		n := len(f.shares)
		f.shares = append(f.shares, r.URL.EscapedPath())
		f.mu.Unlock()
		w.Header().Set("content-type", "application/json")
		fmt.Fprintf(w, `{"url":"https://links.stub.test/s/%d","expiresAt":"2026-09-21T00:00:00Z"}`, n+1)
		return
	case strings.HasPrefix(r.URL.Path, "/api/blobs/"):
		f.mu.Lock()
		// EscapedPath, not Path: the assertion is about what encodeURIComponent
		// produced, and net/http decodes %2F back to a slash in Path.
		f.rest = append(f.rest, restCall{Method: r.Method, Path: r.URL.EscapedPath()})
		status := f.httpStatus
		f.mu.Unlock()
		if status != 0 {
			w.Header().Set("content-type", "application/json")
			w.WriteHeader(status)
			_, _ = w.Write([]byte(`{"error":"forbidden"}`))
			return
		}
		f.mu.Lock()
		refusal, refused := restRefusal{}, false
		if r.Method == http.MethodDelete {
			segments := strings.Split(r.URL.Path, "/")
			refusal, refused = f.blobRefusals[segments[len(segments)-1]]
		}
		list := f.blobList
		f.mu.Unlock()
		w.Header().Set("content-type", "application/json")
		if refused {
			w.WriteHeader(refusal.status)
			_, _ = w.Write([]byte(refusal.body))
			return
		}
		if r.Method == http.MethodDelete {
			segments := strings.Split(r.URL.Path, "/")
			fmt.Fprintf(w, `{"blobId":%q,"deleted":true}`, segments[len(segments)-1])
			return
		}
		if list == "" {
			list = `{"accountId":"a_you","blobs":[],"totalSize":0}`
		}
		_, _ = w.Write([]byte(list))
		return
	case strings.HasPrefix(r.URL.Path, "/dl/"):
		f.mu.Lock()
		// EscapedPath, not Path: the assertion is about what encodeURIComponent
		// produced, and net/http decodes %2F back to a slash in Path.
		f.downloads = append(f.downloads, r.URL.EscapedPath())
		f.mu.Unlock()
		w.Header().Set("content-type", "message/rfc822")
		_, _ = w.Write([]byte("Subject: raw\r\n\r\nraw body\r\n"))
		return
	case r.URL.Path != "/jmap-endpoint":
		w.WriteHeader(404)
		return
	}
	if f.httpStatus != 0 {
		w.WriteHeader(f.httpStatus)
		_, _ = w.Write([]byte(`{"error":"forbidden"}`))
		return
	}

	var req struct {
		MethodCalls [][]json.RawMessage `json:"methodCalls"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, 0, len(req.MethodCalls))
	for _, mc := range req.MethodCalls {
		var name, callID string
		_ = json.Unmarshal(mc[0], &name)
		_ = json.Unmarshal(mc[2], &callID)
		f.calls = append(f.calls, recordedCall{Name: name, Args: mc[1]})
		out = append(out, f.invoke(name, mc[1], callID))
	}
	w.Header().Set("content-type", "application/json")
	fmt.Fprintf(w, `{"methodResponses":[%s]}`, strings.Join(out, ","))
}

func (f *mailFake) invoke(name string, args json.RawMessage, callID string) string {
	reply := func(result string) string {
		return fmt.Sprintf(`[%q,%s,%q]`, name, result, callID)
	}
	fail := func(typ, description string) string {
		if description == "" {
			return fmt.Sprintf(`["error",{"type":%q},%q]`, typ, callID)
		}
		return fmt.Sprintf(`["error",{"type":%q,"description":%q},%q]`, typ, description, callID)
	}
	switch name {
	case "Mailbox/get":
		if f.boxes != nil {
			return reply(fmt.Sprintf(`{"accountId":"a_you","state":%q,"list":[%s]}`,
				f.mailboxState, strings.Join(f.boxes, ",")))
		}
		return reply(`{"accountId":"a_you","state":"1","list":` + f.mailboxes + `}`)

	case "Mailbox/set":
		// The same model services/jmap/src/methods/mailbox.ts and
		// packages/cli/smoke/server.mjs:120 run, so a `mailbox` test here and the
		// contract suite are measuring the same server behaviour: ifInState
		// refuses the WHOLE method before touching anything, a create mints an
		// id, an update is Object.assign over the stored object, and a destroy of
		// a folder that holds mail is refused unless onDestroyRemoveEmails.
		var a struct {
			IfInState             *string                    `json:"ifInState"`
			Create                map[string]json.RawMessage `json:"create"`
			Update                map[string]json.RawMessage `json:"update"`
			Destroy               []string                   `json:"destroy"`
			OnDestroyRemoveEmails bool                       `json:"onDestroyRemoveEmails"`
		}
		_ = json.Unmarshal(args, &a)
		if a.IfInState != nil && *a.IfInState != f.mailboxState {
			return fail("stateMismatch", "")
		}
		return reply(f.applyMailboxSet(a.Create, objectKeyOrder(args, "create"),
			a.Update, objectKeyOrder(args, "update"), a.Destroy, a.OnDestroyRemoveEmails))
	case "Identity/get":
		return reply(`{"accountId":"a_you","state":"1","list":` + f.identities + `}`)
	case "Email/query":
		if f.emptyMailbox {
			return reply(`{"accountId":"a_you","queryState":"1","position":0,"ids":[]}`)
		}
		ids, _ := json.Marshal(f.queryIDs)
		return reply(`{"accountId":"a_you","queryState":"1","position":0,"ids":` + string(ids) + `}`)
	case "Email/get":
		var a struct {
			IDs []string `json:"ids"`
		}
		_ = json.Unmarshal(args, &a)
		var list []string
		var notFound []string
		for _, id := range a.IDs {
			if raw, ok := f.emails[id]; ok {
				list = append(list, raw)
				continue
			}
			notFound = append(notFound, id)
		}
		nf, _ := json.Marshal(notFound)
		return reply(fmt.Sprintf(`{"accountId":"a_you","state":"1","list":[%s],"notFound":%s}`,
			strings.Join(list, ","), nf))
	case "Identity/set":
		var iset struct {
			Create  map[string]json.RawMessage `json:"create"`
			Update  map[string]json.RawMessage `json:"update"`
			Destroy []string                   `json:"destroy"`
		}
		_ = json.Unmarshal(args, &iset)
		parts := []string{`"accountId":"a_you"`, `"newState":"idstate-2"`}
		if len(iset.Create) > 0 {
			var made []string
			n := 0
			for cid := range iset.Create {
				n++
				made = append(made, fmt.Sprintf(`%q:{"id":"id_new_%d"}`, cid, n))
			}
			parts = append(parts, `"created":{`+strings.Join(made, ",")+`}`)
		}
		if len(iset.Update) > 0 {
			var upd []string
			for id := range iset.Update {
				upd = append(upd, fmt.Sprintf("%q:null", id))
			}
			parts = append(parts, `"updated":{`+strings.Join(upd, ",")+`}`)
		}
		if len(iset.Destroy) > 0 {
			b, _ := json.Marshal(iset.Destroy)
			parts = append(parts, `"destroyed":`+string(b))
		}
		return reply(`{` + strings.Join(parts, ",") + `}`)
	case "VacationResponse/get":
		v := f.vacation
		if v == "" {
			v = `{"accountId":"a_you","list":[{"id":"singleton","isEnabled":false}]}`
		}
		return reply(v)
	case "VacationResponse/set":
		return reply(`{"accountId":"a_you","newState":"v2","updated":{"singleton":null}}`)
	case "AgentInvocation/query":
		ids := f.invocationIDs
		if ids == "" {
			ids = "[]"
		}
		return reply(fmt.Sprintf(`{"accountId":"a_you","ids":%s}`, ids))
	case "AgentInvocation/get":
		list := f.invocationList
		if list == "" {
			list = "[]"
		}
		return reply(fmt.Sprintf(`{"accountId":"a_you","state":"agstate-1","list":%s}`, list))
	case "AgentInvocation/set":
		var set struct {
			Create  map[string]json.RawMessage `json:"create"`
			Destroy []string                   `json:"destroy"`
		}
		_ = json.Unmarshal(args, &set)
		if len(set.Create) > 0 {
			if f.refuseInvocation != "" {
				return reply(fmt.Sprintf(`{"accountId":"a_you","notCreated":{"c":%s}}`, f.refuseInvocation))
			}
			f.seq++
			return reply(fmt.Sprintf(
				`{"accountId":"a_you","created":{"c":{"id":"inv_new_%d","status":"pending"}},"newState":"agstate-2"}`, f.seq))
		}
		if len(set.Destroy) > 0 {
			if f.refuseInvocation != "" {
				return reply(fmt.Sprintf(`{"accountId":"a_you","notDestroyed":{%q:%s}}`,
					set.Destroy[0], f.refuseInvocation))
			}
			d, _ := json.Marshal(set.Destroy)
			return reply(fmt.Sprintf(`{"accountId":"a_you","destroyed":%s,"newState":"agstate-2"}`, d))
		}
		return fail("invalidArguments", "empty AgentInvocation/set")
	case "AgentBinding/set":
		var set struct {
			Update map[string]struct {
				Enabled *bool `json:"enabled"`
			} `json:"update"`
		}
		_ = json.Unmarshal(args, &set)
		for id, u := range set.Update {
			if f.refuseBinding != "" {
				return reply(fmt.Sprintf(`{"accountId":"a_you","notUpdated":{%q:%s}}`, id, f.refuseBinding))
			}
			enabled := "true"
			if u.Enabled != nil && !*u.Enabled {
				enabled = "false"
			}
			return reply(fmt.Sprintf(`{"accountId":"a_you","updated":{%q:{"enabled":%s}}}`, id, enabled))
		}
		return fail("invalidArguments", "empty AgentBinding/set")
	case "Email/import":
		var imp struct {
			Emails map[string]struct {
				BlobID string `json:"blobId"`
			} `json:"emails"`
		}
		_ = json.Unmarshal(args, &imp)
		created := make([]string, 0, len(imp.Emails))
		for cid := range imp.Emails {
			f.emailSeq++
			created = append(created, fmt.Sprintf("%q:{\"id\":\"em_new_%d\"}", cid, f.emailSeq))
		}
		return reply(`{"accountId":"a_you","created":{` + strings.Join(created, ",") + `}}`)
	case "Email/set":
		var a struct {
			IfInState *string                    `json:"ifInState"`
			Create    map[string]json.RawMessage `json:"create"`
			Update    map[string]json.RawMessage `json:"update"`
			Destroy   []string                   `json:"destroy"`
		}
		_ = json.Unmarshal(args, &a)
		// ifInState is honoured exactly as services/jmap/src/methods/email.ts:234
		// does: refuse the WHOLE method before touching anything, so the triage
		// tests can assert both halves of "exit 5 and changed nothing".
		if a.IfInState != nil && *a.IfInState != f.state {
			return fail("stateMismatch", "")
		}
		if len(a.Update) > 0 || len(a.Destroy) > 0 {
			return reply(f.applySet(a.Update, updateKeyOrder(args), a.Destroy))
		}
		created := []string{}
		for cid := range a.Create {
			f.seq++
			id := fmt.Sprintf("em_new_%d", f.seq)
			f.created[cid] = id
			// The draft is registered so the post-send reconcile's Email/get
			// finds it, with the mirror-shaped properties that reconcile asks for.
			f.emails[id] = fmt.Sprintf(`{"id":%q,"blobId":"b_1","threadId":"th_1",`+
				`"mailboxIds":{"mb_sent":true},"keywords":{"$seen":true},"size":42,`+
				`"receivedAt":"2026-08-01T00:00:00.000Z","messageId":["<1@stub.test>"],`+
				`"inReplyTo":null,"from":[{"name":"You","email":"you@stub.test"}],`+
				`"to":[{"name":null,"email":"a@b.com"}],"cc":null,"bcc":null,`+
				`"subject":"hi","hasAttachment":false,"preview":"p","attachments":[]}`, id)
			created = append(created, fmt.Sprintf(`%q:{"id":%q}`, cid, id))
		}
		return reply(fmt.Sprintf(`{"accountId":"a_you","oldState":"1","newState":"2",`+
			`"created":{%s},"notCreated":{},"updated":{},"notUpdated":{}}`, strings.Join(created, ",")))
	case "EmailSubmission/set":
		if f.refuseSubmission == "method" {
			// The scope wall: services/jmap/src/methods/common.ts:110 via
			// packages/auth-core/src/principal.ts:277.
			return fail("forbidden", `token lacks the "send" scope`)
		}
		if f.refuseSubmission == "seterror" {
			// A per-object refusal, submission.ts:150's catch — the shape an
			// outbound-bound refusal would take.
			return reply(`{"accountId":"a_you","oldState":"2","newState":"2","created":{},` +
				`"notCreated":{"s":{"type":"forbidden","description":"recipient(s) not in the governing book: x@y.test"}}}`)
		}
		var a struct {
			Create map[string]struct {
				EmailID string `json:"emailId"`
			} `json:"create"`
		}
		_ = json.Unmarshal(args, &a)
		created := []string{}
		for cid, spec := range a.Create {
			f.seq++
			created = append(created, fmt.Sprintf(`%q:{"id":"es_%d","emailId":%q}`, cid, f.seq, spec.EmailID))
		}
		return reply(fmt.Sprintf(`{"accountId":"a_you","oldState":"2","newState":"3",`+
			`"created":{%s},"notCreated":{}}`, strings.Join(created, ",")))
	default:
		return fail("unknownMethod", name)
	}
}

// reset clears the recorded calls, for a test that drives two invocations.
func (f *mailFake) reset() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = nil
}

// names is the recorded call sequence, for the assertion that matters most.
func (f *mailFake) names() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, len(f.calls))
	for i, c := range f.calls {
		out[i] = c.Name
	}
	return out
}

// argsOf returns the raw args of the first call to a method.
func (f *mailFake) argsOf(method string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range f.calls {
		if c.Name == method {
			return string(c.Args)
		}
	}
	return ""
}

// ---- mirror seed -----------------------------------------------------------

// seedMailMirror writes the config the commands read (base/token/accounts) plus
// the mirror tables `read`'s owner lookup and `send`'s reconcile touch. The
// schema is the subset of packages/mailstore/sql/data-plane.sql + db.ts's
// LOCAL_SCHEMA those two use.
func seedMailMirror(t *testing.T, base, token string, accounts string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "mail.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("open seed db: %v", err)
	}
	defer db.Close()
	for _, stmt := range []string{
		`CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
		`CREATE TABLE emails (
		   id TEXT NOT NULL, account_id TEXT NOT NULL, blob_id TEXT NOT NULL,
		   thread_id TEXT NOT NULL, message_id TEXT, in_reply_to TEXT,
		   subject TEXT NOT NULL DEFAULT '', from_json TEXT NOT NULL DEFAULT '[]',
		   to_json TEXT NOT NULL DEFAULT '[]', cc_json TEXT NOT NULL DEFAULT '[]',
		   bcc_json TEXT NOT NULL DEFAULT '[]', preview TEXT NOT NULL DEFAULT '',
		   size INTEGER NOT NULL, received_at INTEGER NOT NULL,
		   has_attachment INTEGER NOT NULL DEFAULT 0,
		   attachments_json TEXT NOT NULL DEFAULT '[]',
		   -- The provenance columns (s03.A T1) are here because show --json emits
		   -- SELECT * — every column the mirror declares, in DECLARATION ORDER.
		   -- A seed missing them would let a port pass while emitting a shorter
		   -- object than the Node CLI does against a real mirror.
		   last_writer_principal TEXT,
		   last_writer_binding TEXT,
		   last_writer_invocation TEXT,
		   PRIMARY KEY (account_id, id))`,
		`CREATE TABLE email_mailboxes (account_id TEXT, email_id TEXT, mailbox_id TEXT,
		   PRIMARY KEY (account_id, email_id, mailbox_id))`,
		`CREATE TABLE email_keywords (account_id TEXT, email_id TEXT, keyword TEXT,
		   PRIMARY KEY (account_id, email_id, keyword))`,
		`CREATE VIRTUAL TABLE cli_fts USING fts5 (
		   email_id UNINDEXED, subject, from_text, to_text, preview, tokenize='unicode61')`,
		// The triage verbs resolve `--role archive` out of the mirror first, and
		// their reconcile leaves sync_state alone — both need the tables to exist.
		`CREATE TABLE mailboxes (id TEXT NOT NULL, account_id TEXT NOT NULL, parent_id TEXT,
		   name TEXT NOT NULL, role TEXT, sort_order INTEGER NOT NULL DEFAULT 0,
		   PRIMARY KEY (account_id, id))`,
		`CREATE TABLE sync_state (account_id TEXT PRIMARY KEY, email_state TEXT,
		   mailbox_state TEXT, last_sync INTEGER)`,
	} {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatalf("seed schema: %v", err)
		}
	}
	ins := func(k, v string) {
		if _, err := db.Exec(`INSERT INTO config(key,value) VALUES(?,?)`, k, v); err != nil {
			t.Fatalf("insert %s: %v", k, err)
		}
	}
	ins("base", base)
	ins("token", token)
	ins("accountId", "a_you")
	if accounts == "" {
		accounts = `[{"accountId":"a_you","address":"you@stub.test","name":"You"}]`
	}
	ins("accounts", accounts)
	return path
}

// runCmd invokes one native command with captured streams and an appended --db.
func runCmd(t *testing.T, run func(*bmio.Streams, []string) int, dbPath, command string, argv ...string) (out, errOut string, code int) {
	t.Helper()
	var o, e strings.Builder
	s := bmio.NewTo(&o, &e)
	args := append([]string{command}, argv...)
	args = append(args, "--db", dbPath)
	code = run(s, args)
	return o.String(), e.String(), code
}

// withStdin points os.Stdin at a file for the duration of a test, so the
// stdin-fallback branch of readInput is exercised deterministically rather than
// depending on how the test binary was launched.
func withStdin(t *testing.T, content string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "stdin")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	prev := os.Stdin
	os.Stdin = f
	t.Cleanup(func() {
		os.Stdin = prev
		_ = f.Close()
	})
}

// updateKeyOrder reads `update`'s keys in DOCUMENT order. json.Unmarshal into a
// map discards that order and Go then randomises iteration, so the fake needs
// the raw bytes to answer the way a real server does.
func updateKeyOrder(args json.RawMessage) []string { return objectKeyOrder(args, "update") }

// objectKeyOrder is updateKeyOrder for any member — `create` needs the same
// treatment, and so would any future id-keyed argument. Same lesson, stated once:
// a Go map has no order, and ranging one made the fake's answer differ between
// runs, which passed locally and failed in CI.
func objectKeyOrder(args json.RawMessage, member string) []string {
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(args, &envelope); err != nil {
		return nil
	}
	raw, ok := envelope[member]
	if !ok || len(raw) == 0 {
		return nil
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	if tok, err := dec.Token(); err != nil {
		return nil
	} else if delim, ok := tok.(json.Delim); !ok || delim != '{' {
		return nil
	}
	var keys []string
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return keys
		}
		key, _ := tok.(string)
		keys = append(keys, key)
		var skip json.RawMessage
		if err := dec.Decode(&skip); err != nil {
			return keys
		}
	}
	return keys
}
