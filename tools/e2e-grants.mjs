// Grants + sharing + vault + analytics-MCP e2e (Phase 3). Needs three
// local dev servers sharing one state dir (see tools/README.md):
//   jmap :8787, agent :8789, provision :8790
// seeded with tools/fixtures/grants-e2e-seed.sql (eric owner, carol
// sharee, editor read-delegated agent; fixed dev tokens).
const JMAP = 'http://127.0.0.1:8787';
const AGENT = 'http://127.0.0.1:8789';
const PROV = 'http://127.0.0.1:8790';
const ADMIN = 'admintoken';
const INTERNAL = 'internal';

const ERIC = { acct: 't_test__a_eric', token: 'bm_aaaaaaaaaaaa_' + 'a'.repeat(48), email: 'eric@test.local' };
const CAROL = { acct: 't_test__a_carol', token: 'bm_bbbbbbbbbbbb_' + 'b'.repeat(48), email: 'carol@test.local' };
const EDITOR = { acct: 't_test__a_editor', token: 'bm_cccccccccccc_' + 'c'.repeat(48), email: 'editor@test.local' };

const assert = (cond, msg) => { if (!cond) { console.error('FAIL: ' + msg); process.exit(1); } };
const USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail', 'urn:ietf:params:jmap:contacts'];
const jmap = async (who, methodCalls) => {
  const res = await fetch(`${JMAP}/api/jmap`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${who.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ using: USING, methodCalls }),
  });
  if (!res.ok) { console.error(`FAIL: api/jmap HTTP ${res.status}: ${await res.text()}`); process.exit(1); }
  return (await res.json()).methodResponses;
};
const session = async (who) =>
  (await fetch(`${JMAP}/.well-known/jmap`, { headers: { Authorization: `Bearer ${who.token}` } })).json();

// ---- 1. owner setup: Family book + one private, one shared card -------
// First touch auto-creates the default "Contacts" book, so Family below
// is NOT the default and private cards stay out of it.
const [[, abInit]] = await jmap(ERIC, [['AddressBook/get', { accountId: ERIC.acct, ids: null }, 'i0']]);
assert(abInit.list.some(b => b.isDefault && b.name === 'Contacts'), 'owner default book exists');
const [[, fam]] = await jmap(ERIC, [['AddressBook/set', { accountId: ERIC.acct, create: {
  f: { name: 'Family' } } }, 'c0']]);
const famId = fam.created?.f?.id;
assert(famId, `family book created: ${JSON.stringify(fam.notCreated)}`);

const [[, cards]] = await jmap(ERIC, [['ContactCard/set', { accountId: ERIC.acct, create: {
  gm: { name: { full: 'Grandma Moore' }, uid: 'e2e-grandma', addressBookIds: { [famId]: true } },
  pv: { name: { full: 'Private Pete' }, uid: 'e2e-private' },
} }, 'c1']]);
const grandmaId = cards.created?.gm?.id;
const privateId = cards.created?.pv?.id;
assert(grandmaId && privateId, `cards created: ${JSON.stringify(cards.notCreated)}`);
const stateBeforeShare = cards.newState;

// ---- 2. carol has no access before sharing ----------------------------
const carolPre = await session(CAROL);
assert(!carolPre.accounts[ERIC.acct], 'carol does not see eric pre-share');

// ---- 3. owner shares Family with carol (mayWrite) ---------------------
const [[, shareRes]] = await jmap(ERIC, [['AddressBook/set', { accountId: ERIC.acct, update: {
  [famId]: { shareWith: { [CAROL.acct]: { mayRead: true, mayWrite: true } } },
} }, 'c2']]);
assert(shareRes.updated && famId in shareRes.updated, `share applied: ${JSON.stringify(shareRes.notUpdated)}`);

const [[, abOwner]] = await jmap(ERIC, [['AddressBook/get', { accountId: ERIC.acct, ids: [famId] }, 'c3']]);
const ownerView = abOwner.list[0];
assert(ownerView.shareWith?.[CAROL.acct]?.mayWrite === true, `owner sees shareWith: ${JSON.stringify(ownerView.shareWith)}`);
assert(ownerView.myRights.mayShare === true, 'owner keeps full rights');

// ---- 4. carol's session now includes eric's account -------------------
const carolSess = await session(CAROL);
const carolEric = carolSess.accounts[ERIC.acct];
assert(carolEric, 'granted account appears in carol session');
assert(carolEric.isPersonal === false, 'granted account is not personal');
assert(carolEric.accountCapabilities['urn:ietf:params:jmap:contacts'], 'contacts capability granted');
assert(!carolEric.accountCapabilities['urn:ietf:params:jmap:mail'], 'book-scoped grant exposes NO mail capability');

