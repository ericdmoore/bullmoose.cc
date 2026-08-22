package cmd

// `bullmoose identity` — list, show, and edit the RFC 8621 §6 sending
// identities. A port of packages/cli/src/identity.ts under s42.
//
// The subtle rule kept intact: **signature sources, not signature strings**.
// `--text` and `--html` name a FILE (or `-` for stdin); a bare
// `identity signature default` reads a pipe, which is what makes
// `cat sig.txt | bullmoose identity signature default` work. `--clear` wins
// over both and clears BOTH signatures — clearing only one would leave a
// multipart/alternative send signing one half of itself.

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	bmio "github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/jmap"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/store"
)

// jmapIdentity is the wire object, kept raw-ish so --json re-emits faithfully.
type jmapIdentity struct {
	ID            string          `json:"id"`
	Email         string          `json:"email"`
	Name          string          `json:"name"`
	TextSignature string          `json:"textSignature"`
	HTMLSignature string          `json:"htmlSignature"`
	MayDelete     bool            `json:"mayDelete"`
	ReplyTo       []identityAddr  `json:"replyTo,omitempty"`
	Bcc           []identityAddr  `json:"bcc,omitempty"`
	Raw           json.RawMessage `json:"-"`
}

type identityAddr struct {
	Email string `json:"email"`
}

