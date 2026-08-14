package cmd

// `bullmoose contacts` (s08 T6 wave 3 / sVOL 017) against a recording fake.
//
// Three properties carry the weight, and each has its own group below:
//
//	the REQUEST     every verb sends the JMAP call the TypeScript sends, with the
//	                same capability list, the same filter and the same paging
//	a REFUSAL COSTS every missing-argument and every client-side guard refuses
//	NOTHING         having sent ZERO requests
//	a SERVER NO     renders legibly with the exit code the §1.5 table assigns —
//	                including the governed-book case s10 T1 introduced

import (
	"encoding/json"
	"strings"
	"testing"
)

// runContactsCmd drives one invocation against a fake and returns the streams.
func runContactsCmd(t *testing.T, f *cardFake, argv ...string) (out, errOut string, code int) {
	t.Helper()
	srv := f.start(t)
	db := seedMailMirror(t, srv.URL, "tok", "")
	return runCmd(t, runContacts, db, "contacts", argv...)
}

// ---- the request ------------------------------------------------------------

func TestContactsExportSendsTheRightCalls(t *testing.T) {
	f := newCardFake().withContacts()
	out, _, code := runContactsCmd(t, f, "export", "--ids")
	if code != 0 {
		t.Fatalf("code = %d, want 0", code)
	}
	// export = enumerate then fetch; no `properties`, because the WHOLE card is
	// what gets re-serialised to vCard.
	if got, want := strings.Join(f.names(), ","), "ContactCard/query,ContactCard/get"; got != want {
		t.Errorf("calls = %s, want %s", got, want)
	}
	if args := f.argsOf("ContactCard/query"); !strings.Contains(args, `"limit":256`) ||
		!strings.Contains(args, `"position":0`) || strings.Contains(args, "filter") {
		t.Errorf("query args = %s, want position 0, limit 256 (contactsPage) and no filter", args)
	}
	if args := f.argsOf("ContactCard/get"); strings.Contains(args, "properties") {
		t.Errorf("export must not narrow properties (it re-serialises the whole card): %s", args)
	}
	if got, want := out, "cc_ada\ncc_alan\n"; got != want {
		t.Errorf("--ids = %q, want %q", got, want)
	}
	// The capability list is not decoration: the server validates `using`, and a
	// request missing urn:…:contacts is refused with unknownCapability.
	if len(f.usings) == 0 || strings.Join(f.usings[0], ",") !=
		"urn:ietf:params:jmap:core,urn:ietf:params:jmap:contacts" {
		t.Errorf("using = %v, want core+contacts", f.usings)
	}
}

func TestContactsExportBookFiltersTheQuery(t *testing.T) {
	f := newCardFake().withContacts()
	_, _, code := runContactsCmd(t, f, "export", "--book", "Work", "--ids")
	if code != 0 {
		t.Fatalf("code = %d, want 0", code)
	}
	// The book is resolved by NAME first (AddressBook/get), then its id filters
	// the query — the CLI never sends a name to the server.
	if got, want := strings.Join(f.names(), ","),
		"AddressBook/get,ContactCard/query,ContactCard/get"; got != want {
		t.Errorf("calls = %s, want %s", got, want)
	}
	if args := f.argsOf("ContactCard/query"); !strings.Contains(args, `"filter":{"inAddressBook":"ab_work"}`) {
		t.Errorf("query args = %s, want the resolved book id in the filter", args)
	}
}

func TestContactsListSendsSortAndTheLimitBoundedPage(t *testing.T) {
	f := newCardFake().withContacts()
	_, _, code := runContactsCmd(t, f, "list", "-n", "2")
	if code != 0 {
		t.Fatalf("code = %d, want 0", code)
	}
	args := f.argsOf("ContactCard/query")
	// `list` sorts by name and asks for min(PAGE, limit) — NOT a full page, which
	// on an unindexed query is the difference between reading 2 and reading 256.
	if !strings.Contains(args, `"sort":[{"property":"name","isAscending":true}]`) {
		t.Errorf("query args = %s, want the name sort", args)
	}
	if !strings.Contains(args, `"limit":2`) {
		t.Errorf("query args = %s, want limit 2 from -n 2", args)
	}
	if args := f.argsOf("ContactCard/get"); !strings.Contains(args,
		`"properties":["id","name","emails","phones","organizations","addressBookIds"]`) {
		t.Errorf("get args = %s, want the list property set", args)
	}
}

