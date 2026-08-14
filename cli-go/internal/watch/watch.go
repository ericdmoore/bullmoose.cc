package watch

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"math/rand"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/jmap"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/mirror"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/ws"
)

// `bullmoose watch` — long-running, push-triggered sync. A port of
// packages/cli/src/watch.ts:139, including its design note, which is the reason
// the reconnect story is short:
//
//	PUSH IS A HINT, THE CHANGELOG IS THE TRUTH.
//
// The WebSocket to the account's Durable Object delivers StateChange hints;
// every hint (debounced) just triggers the ordinary incremental sync off the
// LOCAL cursor. Missed pushes are therefore harmless: each (re)connect and a
// slow fallback timer run the same catch-up. The watcher never interprets a push
// payload — it does not even read `changed`.
//
// The resume contract falls straight out of that: a dropped socket loses no
// state, because the socket never held any. On reconnect the watcher runs the
// same Email/changes from the same stored cursor it would have run anyway, so
// nothing is replayed (the cursor advanced past what was already emitted) and
// nothing is skipped (the cursor did not advance past what was not).

// Defaults, watch.ts:20-23.
const (
	DefaultDebounce     = 300 * time.Millisecond
	DefaultFallbackSync = 5 * time.Minute
	DefaultBackoffMin   = 1 * time.Second
	DefaultBackoffMax   = 60 * time.Second
)

// Account is one watched account: the id to sync and the label to print.
type Account struct {
	ID    string
	Label string
}

// Printer is the output surface — satisfied by *bmio.Streams. Taken as an
// interface so the watcher can be driven into a buffer by a test without
// touching the process streams.
type Printer interface {
	Out(line string)
	Note(line string)
	EmitJSON(value any) error
}

// Socket is the read side of a push channel. The default implementation is
// internal/ws; the seam exists so a test can inject a socket that misbehaves in
// a specific way, not so the real one goes untested (watch_test.go drives the
// real client against a real server).
type Socket interface {
	ReadMessage() (opcode int, payload []byte, err error)
	Close() error
}

// DialFunc opens a push channel.
type DialFunc func(ctx context.Context, rawURL string) (Socket, error)

// Options configures a Watcher. Everything with a zero value has a documented
// default, so a caller sets the four fields it actually knows about.
type Options struct {
	DB       *sql.DB
	Client   *jmap.Client
	Base     string
	Token    string
	Accounts []Account
	Out      Printer

	// JSON switches stdout to the NDJSON event stream (§1.3).
	JSON bool
	// Exec is the operator's hook template, or "" for none.
	Exec string

	// Timings. Zero means the watch.ts default; a test sets them small.
	Debounce     time.Duration
	FallbackSync time.Duration
	BackoffMin   time.Duration
	BackoffMax   time.Duration

	// Dial defaults to the internal/ws client.
	Dial DialFunc
	// Jitter returns a factor in [0.5, 1) for the reconnect delay (watch.ts:337).
	// Injectable so a test's backoff is deterministic.
	Jitter func() float64
}

// Watcher holds one run's state.
type Watcher struct {
	opts     Options
	multi    bool
	channels []*channel
}

// channel is one account's push channel: its own socket, backoff, debounce and
// serialized sync — watch.ts:173. A burst on one inbox never blocks another's
// pushes, and two syncs of the SAME account never overlap.
type channel struct {
	account Account
	// requests carries a coalescing sync request. Capacity 1 is the whole
	// coalescing rule: while a sync runs, further requests collapse into the one
	// already queued, which is watch.ts:215's pendingReason without the
	// re-entrancy.
	requests chan string
	debounce *time.Timer
	mu       sync.Mutex
}

// New builds a Watcher, filling in defaults.
func New(opts Options) *Watcher {
	if opts.Debounce == 0 {
		opts.Debounce = DefaultDebounce
	}
	if opts.FallbackSync == 0 {
		opts.FallbackSync = DefaultFallbackSync
	}
	if opts.BackoffMin == 0 {
		opts.BackoffMin = DefaultBackoffMin
	}
	if opts.BackoffMax == 0 {
		opts.BackoffMax = DefaultBackoffMax
	}
	if opts.Dial == nil {
		opts.Dial = func(ctx context.Context, rawURL string) (Socket, error) {
			return ws.Dial(ctx, rawURL)
		}
	}
	if opts.Jitter == nil {
		opts.Jitter = func() float64 { return 0.5 + rand.Float64()*0.5 } //nolint:gosec // backoff jitter
	}
	w := &Watcher{opts: opts, multi: len(opts.Accounts) > 1}
	for _, a := range opts.Accounts {
		w.channels = append(w.channels, &channel{account: a, requests: make(chan string, 1)})
	}
	return w
}

