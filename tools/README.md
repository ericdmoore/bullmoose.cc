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
