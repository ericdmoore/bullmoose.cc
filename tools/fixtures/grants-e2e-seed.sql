-- Seed for tools/e2e-grants.mjs: a tenant with three principals/accounts
-- (owner eric@, sharee carol@, delegated agent editor@) and fixed test
-- tokens (LOCAL DEV ONLY — the secrets are public in this repo):
--   eric   bm_aaaaaaaaaaaa_<48×a>   scopes ["mail"]
--   carol  bm_bbbbbbbbbbbb_<48×b>   scopes ["mail"]
--   editor bm_cccccccccccc_<48×c>   scopes ["read"]
INSERT INTO tenants (id, name, status, created_at) VALUES
  ('t_test', 'Grants E2E', 'active', 1700000000000);

INSERT INTO principals (id, tenant_id, login_email, created_at) VALUES
  ('p_eric',   't_test', 'eric@test.local',   1700000000000),
  ('p_carol',  't_test', 'carol@test.local',  1700000000000),
  ('p_editor', 't_test', 'editor@test.local', 1700000000000);

INSERT INTO accounts (id, tenant_id, principal_id, display_name, shard, created_at) VALUES
  ('t_test__a_eric',   't_test', 'p_eric',   'Eric',   'shard0', 1700000000000),
  ('t_test__a_carol',  't_test', 'p_carol',  'Carol',  'shard0', 1700000000000),
  ('t_test__a_editor', 't_test', 'p_editor', 'Editor', 'shard0', 1700000000000);

INSERT INTO identities (id, account_id, email, name) VALUES
  ('id_eric',   't_test__a_eric',   'eric@test.local',   'Eric'),
  ('id_carol',  't_test__a_carol',  'carol@test.local',  'Carol'),
  ('id_editor', 't_test__a_editor', 'editor@test.local', 'Editor');

INSERT INTO tokens (id, principal_id, kind, secret_hash, name, scopes, created_at) VALUES
  ('tk_aaaaaaaaaaaa', 'p_eric',   'bearer',
   '97daac0ee9998dfcad6c9c0970da5ca411c86233a944c25b47566f6a7bc1ddd5', 'e2e-eric',   '["mail"]', 1700000000000),
  ('tk_bbbbbbbbbbbb', 'p_carol',  'bearer',
   '720228e4b7b018b5e0c8c5dcc15b8955175fa5e5826c7e80c267f2a2d397d0e0', 'e2e-carol',  '["mail"]', 1700000000000),
  ('tk_cccccccccccc', 'p_editor', 'bearer',
   '3cb5a29b1a38406c80bcd134189426fadf7b55735d1de53eabb6202e3fd48545', 'e2e-editor', '["read"]', 1700000000000);

-- Eric's inbox with one message (delegated-read + analytics fixtures).
INSERT INTO mailboxes (id, account_id, parent_id, name, role, sort_order) VALUES
  ('mb_e2e_inbox', 't_test__a_eric', NULL, 'Inbox', 'inbox', 0);

INSERT INTO emails (id, account_id, blob_id, thread_id, message_id, in_reply_to,
                    subject, from_json, to_json, preview, size, received_at)
VALUES ('em_e2e_1', 't_test__a_eric', 'b_e2e', 'th_e2e_1', 'e2e-1@test.local', NULL,
        'Quarterly numbers', '[{"email":"cfo@example.com"}]',
        '[{"email":"eric@test.local"}]', 'numbers inside', 1234, 1782000000000);

INSERT INTO email_mailboxes (account_id, email_id, mailbox_id) VALUES
  ('t_test__a_eric', 'em_e2e_1', 'mb_e2e_inbox');

-- Spend ledger fixtures for the analytics MCP.
INSERT INTO spend_facts (account_id, id, email_id, vendor, amount_cents, currency,
                         txn_date, period_month, category, confidence, dedup_hash, created_at)
VALUES
  ('t_test__a_eric', 'sf_1', NULL, 'sparkling-pools', 12500, 'USD',
   '2026-06-15', '2026-06', 'home', 1, 'h1', 1750000000000),
  ('t_test__a_eric', 'sf_2', NULL, 'acme-water',       4200, 'USD',
   '2026-06-20', '2026-06', 'home', 1, 'h2', 1750000000000),
  ('t_test__a_eric', 'sf_3', NULL, 'sparkling-pools', 12500, 'USD',
   '2026-07-01', '2026-07', 'home', 1, 'h3', 1750000000000);