// Run holds the push channels open until ctx is cancelled — watch.ts:344.
//
// Startup order is load-bearing: catch up FIRST, then listen, so a push only
// ever means a delta. Connecting first would race the initial sync and announce
// the same message twice.
func (w *Watcher) Run(ctx context.Context) error {
	if w.opts.Exec != "" {
		// A template written against the old contract fails SILENTLY otherwise
		// (the literal `{subject}` reaches the shell). Say so once — and do NOT
		// substitute: substitution is the vulnerability (watch.ts:158).
		if stale := LegacyPlaceholders(w.opts.Exec); len(stale) > 0 {
			w.status("--exec: " + strings.Join(stale, " ") + LegacyPlaceholderWarning)
		}
	}

	for _, ch := range w.channels {
		w.runSync(ctx, ch, "startup")
	}

	var wg sync.WaitGroup
	for _, ch := range w.channels {
		wg.Add(2)
		go func(ch *channel) { defer wg.Done(); w.syncWorker(ctx, ch) }(ch)
		go func(ch *channel) { defer wg.Done(); w.connectLoop(ctx, ch) }(ch)
	}

	// Guard against a silently dead socket: a slow unconditional resync
	// (watch.ts:347). The socket can be up and the fetch loop dead — the exact
	// failure mode the hermes email watchdog exists for elsewhere.
	wg.Add(1)
	go func() {
		defer wg.Done()
		ticker := time.NewTicker(w.opts.FallbackSync)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				for _, ch := range w.channels {
					ch.request("fallback")
				}
			}
		}
	}()

	<-ctx.Done()
	for _, ch := range w.channels {
		ch.stopDebounce()
	}
	wg.Wait()
	return nil
}

// request queues a sync, coalescing with one already waiting.
func (ch *channel) request(reason string) {
	select {
	case ch.requests <- reason:
	default: // a pass is already queued; this one folds into it
	}
}

// scheduleDebounced is watch.ts:247 scheduleSync — a burst of pushes for one
// account costs one sync.
func (ch *channel) scheduleDebounced(d time.Duration, reason string) {
	ch.mu.Lock()
	defer ch.mu.Unlock()
	if ch.debounce != nil {
		ch.debounce.Stop()
	}
	ch.debounce = time.AfterFunc(d, func() { ch.request(reason) })
}

func (ch *channel) stopDebounce() {
	ch.mu.Lock()
	defer ch.mu.Unlock()
	if ch.debounce != nil {
		ch.debounce.Stop()
	}
}

// syncWorker serializes one account's syncs.
func (w *Watcher) syncWorker(ctx context.Context, ch *channel) {
	for {
		select {
		case <-ctx.Done():
			return
		case reason := <-ch.requests:
			w.runSync(ctx, ch, reason)
		}
	}
}

// connectLoop holds one account's socket open, reconnecting with jittered
// exponential backoff — watch.ts:304/335.
func (w *Watcher) connectLoop(ctx context.Context, ch *channel) {
	backoff := w.opts.BackoffMin
	for {
		if ctx.Err() != nil {
			return
		}
		conn, err := w.opts.Dial(ctx, PushURL(w.opts.Base, ch.account.ID, w.opts.Token))
		if err == nil {
			backoff = w.opts.BackoffMin
			w.status(w.tag(ch) + "connected — waiting for pushes")
			// Catch up on anything missed while offline. This is the resume: the
			// cursor in the mirror decides the window, not the socket.
			ch.request("reconnect")
			w.readLoop(ctx, ch, conn)
		} else if ctx.Err() == nil {
			// DIVERGENCE from watch.ts, deliberate: there the socket's `onerror`
			// is an empty handler and only "disconnected — retrying" is printed,
			// so a 401 from an expired token is indistinguishable from a laptop
			// waking up on a different network. Both are stderr chrome and no
			// contract case reads them, so naming the reason costs nothing and
			// saves the one debugging session that matters.
			w.status(w.tag(ch) + "connect failed: " + err.Error())
		}
		if ctx.Err() != nil {
			return
		}
		delay := time.Duration(float64(backoff) * w.opts.Jitter())
		w.status(fmt.Sprintf("%sdisconnected — retrying in %ds",
			w.tag(ch), int64(roundHalfUp(delay.Seconds()))))
		backoff = min(backoff*2, w.opts.BackoffMax)
		select {
		case <-ctx.Done():
			return
		case <-time.After(delay):
		}
	}
}

