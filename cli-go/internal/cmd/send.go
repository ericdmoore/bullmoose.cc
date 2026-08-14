package cmd

// `bullmoose send` — compose and submit (s08 T6 wave 2), a port of main.ts:568
// cmdSend.
//
// This is the first PORTED command that mutates anything, and the mutation is
// IRREVERSIBLE: there is no unsend. Three consequences shape the code below.
//
//  1. Every refusal happens as EARLY as the TypeScript refuses it, and in the
//     same order. `send` with no --to costs ZERO requests in both
//     implementations — the recipient check sits above the first round trip
//     (main.ts:589), so a mistyped invocation cannot half-send.
//  2. The native path owns ONLY the plain-text send. `--expandMD html` (the
//     Markdown → MIME pipeline: marked, processAssets, buildMime, blob upload,
//     expiring share links) is NOT ported, and registry.go deliberately leaves
//     its flags out of `send`'s owned set so such an invocation delegates to Node
//     whole. Approximating that path would mean sending a different message than
//     the user wrote.
//  3. The account is resolved through account.One — the cli/009 rule — so an
//     ambiguous --account is refused rather than silently resolved to the first
//     match. devPlan.md:151 predicted this seam would first bite on a
//     single-account WRITE going native; this is that write.
//
// The choreography is RFC 8621's, and the order is load-bearing: create the
// draft, THEN submit it, with the Drafts → Sent move riding on the submission's
// own success (onSuccessUpdateEmail). Submitting before the draft exists is not a
// reordering, it is a different protocol — the server has nothing to relay.

import (
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"os"
	"strconv"
	"strings"

	"golang.org/x/term"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/account"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/jmap"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/store"
)

// sigSep is RFC 3676 §4.3's signature separator — identity.ts:66 SIG_SEP. A line
// of exactly "-- " is what lets a reply strip the signature instead of quoting it.
const sigSep = "\n-- \n"

// identity is the slice of RFC 8621 §6 Identity `send` reads — identity.ts:48
// JmapIdentity.
type identity struct {
	ID            string `json:"id"`
	Email         string `json:"email"`
	Name          string `json:"name"`
	TextSignature string `json:"textSignature"`
}

// address is one recipient. splitAddresses produces only the email — a name is
// not something --to carries.
type address struct {
	Email string `json:"email"`
}

// The request shapes. Structs, not maps, so the key order on the wire is the
// TypeScript's (see jmap.Invocation) — for the one command whose requests are
// irreversible, "the same bytes Node would have sent" is worth being literal
// about.

// namedAddress is the SENDER: `{...(identity.name ? {name} : {}), email}`
// (main.ts:706), so a nameless identity emits no `name` key at all.
type namedAddress struct {
	Name  string `json:"name,omitempty"`
	Email string `json:"email"`
}

// bodyPart is one entry of textBody.
type bodyPart struct {
	PartID string `json:"partId"`
	Type   string `json:"type"`
}

// bodyValue is one entry of bodyValues.
type bodyValue struct {
	Value string `json:"value"`
}

// draftSpec is the Email/set create object, in main.ts:706's key order. cc/bcc
// are omitempty, which is exactly the TypeScript's `...(cc.length > 0 ? {cc} : {})`.
type draftSpec struct {
	MailboxIDs map[string]bool      `json:"mailboxIds"`
	Keywords   map[string]bool      `json:"keywords"`
	From       []namedAddress       `json:"from"`
	To         []address            `json:"to"`
	CC         []address            `json:"cc,omitempty"`
	BCC        []address            `json:"bcc,omitempty"`
	Subject    string               `json:"subject"`
	BodyValues map[string]bodyValue `json:"bodyValues"`
	TextBody   []bodyPart           `json:"textBody"`
}

// emailSetArgs is Email/set with a single creation.
type emailSetArgs struct {
	AccountID string               `json:"accountId"`
	Create    map[string]draftSpec `json:"create"`
}

