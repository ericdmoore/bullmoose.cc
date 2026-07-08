// anglebrackets CardDAV e2e (Phase 2) — requests shaped like Apple
// Contacts' sync engine. Needs jmap :8787 + anglebrackets :8791 on one
// --persist-to state, seeded with grants-e2e-seed.sql (eric/carol).
const JMAP = 'http://127.0.0.1:8787';
const DAV = 'http://127.0.0.1:8791';
const ERIC = { acct: 't_test__a_eric', token: 'bm_aaaaaaaaaaaa_' + 'a'.repeat(48), email: 'eric@test.local' };
const CAROL = { acct: 't_test__a_carol', token: 'bm_bbbbbbbbbbbb_' + 'b'.repeat(48), email: 'carol@test.local' };

const assert = (cond, msg) => { if (!cond) { console.error('FAIL: ' + msg); process.exit(1); } };
const basic = (who) => 'Basic ' + Buffer.from(`${who.email}:${who.token}`).toString('base64');
const dav = async (who, method, path, { body, headers = {} } = {}) => {
  const res = await fetch(`${DAV}${path}`, {
    method,
    headers: { Authorization: basic(who), 'content-type': 'application/xml; charset=utf-8', ...headers },
    ...(body !== undefined ? { body } : {}),
    redirect: 'manual',
  });
  return { status: res.status, headers: res.headers, text: await res.text() };
};
const jmap = async (who, methodCalls) => {
  const res = await fetch(`${JMAP}/api/jmap`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${who.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:contacts'], methodCalls }),
  });
  return (await res.json()).methodResponses;
};
const extract = (xml, re) => { const m = xml.match(re); return m ? m[1] : null; };

// 1. discovery + auth surface
const opt = await fetch(`${DAV}/`, { method: 'OPTIONS' });
assert((opt.headers.get('dav') ?? '').includes('addressbook'), `OPTIONS DAV header: ${opt.headers.get('dav')}`);
const wk = await fetch(`${DAV}/.well-known/carddav`, { redirect: 'manual' });
assert(wk.status === 301 && wk.headers.get('location') === '/dav/', 'well-known redirects to /dav/');
const noAuth = await fetch(`${DAV}/dav/`, { method: 'PROPFIND' });
assert(noAuth.status === 401 && (noAuth.headers.get('www-authenticate') ?? '').includes('Basic'),
  'unauthenticated PROPFIND → 401 Basic challenge');
const badPw = await fetch(`${DAV}/dav/`, { method: 'PROPFIND',
  headers: { Authorization: 'Basic ' + Buffer.from(`${ERIC.email}:bm_aaaaaaaaaaaa_${'f'.repeat(48)}`).toString('base64') } });
assert(badPw.status === 401, 'wrong app-password → 401');

// 2. principal discovery chain
const root = await dav(ERIC, 'PROPFIND', '/dav/', { headers: { Depth: '0' },
  body: `<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:current-user-principal/></D:prop></D:propfind>` });
assert(root.status === 207, `root PROPFIND: ${root.status}`);
const principalHref = extract(root.text, /<D:current-user-principal><D:href>([^<]+)<\/D:href>/);
assert(principalHref === `/dav/principals/${encodeURIComponent(ERIC.acct)}/`, `principal href: ${principalHref}`);

const prin = await dav(ERIC, 'PROPFIND', principalHref, { headers: { Depth: '0' },
  body: `<?xml version="1.0"?><D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav"><D:prop><C:addressbook-home-set/><D:displayname/></D:prop></D:propfind>` });
const homeHref = extract(prin.text, /<C:addressbook-home-set><D:href>([^<]+)<\/D:href>/);
assert(homeHref === `/dav/addressbooks/${encodeURIComponent(ERIC.acct)}/`, `home href: ${homeHref}`);

// 3. seed a card over JMAP; find the default book in the DAV home
await jmap(ERIC, [['AddressBook/get', { accountId: ERIC.acct, ids: null }, 'i']]);
const [[, seeded]] = await jmap(ERIC, [['ContactCard/set', { accountId: ERIC.acct, create: {
  a: { uid: 'dav-e2e-ada', name: { full: 'Ada Lovelace' }, emails: { e: { address: 'ada@dav.test' } } },
} }, 's']]);
const adaId = seeded.created?.a?.id;
assert(adaId, `seed card: ${JSON.stringify(seeded.notCreated)}`);