// readLoop turns pushes into debounced sync requests until the socket dies.
// A malformed frame is IGNORED, not fatal (watch.ts:325) — the payload is a hint
// we do not interpret, so there is nothing to fail on.
func (w *Watcher) readLoop(ctx context.Context, ch *channel, conn Socket) {
	done := make(chan struct{})
	// Closing the socket is how a blocked read is unblocked on shutdown.
	go func() {
		select {
		case <-ctx.Done():
			_ = conn.Close()
		case <-done:
		}
	}()
	defer close(done)
	defer func() { _ = conn.Close() }()

	for {
		_, payload, err := conn.ReadMessage()
		if err != nil {
			return
		}
		var msg struct {
			Type string `json:"@type"`
		}
		if json.Unmarshal(payload, &msg) != nil {
			continue // not JSON — ignore
		}
		if msg.Type == "StateChange" {
			ch.scheduleDebounced(w.opts.Debounce, "push")
		}
	}
}

// runSync is watch.ts:213: one incremental pass, then the events it produced.
// A failed pass is reported and dropped — the cursor is untouched, so the next
// pass (push, fallback or reconnect) covers the same window.
func (w *Watcher) runSync(ctx context.Context, ch *channel, reason string) {
	stats, err := mirror.Sync(ctx, w.opts.DB, w.opts.Client, ch.account.ID, mirror.Options{})
	if err != nil {
		if ctx.Err() != nil {
			return // shutting down; not a failure worth printing
		}
		w.status(fmt.Sprintf("%ssync failed (%s): %s", w.tag(ch), reason, err.Error()))
		return
	}
	switch {
	case stats.Mode == "full":
		w.status(fmt.Sprintf("%sfull sync (%s): %d messages, state %s",
			w.tag(ch), reason, stats.Created, stats.NewState))
	case stats.Created+stats.Updated+stats.Destroyed > 0:
		w.status(fmt.Sprintf("%ssync (%s): +%d ~%d -%d, state %s",
			w.tag(ch), reason, stats.Created, stats.Updated, stats.Destroyed, stats.NewState))
	}

	w.emit(ch, stats.CreatedIDs, "created")
	w.emit(ch, stats.UpdatedIDs, "updated")
	for _, id := range stats.DestroyedIDs {
		if w.opts.JSON {
			_ = w.opts.Out.EmitJSON(destroyedEvent{Event: "destroyed", ID: id, Account: ch.account.Label})
		}
	}
}

// event is the --json record for a created/updated message, watch.ts:270. Field
// order is the object-literal order there, so the two implementations emit the
// same bytes.
type event struct {
	Event      string  `json:"event"`
	ID         string  `json:"id"`
	Account    string  `json:"account"`
	From       string  `json:"from"`
	Subject    string  `json:"subject"`
	Preview    string  `json:"preview"`
	ReceivedAt string  `json:"receivedAt"`
	Mailboxes  *string `json:"mailboxes"`
}

// destroyedEvent is watch.ts:232 — a destroyed id has no row left to describe,
// so it carries three fields and no nulls pretending otherwise.
type destroyedEvent struct {
	Event   string `json:"event"`
	ID      string `json:"id"`
	Account string `json:"account"`
}