func runIdentity(s *bmio.Streams, argv []string) int {
	a := parse(argv)
	sub := a.at(1)
	arg := a.at(2)

	// Refusals cost zero requests.
	switch sub {
	case "", "list", "show", "signature", "add", "rm":
	default:
		s.Note("usage: unknown identity subcommand: " + sub + " (list|show|signature|add|rm)")
		return 2
	}
	needsArg := map[string]string{
		"show":      "bullmoose identity show <id-or-email>",
		"signature": "bullmoose identity signature <id-or-email> [--text <file|->] [--html <file>] [--clear]",
		"add":       "bullmoose identity add <email> [--name <n>] [--reply-to <addr>] [--bcc <addr>]",
		"rm":        "bullmoose identity rm <id-or-email>",
	}
	if u, ok := needsArg[sub]; ok && arg == "" {
		s.Note("usage: " + u)
		return 2
	}

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
	client := jmap.NewSessionClient(settings.Base, settings.Token)
	ctx := context.Background()

	list, err := fetchIdentities(ctx, client, acc.AccountID)
	if err != nil {
		return die(s, err)
	}

	switch sub {
	case "", "list":
		if a.IDs {
			ids := make([]string, 0, len(list))
			for _, i := range list {
				ids = append(ids, i.ID)
			}
			s.EmitIDs(ids)
			return 0
		}
		if a.JSON {
			rows := make([]any, 0, len(list))
			for _, i := range list {
				rows = append(rows, json.RawMessage(i.Raw))
			}
			if err := s.EmitNDJSON(rows); err != nil {
				return die(s, err)
			}
			return 0
		}
		if len(list) == 0 {
			s.Note("(no identities)")
			return 0
		}
		for _, i := range list {
			s.Out(renderIdentity(i))
		}
		return 0

	case "show":
		found, err := resolveIdentityRef(list, arg)
		if err != nil {
			return die(s, err)
		}
		if a.IDs {
			s.EmitIDs([]string{found.ID})
			return 0
		}
		if a.JSON {
			if err := s.EmitJSON(json.RawMessage(found.Raw)); err != nil {
				return die(s, err)
			}
			return 0
		}
		s.Out(renderIdentity(*found))
		if found.TextSignature != "" {
			s.Note("")
			s.Note("signature:")
			s.Out(found.TextSignature)
		}
		return 0

	case "signature":
		found, err := resolveIdentityRef(list, arg)
		if err != nil {
			return die(s, err)
		}
		patch, err := signaturePatch(a)
		if err != nil {
			return die(s, err)
		}
		if a.DryRun {
			s.Note("dry run: would set the signature on " + found.Email)
			if a.JSON {
				row := map[string]any{"dryRun": true, "id": found.ID}
				for k, v := range patch {
					row[k] = v
				}
				if err := s.EmitJSON(row); err != nil {
					return die(s, err)
				}
			}
			return 0
		}
		res, err := setIdentity(ctx, client, acc.AccountID, a, map[string]any{
			"update": map[string]any{found.ID: patch},
		})
		if err != nil {
			return die(s, err)
		}
		if reason, refused := res.NotUpdated[found.ID]; refused {
			return die(s, setErrToError("signature", reason))
		}
		return identityReport(s, a, res, found.ID, map[string]any{"id": found.ID},
			"signature set on "+found.Email)

	case "add":
		spec := map[string]any{"email": arg}
		if a.Name != "" {
			spec["name"] = a.Name
		}
		if a.ReplyTo != "" {
			spec["replyTo"] = []identityAddr{{Email: a.ReplyTo}}
		}
		if len(a.BCC) > 0 {
			var bccs []identityAddr
			for _, v := range a.BCC {
				for _, one := range strings.Split(v, ",") {
					if e := strings.TrimSpace(one); e != "" {
						bccs = append(bccs, identityAddr{Email: e})
					}
				}
			}
			spec["bcc"] = bccs
		}
		if a.DryRun {
			s.Note("dry run: would add identity " + arg)
			if a.JSON {
				row := map[string]any{"dryRun": true}
				for k, v := range spec {
					row[k] = v
				}
				if err := s.EmitJSON(row); err != nil {
					return die(s, err)
				}
			}
			return 0
		}
		res, err := setIdentity(ctx, client, acc.AccountID, a, map[string]any{
			"create": map[string]any{"c1": spec},
		})
		if err != nil {
			return die(s, err)
		}
		made, ok := res.Created["c1"]
		if !ok || made.ID == "" {
			return die(s, setErrToError("add", res.NotCreated["c1"]))
		}
		return identityReport(s, a, res, made.ID, map[string]any{"id": made.ID, "email": arg},
			fmt.Sprintf("added %s (%s)", arg, made.ID))

	default: // rm
		found, err := resolveIdentityRef(list, arg)
		if err != nil {
			return die(s, err)
		}
		if a.DryRun {
			s.Note(fmt.Sprintf("dry run: would remove %s (%s)", found.Email, found.ID))
			if a.JSON {
				if err := s.EmitJSON(map[string]any{"dryRun": true, "id": found.ID, "email": found.Email}); err != nil {
					return die(s, err)
				}
			}
			return 0
		}
		res, err := setIdentity(ctx, client, acc.AccountID, a, map[string]any{
			"destroy": []string{found.ID},
		})
		if err != nil {
			return die(s, err)
		}
		destroyed := false
		for _, id := range res.Destroyed {
			if id == found.ID {
				destroyed = true
			}
		}
		if !destroyed {
			return die(s, setErrToError("rm", res.NotDestroyed[found.ID]))
		}
		return identityReport(s, a, res, found.ID, map[string]any{"id": found.ID, "email": found.Email},
			"removed "+found.Email)
	}
}

// renderIdentity is identity.ts:107 — id, label, then the marks column.
func renderIdentity(i jmapIdentity) string {
	var marks []string
	if !i.MayDelete {
		marks = append(marks, "primary")
	}
	if i.TextSignature != "" {
		marks = append(marks, "sig")
	}
	if i.HTMLSignature != "" {
		marks = append(marks, "html-sig")
	}
	if len(i.ReplyTo) > 0 {
		var es []string
		for _, r := range i.ReplyTo {
			es = append(es, r.Email)
		}
		marks = append(marks, "reply-to:"+strings.Join(es, ","))
	}
	if len(i.Bcc) > 0 {
		var es []string
		for _, b := range i.Bcc {
			es = append(es, b.Email)
		}
		marks = append(marks, "bcc:"+strings.Join(es, ","))
	}
	label := i.Email
	if i.Name != "" {
		label = i.Name + " <" + i.Email + ">"
	}
	line := i.ID + "\t" + label
	if len(marks) > 0 {
		line += "\t" + strings.Join(marks, " ")
	}
	return line
}

