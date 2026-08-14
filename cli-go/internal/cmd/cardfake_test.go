package cmd

// The fake `contacts` and `calendar` are tested against.
//
// It records every method call VERBATIM — name, args and the `using` list —
// because for these two commands the REQUEST is most of what is under test:
//
//   - a verb that sends the wrong filter, the wrong page size or the wrong
//     capability is wrong in a way no exit code reveals;
//   - a refusal that costs zero requests is the whole point of the
//     missing-argument tests, and only the recorder can prove the count is zero;
//   - `--dry-run`'s invariant 4 ("zero mutations") is a claim about which
//     methods were called, not about what was printed.
//
// Replies are CANNED per method, so a test pins exactly what the server said and
// therefore exactly what `--json` re-emits. Like mailFake it advertises an apiUrl
// that is NOT `<base>/api/jmap`, so a client that hardcoded the path fails here.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

type cardFake struct {
	mu    sync.Mutex
	calls []recordedCall
	// usings is the `using` list of each REQUEST (not each call), in order.
	usings [][]string
	base   string

	// replies maps a method name to the raw result JSON it answers with.
	replies map[string]string
	// methodErrors maps a method name to a method-level error type (and an
	// optional description), which is how a server refuses before any per-object
	// result exists.
	methodErrors map[string][2]string
	// httpStatus, when non-zero, makes every JMAP POST answer that status —
	// the transport-refusal path (a 403 must still be exit 4).
	httpStatus int
}

func newCardFake() *cardFake {
	return &cardFake{
		replies:      map[string]string{},
		methodErrors: map[string][2]string{},
	}
}

// books/cards/calendars/events are the default fixtures, matching the shapes the
// contract suite's own stub serves so a Go test and a contract case describe the
// same world.
func (f *cardFake) withContacts() *cardFake {
	f.replies["AddressBook/get"] = `{"accountId":"a_you","state":"abstate-1","list":[` +
		`{"id":"ab_personal","name":"Personal","isDefault":true},` +
		`{"id":"ab_work","name":"Work","isDefault":false}],"notFound":[]}`
	f.replies["ContactCard/query"] = `{"accountId":"a_you","queryState":"ccstate-1","position":0,` +
		`"ids":["cc_ada","cc_alan"]}`
	f.replies["ContactCard/get"] = `{"accountId":"a_you","state":"ccstate-1","list":[` +
		`{"id":"cc_ada","@type":"Card","version":"1.0","uid":"urn:uuid:ada",` +
		`"name":{"full":"Ada Lovelace"},"emails":{"e1":{"address":"ada@smoke.test"}},` +
		`"addressBookIds":{"ab_personal":true}},` +
		`{"id":"cc_alan","@type":"Card","version":"1.0","uid":"urn:uuid:alan",` +
		`"name":{"full":"Alan Turing"},"emails":{"e1":{"address":"alan@smoke.test"}},` +
		`"addressBookIds":{"ab_work":true}}],"notFound":[]}`
	return f
}

func (f *cardFake) withCalendars() *cardFake {
	f.replies["Calendar/get"] = `{"accountId":"a_you","state":"calstate-1","list":[` +
		`{"id":"cal_default","name":"Personal","isDefault":true},` +
		`{"id":"cal_work","name":"Work","isDefault":false}],"notFound":[]}`
	f.replies["CalendarEvent/query"] = `{"accountId":"a_you","queryState":"calstate-1","ids":["ev_1"]}`
	f.replies["CalendarEvent/get"] = `{"accountId":"a_you","state":"calstate-1","list":[` +
		`{"id":"ev_1","@type":"Event","uid":"urn:uuid:ev1","title":"Standup",` +
		`"start":"2026-07-08T09:00:00","timeZone":"Etc/UTC","duration":"PT15M",` +
		`"calendarIds":{"cal_work":true}}],"notFound":[]}`
	return f
}

func (f *cardFake) start(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(f.handle))
	t.Cleanup(srv.Close)
	f.base = srv.URL
	return srv
}

func (f *cardFake) handle(w http.ResponseWriter, r *http.Request) {
	if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
		w.WriteHeader(401)
		_, _ = w.Write([]byte(`{"error":"bad token"}`))
		return
	}
	if r.URL.Path == "/.well-known/jmap" {
		w.Header().Set("content-type", "application/json")
		fmt.Fprintf(w, `{"username":"you@stub.test","accounts":{},"primaryAccounts":{},`+
			`"apiUrl":%q,"downloadUrl":%q}`, f.base+"/jmap-endpoint", f.base+"/dl/{accountId}/{blobId}")
		return
	}
	if r.URL.Path != "/jmap-endpoint" {
		w.WriteHeader(404)
		return
	}
	if f.httpStatus != 0 {
		w.WriteHeader(f.httpStatus)
		_, _ = w.Write([]byte(`{"error":"forbidden"}`))
		return
	}

	var req struct {
		Using       []string            `json:"using"`
		MethodCalls [][]json.RawMessage `json:"methodCalls"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	f.mu.Lock()
	defer f.mu.Unlock()
	f.usings = append(f.usings, req.Using)
	out := make([]string, 0, len(req.MethodCalls))
	for _, mc := range req.MethodCalls {
		var name, callID string
		_ = json.Unmarshal(mc[0], &name)
		_ = json.Unmarshal(mc[2], &callID)
		f.calls = append(f.calls, recordedCall{Name: name, Args: mc[1]})
		out = append(out, f.invoke(name, callID))
	}
	w.Header().Set("content-type", "application/json")
	fmt.Fprintf(w, `{"methodResponses":[%s]}`, strings.Join(out, ","))
}

func (f *cardFake) invoke(name, callID string) string {
	if e, ok := f.methodErrors[name]; ok {
		if e[1] == "" {
			return fmt.Sprintf(`["error",{"type":%q},%q]`, e[0], callID)
		}
		return fmt.Sprintf(`["error",{"type":%q,"description":%q},%q]`, e[0], e[1], callID)
	}
	if reply, ok := f.replies[name]; ok {
		return fmt.Sprintf(`[%q,%s,%q]`, name, reply, callID)
	}
	return fmt.Sprintf(`["error",{"type":"unknownMethod","description":%q},%q]`, name, callID)
}

// ---- assertions -------------------------------------------------------------

func (f *cardFake) names() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, len(f.calls))
	for i, c := range f.calls {
		out[i] = c.Name
	}
	return out
}

func (f *cardFake) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

// argsOf returns the raw args of the FIRST call to a method.
func (f *cardFake) argsOf(method string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range f.calls {
		if c.Name == method {
			return string(c.Args)
		}
	}
	return ""
}

// argsAt returns the raw args of the n-th call to a method (0-based), for the
// paging loops where the SECOND request is the interesting one.
func (f *cardFake) argsAt(method string, n int) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	seen := 0
	for _, c := range f.calls {
		if c.Name != method {
			continue
		}
		if seen == n {
			return string(c.Args)
		}
		seen++
	}
	return ""
}

func (f *cardFake) reset() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = nil
	f.usings = nil
}

// mutatingCalls is every recorded call to a `/set` method — what `--dry-run`'s
// invariant 4 is actually a claim about.
func (f *cardFake) mutatingCalls() []string {
	var out []string
	for _, n := range f.names() {
		if strings.HasSuffix(n, "/set") {
			out = append(out, n)
		}
	}
	return out
}
