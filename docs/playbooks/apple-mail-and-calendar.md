# Playbook: a human account on Apple Mail + Apple Calendar

Goal: `you@example.com` as a normal person's mailbox, synced by the Apple
apps on macOS/iOS — Mail, Calendar, and (free) Contacts.

**Protocol reality up front.** Apple Calendar/Contacts speak CalDAV/CardDAV,
which the `anglebrackets` worker serves *publicly* at `dav.<your-domain>` —
nothing extra to run. Apple **Mail** speaks IMAP/POP3/SMTP, *not* JMAP, so
its mail side rides the **popcorn** POP3S/SMTPS shim, which you run on any
host with a real socket — **$0** on a homelab box reachable over Tailscale,
or **~$5/mo** on a small VPS (see the cost caveat in §3, and
[`packages/popcorn`](../../packages/popcorn/README.md)). If you only want
calendar/contacts on Apple and read mail in a JMAP client, skip §3 and use
the [JMAP-client playbook](jmap-client.md) for mail.

Endpoints below use placeholders; map them to your deploy:
`jmap.<your-domain>`, `dav.<your-domain>` (Workers custom domains, or the
`*.workers.dev` fallbacks), and `pop.<your-domain>` (wherever you run
popcorn).

## 1. Create the account

```sh
bullmoose admin account create you@example.com --tenant t_home --name "Your Name"
bullmoose admin password you@example.com          # sets the login password (prompts)
bullmoose login you@example.com
```

## 2. Mint a device app-password (never the login password)

One token per device so it can be revoked alone. Apple needs mail + DAV, so
scope it for all three surfaces:

```sh
bullmoose token create --name "iphone" --scopes mail,contacts,calendar   # → bm_… , shown once
```

Copy the `bm_…` string. (Prefer separate tokens — `mail` for Mail,
`contacts,calendar` for the DAV account — if you want per-surface revocation.)

## 3. Apple Mail (POP3S in, SMTPS out — via popcorn)

> **Cost caveat — this is the only part of bullmoose that isn't free.**
> POP3/SMTP are raw-socket protocols that can't terminate on Cloudflare's
> HTTP edge, so popcorn runs *somewhere with a real socket*. Two ways:
> - **$0 — homelab + Tailscale.** Run popcorn on a box you already own and
>   reach it over your tailnet (the repo's `alpaca` reference: POP3S `:9995`,
>   SMTPS `:9587`). No public IP, no cert hassle, no monthly bill.
> - **~$5/mo — small VPS.** A $4–6 instance with a public IPv4 and a
>   Let's Encrypt cert for `pop.<your-domain>` (DNS-01; the zone is already
>   on Cloudflare). Use this if devices must sync off your network.
>
> Everything else here — calendar, contacts, and JMAP mail — is serverless
> and $0. If you don't want to run popcorn at all, read mail in a JMAP client
> ([playbook](jmap-client.md)) and use §4 for calendar/contacts only.

popcorn's defaults: **POP3S on `:995`** and
**SMTPS on whatever you set `POPCORN_SMTP_LISTEN` to** (implicit TLS, no
STARTTLS). The homelab reference in this repo uses `:9995` / `:9587` on a
tailnet host.

macOS Mail → **Settings → Accounts → Add Other Mail Account… → Mail Account**,
let it fail auto-setup, then **Manual**:

| field | Incoming (POP) | Outgoing (SMTP) |
|---|---|---|
| Server | `pop.<your-domain>` | `pop.<your-domain>` |
| Port / SSL | `995`, SSL **on** | `465` (or your `POPCORN_SMTP_LISTEN`), SSL **on** |
| Authentication | Password | Password |
| User name | `you@example.com` | `you@example.com` |
| Password | the `bm_…` token | the same `bm_…` token |

iOS: **Settings → Mail → Accounts → Add Account → Other → Add Mail Account**,
then set POP with the same values.

What to expect — POP3 is a download protocol, so this is the *legacy* face:
one Inbox, no folders, no push. popcorn **archives, never destroys** — "remove
copy from server after retrieving" just moves the message Inbox→Archive, so
nothing is lost and it still shows in every JMAP client's Archive. Sent mail
goes out through kettle-corn and is filed with `Email/import`, so it lands in
**Sent** everywhere. For folders/threads/push, use a JMAP client
([playbook](jmap-client.md)) and keep Apple Mail only if you need it.

## 4. Apple Calendar + Contacts (CalDAV/CardDAV — public, no shim)

Same credentials, the public DAV worker. This is covered field-by-field in
[`../carddav-setup.md`](../carddav-setup.md); the short version:

Calendar → **Settings → Accounts → Add Account… → Other CalDAV Account**
(and Contacts → **Add CardDAV Account**):

| field | value |
|---|---|
| User name | `you@example.com` |
| Password | the `bm_…` token (`calendar` / `contacts` scope) |
| Server address | `dav.<your-domain>` |
| Server path (Advanced) | `/dav/` · Port 443, SSL on |

Autodiscovery (`/.well-known/caldav`, `/.well-known/carddav`) is wired, so the
hostname alone usually suffices. Recurring events carry RRULE/EXDATE + a
generated VTIMEZONE and expand correctly across DST. Edits PUT back into the
core and appear in `bullmoose calendar agenda` / `contacts list` (and the
reverse reaches the Mac on its next poll). Idle polls are one O(1) PROPFIND.

## Troubleshooting

- **Mail won't connect** → popcorn must be reachable from the device
  (public host, or same tailnet). Check its port/TLS; `wrangler tail
  bullmoose-jmap` shows the JMAP calls behind it.
- **Calendar/Contacts 401** → token lacks `calendar`/`contacts` or was
  revoked; mint a fresh one. Live log: `wrangler tail bullmoose-anglebrackets`.
- **Wipe-and-resync** → remove the account on the device and re-add; the
  server is stateless, nothing to clean up.