// ---- 5. carol sees exactly the shared book ----------------------------
const [[, abCarol]] = await jmap(CAROL, [['AddressBook/get', { accountId: ERIC.acct, ids: null }, 'c4']]);
assert(abCarol.list.length === 1 && abCarol.list[0].id === famId,
  `carol sees only Family: ${JSON.stringify(abCarol.list.map(b => b.name))}`);
assert(abCarol.list[0].myRights.mayWrite === true && abCarol.list[0].myRights.mayShare === false,
  'sharee rights from grant');
assert(abCarol.list[0].shareWith === null, 'sharee sees shareWith null');

// ---- 6. card visibility is book-scoped --------------------------------
const [[, qCarol]] = await jmap(CAROL, [['ContactCard/query', { accountId: ERIC.acct, calculateTotal: true }, 'c5']]);
assert(qCarol.total === 1 && qCarol.ids[0] === grandmaId, `carol queries only shared cards: ${JSON.stringify(qCarol)}`);
const [[, gPriv]] = await jmap(CAROL, [['ContactCard/get', { accountId: ERIC.acct, ids: [privateId] }, 'c6']]);
assert(gPriv.notFound.includes(privateId), 'private card reads as notFound for carol');

// ---- 7. carol writes into the shared book -----------------------------
const [[, cCreate]] = await jmap(CAROL, [['ContactCard/set', { accountId: ERIC.acct, create: {
  n: { name: { full: 'Nephew Ned' }, uid: 'e2e-ned' },
} }, 'c7']]);
const nedId = cCreate.created?.n?.id;
assert(nedId, `carol created in shared book: ${JSON.stringify(cCreate.notCreated)}`);
const [[, gNed]] = await jmap(ERIC, [['ContactCard/get', { accountId: ERIC.acct, ids: [nedId] }, 'c8']]);
assert(gNed.list[0]?.addressBookIds?.[famId] === true, 'owner sees carol-created card in Family');

// ---- 8. the grant does NOT unlock mail or book management -------------
const [mailTry] = await jmap(CAROL, [['Email/query', { accountId: ERIC.acct }, 'c9']]);
assert(mailTry[0] === 'error' && mailTry[1].type === 'forbidden', `mail blocked for carol: ${JSON.stringify(mailTry[1])}`);
const [abTry] = await jmap(CAROL, [['AddressBook/set', { accountId: ERIC.acct, create: { x: { name: 'Nope' } } }, 'c10']]);
assert(abTry[0] === 'error' && abTry[1].type === 'forbidden', 'sharee cannot manage books');

// ---- 9. changes are filtered for the sharee ----------------------------
const [[, chCarol]] = await jmap(CAROL, [['ContactCard/changes', { accountId: ERIC.acct, sinceState: stateBeforeShare }, 'c11']]);
assert(chCarol.created.includes(nedId), 'carol sees her create in changes');
assert(!chCarol.created.includes(privateId) && !chCarol.updated.includes(privateId),
  'private card never appears in carol changes');

// ---- 10. rights downgrade: read-only ----------------------------------
await jmap(ERIC, [['AddressBook/set', { accountId: ERIC.acct, update: {
  [famId]: { [`shareWith/${CAROL.acct}/mayWrite`]: false },
} }, 'c12']]);
const [roTry] = await jmap(CAROL, [['ContactCard/set', { accountId: ERIC.acct, create: {
  x: { name: { full: 'Blocked' } } } }, 'c13']]);
assert(roTry[0] === 'error' && roTry[1].type === 'forbidden', 'downgraded sharee cannot write');
const [[, roRead]] = await jmap(CAROL, [['ContactCard/query', { accountId: ERIC.acct }, 'c14']]);
assert(roRead.ids.length === 2, 'read still works after downgrade');

// ---- 11. unshare revokes access entirely --------------------------------
await jmap(ERIC, [['AddressBook/set', { accountId: ERIC.acct, update: {
  [famId]: { [`shareWith/${CAROL.acct}`]: null },
} }, 'c15']]);
const [gone] = await jmap(CAROL, [['AddressBook/get', { accountId: ERIC.acct, ids: null }, 'c16']]);
assert(gone[0] === 'error' && gone[1].type === 'accountNotFound', 'unshared: account vanishes for carol');
const carolPost = await session(CAROL);
assert(!carolPost.accounts[ERIC.acct], 'session no longer lists eric');