const home = await dav(ERIC, 'PROPFIND', homeHref, { headers: { Depth: '1' },
  body: `<?xml version="1.0"?><D:propfind xmlns:D="DAV:" xmlns:CS="http://calendarserver.org/ns/"><D:prop><D:resourcetype/><D:displayname/><CS:getctag/><D:sync-token/></D:prop></D:propfind>` });
assert(home.status === 207 && home.text.includes('<C:addressbook/>'), 'home lists an addressbook collection');
const bookHref = extract(home.text, /<D:href>(\/dav\/addressbooks\/[^<]+\/ab_[^<]+\/)<\/D:href>/);
assert(bookHref, `book href found: ${bookHref}`);
const ctag0 = extract(home.text, /<CS:getctag>([^<]*)<\/CS:getctag>/);
assert(ctag0 !== null, 'getctag present');

// 4. book PROPFIND depth 1 lists the card with an etag
const bookList = await dav(ERIC, 'PROPFIND', bookHref, { headers: { Depth: '1' },
  body: `<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:getetag/><D:resourcetype/></D:prop></D:propfind>` });
assert(bookList.text.includes(`${adaId}.vcf`), 'card resource listed by canonical name');
const adaEtag = extract(bookList.text, new RegExp(`${adaId}\\.vcf</D:href><D:propstat><D:prop><D:getetag>([^<]+)</D:getetag>`));
assert(adaEtag?.startsWith('&quot;'), `etag rendered: ${adaEtag}`);

// 5. initial sync-collection
const sync0 = await dav(ERIC, 'REPORT', bookHref, { headers: { Depth: '1' },
  body: `<?xml version="1.0"?><D:sync-collection xmlns:D="DAV:"><D:sync-token/><D:sync-level>1</D:sync-level><D:prop><D:getetag/></D:prop></D:sync-collection>` });
assert(sync0.status === 207 && sync0.text.includes(`${adaId}.vcf`), 'initial sync lists the card');
const token0 = extract(sync0.text, /<D:sync-token>([^<]+)<\/D:sync-token>/);
assert(token0?.startsWith('bm:sync:'), `sync token: ${token0}`);

// 6. multiget returns the vCard body
const mg = await dav(ERIC, 'REPORT', bookHref, { headers: { Depth: '1' },
  body: `<?xml version="1.0"?><C:addressbook-multiget xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav"><D:prop><D:getetag/><C:address-data/></D:prop><D:href>${bookHref}${adaId}.vcf</D:href></C:addressbook-multiget>` });
assert(mg.text.includes('BEGIN:VCARD') && mg.text.includes('FN:Ada Lovelace') && mg.text.includes('UID:dav-e2e-ada'),
  'multiget carries serialized vCard');

// 7. GET single resource
const got = await dav(ERIC, 'GET', `${bookHref}${adaId}.vcf`);
assert(got.status === 200 && got.text.includes('EMAIL;TYPE=INTERNET:ada@dav.test') && got.headers.get('etag'),
  `GET card: ${got.status}`);

// 8. PUT create (client-chosen name), visible over JMAP
const putVcf = ['BEGIN:VCARD', 'VERSION:3.0', 'UID:dav-e2e-charles', 'FN:Charles Babbage',
  'N:Babbage;Charles;;;', 'EMAIL;type=INTERNET;type=WORK:charles@dav.test',
  'TEL;type=CELL:+44 20 7946 0958', 'END:VCARD', ''].join('\r\n');
const put = await dav(ERIC, 'PUT', `${bookHref}ABC-123-APPLE.vcf`, {
  body: putVcf, headers: { 'content-type': 'text/vcard', 'If-None-Match': '*' } });
assert(put.status === 201 && put.headers.get('etag'), `PUT create: ${put.status}`);
const [[, q1]] = await jmap(ERIC, [['ContactCard/query', { accountId: ERIC.acct, filter: { email: 'charles@dav.test' } }, 'q']]);
assert(q1.ids.length === 1, 'DAV-created card visible over JMAP');

