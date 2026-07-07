# popcorn 🍿

POP3, *"but way more corny."* A barely-conforming POP3S front-end that
translates onto a JMAP server. Legacy mail clients get their `RETR`; the
serverless brain (bullmoose.cc) keeps every message — popcorn **archives,
never destroys**.

## Why this exists

POP3 is a raw-TCP, server-speaks-first protocol — it cannot terminate at
Cloudflare's HTTP edge (Workers only accept HTTP/WebSockets, and the edge
waits for a request while the POP3 client waits for `+OK`). So the dumb
protocol adapter runs on anything with a real socket — a homelab Mac, a
$4 VPS, a container — and every stateful decision stays behind JMAP.

```
mail client ──POP3S :995──▶ popcorn (stateless per connection)
                               │ HTTPS + Basic (app-password token)
                               ▼
                        JMAP server (state lives here)
```

## Design

- **One common core, tiny platform branches.** The Go binary is static
  and identical everywhere (`CGO_ENABLED=0`); the only per-platform bits
  are in `deploy/` — a systemd unit (Debian/Ubuntu), a launchd plist
  (macOS), a distroless Dockerfile (multi-arch via buildx). arm64 vs
  x86_64 is a `GOARCH` flag, not a code branch. See `Makefile: all`.
- **Zero config for hosted domains.** The JMAP origin is discovered per
  login via the domain's `_jmap._tcp` SRV record (RFC 8620 §2.2);
  `POPCORN_JMAP_BASE` overrides.
- **Stateless sessions.** Every connection fetches a fresh JMAP session;
  the maildrop is snapshotted at login (POP3 requires stable numbering).
  popcorn holds no disk state at all.
- **`DELE` is an archive move.** Clients that "delete after download"
  shrink the maildrop as they expect, but the message just leaves the
  Inbox for Archive. `POPCORN_DELE_MODE=noop` ignores DELE entirely.
- **App-passwords only.** `PASS` takes a minted `bm_…` token
  (`bullmoose token create --name my-popper --scopes read,move`), never
  the account password.

Conformance: `USER PASS CAPA STAT LIST UIDL RETR TOP DELE RSET NOOP QUIT`
over implicit TLS. No STLS, no APOP, no plaintext in production. That
covers every client we care about; "barely" is a feature.

## Configuration (environment)

| var | default | notes |
|---|---|---|
| `POPCORN_LISTEN` | `:995` | comma-separated; any port works (`:443` too — see below) |
| `POPCORN_TLS_CERT` / `_KEY` | *(empty)* | PEM paths; both unset = plaintext **dev only** |
| `POPCORN_JMAP_BASE` | *(SRV discovery)* | e.g. `https://jmap.bullmoose.cc` |
| `POPCORN_DELE_MODE` | `archive` | or `noop` |
| `POPCORN_MAX_MESSAGES` | `200` | maildrop window, newest N |
| `POPCORN_IDLE_TIMEOUT` | `5m` | per-command deadline |

**Port 443?** Sure — on a DNS-only (grey-cloud) hostname the port is
yours, and most clients accept custom ports. Just don't put the record
behind Cloudflare's proxy; the HTTP edge can't pass raw POP3.

## Install

```sh
cd packages/popcorn

# macOS (launchd) or Linux (systemd) — auto-detected:
sh deploy/install.sh

# Docker (linux/amd64 + arm64):
docker buildx build --platform linux/amd64,linux/arm64 -f deploy/Dockerfile -t popcorn .
docker run -p 995:995 -v /etc/letsencrypt/live/pop3.example.com:/certs:ro \
  -e POPCORN_TLS_CERT=/certs/fullchain.pem -e POPCORN_TLS_KEY=/certs/privkey.pem popcorn

# cross-compile everything:
make all   # dist/popcorn-{darwin-arm64,linux-amd64,linux-arm64}
```

TLS cert for `pop3.<domain>`: Let's Encrypt DNS-01 (the zone is already
on Cloudflare — certbot's cloudflare plugin with a DNS-scoped token).

### Tailscale variant (no port-forward, no DDNS, nothing public)

For a homelab host on a tailnet, skip ALL the network surgery — no
router hole, no dynamic-DNS updater, no exposure to the internet:

```sh
sh deploy/install-tailscale-macos.sh    # macOS/launchd; idempotent
```

- binds **only** the node's tailscale IP — invisible to the LAN and
  the public internet; reachable from every device on your tailnet
  (rotating home DHCP is irrelevant: tailnet IPs and the
  `<node>.<tailnet>.ts.net` name are stable)
- TLS via `tailscale cert` — a real Let's Encrypt certificate for the
  ts.net name, auto-renewed weekly by a companion launchd job.
  Requires the tailnet's **HTTPS Certificates** toggle
  (admin console → DNS); until it's enabled the installer runs without
  app-layer TLS, which is acceptable *only* here because every tailnet
  packet is already WireGuard-encrypted device-to-device — re-run the
  installer after flipping the toggle to upgrade in place