// ---- 12. operator grant via provision: editor reads eric's mail --------
const prov = async (method, path, body) => {
  const res = await fetch(`${PROV}${path}`, {
    method,
    headers: { Authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) assert(false, `provision ${method} ${path} → HTTP ${res.status}: ${await res.text()}`);
  return res.json();
};
const grant = await prov('POST', '/grants', {
  granteeEmail: EDITOR.email, targetEmail: ERIC.email, scopes: ['read', 'draft'],
});
assert(grant.grantId?.startsWith('g_'), `grant minted: ${JSON.stringify(grant)}`);

const edSess = await session(EDITOR);
assert(edSess.accounts[ERIC.acct]?.accountCapabilities['urn:ietf:params:jmap:mail'],
  'whole-account grant exposes mail capability');

const [[, edQuery]] = await jmap(EDITOR, [['Email/query', { accountId: ERIC.acct, calculateTotal: true }, 'c17']]);
assert(edQuery.total === 1, `editor reads eric mail: ${JSON.stringify(edQuery)}`);
const [[, edContacts]] = await jmap(EDITOR, [['ContactCard/query', { accountId: ERIC.acct, calculateTotal: true }, 'c18']]);
assert(edContacts.total === 3, 'whole-account grant covers contacts reads too');

// Token ∩ grant: the grant carries draft, but editor's TOKEN is read-only.
const [edSet] = await jmap(EDITOR, [['Email/set', { accountId: ERIC.acct, create: {} }, 'c19']]);
assert(edSet[0] === 'error' && edSet[1].type === 'forbidden', 'token scopes clamp granted rights');

const listed = await prov('GET', `/grants?email=${encodeURIComponent(EDITOR.email)}`);
assert(listed.grants.some(g => g.id === grant.grantId), 'grant listed by email');
const revoked = await prov('DELETE', `/grants/${grant.grantId}`);
assert(revoked.revoked === true, 'grant revoked');
const [edGone] = await jmap(EDITOR, [['Email/query', { accountId: ERIC.acct }, 'c20']]);
assert(edGone[0] === 'error' && edGone[1].type === 'accountNotFound', 'revoked grant removes access');

// ---- 13. credential vault ------------------------------------------------
const vault = async (who, method, path, body) => {
  const res = await fetch(`${AGENT}${path}`, {
    method,
    headers: { Authorization: `Bearer ${who.token}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const noAuth = await fetch(`${AGENT}/vault/credentials`);
assert(noAuth.status === 401, 'vault rejects unauthenticated');

const put = await vault(ERIC, 'PUT', '/vault/credentials', {
  name: 'anthropic-api', kind: 'api-key', secret: 'sk-test-secret-123', meta: { provider: 'anthropic' },
});
assert(put.status === 200 && put.body.ok === true && !JSON.stringify(put.body).includes('sk-test'),
  `vault stores without echoing: ${JSON.stringify(put.body)}`);

const list = await vault(ERIC, 'GET', '/vault/credentials');
assert(list.body.credentials.length === 1 && list.body.credentials[0].name === 'anthropic-api'
  && !JSON.stringify(list.body).includes('sk-test'), 'list is metadata-only');

const carolList = await vault(CAROL, 'GET', '/vault/credentials');
assert(carolList.body.credentials.length === 0, 'vault is per-principal');

const verify = await fetch(`${AGENT}/internal/vault/verify`, {
  method: 'POST',
  headers: { 'x-internal-token': INTERNAL, 'content-type': 'application/json' },
  body: JSON.stringify({ principalEmail: ERIC.email, name: 'anthropic-api' }),
});
assert((await verify.json()).ok === true, 'sealed secret decrypts under the master key');

const del = await vault(ERIC, 'DELETE', '/vault/credentials/anthropic-api');
assert(del.body.deleted === true, 'credential deleted');

// ---- 14. mailstore-analytics MCP -----------------------------------------
const mcp = async (payload) => {
  const res = await fetch(`${AGENT}/mcp/analytics`, {
    method: 'POST',
    headers: { 'x-internal-token': INTERNAL, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
};
const init = await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
assert(init.result?.serverInfo?.name === 'bullmoose-mailstore-analytics', 'MCP initialize');
const tools = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
assert(tools.result?.tools?.length === 4, `MCP lists 4 tools: ${tools.result?.tools?.map(t => t.name)}`);
const spend = await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
  name: 'spend_by_month', arguments: { accountId: ERIC.acct } } });
const spendRows = JSON.parse(spend.result.content[0].text);
assert(spendRows.length === 2 && spendRows[0].period_month === '2026-07', `spend_by_month: ${spend.result.content[0].text}`);
const senders = await mcp({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: {
  name: 'top_senders', arguments: { accountId: ERIC.acct, days: 365 } } });
assert(JSON.parse(senders.result.content[0].text)[0]?.sender === 'cfo@example.com', 'top_senders');
const noTokenMcp = await fetch(`${AGENT}/mcp/analytics`, { method: 'POST', body: '{}' });
assert(noTokenMcp.status === 404, 'MCP hidden without internal token');

console.log('E2E GRANTS OK — sharing, delegation, vault, and analytics MCP verified');