func TestContactsBooksRmCountsBeforeItRefuses(t *testing.T) {
	f := newCardFake().withContacts()
	_, errOut, code := runContactsCmd(t, f, "books", "rm", "Work")
	// A non-empty book is a CONFLICT (exit 5) refused client-side, so the server
	// never sees a destroy it would have rejected generically.
	if code != 5 {
		t.Fatalf("code = %d, want 5 (conflict)", code)
	}
	if !strings.Contains(errOut, "--force") {
		t.Errorf("the refusal must name the resolution: %q", errOut)
	}
	if len(f.mutatingCalls()) != 0 {
		t.Errorf("a refused rm must send no /set: %v", f.names())
	}
}

func TestContactsRmResolvesTheTargetThenDestroys(t *testing.T) {
	f := newCardFake().withContacts()
	f.replies["ContactCard/get"] = `{"accountId":"a_you","state":"ccstate-1","list":[` +
		`{"id":"cc_ada","name":{"full":"Ada Lovelace"}}],"notFound":[]}`
	f.replies["ContactCard/set"] = `{"accountId":"a_you","oldState":"ccstate-1",` +
		`"newState":"ccstate-2","created":{},"notCreated":{},"updated":{},"notUpdated":{},` +
		`"destroyed":["cc_ada"],"notDestroyed":{}}`
	out, errOut, code := runContactsCmd(t, f, "rm", "cc_ada")
	if code != 0 {
		t.Fatalf("code = %d, want 0 (%s)", code, errOut)
	}
	if got, want := strings.Join(f.names(), ","), "ContactCard/get,ContactCard/set"; got != want {
		t.Errorf("calls = %s, want a resolve then a destroy", got)
	}
	if args := f.argsOf("ContactCard/set"); !strings.Contains(args, `"destroy":["cc_ada"]`) {
		t.Errorf("set args = %s", args)
	}
	if got, want := out, "removed Ada Lovelace (cc_ada)\n"; got != want {
		t.Errorf("stdout = %q, want %q", got, want)
	}
	// The chainable state is chrome, not a record — §1.1.
	if !strings.Contains(errOut, "state ccstate-2") {
		t.Errorf("the new state belongs on stderr: %q", errOut)
	}
}

func TestContactsIfStateReachesTheWire(t *testing.T) {
	f := newCardFake().withContacts()
	f.replies["AddressBook/set"] = `{"accountId":"a_you","created":{"b0":{"id":"ab_new"}},"newState":"abstate-2"}`
	_, _, code := runContactsCmd(t, f, "books", "create", "New", "--if-state", "abstate-1")
	if code != 0 {
		t.Fatalf("code = %d, want 0", code)
	}
	args := f.argsOf("AddressBook/set")
	if !strings.Contains(args, `"ifInState":"abstate-1"`) {
		t.Errorf("--if-state must map onto ifInState: %s", args)
	}
	// §1.7's ordering: accountId, then ifInState, then the operation.
	if !strings.HasPrefix(args, `{"accountId":"a_you","ifInState":"abstate-1","create":`) {
		t.Errorf("argument order drifted from the TypeScript spread: %s", args)
	}
}

// ---- a refusal costs nothing ------------------------------------------------

// TestContactsMissingArgumentsCostZeroRequests is the property a mutation test
// below deliberately breaks: every guard sits ABOVE the first round trip, so a
// mistyped invocation cannot half-write.
func TestContactsMissingArgumentsCostZeroRequests(t *testing.T) {
	cases := []struct {
		name string
		argv []string
		want int
	}{
		{"no subcommand", nil, 2},
		{"unknown subcommand", []string{"wat"}, 2},
		{"show without an id", []string{"show"}, 2},
		{"edit without an id", []string{"edit"}, 2},
		{"rm without an id", []string{"rm"}, 2},
		{"books without a verb", []string{"books"}, 2},
		{"books unknown verb", []string{"books", "wat"}, 2},
		{"books create without a name", []string{"books", "create"}, 2},
		{"books rename without a new name", []string{"books", "rename", "Work"}, 2},
		{"books rm without a selector", []string{"books", "rm"}, 2},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newCardFake().withContacts()
			_, errOut, code := runContactsCmd(t, f, c.argv...)
			if code != c.want {
				t.Errorf("code = %d, want %d (%s)", code, c.want, errOut)
			}
			if n := f.count(); n != 0 {
				t.Errorf("a refused invocation sent %d request(s) (%v); it must send none",
					n, f.names())
			}
			if !strings.HasPrefix(errOut, "error: usage:") {
				t.Errorf("stderr = %q, want a usage error", errOut)
			}
		})
	}
}