// envelope is RFC 8621 §7's Envelope — the SMTP-level sender and recipients,
// which is how bcc reaches its recipients without appearing in the MIME.
type envelope struct {
	MailFrom address   `json:"mailFrom"`
	RcptTo   []address `json:"rcptTo"`
}

// submissionSpec is the EmailSubmission/set create object (main.ts:727).
type submissionSpec struct {
	EmailID    string   `json:"emailId"`
	IdentityID string   `json:"identityId"`
	Envelope   envelope `json:"envelope"`
}

// submissionSetArgs is EmailSubmission/set: the creation plus the conditional
// Drafts → Sent move.
type submissionSetArgs struct {
	AccountID            string                    `json:"accountId"`
	Create               map[string]submissionSpec `json:"create"`
	OnSuccessUpdateEmail map[string]jmap.Object    `json:"onSuccessUpdateEmail"`
}

// sendJSON is the --json record, in main.ts:743's key order.
type sendJSON struct {
	EmailID      string   `json:"emailId"`
	SubmissionID string   `json:"submissionId"`
	Identity     string   `json:"identity"`
	To           []string `json:"to"`
}

func runSend(s *bmio.Streams, argv []string) int {
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
	client := jmap.NewSessionClient(settings.Base, settings.Token)
	ctx := context.Background()

	// --from selects both the sending ACCOUNT (by address) and, below, the
	// identity within it; it falls back to --account, then the default.
	//
	// Ambiguity is refused rather than resolved to [0] (cli/009): this is the
	// send path, and silently choosing a sender is the one outcome that cannot be
	// undone. A --from that matches NO account is NOT an error here, though — it
	// may name an alias identity inside the default account, which is why this
	// uses account.Match (no refusal) and the identity lookup below is the strict
	// check (main.ts:578).
	var fromAccounts []account.Account
	if a.From != "" {
		fromAccounts = account.Match(settings.Accounts, settings.AccountID, a.From)
	}
	if len(fromAccounts) > 1 {
		return die(s, bmio.Usage("--from \""+a.From+"\" matches "+strconv.Itoa(len(fromAccounts))+
			" accounts; name the sending account with --account"))
	}
	var sendAccount string
	if len(fromAccounts) == 1 {
		sendAccount = fromAccounts[0].AccountID
	} else {
		// `??` short-circuits, so this resolution happens ONLY when --from
		// matched no account (main.ts:586).
		acc, err := resolveAccount(settings, a.Account)
		if err != nil {
			return die(s, err)
		}
		sendAccount = acc.AccountID
	}

	to := splitAddresses(a.To)
	cc := splitAddresses(a.CC)
	bcc := splitAddresses(a.BCC)
	// The gate, and it is above every round trip on purpose: no destination, no
	// requests, nothing created server-side (main.ts:589).
	if len(to) == 0 {
		return die(s, bmio.Usage("send requires --to"))
	}
	subject := a.Subject

	// main.ts:596 readBody: an explicit --body beats implicit stdin, and an
	// EMPTY --body is a legitimate empty body — `opts.body !== undefined`
	// (main.ts:778) tests presence, not truthiness. The port does NOT add a
	// whitespace refusal the TypeScript does not have; a divergence here would
	// make the two implementations disagree about what was sent.
	body, err := readBody(a)
	if err != nil {
		return die(s, err)
	}

	// ---- 1. Identity/get — who is sending -----------------------------------
	idRaw, err := client.One(ctx, "Identity/get",
		map[string]any{"accountId": sendAccount, "ids": nil}, jmap.MailUsing)
	if err != nil {
		return die(s, err)
	}
	var idRes struct {
		List []identity `json:"list"`
	}
	if err := json.Unmarshal(idRaw, &idRes); err != nil {
		return die(s, err)
	}
	from, err := pickIdentity(idRes.List, a.Identity, a.From)
	if err != nil {
		return die(s, err)
	}

	// The signature is applied HERE, client-side, because that is where the MIME
	// is built: EmailSubmission/set hands the submit worker an already-imported
	// blob id and the worker relays those exact R2 bytes, so a server-injected
	// signature would make the copy in Sent differ from what the recipient
	// received (main.ts:611, identity.ts:29).
	signedBody := appendTextSignature(body, from.TextSignature)

	// ---- 2. Mailbox/get — the draft → Sent dance needs both roles -----------
	mbRaw, err := client.One(ctx, "Mailbox/get",
		map[string]any{"accountId": sendAccount, "ids": nil}, jmap.MailUsing)
	if err != nil {
		return die(s, err)
	}
	var mbRes struct {
		List []struct {
			ID   string  `json:"id"`
			Role *string `json:"role"`
		} `json:"list"`
	}
	if err := json.Unmarshal(mbRaw, &mbRes); err != nil {
		return die(s, err)
	}
	var draftsID, sentID string
	for _, m := range mbRes.List {
		if m.Role == nil {
			continue
		}
		if *m.Role == "drafts" && draftsID == "" {
			draftsID = m.ID
		}
		if *m.Role == "sent" && sentID == "" {
			sentID = m.ID
		}
	}
	if draftsID == "" || sentID == "" {
		return die(s, bmio.NotFound("account is missing a drafts/sent role mailbox"))
	}

	// ---- 3. Email/set — create the draft ------------------------------------
	//
	// Bcc is stored on the draft but never written into the relayed MIME;
	// delivery to those recipients rides on the explicit envelope below.
	draft := draftSpec{
		MailboxIDs: map[string]bool{draftsID: true},
		Keywords:   map[string]bool{"$draft": true, "$seen": true},
		From:       []namedAddress{{Name: from.Name, Email: from.Email}},
		To:         to,
		CC:         cc,
		BCC:        bcc,
		Subject:    subject,
		BodyValues: map[string]bodyValue{"t": {Value: signedBody}},
		TextBody:   []bodyPart{{PartID: "t", Type: "text/plain"}},
	}
	setRaw, err := client.One(ctx, "Email/set", emailSetArgs{
		AccountID: sendAccount,
		Create:    map[string]draftSpec{"d": draft},
	}, jmap.MailUsing)
	if err != nil {
		return die(s, err)
	}
	var setRes struct {
		Created map[string]struct {
			ID string `json:"id"`
		} `json:"created"`
		NotCreated map[string]setErr `json:"notCreated"`
	}
	if err := json.Unmarshal(setRaw, &setRes); err != nil {
		return die(s, err)
	}
	created, ok := setRes.Created["d"]
	if !ok || created.ID == "" {
		return die(s, failSetError("draft creation", setRes.NotCreated, "d"))
	}
	draftID := created.ID

	// ---- 4. EmailSubmission/set — submit, and move Drafts → Sent on success --
	//
	// The envelope is EXPLICIT so bcc recipients — who are never written into the
	// MIME — still receive it (main.ts:725). onSuccessUpdateEmail makes the
	// mailbox move conditional on the relay actually accepting the message: a
	// refused send leaves the draft in Drafts, where it can be fixed and retried.
	rcptTo := make([]address, 0, len(to)+len(cc)+len(bcc))
	rcptTo = append(rcptTo, to...)
	rcptTo = append(rcptTo, cc...)
	rcptTo = append(rcptTo, bcc...)
	subRaw, err := client.One(ctx, "EmailSubmission/set", submissionSetArgs{
		AccountID: sendAccount,
		Create: map[string]submissionSpec{"s": {
			EmailID:    draftID,
			IdentityID: from.ID,
			Envelope: envelope{
				MailFrom: address{Email: from.Email},
				RcptTo:   rcptTo,
			},
		}},
		OnSuccessUpdateEmail: map[string]jmap.Object{"#s": {
			{Key: "mailboxIds/" + draftsID, Value: nil},
			{Key: "mailboxIds/" + sentID, Value: true},
			{Key: "keywords/$draft", Value: nil},
		}},
	}, jmap.MailUsing)
	if err != nil {
		// A METHOD-level refusal lands here — including the scope wall
		// (services/jmap/src/methods/common.ts:110 → `token lacks the "send"
		// scope`), which is what an agent-marked token without send actually hits.
		// The server's own sentence is printed verbatim and `forbidden` maps to
		// exit 4, so a refusal reads as a refusal rather than a generic failure.
		return die(s, err)
	}
	var subRes struct {
		Created map[string]struct {
			ID string `json:"id"`
		} `json:"created"`
		NotCreated map[string]setErr `json:"notCreated"`
	}
	if err := json.Unmarshal(subRaw, &subRes); err != nil {
		return die(s, err)
	}
	submission, ok := subRes.Created["s"]
	if !ok || submission.ID == "" {
		// A PER-OBJECT refusal (submission.ts:150 wraps everything submitOne
		// throws into notCreated) — "not a draft", a suppression-list recipient,
		// an outbound bound. Same treatment: the server's type decides the exit
		// code, its description is quoted, and nothing is invented.
		return die(s, failSetError("submission", subRes.NotCreated, "s"))
	}

	emails := make([]string, len(rcptTo))
	for i, r := range rcptTo {
		emails[i] = r.Email
	}
	if a.JSON {
		if err := s.EmitJSON(sendJSON{
			EmailID: draftID, SubmissionID: submission.ID, Identity: from.Email, To: emails,
		}); err != nil {
			return die(s, err)
		}
	} else {
		// `extras` (main.ts:748) is the Markdown pipeline's inline/attached/linked
		// summary. The native path is plain-text only, so it is always empty here
		// — an --expandMD invocation never reaches this code.
		s.Out("sent " + draftID + " to " + strings.Join(emails, ", ") +
			" (submission " + submission.ID + ")")
	}

	// Keep the local log current; best-effort, exactly as main.ts:757 is.
	reconcileSent(db, client, sendAccount, draftID)
	return 0
}

