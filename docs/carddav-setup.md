# Connecting Apple Contacts & Calendar to bullmoose (anglebrackets DAV)

The contacts core is the source of truth; anglebrackets serves it over
CardDAV at:

    https://bullmoose-anglebrackets.eric-d-moore.workers.dev

Autodiscovery (`/.well-known/carddav`) is wired, so clients only need
the hostname.

## 1. Mint a device app-password

Use a dedicated token per device so it can be revoked alone — contacts
sync needs only `read,contacts`:

```sh
bullmoose token create --name "macbook-contacts" --scopes read,contacts
```

Copy the `bm_…` string; it is shown once.

## 2. macOS Contacts

Contacts → **Settings → Accounts → Add Other Account… → CardDAV account**

| field | value |
|---|---|
| Account type | Advanced (if asked; Manual also works) |
| User name | `eric@bullmoose.cc` |
| Password | the `bm_…` token |
| Server address | `bullmoose-anglebrackets.eric-d-moore.workers.dev` |
| Server path (Advanced only) | `/dav/` |
| Port / SSL (Advanced only) | 443, SSL on |

iOS: Settings → Contacts → Accounts → Add Account → Other → **Add
CardDAV Account** with the same values.

## 2b. Apple Calendar (CalDAV — same worker, same credentials)

Calendar → **Settings → Accounts → Add Account… → Other CalDAV Account**

| field | value |
|---|---|
| Account type | Advanced (Manual also works) |
| User name | `eric@bullmoose.cc` |
| Password | a `bm_…` token (mint with `--scopes read,calendar`, or reuse one with both `contacts,calendar`) |
| Server address | `bullmoose-anglebrackets.eric-d-moore.workers.dev` |
| Server path (Advanced only) | `/dav/` |
| Port / SSL | 443, SSL on |

The default "Calendar" (with the imported Google events) appears;
recurring events carry RRULE/EXDATE and a generated VTIMEZONE, so the
Mac expands them correctly across DST. Edits PUT back into the core and
show up in `bullmoose calendar agenda` (and vice versa).

## 3. What to expect

- The "Contacts" book (3,559 cards) appears under the account; edits
  made in Contacts.app PUT straight into the core and show up in
  `bullmoose contacts list` (and vice versa — JMAP/CLI changes reach
  the Mac on its next poll).
- Idle polls are one ctag PROPFIND (O(1)); only real changes trigger a
  sync REPORT.
- A shared address book (granted via `AddressBook.shareWith` or
  `bullmoose admin grant … --book …`) appears automatically in the
  sharee's account — read-only unless the grant carries `contacts`.

## Troubleshooting

- Live request log: `npx wrangler tail bullmoose-anglebrackets`
- 401 → token lacks scopes or was revoked; mint a fresh one.
- Client shows stale data → force-sync (macOS: ⌘R in Contacts).
- Wipe-and-resync: remove the account on the device and re-add; the
  server is stateless, nothing to clean up.
