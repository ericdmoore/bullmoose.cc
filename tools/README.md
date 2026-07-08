# tools — end-to-end test suites

Both suites run against a **freshly seeded** local dev server, in order
(`e2e-jmap.mjs` first — it expects an empty mailstore):

```sh
cd services/jmap
printf 'DEV_BEARER_TOKEN=devtoken\nINTERNAL_TOKEN=internal\n' > .dev.vars
rm -rf .wrangler   # wipe prior local state
npx wrangler d1 execute bullmoose-mail-shard0 --local --file ../../packages/mailstore/sql/data-plane.sql
npx wrangler d1 execute bullmoose-mail-shard0 --local --file ../../packages/mailstore/sql/control-plane.sql
npx wrangler d1 execute bullmoose-mail-shard0 --local --command \
  "INSERT INTO mailboxes (id, account_id, parent_id, name, role, sort_order) VALUES
   ('mb_inbox','t_dev__a_local',NULL,'Inbox','inbox',0),
   ('mb_drafts','t_dev__a_local',NULL,'Drafts','drafts',3),
   ('mb_sent','t_dev__a_local',NULL,'Sent','sent',1)"
npx wrangler dev --port 8787 &

cd ../..
node tools/e2e-jmap.mjs        # core surface: session, set/query/get, patches, changes, blobs
node tools/e2e-punchlist.mjs   # himalaya punch list: Mailbox/query, Email/import, threading
node tools/e2e-contacts.mjs    # JMAP Contacts (RFC 9610): books, cards, query, ctag cascade
```

The contacts CLI doubles as the vCard-import acceptance test (same dev
server; `tools/fixtures/contacts-sample.vcf` exercises v3/v4, Apple item
groups, QP, and a UID-less card):

```sh
export BULLMOOSE_DB=/tmp/bullmoose-test.db
node packages/cli/bin/bullmoose.mjs init --base http://127.0.0.1:8787 --token devtoken
node packages/cli/bin/bullmoose.mjs contacts import tools/fixtures/contacts-sample.vcf
node packages/cli/bin/bullmoose.mjs contacts import tools/fixtures/contacts-sample.vcf  # idempotent: created 0
node packages/cli/bin/bullmoose.mjs contacts list
```

The `@bullmoose/cli` sync client doubles as the acceptance test for
incremental sync — against the same dev server:

```sh
npm run build:cli
export BULLMOOSE_DB=/tmp/bullmoose-test.db
node packages/cli/bin/bullmoose.mjs init --base http://127.0.0.1:8787 --token devtoken
node packages/cli/bin/bullmoose.mjs sync      # full
# ...mutate via Email/set, then:
node packages/cli/bin/bullmoose.mjs sync      # incremental via Email/changes
node packages/cli/bin/bullmoose.mjs log
```

## Testing `send` locally (mock relay, two workers)

`bullmoose send` exercises the full submission path
(Email/set draft → EmailSubmission/set → submit worker → relay →
onSuccessUpdateEmail drafts→Sent). SES can't run locally, so the submit
worker has a mock relay mode; both workers must share one local state
dir (`--persist-to`) so they see the same D1/R2, and wrangler's dev
registry connects the SUBMIT service binding automatically:

```sh
printf 'INTERNAL_TOKEN=internal\nRELAY=mock\n' > services/submit/.dev.vars
# jmap .dev.vars additionally needs SHARE_SIGNING_KEY=<anything> for
# big-file share links (send --expandMD html with files over --linkMax)
STATE=/tmp/bm-state   # seed D1 with --persist-to $STATE as above
(cd services/submit && npx wrangler dev --port 8788 --persist-to $STATE) &
(cd services/jmap   && npx wrangler dev --port 8787 --persist-to $STATE) &

printf '# Hello\n\n**bold** move' | \
  node packages/cli/bin/bullmoose.mjs send \
    --to someone@example.com --subject "Hi" --expandMD html
node packages/cli/bin/bullmoose.mjs read           # most recent message
node packages/cli/bin/bullmoose.mjs read <id> --raw  # original MIME
```
