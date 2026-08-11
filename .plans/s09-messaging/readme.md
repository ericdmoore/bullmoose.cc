# s09 — Messaging gateway (XMPP / Matrix)

> **Status: deferred stub.** Nothing is built and nothing should be. This file exists so
> the transport analysis is not re-derived in six months — it is cheap to write now and
> annoying to reconstruct later.
>
> **Trigger:** a second human actually needs to talk to you *inside* bullmoose. Today the
> deployment has one operator, so a messaging service would have nobody on the other end.
> Presence and rosters are infrastructure for a social graph that does not exist yet.
>
> **Ordering:** firmly behind `s03.D` (`ActionProposal` — the thing that makes this a
> collaboration space at all) and `s08` (the Go CLI). Do not start this because it is
> interesting.

---

## The finding: XMPP splits cleanly, and the halves land on opposite sides

**Client-to-server works on this runtime.** XMPP's native C2S is a long-lived XML stream on
TCP 5222, but **RFC 7395 defines XMPP over WebSocket** — a real standard binding, not a
workaround. That lands on infrastructure that already exists here: `services/jmap/src/index.ts:138`
already proxies a WebSocket straight to the account's Durable Object. A DO per account
holding a stream, with hibernation, is the natural shape for presence and rosters. (BOSH,
XEP-0124/0206, is the HTTP long-polling fallback if it were ever needed.)

**Server-to-server does not.** S2S is TCP 5269 carrying raw XML streams, and **RFC 7395 is
client-to-server only** — there is no standard WebSocket binding for federation. Workers
cannot accept inbound TCP on arbitrary ports, so federated traffic cannot arrive at a
Worker at all.

**That is exactly the SMTP situation, for exactly the same reason.** Port 25/587 cannot live
in a Worker, so `popcorn` — a Go shim under launchd, bound to the Tailscale IP — holds it.
XMPP federation would need a second popcorn: same shape, same constraint, same box.

Pleasant compounding: popcorn is Go, `s08` commits to a Go toolchain, and an S2S shim is
that kind of program.

### "Why not just let them talk to Cloudflare directly?"

The first question anyone asks, and the answer is not about reachability.

S2S is the inter-domain hop, exactly like SMTP's MTA-to-MTA: `example.org` needs to know a
stanza really came from `alice@bullmoose.cc`, and it learns that because the **servers**
authenticate to each other (TLS certs plus dialback or SASL EXTERNAL) and it trusts
bullmoose.cc's assertion about its own users. Alice has no credentials at `example.org` and
never will. Offline store-and-forward, presence fan-out and domain-boundary policy all live
on that hop too.

So the blocker is not that Cloudflare is unreachable. It is **what the peer will try to
speak.** A remote Prosody or ejabberd does an SRV lookup for `_xmpp-server._tcp`, opens a
raw TCP connection on 5269, and starts streaming XML. Cloudflare's edge terminates
HTTP/HTTPS — WebSocket upgrades included — and 5269 is not HTTP. There is nothing to hand
the connection to.

And it cannot be fixed from our side. An HTTP binding for S2S could be invented tomorrow and
**no other server would speak it.** Federation only works if you speak what everyone else
already speaks: the protocol is a contract with strangers, and it cannot be amended
unilaterally. That is the whole difference between C2S — where we ship the client, so RFC
7395 is usable — and S2S, where the peer is someone else's software configured by someone we
will never meet.

> Cloudflare **Spectrum** proxies arbitrary TCP and is the obvious counter-suggestion. It
> proxies *to an origin*, so something still has to hold 5269. It moves which machine
> accepts the packet, not whether a long-lived process has to exist.

## The comparison that matters, and it inverts the obvious guess

| | XMPP | Matrix |
|---|---|---|
| C2S on Workers | ✅ WebSocket → DO (RFC 7395) | ✅ plain HTTP + long-poll `/sync` |
| **federation** | ❌ TCP 5269, needs a port-holder | ✅ **HTTPS 8448 (or 443 via `.well-known`), Ed25519-signed JSON — nothing extra** |
| server complexity | simple per-message | **hard** — room DAG, state resolution v2 |
| storage appetite | modest | **large** — rooms replicate full event graphs |

**Matrix federates over HTTP**, which is the one thing this runtime is unambiguously good
at — a remote homeserver federating with us is *literally making HTTP requests*, which a
Worker answers with nothing extra. XMPP is the simpler protocol that fights the runtime;
Matrix is the harder protocol that fits it.

That is not luck, and it is worth stating because it predicts how other protocols will
land: XMPP was designed in 1999, when a long-lived TCP stream was the obvious shape for
real-time. Matrix was designed in 2014, when HTTP was. **A protocol's federation transport
tends to date it**, and that is the single best predictor of whether it can live on this
runtime without a shim.

⚠️ Matrix's storage profile is the reason this is not an easy "just do Matrix": full
event-graph replication per room is not a D1-shaped workload, and
`docs/architecture/capacity-and-scaling.md` already worries about single-shard ceilings for
mail alone. Any serious Matrix work starts with that measurement, not with the protocol.

## The pragmatic path, when the trigger fires

**Do not federate first.** XMPP C2S over WebSocket, one DO per account, no S2S:

- a working messaging service for your own users
- zero new infrastructure — the WS proxy and AccountDO already exist
- no port-holder, no second popcorn, nothing on the alpaca box

Federation is the *only* part that needs the shim, and deferring it indefinitely is a
legitimate end state. If federation ever becomes the point, that is the moment to weigh
Matrix seriously rather than bolting S2S onto XMPP.

## What it would reuse

- **`AccountDO`** — already per-account, already the target of a WS proxy. Presence and
  roster are per-account state.
- **The WebSocket path** (`services/jmap/src/index.ts:138`, `webmail`'s `watch()`).
- **The SRV convention.** The zone already carries `_jmap._tcp.bullmoose.cc`; XMPP uses the
  same shape (`_xmpp-client._tcp`, `_xmpp-server._tcp`), so discovery would feel familiar.
- **Go**, from `s08`, if an S2S shim is ever wanted.
- **The grant model** — messaging between accounts is an authorization question the
  `grants` table already has opinions about.

## References

- RFC 6120 / 6121 — XMPP core and IM/presence
- RFC 7395 — XMPP over WebSocket (**C2S only**; this is the load-bearing citation)
- XEP-0124 / XEP-0206 — BOSH
- Matrix Server-Server API — federation over HTTPS, Ed25519-signed
- `docs/architecture/capacity-and-scaling.md` — why Matrix storage needs measuring first
- `~/.popcorn/` — the existing precedent for "a protocol that needs a held port"
