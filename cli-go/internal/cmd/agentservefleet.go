package cmd

// Fleet mode + the persistent listen loop (s43 step 6, the last port work
// before the registry flip).
//
// DISCOVERY, NOT DECLARATION (jobs-and-facets §4): "which accounts may I
// claim for?" = the accounts on a FRESH session. The session surface already
// resolves grants — verifyBearer folds live grants into principal.accounts,
// and buildSession exposes the agent capability for owned and whole-account-
// granted accounts, but NOT for book-scoped ones — so there is no new
// endpoint: the grants ARE the served set. Adding an agent = minting a grant;
// revoking one stops that binding without touching the rest or restarting
// the process.
//
// Revocation is LIVE, in two halves: an authz refusal mid-drain drops the
// account immediately (fleetDrain, step 4), and the periodic tick's
// re-discovery is the only way accounts come BACK. Channels FOLLOW the
// served set — a dropped grant also closes its socket.
//
// The ONE named divergence (s43 readme): graceful shutdown. Node dies
// mid-invocation and strands the claim as `running`; here the signal cancels
// the LISTENING (channels, ticker) while the drain runs on an uncancellable
// context — an in-flight invocation completes (or fail-completes) before the
// loop notices Done, so the server sees a COMPLETED invocation instead of a
// stranded one. A second signal falls through to the default disposition
// (signal.NotifyContext un-registers after the first), so a hung server
// cannot hold the process hostage.

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"net/url"
	"os/signal"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/account"
	bmio "github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/jmap"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/store"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/watch"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/ws"
)

// discoverAgentAccounts resolves the served set from a FRESH session. Absent
// capabilities (an older server) admit the account; the per-account drain
// refusal is the backstop.
func discoverAgentAccounts(ctx context.Context, client *jmap.Client) ([]account.Account, error) {
	session, err := client.RefreshSession(ctx)
	if err != nil {
		return nil, err
	}
	entries, err := session.Accounts()
	if err != nil {
		return nil, err
	}
	var out []account.Account
	for _, a := range entries {
		if a.AccountCapabilities != nil {
			if _, granted := a.AccountCapabilities[jmap.AgentCap]; !granted {
				continue
			}
		}
		out = append(out, account.Account{AccountID: a.ID, Name: a.Name})
	}
	return out, nil
}