// emit prints one batch of changed ids — watch.ts:252. A hook fires for
// `created` only: `updated` is a flag change on mail you have already been told
// about, and re-notifying on it would make every `bullmoose seen` fire the hook.
func (w *Watcher) emit(ch *channel, ids []string, kind string) {
	if len(ids) == 0 {
		return
	}
	rows, err := mirror.EventRows(w.opts.DB, ch.account.ID, ids)
	if err != nil {
		w.status(w.tag(ch) + "could not read changed rows: " + err.Error())
		return
	}
	for _, row := range rows {
		from := row.From()
		if w.opts.JSON {
			_ = w.opts.Out.EmitJSON(event{
				Event: kind, ID: row.ID, Account: ch.account.Label, From: from,
				Subject: row.Subject, Preview: row.Preview,
				ReceivedAt: time.UnixMilli(row.ReceivedAt).UTC().Format("2006-01-02T15:04:05.000Z"),
				Mailboxes:  row.Mailboxes,
			})
		} else {
			w.opts.Out.Out(renderLine(kind, row, ch.account, w.multi))
		}
		if w.opts.Exec != "" && kind == "created" {
			plan, err := BuildHookPlan(w.opts.Exec, HookFields{
				ID: row.ID, Account: ch.account.Label, From: from,
				Subject: row.Subject, Preview: row.Preview,
			})
			if err != nil {
				w.status("--exec: " + err.Error())
				continue
			}
			RunHook(plan, HookOptions{JSON: w.opts.JSON, OnError: w.status})
		}
	}
}

// renderLine is the human row, watch.ts:284.
func renderLine(kind string, row mirror.EventRow, acct Account, multi bool) string {
	mark := "~"
	if kind == "created" {
		mark = "●"
	}
	date := time.UnixMilli(row.ReceivedAt).UTC().Format("2006-01-02 15:04")
	label := ""
	if multi {
		label = padTrunc(acct.Label, 20) + "  "
	}
	subject := row.Subject
	if subject == "" {
		subject = "(no subject)"
	}
	mailboxes := ""
	if row.Mailboxes != nil {
		mailboxes = *row.Mailboxes
	}
	return fmt.Sprintf("%s %s  %s%s  %s  [%s]  %s",
		mark, date, label, padTrunc(row.From(), 24), truncRunes(subject, 48), mailboxes, row.ID)
}

// PushURL is watch.ts:306: the JMAP push endpoint for one account.
//
// The token rides in the QUERY STRING because a browser/undici WebSocket cannot
// set an Authorization header — that is a protocol limitation, not a choice, and
// it is why watch.ts does the same. Consequence worth knowing: the token can
// land in a proxy access log, so this URL is never printed (the status lines say
// "connected", never where).
//
// One cosmetic divergence from watch.ts: Go's url.Values.Encode sorts keys, so
// the query reads `access_token=…&accountId=…` where Node's insertion-ordered
// URLSearchParams reads `accountId=…&access_token=…`. Same request.
func PushURL(base, accountID, token string) string {
	u, err := url.Parse(base)
	if err != nil {
		return base
	}
	if u.Scheme == "https" {
		u.Scheme = "wss"
	} else {
		u.Scheme = "ws"
	}
	u.Path = "/api/ws"
	q := u.Query()
	q.Set("accountId", accountID)
	q.Set("access_token", token)
	u.RawQuery = q.Encode()
	return u.String()
}

// status is watch.ts:155: connection state, sync progress and hook failures are
// CHROME (§1.1). Under --json stdout carries the event stream and nothing else
// may enter it, so every one of these goes to stderr.
func (w *Watcher) status(msg string) { w.opts.Out.Note("[watch] " + msg) }

// tag prefixes a line with the account label, but only when more than one
// account is being watched — watch.ts:211.
func (w *Watcher) tag(ch *channel) string {
	if !w.multi {
		return ""
	}
	return ch.account.Label + ": "
}

// padTrunc is JS `s.padEnd(w).slice(0, w)`.
func padTrunc(s string, w int) string {
	r := []rune(s)
	if len(r) >= w {
		return string(r[:w])
	}
	return s + strings.Repeat(" ", w-len(r))
}

// truncRunes is JS `s.slice(0, w)` — truncate without padding.
func truncRunes(s string, w int) string {
	r := []rune(s)
	if len(r) <= w {
		return s
	}
	return string(r[:w])
}

// roundHalfUp is JS Math.round (which rounds .5 UP, unlike Go's math.Round for
// negatives — irrelevant here, but the delay wording is a direct port).
func roundHalfUp(f float64) float64 {
	return float64(int64(f + 0.5))
}
