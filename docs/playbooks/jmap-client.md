# Playbook: a human account in a JMAP client (Mailtemi, etc.)

Goal: `you@example.com` in a modern JMAP client — [Mailtemi](https://www.mailtemi.com/),
the `bullmoose` CLI, or any RFC 8620 client. This is the **native** face: full
mailboxes/folders, threads, server-side search, live push, drafts, vacation —
and it is entirely **serverless and $0** (no popcorn, unlike the
[Apple Mail playbook](apple-mail-and-calendar.md)).

Endpoint placeholder: `jmap.<your-domain>` is your jmap worker's Workers
custom domain (or the `bullmoose-jmap.<acct>.workers.dev` fallback).

## 1. Create the account

```sh
bullmoose admin account create you@example.com --tenant t_home --name "Your Name"
bullmoose admin password you@example.com          # login password (prompts)
```

## 2. Mint a device app-password

`mail` covers every mail verb (read/draft/send/move/…). One token per device:

```sh
bullmoose login you@example.com
bullmoose token create --name "mailtemi" --scopes mail    # → bm_… , shown once
```

## 3. Connect the client

JMAP clients authenticate with the **app-password**, never the login password.
Two ways in:

- **Autodiscovery (just email + password).** `admin domain add` planted a
  `_jmap._tcp.<domain>` SRV record (RFC 8620 §2.2), so a client that
  autodiscovers finds your jmap host from the address alone. Enter
  `you@example.com` and the `bm_…` token.
- **Manual (if it asks for a JMAP URL).** Session resource:
  `https://jmap.<your-domain>/.well-known/jmap` · user `you@example.com` ·
  password = the `bm_…` token. The server advertises **both** `Bearer` and
  `Basic`, so username+password clients (Basic) and token clients (Bearer)
  both work.

**Mailtemi:** add a JMAP/email account, enter your address + the app-password;
if prompted for a server, give the session URL above.

**CLI (the reference client):**

```sh
bullmoose login you@example.com     # autodiscovers via SRV; --base <url> to override
bullmoose watch                     # live push
echo "hi" | bullmoose send --to a@b.com --subject "sent from the CLI"
```

## 4. What to expect

- Real mailboxes, threads, and full-text search — server-side, not
  client-side heuristics.
- **Push**: new mail appears within ~2s (EventSource / the CLI's `watch`).
- **Sending** goes through the submit worker → SES with your DKIM/SPF/DMARC.
  While SES is in sandbox, recipients must be verified identities.
- Drafts, flags, and vacation responses (RFC 8621 VacationResponse) sync
  across every JMAP client and the CLI.

## Troubleshooting

- **401 / auth fails** → token revoked or wrong scope; mint a fresh `mail`
  token. Confirm you used the `bm_…` token, not the login password.
- **Autodiscovery fails** → the client may not implement §2.2; enter the
  manual session URL. Check the record: `dig SRV _jmap._tcp.example.com`
  (an SRV target of `.` means "not offered").
- **Nothing arrives** → `wrangler tail bullmoose-jmap`; verify Email Routing
  catch-all targets `bullmoose-ingest` and the KV route exists.