// ---- helpers ---------------------------------------------------------------

// splitAddresses is main.ts:767: flatten on commas, trim, drop empties. So
// `--to "a@x, b@x" --to c@x` is three recipients, and a trailing comma is not a
// fourth empty one.
func splitAddresses(values []string) []address {
	out := []address{}
	for _, v := range values {
		for _, part := range strings.Split(v, ",") {
			part = strings.TrimSpace(part)
			if part == "" {
				continue
			}
			out = append(out, address{Email: part})
		}
	}
	return out
}

// pickIdentity is main.ts:600: --identity by id OR email; else --from by exact
// email; else the first identity. An explicit selector that matches nothing is an
// error (exit 3) — only the ABSENCE of a selector falls back.
func pickIdentity(list []identity, selector, from string) (identity, error) {
	var found *identity
	switch {
	case selector != "":
		for i := range list {
			if list[i].ID == selector || list[i].Email == selector {
				found = &list[i]
				break
			}
		}
	case from != "":
		for i := range list {
			if list[i].Email == from {
				found = &list[i]
				break
			}
		}
	default:
		if len(list) > 0 {
			found = &list[0]
		}
	}
	if found == nil {
		named := selector
		if named == "" {
			named = from
		}
		if named == "" {
			named = "(default)"
		}
		available := make([]string, len(list))
		for i, x := range list {
			available[i] = x.Email
		}
		return identity{}, bmio.NotFound("identity " + named + " not found; available: " +
			strings.Join(available, ", "))
	}
	return *found, nil
}