func TestContactsDryRunPerformsZeroMutations(t *testing.T) {
	cases := []struct {
		name string
		argv []string
	}{
		{"books create", []string{"books", "create", "New", "--dry-run"}},
		{"books rename", []string{"books", "rename", "Work", "Werk", "--dry-run"}},
		{"books rm", []string{"books", "rm", "Work", "--force", "--dry-run"}},
		{"rm", []string{"rm", "cc_ada", "--dry-run"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newCardFake().withContacts()
			out, errOut, code := runContactsCmd(t, f, c.argv...)
			if code != 0 {
				t.Fatalf("code = %d, want 0 (%s)", code, errOut)
			}
			if calls := f.mutatingCalls(); len(calls) != 0 {
				t.Errorf("invariant 4: --dry-run performed %v", calls)
			}
			if !strings.Contains(errOut, "dry run: would") {
				t.Errorf("the rehearsal belongs on stderr: %q", errOut)
			}
			if out != "" {
				t.Errorf("a rehearsal is not a record; stdout = %q", out)
			}
		})
	}
}

// TestContactsDryRunStillResolves — a dry run that did not resolve would be
// evidence of nothing, so an unknown target still exits 3.
func TestContactsDryRunStillResolves(t *testing.T) {
	f := newCardFake().withContacts()
	_, _, code := runContactsCmd(t, f, "books", "rm", "NoSuchBook", "--dry-run")
	if code != 3 {
		t.Errorf("code = %d, want 3 — --dry-run resolves for real", code)
	}
}

func TestContactsImportRefusesTheWrongContentType(t *testing.T) {
	f := newCardFake().withContacts()
	withStdin(t, "just some words\n")
	_, errOut, code := runContactsCmd(t, f, "import", "-")
	if code != 2 {
		t.Fatalf("code = %d, want 2", code)
	}
	if !strings.Contains(errOut, "--as") {
		t.Errorf("the refusal must point at --as: %q", errOut)
	}
	if n := f.count(); n != 0 {
		t.Errorf("a content-type refusal sent %d request(s)", n)
	}
}

// ---- a server no ------------------------------------------------------------

// TestContactsGovernedBookRefusalIsLegible is s10 T1's case: a governed address
// book IS an agent's outbound send authority, so the mailstore chokepoint refuses
// a direct card write with a typed `forbidden` whose message names the path that
// IS allowed. The CLI must carry all three of those through — the type (→ exit
// 4), the sentence, and the absence of any stack.
func TestContactsGovernedBookRefusalIsLegible(t *testing.T) {
	const refusal = "address book ab_governed is governed (an agent's outbound bound): " +
		"agents never write it directly — file a grant-request proposal for a human to approve"
	f := newCardFake().withContacts()
	f.replies["AddressBook/get"] = `{"accountId":"a_you","state":"abstate-1","list":[` +
		`{"id":"ab_governed","name":"Bound","isDefault":true}],"notFound":[]}`
	f.replies["ContactCard/set"] = `{"accountId":"a_you","created":{},"notCreated":` +
		`{"c0":{"type":"forbidden","description":` + jsonQuote(refusal) + `}},` +
		`"updated":{},"notUpdated":{},"destroyed":[],"notDestroyed":{}}`
	withStdin(t, `{"uid":"u-1","name":{"full":"X"}}`)

	out, errOut, code := runContactsCmd(t, f, "create", "-", "--book", "Bound")

	// 4, not 1: `forbidden` is in the §1.5 table, so a script can branch on
	// "not permitted" rather than on a substring.
	if code != 4 {
		t.Fatalf("code = %d, want 4 (auth/forbidden) — the SetError type decides", code)
	}
	if !strings.Contains(errOut, refusal) {
		t.Errorf("the server's own sentence must survive verbatim, so the user is told\n"+
			"what to do instead. got: %q", errOut)
	}
	if !strings.HasPrefix(errOut, "error: create failed: forbidden — ") {
		t.Errorf("stderr = %q, want the failSetError shape", errOut)
	}
	if strings.Contains(errOut, "goroutine") || strings.Contains(errOut, ".go:") {
		t.Errorf("a refusal is not a crash: %q", errOut)
	}
	if out != "" {
		t.Errorf("a refusal writes no record to stdout, got %q", out)
	}
}

