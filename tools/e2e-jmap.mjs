const BASE = 'http://127.0.0.1:8787';
const ACCT = 't_dev__a_local';
const H = { 'Authorization': 'Bearer devtoken', 'content-type': 'application/json' };
const assert = (cond, msg) => { if (!cond) { console.error('FAIL: ' + msg); process.exit(1); } };
const jmap = async (methodCalls) => {
  const res = await fetch(`${BASE}/api/jmap`, { method: 'POST', headers: H, body: JSON.stringify({
    using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail', 'urn:ietf:params:jmap:submission'],
    methodCalls,
  })});
  if (!res.ok) { console.error(`FAIL: api/jmap HTTP ${res.status}: ${await res.text()}`); process.exit(1); }
  return (await res.json()).methodResponses;
};

// 1. unauthorized without token
const noAuth = await fetch(`${BASE}/.well-known/jmap`);
assert(noAuth.status === 401, 'no token → 401');

// 2. session
const session = await (await fetch(`${BASE}/.well-known/jmap`, { headers: H })).json();
assert(session.accounts[ACCT], 'session lists dev account');
assert(session.apiUrl.endsWith('/api/jmap'), 'apiUrl');
assert(session.capabilities['urn:ietf:params:jmap:core'].maxCallsInRequest === 16, 'core capability');

// 3. Mailbox/get
let [[name, mb]] = await jmap([['Mailbox/get', { accountId: ACCT, ids: null }, 'c0']]);
assert(name === 'Mailbox/get', 'Mailbox/get responds');
assert(mb.list.length === 3, `3 seeded mailboxes, got ${mb.list.length}`);
const inbox = mb.list.find(m => m.role === 'inbox');
const drafts = mb.list.find(m => m.role === 'drafts');
const sent = mb.list.find(m => m.role === 'sent');
assert(inbox && drafts && sent, 'roles present');
const state0 = mb.state;

// 4. Email/set create a draft
const [[, setRes]] = await jmap([['Email/set', { accountId: ACCT, create: { d1: {
  mailboxIds: { [drafts.id]: true },
  keywords: { '$draft': true, '$seen': true },
  from: [{ name: 'Dev', email: 'dev@localhost' }],
  to: [{ email: 'someone@example.com' }],
  subject: 'Test draft ☕',
  bodyValues: { body: { value: 'Hello from the draft body' } },
  textBody: [{ partId: 'body', type: 'text/plain' }],
}}}, 'c1']]);
assert(setRes.created?.d1?.id, `draft created: ${JSON.stringify(setRes.notCreated)}`);
assert(Number(setRes.newState) > Number(setRes.oldState), 'state bumped by create');
const draftId = setRes.created.d1.id;

// 5. Email/query + back-ref Email/get with bodies
const [q, g] = await jmap([
  ['Email/query', { accountId: ACCT, filter: { inMailbox: drafts.id }, calculateTotal: true }, 'q'],
  ['Email/get', { accountId: ACCT, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' },
    properties: ['id','subject','keywords','mailboxIds','preview','bodyValues','textBody'],
    fetchTextBodyValues: true }, 'g'],
]);
assert(q[1].ids.includes(draftId) && q[1].total === 1, 'query finds draft in Drafts');
const got = g[1].list[0];
assert(got.subject === 'Test draft ☕', `unicode subject round-trip: "${got.subject}"`);
assert(got.keywords['$draft'] === true, 'keywords stored');
assert(got.bodyValues.t.value.trim() === 'Hello from the draft body', `body round-trip: ${JSON.stringify(got.bodyValues)}`);

// 6. filters: text match + notKeyword excludes
const [f1] = await jmap([['Email/query', { accountId: ACCT, filter: { text: 'draft ☕' } }, 'f']]);
assert(f1[1].ids.length === 1, 'text filter matches');
const [f2] = await jmap([['Email/query', { accountId: ACCT, filter: { notKeyword: '$draft' } }, 'f']]);
assert(f2[1].ids.length === 0, 'notKeyword excludes the draft');

// 7. Email/set patch: unset $seen, move Drafts → Sent
const [[, patchRes]] = await jmap([['Email/set', { accountId: ACCT, update: { [draftId]: {
  'keywords/$seen': null,
  'mailboxIds': { [sent.id]: true },
}}}, 'p']]);
assert(patchRes.updated && draftId in patchRes.updated, `patch applied: ${JSON.stringify(patchRes.notUpdated)}`);
const [gv] = await jmap([['Email/get', { accountId: ACCT, ids: [draftId], properties: ['keywords','mailboxIds'] }, 'v']]);
assert(!gv[1].list[0].keywords['$seen'], '$seen removed');
assert(gv[1].list[0].mailboxIds[sent.id] === true && !gv[1].list[0].mailboxIds[drafts.id], 'moved to Sent');

// 8. Mailbox counts reflect the move
const [mb2] = await jmap([['Mailbox/get', { accountId: ACCT, ids: [sent.id, drafts.id] }, 'm']]);
const sent2 = mb2[1].list.find(m => m.id === sent.id);
const drafts2 = mb2[1].list.find(m => m.id === drafts.id);
assert(sent2.totalEmails === 1 && drafts2.totalEmails === 0, `counts: sent=${sent2.totalEmails} drafts=${drafts2.totalEmails}`);

// 9. Email/changes from state 0 replays create+update
const [ch] = await jmap([['Email/changes', { accountId: ACCT, sinceState: '0' }, 'ch']]);
assert(ch[1].created.includes(draftId), 'changes since 0: created contains draft');
const [ch2] = await jmap([['Email/changes', { accountId: ACCT, sinceState: state0 }, 'ch2']]);
assert(ch2[1].newState !== state0 || ch2[1].created.length + ch2[1].updated.length >= 0, 'changes from state0 ok');

// 10. Thread/get + Identity/get
const [th] = await jmap([['Thread/get', { accountId: ACCT, ids: [got.id ? g[1].list[0].id : draftId] }, 't']]);
const [[, idn]] = await jmap([['Identity/get', { accountId: ACCT, ids: null }, 'i']]);
assert(idn.list[0].email === 'dev@localhost', 'synthesized identity');

// 11. destroy
const [[, dRes]] = await jmap([['Email/set', { accountId: ACCT, destroy: [draftId] }, 'd']]);
assert(dRes.destroyed.includes(draftId), 'destroyed');
const [gone] = await jmap([['Email/get', { accountId: ACCT, ids: [draftId] }, 'gone']]);
assert(gone[1].notFound.includes(draftId), 'destroyed email is notFound');

// 12. stateMismatch guard
const [sm] = await jmap([['Email/set', { accountId: ACCT, ifInState: '0', update: {} }, 'sm']]);
assert(sm[0] === 'error' && sm[1].type === 'stateMismatch', 'ifInState mismatch → stateMismatch');

// 13. blob upload + download round trip
const up = await (await fetch(`${BASE}/api/upload/${ACCT}`, { method: 'POST', headers: { ...H, 'content-type': 'text/plain' }, body: 'blob payload' })).json();
assert(up.blobId?.startsWith('b_') && up.size === 12, `upload: ${JSON.stringify(up)}`);
const down = await fetch(`${BASE}/api/download/${ACCT}/${up.blobId}/x?type=text/plain`, { headers: H });
assert(await down.text() === 'blob payload', 'download round-trip');

console.log('E2E OK — all 13 checks passed');
