# Run bullmoose on your own domain

One binary, one token, your domain. `bullmoose cloud install` stands up the
whole mail platform — workers, database, storage, routes — on **your**
Cloudflare account, downloading the published stack from
[dl.bullmoose.cc](https://dl.bullmoose.cc/stack/latest.txt). No Node, no
checkout, no access to this repo needed.

Everything the installer generates (admin token, vault master key, signing
keys) is minted on your machine and lands only in your Cloudflare account.
This project sees nothing — that is the point.

## What you need

1. **The CLI** — [docs/install-cli.md](./install-cli.md), or:
   ```sh
   curl -fsSLO "https://dl.bullmoose.cc/cli/$(curl -fsSL https://dl.bullmoose.cc/cli/latest.txt)/checksums.txt"
   # download the binary for your platform from the same directory, verify, chmod +x
   ```
2. **A domain on Cloudflare** — the zone the stack installs onto.
3. **A Cloudflare API token** (create a *Custom Token* in the dashboard):

   | scope | why |
   |---|---|
   | Account · Workers Scripts · Edit | upload the eight workers |
   | Account · D1 · Edit | the mailstore database + schema |
   | Account · Workers KV Storage · Edit | routing/session namespaces |
   | Account · Workers R2 Storage · Edit | the blob bucket |
   | Account · Cloudflare Pages · Edit | the webmail app |
   | Zone · Zone · Read | find your zone, derive the account |
   | Zone · DNS · Edit | the app/api hostnames |
   | Zone · Workers Routes · Edit | bind paths on your hostnames |
   | Zone · Email Routing · Read | `cloud doctor`'s mail-path walk |

   If the token is missing a scope, `cloud plan` names the missing one
   exactly — running it is the honest way to check.

4. **SES keys for outbound mail** (`SES_ACCESS_KEY_ID` /
   `SES_SECRET_ACCESS_KEY`, IAM scoped to `ses:SendRawEmail` plus identity
   management — the receipt names them if absent). Bring-your-own-provider
   is config the installer accepts and verifies, never an account it
   conjures.

## Zero to inbox

```sh
export CLOUDFLARE_API_TOKEN=…        # never an argument — env only
export SES_ACCESS_KEY_ID=…  SES_SECRET_ACCESS_KEY=…

bullmoose cloud plan    --zone example.com   # read-only: see everything first
bullmoose cloud install --zone example.com   # the same plan + one yes + apply
```

`plan` prints every resource by name — create / reuse / refuse — with
refusals ranked first. The installer **never overwrites a resource it did
not make**: a DNS record it can't prove is platform-shaped is refused, and
there is no uninstall verb (deletion is a documented manual act, never a
side effect). A half-applied install is a resumable state — fix the cause,
re-run the same command.

`install` ends where `admin init` begins. Its receipt prints your
`ADMIN_TOKEN` **once** and the exact commands that follow:

```sh
bullmoose admin init --url https://bullmoose-provision.<your-subdomain>.workers.dev --token …
bullmoose admin tenant add my-house
bullmoose admin domain add example.com --tenant <tenantId>
```

`domain add` is the mail path: the stack itself enables Email Routing,
points the catch-all at its ingest worker, and writes the SES DKIM /
MAIL FROM / DMARC records — each step receipted. Then verify from outside:

```sh
bullmoose cloud doctor --zone example.com
```

The doctor is read-only and walks Email Routing, catch-all→ingest, MX,
DKIM and DMARC, naming the fixing command per gap (and a token gap as a
token gap — never as a mail problem).

The webmail app is the one step that still runs through `npx` (Pages
direct upload is wrangler's own file-hash protocol); the receipt prints it
filled in:

```sh
d=$(mktemp -d) && curl -fsSL https://dl.bullmoose.cc/stack/<version>/webmail.tar.gz | tar -xz -C "$d" && \
  npx --yes wrangler@4 pages deploy "$d" --project-name bullmoose-app
```

From there: `bullmoose admin account add`, log in at `https://app.example.com`,
and send yourself the first message.

## Staying current

```sh
bullmoose cloud update --zone example.com
```

Same machinery, newest published stack: existing resources are bound by
the ids your account assigned, **secrets are kept, never rotated** (a
rotated vault key would orphan every sealed credential — the installer
refuses to be the thing that does that), workers re-upload, migrations run
exactly where the schema predates them.

## Where the truth lives

- The stack you install is checksummed end to end: `manifest.json` carries
  a sha256 for every file, and nothing is parsed or uploaded without
  verifying it.
- `bullmoose cloud plan --json` / `cloud doctor --json` emit the same
  answers machine-readably.
- Versions: `https://dl.bullmoose.cc/stack/latest.txt`, contents under
  `stack/<version>/manifest.json`.
