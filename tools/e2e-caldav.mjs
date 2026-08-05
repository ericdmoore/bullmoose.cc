// anglebrackets CalDAV e2e (Phase 5) — Apple Calendar-shaped requests.
// Needs jmap :8787 + anglebrackets :8791 on one --persist-to state,
// seeded with grants-e2e-seed.sql.
const JMAP = 'http://127.0.0.1:8787';
const DAV = 'http://127.0.0.1:8791';
const ERIC = { acct: 't_test__a_eric', token: 'bm_aaaaaaaaaaaa_' + 'a'.repeat(48), email: 'eric@test.local' };

const assert = (cond, msg) => { if (!cond) { console.error('FAIL: ' + msg); process.exit(1); } };
const basic = 'Basic ' + Buffer.from(`${ERIC.email}:${ERIC.token}`).toString('base64');
const dav = async (method, path, { body, headers = {} } = {}) => {
  const res = await fetch(`${DAV}${path}`, {
    method, redirect: 'manual',
    headers: { Authorization: basic, 'content-type': 'application/xml; charset=utf-8', ...headers },
    ...(body !== undefined ? { body } : {}),
  });
  return { status: res.status, headers: res.headers, text: await res.text() };
};
const jmap = async (methodCalls) => {
  const res = await fetch(`${JMAP}/api/jmap`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ERIC.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:calendars'], methodCalls }),
  });
  return (await res.json()).methodResponses;
};
const x = (t, re) => t.match(re)?.[1] ?? null;

// 1. discovery
const wk = await fetch(`${DAV}/.well-known/caldav`, { redirect: 'manual' });
assert(wk.status === 301, 'well-known/caldav → 301');
const opt = await fetch(`${DAV}/`, { method: 'OPTIONS' });
assert((opt.headers.get('dav') ?? '').includes('calendar-access'), `DAV header: ${opt.headers.get('dav')}`);

const prin = await dav('PROPFIND', `/dav/principals/${encodeURIComponent(ERIC.acct)}/`, {
  body: `<?xml version="1.0"?><D:propfind xmlns:D="DAV:" xmlns:CAL="urn:ietf:params:xml:ns:caldav"><D:prop><CAL:calendar-home-set/></D:prop></D:propfind>` });
const calHome = x(prin.text, /<CAL:calendar-home-set><D:href>([^<]+)<\/D:href>/);
assert(calHome === `/dav/calendars/${encodeURIComponent(ERIC.acct)}/`, `calendar-home-set: ${calHome}`);

// 2. seed events over JMAP (default calendar auto-creates)
await jmap([['Calendar/get', { accountId: ERIC.acct, ids: null }, 'i']]);
const [[, seeded]] = await jmap([['CalendarEvent/set', { accountId: ERIC.acct, create: {
  a: { uid: 'caldav-e2e-standup', title: 'Standup', start: '2026-10-26T09:00:00',
       timeZone: 'America/Chicago', duration: 'PT30M',
       recurrenceRules: [{ frequency: 'weekly', count: 6 }],
       recurrenceOverrides: { '2026-11-02T09:00:00': { excluded: true } } },
  b: { uid: 'caldav-e2e-review', title: 'Review', start: '2026-08-20T15:00:00',
       timeZone: 'Etc/UTC', duration: 'PT1H' },
} }, 's']]);
const standupId = seeded.created?.a?.id;
const reviewId = seeded.created?.b?.id;
assert(standupId && reviewId, `seeded: ${JSON.stringify(seeded.notCreated)}`);

// 3. home depth-1 lists the calendar with ctag
const home = await dav('PROPFIND', calHome, { headers: { Depth: '1' },
  body: `<?xml version="1.0"?><D:propfind xmlns:D="DAV:" xmlns:CS="http://calendarserver.org/ns/"><D:prop><D:resourcetype/><D:displayname/><CS:getctag/><D:sync-token/></D:prop></D:propfind>` });
assert(home.status === 207 && home.text.includes('<CAL:calendar/>'), 'home lists a calendar collection');
const calHref = x(home.text, /<D:href>(\/dav\/calendars\/[^<]+\/cal_[^<]+\/)<\/D:href>/);
const ctag0 = x(home.text, /<CS:getctag>([^<]*)<\/CS:getctag>/);
assert(calHref && ctag0 !== null, `calendar found (ctag=${ctag0}): ${calHref}`);