// serveWSURL is the push channel's address — watch.ts's construction: same
// host, ws(s) scheme, /api/ws, the account and token as query parameters.
func serveWSURL(base, token, accountID string) string {
	u, err := url.Parse(base)
	if err != nil {
		return ""
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

// serveLoopDeps carries the effects the persistent-loop tests must own: the
// socket dial, the reconnect jitter, the discovery tick and the backoff
// bounds. Production fills every zero value.
type serveLoopDeps struct {
	dial       watch.DialFunc
	jitter     func() float64
	tick       <-chan time.Time
	backoffMin time.Duration
	backoffMax time.Duration
}

func (d *serveLoopDeps) fill() func() {
	stop := func() {}
	if d.dial == nil {
		d.dial = func(ctx context.Context, rawURL string) (watch.Socket, error) {
			return ws.Dial(ctx, rawURL)
		}
	}
	if d.jitter == nil {
		d.jitter = func() float64 { return 0.5 + rand.Float64()*0.5 }
	}
	if d.backoffMin == 0 {
		d.backoffMin = watch.DefaultBackoffMin
	}
	if d.backoffMax == 0 {
		d.backoffMax = watch.DefaultBackoffMax
	}
	if d.tick == nil {
		// The periodic tick is BOTH the fallback drain and the discovery
		// refresh: a newly minted grant is picked up within one interval,
		// no restart (agent.ts:388's 5 minutes).
		ticker := time.NewTicker(5 * time.Minute)
		d.tick = ticker.C
		stop = ticker.Stop
	}
	return stop
}

// serveChannel is one account's push socket: dial, read StateChange into
// kicks, reconnect with jittered backoff, die on cancel.
type serveChannel struct {
	cancel context.CancelFunc
	done   chan struct{}
}

func (ch *serveChannel) close() {
	ch.cancel()
	<-ch.done
}

func startServeChannel(parent context.Context, deps serveLoopDeps, base, token string,
	acc account.Account, kick func(), status func(string)) *serveChannel {
	ctx, cancel := context.WithCancel(parent)
	ch := &serveChannel{cancel: cancel, done: make(chan struct{})}
	go func() {
		defer close(ch.done)
		backoff := deps.backoffMin
		for ctx.Err() == nil {
			sock, err := deps.dial(ctx, serveWSURL(base, token, acc.AccountID))
			if err == nil {
				backoff = deps.backoffMin
				status(account.Label(acc) + ": connected")
				kick()
				// Reads block; a close() from the lifecycle side unblocks
				// them by closing the socket under the reader.
				closer := make(chan struct{})
				go func() {
					select {
					case <-ctx.Done():
						_ = sock.Close()
					case <-closer:
					}
				}()
				for {
					_, payload, err := sock.ReadMessage()
					if err != nil {
						break
					}
					var msg struct {
						Type string `json:"@type"`
					}
					if json.Unmarshal(payload, &msg) == nil && msg.Type == "StateChange" {
						kick()
					}
				}
				close(closer)
				_ = sock.Close()
			}
			if ctx.Err() != nil {
				return
			}
			wait := time.Duration(float64(backoff) * deps.jitter())
			select {
			case <-ctx.Done():
				return
			case <-time.After(wait):
			}
			backoff *= 2
			if backoff > deps.backoffMax {
				backoff = deps.backoffMax
			}
		}
	}()
	return ch
}

// agentServePersistent is the listen loop: channels follow the served set,
// the tick refreshes discovery, kicks drain. Runs until the context is
// cancelled (a signal, or a test).
func agentServePersistent(ctx context.Context, s *bmio.Streams, client *jmap.Client,
	settings *store.Settings, fleet *serveFleetConfig, label string, discover bool,
	deps serveLoopDeps) int {
	stopTick := deps.fill()
	defer stopTick()
	status := func(m string) { s.Note("[agent:" + label + "] " + m) }

	// Drains use an UNCANCELLABLE context — the graceful-shutdown half: a
	// signal stops the listening, never a claim mid-completion.
	drainCtx := context.WithoutCancel(ctx)

	served := map[string]account.Account{}
	var order []string
	refreshDiscovery := func() {
		var accounts []account.Account
		if discover {
			found, err := discoverAgentAccounts(drainCtx, client)
			if err != nil {
				// Discovery failing must not kill a running fleet — the
				// current served set keeps working; the next tick retries.
				status("discovery failed: " + bmio.ErrorMessage(err))
				return
			}
			accounts = found
		} else {
			accounts = settings.Accounts
		}
		next := map[string]bool{}
		for _, a := range accounts {
			next[a.AccountID] = true
		}
		for id, ref := range served {
			if !next[id] {
				delete(served, id)
				status(account.Label(ref) + ": no longer granted — dropped")
			}
		}
		source := "own account"
		if discover {
			source = "granted"
		}
		for _, a := range accounts {
			if _, have := served[a.AccountID]; !have {
				served[a.AccountID] = a
				if !containsString(order, a.AccountID) {
					order = append(order, a.AccountID)
				}
				status(account.Label(a) + ": serving (" + source + ")")
			}
		}
	}

	refreshDiscovery()
	names := make([]string, 0, len(fleet.Bindings))
	for name := range fleet.Bindings {
		names = append(names, name)
	}
	sort.Strings(names)
	caps := ""
	if len(fleet.Capabilities) > 0 && string(fleet.Capabilities) != "null" {
		caps = " — capabilities " + string(fleet.Capabilities)
	}
	status(fmt.Sprintf("serving %d binding(s) [%s] over %d account(s)%s",
		len(names), strings.Join(names, ", "), len(served), caps))

	drain := func() int { return fleetDrain(drainCtx, client, served, order, fleet, status) }
	n := drain()
	status(fmt.Sprintf("startup drain: %d invocation(s) handled", n))

	// One push channel per served account, all in ONE process under ONE
	// login — channels follow the served set, so a dropped grant also
	// closes its socket.
	kicks := make(chan struct{}, 1)
	kick := func() {
		select {
		case kicks <- struct{}{}:
		default: // a queued kick already covers this one
		}
	}
	channels := map[string]*serveChannel{}
	syncChannels := func() {
		for id, ch := range channels {
			if _, still := served[id]; !still {
				ch.close()
				delete(channels, id)
			}
		}
		for id, acc := range served {
			if _, have := channels[id]; !have {
				channels[id] = startServeChannel(ctx, deps, settings.Base, settings.Token, acc, kick, status)
			}
		}
	}
	syncChannels()

	for {
		select {
		case <-ctx.Done():
			for _, ch := range channels {
				ch.close()
			}
			status("shutting down — in-flight work completed, channels closed")
			return 0
		case <-deps.tick:
			refreshDiscovery()
			drain()
			syncChannels()
		case <-kicks:
			drain()
			syncChannels()
		}
	}
}

// runAgentServePersistent is production's entry: the signal context IS the
// graceful shutdown ("finish, then stop"); a second signal takes the default
// disposition.
func runAgentServePersistent(s *bmio.Streams, client *jmap.Client, settings *store.Settings,
	fleet *serveFleetConfig, label string, discover bool) int {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	return agentServePersistent(ctx, s, client, settings, fleet, label, discover, serveLoopDeps{})
}
