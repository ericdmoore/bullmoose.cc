# Worked examples — on your own domain

Every command below is real, in order, and assumes nothing about `bullmoose.cc`.
Substitute your own domain for `example.com` throughout — that is the whole
point of this page (issue #2: _"especially on other domains"_).

The cookbook ([`../README.md`](../README.md)) shows what each mailbox _does_
once it exists. This shows the path from a bare domain to the first working
thing, four times, for four different reasons to be here.

---

## 0. The one-time part (everything below assumes it)

```sh
export CLOUDFLARE_API_TOKEN=…          # scopes: ../install-cloud.md
bullmoose cloud plan    --zone example.com     # read-only: see it first
bullmoose cloud install --zone example.com     # the same plan + one yes

# the receipt prints these three, filled in
bullmoose admin init --url https://bullmoose-provision.<subdomain>.workers.dev --token <ADMIN_TOKEN>
bullmoose admin tenant add home
bullmoose admin domain add example.com --tenant <tenantId>
bullmoose cloud doctor  --zone example.com     # MX · routing · DKIM · DMARC
```

`cloud doctor` is the honest check: it walks the mail path from _outside_ the
stack and names the fixing command for anything missing. Mail is not working
until it says so, whatever the install printed.

---

## 1. A person — you, reading mail on your own domain

The smallest useful deployment. One account, any client.

```sh
bullmoose admin account create you@example.com --tenant home --name "You"
bullmoose login you@example.com          # autodiscovery finds the endpoint
bullmoose log -n 10                      # the last ten messages, from the local mirror
bullmoose send --to friend@elsewhere.org --subject "hello" --body "from my own domain"
```

Then point a real client at it:

- **Apple Mail / Calendar / Contacts** — [`../playbooks/`](../playbooks/README.md)
  and [`../carddav-setup.md`](../carddav-setup.md).
- **The webmail** — `https://app.example.com`, which `cloud install` wired.
- **An IMAP-era app that will not speak JMAP** — run
  [popcorn](../../packages/popcorn/README.md) on a box you own; it is a
  POP3/SMTP shim, not another server.

---

## 2. A family — several people, one domain, shared calendars

Accounts are per-person; sharing is a _grant_, never a shared password.

```sh
bullmoose admin account create you@example.com     --tenant home --name "You"
bullmoose admin account create partner@example.com --tenant home --name "Partner"

# the second human sets their OWN credential — you never learn it.
# The link is minted by the provision API (POST /principals/enrollment-link);
# hand the URL over out of band (text it), and they register two passkeys.

# let them read your calendar + contacts, revocably
bullmoose admin grant create partner@example.com you@example.com --scopes read,contacts --expires 365
bullmoose admin grant list partner@example.com
bullmoose admin grant revoke <grantId>
```

The enrollment link is the point: an operator who provisions an account never
holds its credential, because there is no password to hold — the arriving human
registers two passkeys and the account is theirs.

---

## 3. A small business — a role address with an agent behind it

An agent is an ordinary account plus a **binding**. Nothing about the mailbox
is special; what differs is that a runtime claims its deliveries.

```sh
bullmoose admin account create editor@example.com --tenant home --name "Editor"
bullmoose admin agent bind editor@example.com --name editor --reply-mode draft \
  --config editor-emily.config.json          # in this directory

# watch it work — proposals, never actions
bullmoose approvals list
bullmoose approvals show <id>
bullmoose approvals approve <id>            # or edit, or decline with a reason
```

Two things worth knowing before you point one at customers:

- **A binding cannot mail whoever it likes.** Its reach is a _governing address
  book_; a recipient outside it is refused at the relay, not warned about.
- **`--reply-mode draft` means it proposes.** `send` exists, and it is a
  different decision — make it deliberately.

---

## 4. A homelab — your own hardware doing the work

The cloud runtime and your box claim from the _same_ queue, so this is a
capacity choice, not an architecture change.

```sh
bullmoose admin account create hermes@example.com --tenant home --name "Hermes"
bullmoose admin agent bind hermes@example.com --name hermes-responder --sla 45

# on the box (one static binary, no runtime to install)
bullmoose login hermes@example.com
bullmoose local setup                       # finds Ollama/LiteLLM/vLLM/llama.cpp
bullmoose agent serve --fleet fleet.json    # --once drains and exits (cron-friendly)
bullmoose agent install --fleet fleet.json  # optional: survive a reboot, opt-in
```

`agent install` prints the launchd/systemd unit **before** writing it, and
refuses to touch a unit it did not create. If the box already runs its own
watchdogs, pick one owner of restart duty — two supervisors fight.

Your models never leave the box: `bullmoose local` records which host serves
which model, and Settings → Devices renders the join, so the app can tell you
_"`extractor` references `@local/llama3` — no registered box reports serving
it"_ instead of failing silently.

---

## Where to go next

| you want                    | read                                                     |
| --------------------------- | -------------------------------------------------------- |
| what each mailbox can DO    | [the cookbook](../README.md)                             |
| the install's own reference | [`../install-cloud.md`](../install-cloud.md)             |
| every CLI verb              | [`../cli.md`](../cli.md) or `bullmoose help`             |
| agent internals             | [`../agents/README.md`](../agents/README.md)             |
| the design, and why         | [`../architecture/README.md`](../architecture/README.md) |