// 4. calendar depth-1 lists events with etags
const list = await dav('PROPFIND', calHref, { headers: { Depth: '1' },
  body: `<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:getetag/></D:prop></D:propfind>` });
assert(list.text.includes(`${standupId}.ics`) && list.text.includes(`${reviewId}.ics`), 'events listed');

// 5. GET serializes iCalendar with VTIMEZONE + RRULE + EXDATE
const got = await dav('GET', `${calHref}${standupId}.ics`);
assert(got.status === 200 && got.headers.get('etag'), `GET: ${got.status}`);
assert(got.text.includes('BEGIN:VTIMEZONE') && got.text.includes('TZID:America/Chicago'), 'VTIMEZONE present');
assert(got.text.includes('RRULE:FREQ=WEEKLY;COUNT=6'), 'RRULE serialized');
assert(got.text.includes('EXDATE;TZID=America/Chicago:20261102T090000'), 'EXDATE from override');
assert(got.text.includes('DTSTART;TZID=America/Chicago:20261026T090000'), 'TZID DTSTART');

// 6. calendar-multiget
const mg = await dav('REPORT', calHref, {
  body: `<?xml version="1.0"?><CAL:calendar-multiget xmlns:D="DAV:" xmlns:CAL="urn:ietf:params:xml:ns:caldav"><D:prop><D:getetag/><CAL:calendar-data/></D:prop><D:href>${calHref}${reviewId}.ics</D:href></CAL:calendar-multiget>` });
assert(mg.status === 207 && mg.text.includes('SUMMARY:Review') && mg.text.includes('DTSTART:20260820T150000Z'),
  'multiget carries calendar-data');

// 7. calendar-query with time-range → only events with occurrences inside
const tq = await dav('REPORT', calHref, {
  body: `<?xml version="1.0"?><CAL:calendar-query xmlns:D="DAV:" xmlns:CAL="urn:ietf:params:xml:ns:caldav"><D:prop><D:getetag/><CAL:calendar-data/></D:prop><CAL:filter><CAL:comp-filter name="VCALENDAR"><CAL:comp-filter name="VEVENT"><CAL:time-range start="20261101T000000Z" end="20261214T000000Z"/></CAL:comp-filter></CAL:comp-filter></CAL:filter></CAL:calendar-query>` });
assert(tq.text.includes(`${standupId}.ics`) && !tq.text.includes(`${reviewId}.ics`),
  'time-range hits the recurring event only');

// 8. initial + delta sync
const sync0 = await dav('REPORT', calHref, {
  body: `<?xml version="1.0"?><D:sync-collection xmlns:D="DAV:"><D:sync-token/><D:sync-level>1</D:sync-level><D:prop><D:getetag/></D:prop></D:sync-collection>` });
const token0 = x(sync0.text, /<D:sync-token>([^<]+)<\/D:sync-token>/);
assert(sync0.text.includes(`${standupId}.ics`) && token0?.startsWith('bm:sync:'), 'initial sync');

// 9. PUT an Apple-shaped event (DTEND + RRULE UNTIL Z)
const putIcs = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Apple Inc.//Mac OS X 15.0//EN','BEGIN:VEVENT',
  'UID:caldav-e2e-apple','DTSTART;TZID=America/Chicago:20260810T130000',
  'DTEND;TZID=America/Chicago:20260810T141500','SUMMARY:From Apple Calendar',
  'RRULE:FREQ=DAILY;UNTIL=20260815T045959Z','END:VEVENT','END:VCALENDAR',''].join('\r\n');
const put = await dav('PUT', `${calHref}APPLE-EV-1.ics`, {
  body: putIcs, headers: { 'content-type': 'text/calendar', 'If-None-Match': '*' } });
assert(put.status === 201 && put.headers.get('etag'), `PUT create: ${put.status}`);

// visible over JMAP with translated recurrence + occurrences
const [[, occ]] = await jmap([['CalendarEvent/getOccurrences', { accountId: ERIC.acct,
  after: '2026-08-10T00:00:00Z', before: '2026-08-16T00:00:00Z' }, 'o']]);
