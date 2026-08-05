// Round 2: himalaya punch-list methods (Mailbox/query, Email/import,
// queryChanges fallbacks) on top of the round-1 surface.
const BASE = 'http://127.0.0.1:8787';
const ACCT = 't_dev__a_local';
const H = { 'Authorization': 'Bearer devtoken', 'content-type': 'application/json' };
const assert = (cond, msg) => { if (!cond) { console.error('FAIL: ' + msg); process.exit(1); } };
const jmap = async (methodCalls) => {
  const res = await fetch(`${BASE}/api/jmap`, { method: 'POST', headers: H, body: JSON.stringify({
    using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail', 'urn:ietf:params:jmap:submission'],
    methodCalls,
  })});
  if (!res.ok) { console.error(`FAIL: HTTP ${res.status}: ${await res.text()}`); process.exit(1); }
  return (await res.json()).methodResponses;
};

// Mailbox/query: all, by role, hasAnyRole, sorted by name
const [q1] = await jmap([['Mailbox/query', { accountId: ACCT, calculateTotal: true }, 'q']]);
assert(q1[1].ids.length === 3 && q1[1].total === 3, `query all: ${JSON.stringify(q1[1])}`);
const [q2] = await jmap([['Mailbox/query', { accountId: ACCT, filter: { role: 'inbox' } }, 'q']]);
assert(q2[1].ids.length === 1 && q2[1].ids[0] === 'mb_inbox', 'filter by role');
const [q3] = await jmap([['Mailbox/query', { accountId: ACCT, filter: { hasAnyRole: false } }, 'q']]);
assert(q3[1].ids.length === 0, 'hasAnyRole:false → none (all seeded have roles)');
const [q4] = await jmap([['Mailbox/query', { accountId: ACCT, sort: [{ property: 'name', isAscending: true }] }, 'q']]);
assert(q4[1].ids[0] === 'mb_drafts', `name sort: ${q4[1].ids}`);

// queryChanges → cannotCalculateChanges (spec fallback)
const [qc] = await jmap([['Mailbox/queryChanges', { accountId: ACCT, sinceQueryState: '0' }, 'qc']]);
assert(qc[0] === 'error' && qc[1].type === 'cannotCalculateChanges', 'Mailbox/queryChanges error type');
const [eqc] = await jmap([['Email/queryChanges', { accountId: ACCT, sinceQueryState: '0' }, 'eqc']]);
assert(eqc[0] === 'error' && eqc[1].type === 'cannotCalculateChanges', 'Email/queryChanges error type');

// The himalaya send path: Blob upload → Email/import → (submission would follow)
const MIME = [
  'Date: Mon, 06 Jul 2026 12:00:00 +0000',
  'Message-ID: <imported-1@moore.coffee>',
  'From: Eric <eric@moore.coffee>',
  'To: dev@localhost',
  'Subject: Imported via blob upload',
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'This message was uploaded as a raw blob and imported.',
].join('\r\n');
const up = await (await fetch(`${BASE}/api/upload/${ACCT}`, {
  method: 'POST', headers: { ...H, 'content-type': 'message/rfc822' }, body: MIME,
})).json();
assert(up.blobId, `upload: ${JSON.stringify(up)}`);

const [imp] = await jmap([['Email/import', { accountId: ACCT, emails: { i1: {
  blobId: up.blobId, mailboxIds: { mb_drafts: true }, keywords: { '$draft': true, '$seen': true },
}}}, 'i']]);
assert(imp[0] === 'Email/import', 'import responds');
assert(imp[1].created?.i1?.id, `import created: ${JSON.stringify(imp[1].notCreated)}`);
const importedId = imp[1].created.i1.id;
assert(Number(imp[1].newState) > Number(imp[1].oldState), 'import bumps state');

// Imported email is fully queryable with parsed metadata + correct receivedAt from Date header
const [g] = await jmap([['Email/get', { accountId: ACCT, ids: [importedId],
  properties: ['subject','from','receivedAt','mailboxIds','keywords','messageId'] }, 'g']]);
const e = g[1].list[0];
assert(e.subject === 'Imported via blob upload', 'parsed subject');
assert(e.from[0].email === 'eric@moore.coffee' && e.from[0].name === 'Eric', 'parsed from');
assert(e.receivedAt === '2026-07-06T12:00:00.000Z', `receivedAt from Date header: ${e.receivedAt}`);
assert(e.mailboxIds.mb_drafts === true && e.keywords['$draft'] === true, 'placed in drafts with $draft');
assert(e.messageId[0] === 'imported-1@moore.coffee', 'messageId parsed');

// import with a bogus blob → blobNotFound, not a crash
const [bad] = await jmap([['Email/import', { accountId: ACCT, emails: { b: {
  blobId: 'b_nope', mailboxIds: { mb_inbox: true } } } }, 'b']]);
assert(bad[1].notCreated?.b?.type === 'blobNotFound', `bogus blob: ${JSON.stringify(bad[1])}`);

console.log('E2E-2 OK — punch-list methods verified');

// Threading across paths: an Email/set-created reply to the IMPORTED
// message must land in the same thread (message-id normalization).
const [[, reply]] = await jmap([['Email/set', { accountId: ACCT, create: { r1: {
  mailboxIds: { mb_drafts: true },
  from: [{ email: 'dev@localhost' }], to: [{ email: 'eric@moore.coffee' }],
  subject: 'Re: Imported via blob upload',
  inReplyTo: ['<imported-1@moore.coffee>'],   // bracketed, as a client might send
  bodyValues: { b: { value: 'reply body' } }, textBody: [{ partId: 'b', type: 'text/plain' }],
}}}, 'r']]);
assert(reply.created?.r1, `reply created: ${JSON.stringify(reply.notCreated)}`);
const [tg] = await jmap([['Thread/get', { accountId: ACCT, ids: [reply.created.r1.threadId] }, 't']]);
assert(tg[1].list[0].emailIds.length === 2, `thread joined across import+set: ${JSON.stringify(tg[1].list)}`);
assert(tg[1].list[0].emailIds.includes(importedId), 'thread contains imported message');

console.log('E2E-2b OK — cross-path threading verified');
