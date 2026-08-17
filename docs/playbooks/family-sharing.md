# Playbook: a family — shared contacts/calendar, per-device passwords

Goal: a household on one domain — several people under one tenant, a shared
address book (and calendar) everyone sees, and per-device app-passwords you
can revoke one at a time. This exercises the platform's differentiator:
multi-tenant accounts + cross-account **grants** (effective rights =
`token ∩ grant`, every access audited). All serverless, **$0**.

Placeholders: owner `you@example.com`, family member `partner@example.com`,
tenant `t_home`.

## 1. Two (or more) accounts under one tenant

The tenant is the household namespace; each person is an account in it.

```sh
bullmoose admin account create you@example.com     --tenant t_home --name "You"
bullmoose admin account create partner@example.com --tenant t_home --name "Partner"
bullmoose admin password you@example.com
bullmoose admin password partner@example.com
```

Add kids/roommates the same way. Each person connects their own devices via
the [Apple](apple-mail-and-calendar.md) or [JMAP-client](jmap-client.md)
playbook, using **their own** app-passwords.

## 2. A shared address book

Keep the shared book on one account (say `you@`) and grant the others. A
grant carrying `contacts` is read-write; `read` alone is read-only
(carddav-setup.md). Scope it to a single book with `--book` so the rest of
`you@`'s data stays private:

```sh
# whole-account share (simple): partner can read+write your contacts & calendar
bullmoose admin grant create partner@example.com you@example.com --scopes read,contacts,calendar

# tighter: just one address book, read-write, expiring in a year
bullmoose admin grant create partner@example.com you@example.com \
  --scopes read,contacts --book <addressBookId> --expires 365
```

The JMAP-native equivalent is `AddressBook.shareWith` from any client. Either
way the shared book **appears automatically** in the sharee's account — in
Contacts.app, in their JMAP client, in `bullmoose contacts list` — no re-add.
Edits by either person converge through the same core.

Inspect and revoke:

```sh
bullmoose admin grant list you@example.com          # who can reach this account
bullmoose admin grant revoke <grantId>              # instant; access is denied on next call
```

## 3. Per-device app-passwords (revoke one, keep the rest)

Every person mints one token per device — never the login password — so a lost
phone is revoked alone:

```sh
# partner, on their laptop:
bullmoose login partner@example.com
bullmoose token create --name "partner-iphone"  --scopes mail,contacts,calendar
bullmoose token create --name "partner-laptop"  --scopes mail

# you lost a device → operator revokes just that one:
bullmoose admin token list   partner@example.com
bullmoose admin token revoke <tokenId>
```

## 4. What to expect

- **Isolation by default.** Accounts see only their own data until a grant
  says otherwise; a grant is the *only* cross-account path, and its effective
  rights are `token ∩ grant` — a `read`-only grant can never write even if the
  device token holds `mail`.
- **Audited.** Every access through a grant is logged.
- **Composable.** `--book`/`--expires` narrow a grant; agents use the same
  grant machinery (an `assistant@` can be granted scoped, expiring read on a
  shared book — see [`../architecture/agent-integration.md`](../architecture/agent-integration.md) §4).

## Troubleshooting

- **Shared book doesn't appear** → confirm the grant: `admin grant list`;
  the sharee must re-sync (macOS Contacts: ⌘R) or wait for the next poll.
- **Sharee can't edit** → the grant lacks `contacts`/`calendar` (read-only);
  re-create it with the write scope.
- **Revoked but still visible on device** → the server denies immediately;
  the client clears on its next sync or account removal.