// TestContactsGovernedBookRefusalDuringImport — import reports per-card failures
// and exits 1 (a partial failure is still a failure), so the same refusal reads
// differently but no less legibly.
func TestContactsGovernedBookRefusalDuringImport(t *testing.T) {
	const refusal = "address book ab_governed is governed (an agent's outbound bound): " +
		"agents never write it directly — file a grant-request proposal for a human to approve"
	f := newCardFake().withContacts()
	f.replies["AddressBook/get"] = `{"accountId":"a_you","state":"abstate-1","list":[` +
		`{"id":"ab_governed","name":"Bound","isDefault":true}],"notFound":[]}`
	f.replies["ContactCard/query"] = `{"accountId":"a_you","queryState":"1","position":0,"ids":[]}`
	f.replies["ContactCard/set"] = `{"accountId":"a_you","created":{},"notCreated":` +
		`{"c0":{"type":"forbidden","description":` + jsonQuote(refusal) + `}}}`
	withStdin(t, "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:G\r\nUID:g2\r\nEND:VCARD\r\n")

	out, errOut, code := runContactsCmd(t, f, "import", "-")
	if code != 1 {
		t.Fatalf("code = %d, want 1 — import's partial-failure exit", code)
	}
	if !strings.Contains(errOut, "failed: g2: "+refusal) {
		t.Errorf("the per-card reason must be the server's: %q", errOut)
	}
	if !strings.Contains(out, "created 0") {
		t.Errorf("the summary must be honest about having created nothing: %q", out)
	}
}

func TestContactsMethodLevelForbiddenIsExit4(t *testing.T) {
	// The owner-only rule: AddressBook/set throws a METHOD-level forbidden on
	// delegated access, which is a different shape from the SetError above and
	// must land on the same code.
	f := newCardFake().withContacts()
	f.methodErrors["AddressBook/set"] = [2]string{"forbidden", "only the account owner manages address books"}
	_, errOut, code := runContactsCmd(t, f, "books", "create", "New")
	if code != 4 {
		t.Fatalf("code = %d, want 4", code)
	}
	if !strings.Contains(errOut, "only the account owner manages address books") {
		t.Errorf("stderr = %q, want the server's sentence", errOut)
	}
}

func TestContactsStaleIfStateIsExit5(t *testing.T) {
	f := newCardFake().withContacts()
	f.methodErrors["AddressBook/set"] = [2]string{"stateMismatch", ""}
	_, errOut, code := runContactsCmd(t, f, "books", "create", "New", "--if-state", "abstate-stale")
	if code != 5 {
		t.Fatalf("code = %d, want 5", code)
	}
	if !strings.Contains(errOut, "stateMismatch") {
		t.Errorf("stderr = %q, want the reason named", errOut)
	}
}

func TestContactsUnknownCardIsExit3(t *testing.T) {
	f := newCardFake().withContacts()
	f.replies["ContactCard/get"] = `{"accountId":"a_you","state":"1","list":[],"notFound":["cc_nope"]}`
	_, errOut, code := runContactsCmd(t, f, "show", "cc_nope")
	if code != 3 {
		t.Fatalf("code = %d, want 3", code)
	}
	if !strings.Contains(errOut, "no such contact: cc_nope") {
		t.Errorf("stderr = %q", errOut)
	}
}

// ---- --json goldens ---------------------------------------------------------