- client setup: server `<node>.<tailnet>.ts.net`, port 9995, your
  app-password — works from any tailnet device (phones included)

Tradeoff vs the public variant: mail fetch requires the client device
to be on the tailnet — same failure class as any VPN dependency. Both
variants can run side by side (public VPS + tailnet homelab) since
popcorn is stateless: the JMAP server is the single source of truth.

## Picking a VPS

popcorn is a ~6 MB static binary, stateless, with a 64-connection cap —
it is comfortable on the **smallest instance every provider sells**.
What actually matters when picking:

- **RAM ≥ 256 MB** (512 MB is plenty; popcorn idles under 20 MB)
- **1 shared vCPU** — traffic is I/O-bound JMAP calls, not compute
- **A public IPv4** and the ability to open port 995 (and/or 443) —
  this disqualifies some cheap IPv6-only tiers unless your clients do v6
- **Prefer ARM** where offered — same binary (`popcorn-linux-arm64`),
  usually the cheapest tier
- Distro: Debian or Ubuntu LTS (the systemd unit targets both); disk is
  irrelevant (binary + cert + logs)

Approximate entry tiers (prices drift — check current):

| provider | pick | arch | ~cost | notes |
|---|---|---|---|---|
| Hetzner | CAX11 | arm64 | ~€4/mo | best value; EU + US regions |
| DigitalOcean | Basic Droplet 512 MB | amd64 | ~$4/mo | simplest UX; regular CPU is fine |
| AWS | Lightsail 512 MB, or EC2 `t4g.nano` | arm64 | ~$3.50–5/mo | Lightsail bundles the IPv4; raw EC2 adds an IPv4 charge |
| Vultr | Regular Cloud Compute 512 MB | amd64 | ~$5/mo (IPv4) | the ~$2.50 tier is IPv6-only — mind the client caveat |
| Linode/Akamai | Nanode 1 GB | amd64 | ~$5/mo | |
| GCP | `e2-micro` (Always Free, select US regions) | amd64 | $0 | free-tier egress limits are far above popcorn's needs |
| Oracle Cloud | Ampere A1 (Always Free) | arm64 | $0 | famously generous, famously fussy signup/reclaim policies |
| Fly.io | `shared-cpu-1x` + TCP service | either | ~$2–3/mo | deploy the Dockerfile; Fly does raw-TCP passthrough natively |
| your homelab | alpaca et al. | any | $0 | needs a router port-forward + DNS-01 cert |

Anti-recommendation: anything marketed for "mail servers" — popcorn
sends nothing (port 25 never enters the picture), so blocked-SMTP
policies on cheap VPSes don't matter here.

### IPv6-only vs dual-stack: better coverage for a lil' mo' money

The cheapest tiers above are cheap because they skip the IPv4 address
(AWS bills a public IPv4 at ~$3.65/mo under the **VPC** service — on a
nano instance the IP costs more than the computer). Tempting. But
popcorn is raw TCP: there is no Cloudflare proxy in front to bridge
protocol families like there is for HTTP. **An IPv6-only popcorn is
flatly invisible from any IPv4-only network your mail client sits on.**

And v4-only networks hide where you least expect them. Field notes from
this repo's own testing: an AT&T Fiber home network — full IPv6, both
directions ✓ — while an AT&T 5G+ phone *on the same carrier* scored
0/10 on IPv6 (legacy v4-only APN provisioning; the handset was fine).
Turning on a VPN (1.1.1.1/WARP) "fixed" it by tunneling to dual-stack —
which just means the mail path now depends on a VPN toggle. That's a
bad failure mode to buy for ~$1.50/mo of savings.

So, before choosing an IPv6-only tier, run [test-ipv6.com](https://test-ipv6.com)
from **every network you actually read mail on** — home Wi-Fi, cellular
*with any VPN off*, the office. All 10/10? The v6-only tier is a clean
buy, and arguably the more direct path (v6-native phones reach it with
no carrier NAT64 in the way). Anything 0/10? Pay the lil' mo' money for
dual-stack — it's the difference between "reachable from my networks"
and "reachable from networks."

(popcorn's *upstream* leg is immune either way: Cloudflare publishes
AAAA records, so a v6-only box reaches the JMAP API natively.)

## Client setup

- Server: `pop3.bullmoose.cc` (or wherever popcorn runs), SSL/TLS,
  port 995 (or your custom port)
- Username: full address (`eric@bullmoose.cc`)
- Password: an app-password token from `bullmoose token create`
- "Leave messages on server" in the client is belt-and-braces — the
  server keeps them regardless.
