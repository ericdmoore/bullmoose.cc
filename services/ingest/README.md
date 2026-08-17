# bullmoose-ingest

The Email Routing target for every hosted domain — inbound mail's
front door (wired per-domain by the provision worker as the catch-all,
plus literal rules where needed).

Pipeline per message:

1. resolve RCPT via the KV route table: exact → plus-tag-stripped →
   domain catch-all (`route:{domain}:*`); no route → `550 5.1.1`
2. **the s12 boundary cascade** (`boundary.ts`): stage 1 on the bare
   envelope — a bloom-fronted sender-set check where a deny-listed
   domain exits `550` at the SMTP edge with zero storage (daily
   counter only), a blocked-book sender is stored to the QUARANTINE
   mailbox with a `quarantine_events` chain row, a default-book sender
   is ACCEPTed as `sender_class='known'`; stages 2–4 on the parse —
   topmost `Authentication-Results` `dmarc=fail` → quarantine, then
   the sieve/Bayes stages (pass-through stubs until `@bullmoose/boundary`,
   see `boundaryContract.ts`). Empty config ⇒ byte-identical delivery
3. raw RFC 5322 bytes → R2 (content-hash blobId); attachments become
   individually downloadable blobs
4. postal-mime parse → D1 metadata insert (threading via normalized
   Message-IDs)
   4b. **the attachment sidestep** (`sidestep.ts`, s03.B T3): a non-inline
   attachment ≥ `N` bytes ALSO becomes a `FileNode` under the account's
   `Attachments` folder, so a big file is addressable in the Files realm
   and not only inside the one message. The message keeps its attachment
   and gains a `fileNodeId` cross-link; the bytes are not copied (one
   content-addressed blob, two references). `N` = the route's
   `sidestepBytes` → the worker's `ATTACHMENT_SIDESTEP_BYTES` var → 5 MiB;
   `0` disables. **Fail-open**: any Files failure logs and delivers the
   message anyway. Quarantined and screened mail never side-steps
5. agent bindings → `agent_invocations` rows (the envelope RCPT rides
   in `context_json` so the ledger pipeline can read plus-tags), then a
   fire-and-forget **poke** to the agent worker
6. `commitChanges` → AccountDO state bump → WebSocket push (this is
   what makes `bullmoose watch` show mail in ~2s)
7. RFC 3834 gate, then arm delivery-armed responders (vacation,
   watchdogs)
8. **deliver-and-forward**: a route's `forwardTo` list gets verified
   copies via `message.forward()` after the store succeeds (e.g.
   eric@'s Gmail backup) — a forward failure never bounces stored mail
   (quarantined messages are held, never forwarded)

Also: `POST /dev/inject` (DEV_INJECT=1 + internal token; local e2e
only — wrangler dev can't receive SMTP).
