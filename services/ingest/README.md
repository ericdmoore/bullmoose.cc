# bullmoose-ingest

The Email Routing target for every hosted domain — inbound mail's
front door (wired per-domain by the provision worker as the catch-all,
plus literal rules where needed).

Pipeline per message:

1. resolve RCPT via the KV route table: exact → plus-tag-stripped →
   domain catch-all (`route:{domain}:*`); no route → `550 5.1.1`
2. raw RFC 5322 bytes → R2 (content-hash blobId); attachments become
   individually downloadable blobs
3. postal-mime parse → D1 metadata insert (threading via normalized
   Message-IDs)
4. agent bindings → `agent_invocations` rows (the envelope RCPT rides
   in `context_json` so the ledger pipeline can read plus-tags), then a
   fire-and-forget **poke** to the agent worker
5. `commitChanges` → AccountDO state bump → WebSocket push (this is
   what makes `bullmoose watch` show mail in ~2s)
6. RFC 3834 gate, then arm delivery-armed responders (vacation,
   watchdogs)
7. **deliver-and-forward**: a route's `forwardTo` list gets verified
   copies via `message.forward()` after the store succeeds (e.g.
   eric@'s Gmail backup) — a forward failure never bounces stored mail

Also: `POST /dev/inject` (DEV_INJECT=1 + internal token; local e2e
only — wrangler dev can't receive SMTP).
