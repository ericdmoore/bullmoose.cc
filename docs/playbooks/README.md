# Playbooks

Task-oriented walkthroughs — *make an account, then do the thing*. Each is a
few commands plus the client-side setup. For the mailbox-by-mailbox tour of
what's live in prod, see the [cookbook](../README.md); for *why* it's built
this way, [`architecture/`](../architecture/README.md).

Prerequisites for every playbook: the platform deployed
([`../DEPLOY.md`](../DEPLOY.md)) and the operator CLI pointed at it
(`bullmoose admin init --url … --token "$ADMIN_TOKEN"`).

| playbook | for | cost |
|---|---|---|
| [Apple Mail + Apple Calendar](apple-mail-and-calendar.md) | macOS/iOS native Mail, Calendar, Contacts | calendar/contacts **$0**; Mail needs the popcorn shim — **$0** homelab+Tailscale or **~$5/mo** VPS |
| [JMAP client (Mailtemi)](jmap-client.md) | modern, full-fidelity mail (folders, threads, push) | **$0**, serverless |
| [Family sharing](family-sharing.md) | a household — shared contacts/calendar, per-device passwords | **$0**, serverless |

## Cost, in one line

Everything runs **$0** on Cloudflare's free tier **except** the POP3/SMTP shim
([popcorn](../../packages/popcorn/README.md)) — POP3/SMTP are raw-socket
protocols that can't live on Cloudflare's HTTP edge, so they need a real
socket somewhere: **$0** on a homelab box reached over Tailscale, or **~$5/mo**
on a small VPS. You only need popcorn for a *legacy mail client* (Apple Mail,
Outlook, Thunderbird-over-POP). JMAP clients, calendar, contacts, sharing, and
agents are all serverless.

## More to add

Ready to write on request — same shape, different client/use-case:

- **Android — contacts & calendar via [DAVx5](https://www.davx5.com/)** (the
  Android parallel to the Apple playbook; mail via any JMAP app). **$0**.
- **Thunderbird** — desktop, via JMAP (native/experimental) or POP3/SMTP
  through popcorn.
- **Migrate in from Google** — import contacts (`contacts import export.vcf`)
  and Google Calendar, keep Gmail as a live backup via deliver-and-forward
  (cookbook §1). The onboarding on-ramp. **$0**.
- **CLI power-user / offline** — `login` → `sync` to local SQLite → `watch` /
  `send` / `search` from the terminal. **$0**.