// appendTextSignature is identity.ts:69. No signature → the body is untouched,
// byte for byte; otherwise trailing NEWLINES (only) are trimmed from both halves
// before the separator joins them.
func appendTextSignature(body, signature string) string {
	if signature == "" {
		return body
	}
	return trimTrailingNewlines(body) + sigSep + trimTrailingNewlines(signature) + "\n"
}

// trimTrailingNewlines is JavaScript's `.replace(/\n+$/, "")` — newlines only, so
// trailing spaces and tabs survive exactly as they do in Node.
func trimTrailingNewlines(s string) string {
	return strings.TrimRight(s, "\n")
}

// readBody is main.ts:775. Explicit flags beat implicit stdin, so a script with
// stdin redirected to /dev/null can still use --body; `--file -` is explicit
// stdin.
func readBody(a args) (string, error) {
	if a.HasBody {
		return a.Body, nil
	}
	return readInput(a.File, "body")
}

// readInput is io.ts:367 for the required-text case: "-" is explicit stdin, a
// non-empty path is a file, and an absent source falls back to stdin ONLY when
// stdin is not a terminal. An empty pipe counts as no input, which is what makes
// `bullmoose send --to x < /dev/null` a usage error rather than an empty message.
func readInput(source, what string) (string, error) {
	switch {
	case source == "-":
		return readStdin()
	case source != "":
		b, err := os.ReadFile(source)
		if err != nil {
			return "", &bmio.CliError{Msg: nodeFsMessage(err, source), Code: bmio.ExitFail}
		}
		return string(b), nil
	case !term.IsTerminal(int(os.Stdin.Fd())):
		piped, err := readStdin()
		if err != nil {
			return "", err
		}
		if piped != "" {
			return piped, nil
		}
	}
	return "", &bmio.CliError{
		Msg:  "no " + what + `: pipe it on stdin, pass a path, or pass "-" for explicit stdin`,
		Code: bmio.ExitUsage,
	}
}