// 9. ctag bumped by the PUT
const home2 = await dav(ERIC, 'PROPFIND', bookHref, { headers: { Depth: '0' },
  body: `<?xml version="1.0"?><D:propfind xmlns:D="DAV:" xmlns:CS="http://calendarserver.org/ns/"><D:prop><CS:getctag/></D:prop></D:propfind>` });
const ctag1 = extract(home2.text, /<CS:getctag>([^<]*)<\/CS:getctag>/);
assert(ctag1 !== ctag0, `ctag moved: ${ctag0} → ${ctag1}`);

// 10. delta sync sees the new resource under ITS name
const sync1 = await dav(ERIC, 'REPORT', bookHref, {
  body: `<?xml version="1.0"?><D:sync-collection xmlns:D="DAV:"><D:sync-token>${token0}</D:sync-token><D:sync-level>1</D:sync-level><D:prop><D:getetag/></D:prop></D:sync-collection>` });
assert(sync1.text.includes('ABC-123-APPLE.vcf') && !sync1.text.includes(`${adaId}.vcf`),
  'delta sync reports only the new card, by client name');
const token1 = extract(sync1.text, /<D:sync-token>([^<]+)<\/D:sync-token>/);

// 11. conditional PUT update
const putEtag = put.headers.get('etag');
const stale = await dav(ERIC, 'PUT', `${bookHref}ABC-123-APPLE.vcf`, {
  body: putVcf.replace('FN:Charles Babbage', 'FN:Chuck Babbage'),
  headers: { 'content-type': 'text/vcard', 'If-Match': '"cc_bogus-0"' } });
assert(stale.status === 412, `stale If-Match → 412: ${stale.status}`);
const upd = await dav(ERIC, 'PUT', `${bookHref}ABC-123-APPLE.vcf`, {
  body: putVcf.replace('FN:Charles Babbage', 'FN:Chuck Babbage'),
  headers: { 'content-type': 'text/vcard', 'If-Match': putEtag } });
assert(upd.status === 204, `conditional update: ${upd.status}`);
const got2 = await dav(ERIC, 'GET', `${bookHref}ABC-123-APPLE.vcf`);
assert(got2.text.includes('FN:Chuck Babbage'), 'update round-trips');

// 12. uid change on update is rejected
const uidFlip = await dav(ERIC, 'PUT', `${bookHref}ABC-123-APPLE.vcf`, {
  body: putVcf.replace('UID:dav-e2e-charles', 'UID:dav-e2e-other') });
assert(uidFlip.status === 409 && uidFlip.text.includes('no-uid-conflict'), `uid flip → 409: ${uidFlip.status}`);

// 13. DELETE + tombstoned sync 404 under the client name
const del = await dav(ERIC, 'DELETE', `${bookHref}ABC-123-APPLE.vcf`);
assert(del.status === 204, `DELETE: ${del.status}`);
const sync2 = await dav(ERIC, 'REPORT', bookHref, {
  body: `<?xml version="1.0"?><D:sync-collection xmlns:D="DAV:"><D:sync-token>${token1}</D:sync-token><D:sync-level>1</D:sync-level><D:prop><D:getetag/></D:prop></D:sync-collection>` });
assert(sync2.text.includes('ABC-123-APPLE.vcf') && sync2.text.includes('404'),
  'deletion reported under the client resource name (tombstone)');
const gone = await dav(ERIC, 'GET', `${bookHref}ABC-123-APPLE.vcf`);
assert(gone.status === 404, 'deleted resource GETs 404');

// 14. a JMAP-side destroy also reaches DAV sync (tombstone from the JMAP
// path). Sync once between create and destroy — a card created AND
// destroyed inside one window correctly collapses to nothing.
const [[, tmp]] = await jmap(ERIC, [['ContactCard/set', { accountId: ERIC.acct, create: {
  t: { uid: 'dav-e2e-temp', name: { full: 'Temp Person' } } } }, 't']]);
const tmpId = tmp.created?.t?.id;
const syncMid = await dav(ERIC, 'REPORT', bookHref, {
  body: `<?xml version="1.0"?><D:sync-collection xmlns:D="DAV:"><D:sync-token>${extract(sync2.text, /<D:sync-token>([^<]+)<\/D:sync-token>/)}</D:sync-token><D:sync-level>1</D:sync-level><D:prop><D:getetag/></D:prop></D:sync-collection>` });