const apple = occ.list.filter(o => o.uid === 'caldav-e2e-apple');
assert(apple.length === 5, `Apple PUT expands to 5 occurrences over JMAP: ${apple.length}`);
assert(apple[0].title === 'From Apple Calendar', 'title round-trip');

// 10. ctag moved; delta sync reports the PUT under its client name
const home2 = await dav('PROPFIND', calHref, { headers: { Depth: '0' },
  body: `<?xml version="1.0"?><D:propfind xmlns:D="DAV:" xmlns:CS="http://calendarserver.org/ns/"><D:prop><CS:getctag/></D:prop></D:propfind>` });
assert(x(home2.text, /<CS:getctag>([^<]*)<\/CS:getctag>/) !== ctag0, 'ctag bumped by PUT');
const sync1 = await dav('REPORT', calHref, {
  body: `<?xml version="1.0"?><D:sync-collection xmlns:D="DAV:"><D:sync-token>${token0}</D:sync-token><D:sync-level>1</D:sync-level><D:prop><D:getetag/></D:prop></D:sync-collection>` });
assert(sync1.text.includes('APPLE-EV-1.ics'), 'delta sync sees the PUT');
const token1 = x(sync1.text, /<D:sync-token>([^<]+)<\/D:sync-token>/);

// 11. conditional update + uid immutability
const stale = await dav('PUT', `${calHref}APPLE-EV-1.ics`, {
  body: putIcs.replace('SUMMARY:From Apple Calendar', 'SUMMARY:Renamed'),
  headers: { 'If-Match': '"ev_bogus-0"' } });
assert(stale.status === 412, `stale If-Match → 412: ${stale.status}`);
const upd = await dav('PUT', `${calHref}APPLE-EV-1.ics`, {
  body: putIcs.replace('SUMMARY:From Apple Calendar', 'SUMMARY:Renamed'),
  headers: { 'If-Match': put.headers.get('etag') } });
assert(upd.status === 204, `conditional update: ${upd.status}`);
const uidFlip = await dav('PUT', `${calHref}APPLE-EV-1.ics`, {
  body: putIcs.replace('UID:caldav-e2e-apple', 'UID:other-uid') });
assert(uidFlip.status === 409 && uidFlip.text.includes('no-uid-conflict'), `uid flip → 409: ${uidFlip.status}`);

// 12. DELETE + tombstoned 404 in delta sync
const del = await dav('DELETE', `${calHref}APPLE-EV-1.ics`);
assert(del.status === 204, `DELETE: ${del.status}`);
const sync2 = await dav('REPORT', calHref, {
  body: `<?xml version="1.0"?><D:sync-collection xmlns:D="DAV:"><D:sync-token>${token1}</D:sync-token><D:sync-level>1</D:sync-level><D:prop><D:getetag/></D:prop></D:sync-collection>` });
assert(sync2.text.includes('APPLE-EV-1.ics') && sync2.text.includes('404'), 'deletion tombstoned under client name');

// 13. JMAP-side destroy also tombstones for CalDAV sync
const token2 = x(sync2.text, /<D:sync-token>([^<]+)<\/D:sync-token>/);
await jmap([['CalendarEvent/set', { accountId: ERIC.acct, destroy: [reviewId] }, 'd']]);
const sync3 = await dav('REPORT', calHref, {
  body: `<?xml version="1.0"?><D:sync-collection xmlns:D="DAV:"><D:sync-token>${token2}</D:sync-token><D:sync-level>1</D:sync-level><D:prop><D:getetag/></D:prop></D:sync-collection>` });
assert(sync3.text.includes(`${reviewId}.ics`) && sync3.text.includes('404'), 'JMAP destroy reaches CalDAV sync');

// 14. bad sync token → 409 valid-sync-token
const bad = await dav('REPORT', calHref, {
  body: `<?xml version="1.0"?><D:sync-collection xmlns:D="DAV:"><D:sync-token>bm:sync:999999999</D:sync-token><D:sync-level>1</D:sync-level><D:prop><D:getetag/></D:prop></D:sync-collection>` });
assert(bad.status === 409 && bad.text.includes('valid-sync-token'), `bad token → 409: ${bad.status}`);

console.log('E2E CALDAV OK — discovery, iCalendar round-trip, time-range, sync, and tombstones verified');