func readStdin() (string, error) {
	b, err := io.ReadAll(os.Stdin)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// nodeFsMessage renders a file-read failure the way Node's readFileSync does, so
// the commonest mistakes (a typo'd --file, an unreadable one) produce the same
// sentence from both implementations. Anything rarer falls through to Go's own
// message rather than inventing an errno.
func nodeFsMessage(err error, path string) string {
	switch {
	case os.IsNotExist(err):
		return "ENOENT: no such file or directory, open '" + path + "'"
	case os.IsPermission(err):
		return "EACCES: permission denied, open '" + path + "'"
	default:
		return err.Error()
	}
}

// failSetError is io.ts:429: a per-object SetError is the normal failure shape
// for /set methods, arriving inside notCreated rather than as a thrown method
// error. Same exit-code table either way, so a `forbidden` is exit 4 whether the
// server reported it per-object or method-level.
func failSetError(verb string, notCreated map[string]setErr, key string) error {
	e := notCreated[key]
	typ := e.Type
	if typ == "" {
		typ = "unknown"
	}
	detail := ""
	if e.Description != "" {
		detail = " — " + e.Description
	}
	// JMAPType carries e.Type (possibly ""), NOT the "unknown" placeholder: an
	// absent type must fall to exit 1, and naming it "unknown" in the lookup
	// would be the same answer by accident rather than by rule.
	return &bmio.ServerError{Msg: verb + " failed: " + typ + detail, JMAPType: e.Type}
}

// reconcileSent refreshes the mirror row for the message just sent, so it appears
// in `bullmoose log` without waiting for the next sync.
//
// Best-effort and silent, as main.ts:757's try/catch is ("next `bullmoose sync`
// catches up"). It is NARROWER than the TypeScript, which runs a whole `sync`
// here: this writes the one id the server just confirmed and does not advance
// sync_state, which is sync.ts:191 reconcileEmails' contract — the cursor stays
// put, so the next real sync replays these changes instead of skipping them. The
// full sync engine is a later wave.
func reconcileSent(db *sql.DB, client *jmap.Client, accountID, emailID string) {
	raw, err := client.One(context.Background(), "Email/get", emailGetArgs{
		AccountID:  accountID,
		IDs:        []string{emailID},
		Properties: store.EmailProperties,
	}, jmap.MailUsing)
	if err != nil {
		return
	}
	var got struct {
		List []store.Email `json:"list"`
	}
	if err := json.Unmarshal(raw, &got); err != nil || len(got.List) == 0 {
		return
	}
	_ = store.UpsertEmail(db, accountID, got.List[0])
}
