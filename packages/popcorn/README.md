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

## Client setup

- Server: `pop3.bullmoose.cc` (or wherever popcorn runs), SSL/TLS,
  port 995 (or your custom port)
- Username: full address (`eric@bullmoose.cc`)
- Password: an app-password token from `bullmoose token create`
- "Leave messages on server" in the client is belt-and-braces — the
  server keeps them regardless.