// TestContactsJSONIsTheServersOwnBytes pins the §1.3 shape for every read verb.
// The cards are re-emitted with the SERVER's key order, which a Go map would
// silently sort — the failure mode internal/jsobj exists to prevent.
func TestContactsJSONIsTheServersOwnBytes(t *testing.T) {
	cases := []struct {
		name string
		argv []string
		want string
	}{
		{
			name: "export --json is NDJSON, one whole card per line",
			argv: []string{"export", "--json"},
			want: `{"id":"cc_ada","@type":"Card","version":"1.0","uid":"urn:uuid:ada","name":{"full":"Ada Lovelace"},"emails":{"e1":{"address":"ada@smoke.test"}},"addressBookIds":{"ab_personal":true}}` + "\n" +
				`{"id":"cc_alan","@type":"Card","version":"1.0","uid":"urn:uuid:alan","name":{"full":"Alan Turing"},"emails":{"e1":{"address":"alan@smoke.test"}},"addressBookIds":{"ab_work":true}}` + "\n",
		},
		{
			name: "list --json is the same NDJSON shape",
			argv: []string{"list", "--json"},
			want: `{"id":"cc_ada","@type":"Card","version":"1.0","uid":"urn:uuid:ada","name":{"full":"Ada Lovelace"},"emails":{"e1":{"address":"ada@smoke.test"}},"addressBookIds":{"ab_personal":true}}` + "\n" +
				`{"id":"cc_alan","@type":"Card","version":"1.0","uid":"urn:uuid:alan","name":{"full":"Alan Turing"},"emails":{"e1":{"address":"alan@smoke.test"}},"addressBookIds":{"ab_work":true}}` + "\n",
		},
		{
			name: "books list --json",
			argv: []string{"books", "list", "--json"},
			want: `{"id":"ab_personal","name":"Personal","isDefault":true}` + "\n" +
				`{"id":"ab_work","name":"Work","isDefault":false}` + "\n",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newCardFake().withContacts()
			out, errOut, code := runContactsCmd(t, f, c.argv...)
			if code != 0 {
				t.Fatalf("code = %d (%s)", code, errOut)
			}
			if out != c.want {
				t.Errorf("stdout =\n%q\nwant\n%q", out, c.want)
			}
			// §1.3: every line is a COMPLETE value, so `| head` truncates cleanly.
			for _, line := range strings.Split(strings.TrimRight(out, "\n"), "\n") {
				var v map[string]any
				if err := json.Unmarshal([]byte(line), &v); err != nil {
					t.Errorf("line is not a whole JSON value: %q", line)
				}
				if strings.HasPrefix(line, "[") {
					t.Errorf("no wrapping array is allowed: %q", line)
				}
			}
		})
	}
}

// TestContactsShowJSONIsExactlyOneObject — §1.3's `show`-shaped case, and its
// human twin is the same object indented, which is what `JSON.stringify(card,
// null, 2)` produces.
func TestContactsShowJSONIsExactlyOneObject(t *testing.T) {
	f := newCardFake().withContacts()
	f.replies["ContactCard/get"] = `{"accountId":"a_you","state":"1","list":[` +
		`{"id":"cc_ada","uid":"urn:uuid:ada","name":{"full":"Ada Lovelace"},"tags":[],"meta":{}}],"notFound":[]}`
	out, _, code := runContactsCmd(t, f, "show", "cc_ada", "--json")
	if code != 0 {
		t.Fatalf("code = %d", code)
	}
	want := `{"id":"cc_ada","uid":"urn:uuid:ada","name":{"full":"Ada Lovelace"},"tags":[],"meta":{}}` + "\n"
	if out != want {
		t.Errorf("stdout = %q, want %q", out, want)
	}

	f.reset()
	out, _, code = runContactsCmd(t, f, "show", "cc_ada")
	if code != 0 {
		t.Fatalf("code = %d", code)
	}
	wantHuman := "{\n  \"id\": \"cc_ada\",\n  \"uid\": \"urn:uuid:ada\",\n  \"name\": {\n    \"full\": \"Ada Lovelace\"\n  },\n  \"tags\": [],\n  \"meta\": {}\n}\n"
	if out != wantHuman {
		t.Errorf("human stdout =\n%q\nwant\n%q", out, wantHuman)
	}
}

// TestContactsExportIsVCard — the DATA under no flag is vCard 3.0, so
// `export | import` round-trips a book. This is s05 T2's done-when.
func TestContactsExportIsVCard(t *testing.T) {
	f := newCardFake().withContacts()
	out, _, code := runContactsCmd(t, f, "export")
	if code != 0 {
		t.Fatalf("code = %d", code)
	}
	if n := strings.Count(out, "BEGIN:VCARD"); n != 2 {
		t.Errorf("want one block per card, got %d", n)
	}
	for _, want := range []string{"VERSION:3.0", "FN:Ada Lovelace", "UID:urn:uuid:ada",
		"EMAIL;TYPE=INTERNET:ada@smoke.test", "END:VCARD"} {
		if !strings.Contains(out, want) {
			t.Errorf("export is missing %q:\n%s", want, out)
		}
	}
	if !strings.Contains(out, "\r\n") {
		t.Error("vCard lines are CRLF-terminated (RFC 6350 §3.2)")
	}
}

func jsonQuote(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}