// resolveIdentityRef is identity.ts:95 — id first, exact email, then
// case-insensitive email.
func resolveIdentityRef(list []jmapIdentity, selector string) (*jmapIdentity, error) {
	wanted := strings.TrimSpace(selector)
	for i := range list {
		if list[i].ID == wanted {
			return &list[i], nil
		}
	}
	for i := range list {
		if list[i].Email == wanted {
			return &list[i], nil
		}
	}
	lower := strings.ToLower(wanted)
	for i := range list {
		if strings.ToLower(list[i].Email) == lower {
			return &list[i], nil
		}
	}
	return nil, bmio.NotFound("no identity matches " + selector)
}

// signaturePatch is identity.ts:213: --clear wins and clears BOTH, else
// explicit sources, else stdin for the text half.
func signaturePatch(a args) (map[string]any, error) {
	if a.Clear {
		return map[string]any{"textSignature": "", "htmlSignature": ""}, nil
	}
	patch := map[string]any{}
	if a.HasHTML {
		v, err := readInput(a.HTML, "html signature")
		if err != nil {
			return nil, err
		}
		patch["htmlSignature"] = v
	}
	if a.HasText {
		v, err := readInput(a.Text, "signature")
		if err != nil {
			return nil, err
		}
		patch["textSignature"] = v
	} else if !a.HasHTML {
		v, err := readInput("", "signature")
		if err != nil {
			return nil, err
		}
		patch["textSignature"] = v
	}
	return patch, nil
}

type identitySetResult struct {
	NewState string `json:"newState"`
	Created  map[string]struct {
		ID string `json:"id"`
	} `json:"created"`
	NotCreated   map[string]json.RawMessage `json:"notCreated"`
	NotUpdated   map[string]json.RawMessage `json:"notUpdated"`
	Destroyed    []string                   `json:"destroyed"`
	NotDestroyed map[string]json.RawMessage `json:"notDestroyed"`
}

func setIdentity(ctx context.Context, client *jmap.Client, accountID string, a args, body map[string]any) (*identitySetResult, error) {
	call := map[string]any{"accountId": accountID}
	if a.HasIfState {
		call["ifInState"] = a.IfState
	}
	for k, v := range body {
		call[k] = v
	}
	raw, err := client.One(ctx, "Identity/set", call, jmap.MailUsing)
	if err != nil {
		return nil, err
	}
	var res identitySetResult
	if err := json.Unmarshal(raw, &res); err != nil {
		return nil, err
	}
	return &res, nil
}

func identityReport(s *bmio.Streams, a args, res *identitySetResult, id string, what map[string]any, line string) int {
	if a.IDs {
		s.EmitIDs([]string{id})
		return 0
	}
	if a.JSON {
		what["state"] = nil
		if res.NewState != "" {
			what["state"] = res.NewState
		}
		if err := s.EmitJSON(what); err != nil {
			return die(s, err)
		}
		return 0
	}
	s.Out(line)
	if res.NewState != "" {
		s.Note("state " + res.NewState)
	}
	return 0
}

func setErrToError(what string, raw json.RawMessage) error {
	if raw == nil {
		return bmio.Fail(what+" failed: the server refused without a reason", bmio.ExitFail)
	}
	return bmio.Fail(what+" failed: "+string(raw), bmio.ExitFail)
}

func fetchIdentities(ctx context.Context, client *jmap.Client, accountID string) ([]jmapIdentity, error) {
	raw, err := client.One(ctx, "Identity/get", map[string]any{"accountId": accountID, "ids": nil}, jmap.MailUsing)
	if err != nil {
		return nil, err
	}
	var res struct {
		List []json.RawMessage `json:"list"`
	}
	if err := json.Unmarshal(raw, &res); err != nil {
		return nil, err
	}
	out := make([]jmapIdentity, 0, len(res.List))
	for _, r := range res.List {
		var i jmapIdentity
		if err := json.Unmarshal(r, &i); err != nil {
			return nil, err
		}
		i.Raw = r
		out = append(out, i)
	}
	return out, nil
}