assert(syncMid.text.includes(`${tmpId}.vcf`), 'temp card visible pre-destroy');
const tokenMid = extract(syncMid.text, /<D:sync-token>([^<]+)<\/D:sync-token>/);
await jmap(ERIC, [['ContactCard/set', { accountId: ERIC.acct, destroy: [tmpId] }, 'd']]);
const sync3 = await dav(ERIC, 'REPORT', bookHref, {
  body: `<?xml version="1.0"?><D:sync-collection xmlns:D="DAV:"><D:sync-token>${tokenMid}</D:sync-token><D:sync-level>1</D:sync-level><D:prop><D:getetag/></D:prop></D:sync-collection>` });
assert(sync3.text.includes(`${tmpId}.vcf`) && sync3.text.includes('404'), 'JMAP destroy surfaces in DAV sync');

// 15. bogus sync token → 409 valid-sync-token (client falls back to full sync)
const badTok = await dav(ERIC, 'REPORT', bookHref, {
  body: `<?xml version="1.0"?><D:sync-collection xmlns:D="DAV:"><D:sync-token>bm:sync:99999999</D:sync-token><D:sync-level>1</D:sync-level><D:prop><D:getetag/></D:prop></D:sync-collection>` });
assert(badTok.status === 409 && badTok.text.includes('valid-sync-token'), `bad token → 409: ${badTok.status}`);

// 16. addressbook-query returns address-data
const abq = await dav(ERIC, 'REPORT', bookHref, {
  body: `<?xml version="1.0"?><C:addressbook-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav"><D:prop><D:getetag/><C:address-data/></D:prop></C:addressbook-query>` });
assert(abq.status === 207 && abq.text.includes('FN:Ada Lovelace'), 'addressbook-query serves cards');

// 17. sharing: carol's home-set spans both accounts; eric's home shows only the shared book
const [[, fam]] = await jmap(ERIC, [['AddressBook/set', { accountId: ERIC.acct, create: { f: { name: 'DAV Family' } } }, 'f']]);
const famId = fam.created?.f?.id;
await jmap(ERIC, [['AddressBook/set', { accountId: ERIC.acct, update: {
  [famId]: { shareWith: { [CAROL.acct]: { mayRead: true, mayWrite: true } } } } }, 'sh']]);

const carolPrin = await dav(CAROL, 'PROPFIND', `/dav/principals/${encodeURIComponent(CAROL.acct)}/`, {
  body: `<?xml version="1.0"?><D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav"><D:prop><C:addressbook-home-set/></D:prop></D:propfind>` });
assert(carolPrin.text.includes(`/dav/addressbooks/${encodeURIComponent(CAROL.acct)}/`)
  && carolPrin.text.includes(`/dav/addressbooks/${encodeURIComponent(ERIC.acct)}/`),
  'sharee home-set spans own + granted accounts');

const carolHome = await dav(CAROL, 'PROPFIND', homeHref, { headers: { Depth: '1' },
  body: `<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:displayname/><D:resourcetype/><D:current-user-privilege-set/></D:prop></D:propfind>` });
assert(carolHome.text.includes('DAV Family') && !carolHome.text.includes(bookHref),
  'sharee sees only the shared book in the owner home');

const carolPut = await dav(CAROL, 'PUT', `/dav/addressbooks/${encodeURIComponent(ERIC.acct)}/${famId}/carol-card.vcf`, {
  body: ['BEGIN:VCARD','VERSION:3.0','UID:dav-e2e-ned','FN:Nephew Ned','END:VCARD',''].join('\r\n'),
  headers: { 'content-type': 'text/vcard' } });
assert(carolPut.status === 201, `sharee PUT into shared book: ${carolPut.status}`);
const carolPutDenied = await dav(CAROL, 'PUT', `${bookHref}sneaky.vcf`, {
  body: ['BEGIN:VCARD','VERSION:3.0','UID:dav-e2e-sneak','FN:Sneaky','END:VCARD',''].join('\r\n') });
assert(carolPutDenied.status === 403 || carolPutDenied.status === 404,
  `sharee cannot write outside the shared book: ${carolPutDenied.status}`);

console.log('E2E CARDDAV OK — discovery, sync, ETags, tombstones, and shared books verified');
