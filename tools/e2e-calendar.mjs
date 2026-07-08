// JSCalendar core e2e (Phase 4) — against the local dev jmap worker,
// same seeding as the other suites. Exercises the recurrence/timezone
// engine through the full JMAP surface.
const BASE = 'http://127.0.0.1:8787';
const ACCT = 't_dev__a_local';
const H = { 'Authorization': 'Bearer devtoken', 'content-type': 'application/json' };
const assert = (cond, msg) => { if (!cond) { console.error('FAIL: ' + msg); process.exit(1); } };
const jmap = async (methodCalls) => {
  const res = await fetch(`${BASE}/api/jmap`, { method: 'POST', headers: H, body: JSON.stringify({
    using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:calendars'],
    methodCalls,
  })});
  if (!res.ok) { console.error(`FAIL: HTTP ${res.status}: ${await res.text()}`); process.exit(1); }
  return (await res.json()).methodResponses;
};

// 1. session advertises the calendars capability
const session = await (await fetch(`${BASE}/.well-known/jmap`, { headers: H })).json();
const CAP = 'urn:ietf:params:jmap:calendars';
assert(CAP in session.capabilities && CAP in session.accounts[ACCT].accountCapabilities,
  'calendars capability advertised');
assert(session.primaryAccounts[CAP] === ACCT, 'primaryAccounts maps calendars');

// 2. default calendar auto-creates on first touch
const [[, calGet]] = await jmap([['Calendar/get', { accountId: ACCT, ids: null }, 'c0']]);
const defaultCal = calGet.list.find(c => c.isDefault);
assert(defaultCal?.name === 'Calendar', `default calendar: ${JSON.stringify(calGet.list)}`);

// 3. second calendar
const [[, calSet]] = await jmap([['Calendar/set', { accountId: ACCT, create: {
  w: { name: 'Work', color: '#3366ff' } } }, 'c1']]);
const workCal = calSet.created?.w?.id;
assert(workCal && calSet.created.w.isDefault === false, 'work calendar created, not default');

// 4. events: simple, recurring weekly (DST straddle), all-day yearly
const [[, evSet]] = await jmap([['CalendarEvent/set', { accountId: ACCT, create: {
  a: { uid: 'cal-e2e-dentist', title: 'Dentist', start: '2026-08-14T14:30:00',
       timeZone: 'America/Chicago', duration: 'PT1H' },
  b: { uid: 'cal-e2e-standup', title: 'Standup', start: '2026-10-26T09:00:00',
       timeZone: 'America/Chicago', duration: 'PT30M',
       calendarIds: { [workCal]: true },
       recurrenceRules: [{ frequency: 'weekly', count: 6 }] },
  c: { uid: 'cal-e2e-bday', title: 'Ada birthday', start: '2026-12-10T00:00:00',
       timeZone: 'America/Chicago', showWithoutTime: true,
       recurrenceRules: [{ frequency: 'yearly' }] },
  dupe: { uid: 'cal-e2e-dentist', title: 'Dup', start: '2026-08-14T15:00:00' },
} }, 'c2']]);
const dentistId = evSet.created?.a?.id;
const standupId = evSet.created?.b?.id;
const bdayId = evSet.created?.c?.id;
assert(dentistId && standupId && bdayId, `events created: ${JSON.stringify(evSet.notCreated)}`);
assert(evSet.notCreated?.dupe?.type === 'invalidProperties', 'duplicate uid rejected');
assert(evSet.created.a.created && evSet.created.a.updated, 'server-set timestamps returned');
const state0 = evSet.newState;

// 5. get round-trips the JSCalendar blob + wire props
const [[, evGet]] = await jmap([['CalendarEvent/get', { accountId: ACCT, ids: [standupId] }, 'c3']]);
const standup = evGet.list[0];
assert(standup['@type'] === 'Event' && standup.uid === 'cal-e2e-standup', 'JSCalendar envelope');
assert(standup.calendarIds[workCal] === true, 'calendarIds wire property');
assert(standup.recurrenceRules[0].frequency === 'weekly', 'recurrence rules stored');

// 6. time-range query: only events with an occurrence in the window
const q = async (filter, expect, label) => {
  const [[, r]] = await jmap([['CalendarEvent/query', { accountId: ACCT, filter, calculateTotal: true }, 'q']]);
  assert(JSON.stringify([...r.ids].sort()) === JSON.stringify([...expect].sort()),
    `${label}: got ${JSON.stringify(r.ids)} want ${JSON.stringify(expect)}`);
};
await q({ after: '2026-08-14T00:00:00Z', before: '2026-08-15T00:00:00Z' }, [dentistId], 'window hits dentist only');
await q({ after: '2026-11-01T00:00:00Z', before: '2026-11-03T00:00:00Z' }, [standupId], 'window hits a standup occurrence');
await q({ after: '2027-12-01T00:00:00Z', before: '2027-12-31T00:00:00Z' }, [bdayId], 'unbounded yearly matches next year');
await q({ after: '2026-08-20T00:00:00Z', before: '2026-08-21T00:00:00Z' }, [], 'empty window is empty');
await q({ inCalendar: workCal }, [standupId], 'inCalendar filter');
await q({ text: 'dentist' }, [dentistId], 'text filter');

// 7. occurrence expansion across the DST fall-back (Nov 1 2026)
const [[, occ]] = await jmap([['CalendarEvent/getOccurrences', { accountId: ACCT,
  after: '2026-10-01T00:00:00Z', before: '2026-12-15T00:00:00Z' }, 'c4']]);
const standups = occ.list.filter(o => o.eventId === standupId);
assert(standups.length === 6, `6 standup occurrences: ${standups.length}`);
assert(standups.every(o => o.start.endsWith('T09:00:00')), 'wall-clock stays 09:00 across DST');
const utcHours = standups.map(o => new Date(o.utcStart).getUTCHours());
assert(utcHours[0] === 14 && utcHours[5] === 15, `UTC hour shifts at fall-back: ${utcHours.join(',')}`);
const bdayOcc = occ.list.filter(o => o.eventId === bdayId);
assert(bdayOcc.length === 1 && bdayOcc[0].showWithoutTime === true, 'all-day occurrence flagged');

// 8. per-occurrence override: skip one standup, move another
const [[, patchRes]] = await jmap([['CalendarEvent/set', { accountId: ACCT, update: {
  [standupId]: { recurrenceOverrides: {
    '2026-11-02T09:00:00': { excluded: true },
    '2026-11-09T09:00:00': { start: '2026-11-09T10:30:00', title: 'Standup (moved)' },
  } },
} }, 'c5']]);
assert(patchRes.updated && standupId in patchRes.updated, `override patch: ${JSON.stringify(patchRes.notUpdated)}`);
const [[, occ2]] = await jmap([['CalendarEvent/getOccurrences', { accountId: ACCT,
  after: '2026-10-01T00:00:00Z', before: '2026-12-15T00:00:00Z' }, 'c6']]);
const standups2 = occ2.list.filter(o => o.eventId === standupId);
assert(standups2.length === 5, `exclusion drops one: ${standups2.length}`);
const moved = standups2.find(o => o.recurrenceId === '2026-11-09T09:00:00');
assert(moved?.start === '2026-11-09T10:30:00' && moved?.title === 'Standup (moved)', 'occurrence patch applied');

// 9. uid immutability + calendar move
const [[, uidTry]] = await jmap([['CalendarEvent/set', { accountId: ACCT, update: {
  [dentistId]: { uid: 'other' } } }, 'c7']]);
assert(uidTry.notUpdated?.[dentistId]?.type === 'invalidProperties', 'uid immutable');
const [[, moveRes]] = await jmap([['CalendarEvent/set', { accountId: ACCT, update: {
  [dentistId]: { calendarIds: { [workCal]: true } } } }, 'c8']]);
assert(moveRes.updated && dentistId in moveRes.updated, 'moved calendars');
await q({ inCalendar: workCal, text: 'dentist' }, [dentistId], 'move reflected in query');

// 10. changes delta
const [[, ch]] = await jmap([['CalendarEvent/changes', { accountId: ACCT, sinceState: state0 }, 'c9']]);
assert(ch.updated.includes(standupId) && ch.updated.includes(dentistId), 'changes reports updates');

// 11. calendar destroy: refused with events, cascades with flag
const [[, dBad]] = await jmap([['Calendar/set', { accountId: ACCT, destroy: [workCal] }, 'c10']]);
assert(dBad.notDestroyed?.[workCal]?.type === 'calendarHasEvents', 'non-empty destroy refused');
const [[, dOk]] = await jmap([['Calendar/set', { accountId: ACCT, destroy: [workCal],
  onDestroyRemoveEvents: true }, 'c11']]);
assert(dOk.destroyed.includes(workCal), `cascade destroy: ${JSON.stringify(dOk.notDestroyed)}`);
const [[, goneGet]] = await jmap([['CalendarEvent/get', { accountId: ACCT, ids: [standupId, dentistId] }, 'c12']]);
assert(goneGet.notFound.length === 2, 'events gone with their calendar');

// 12. sorting by start
const [[, mk]] = await jmap([['CalendarEvent/set', { accountId: ACCT, create: {
  x: { uid: 'cal-e2e-late', title: 'Late', start: '2026-09-02T10:00:00', timeZone: 'Etc/UTC' },
  y: { uid: 'cal-e2e-early', title: 'Early', start: '2026-09-01T10:00:00', timeZone: 'Etc/UTC' },
} }, 'c13']]);
const [[, sorted]] = await jmap([['CalendarEvent/query', { accountId: ACCT,
  sort: [{ property: 'start', isAscending: true }] }, 'c14']]);
const earlyIdx = sorted.ids.indexOf(mk.created.y.id);
const lateIdx = sorted.ids.indexOf(mk.created.x.id);
assert(earlyIdx !== -1 && earlyIdx < lateIdx, 'start sort orders events');

console.log('E2E CALENDAR OK — recurrence, DST, overrides, queries, and cascades verified');
