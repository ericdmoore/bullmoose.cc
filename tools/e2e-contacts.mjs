// JMAP Contacts (RFC 9610) e2e — run against a freshly seeded local dev
// server (see tools/README.md). Safe to run after e2e-jmap.mjs on the
// same state; it only touches AddressBook/ContactCard collections.
const BASE = 'http://127.0.0.1:8787';
const ACCT = 't_dev__a_local';
const H = { 'Authorization': 'Bearer devtoken', 'content-type': 'application/json' };
const assert = (cond, msg) => { if (!cond) { console.error('FAIL: ' + msg); process.exit(1); } };
const jmap = async (methodCalls) => {
  const res = await fetch(`${BASE}/api/jmap`, { method: 'POST', headers: H, body: JSON.stringify({
    using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:contacts'],
    methodCalls,
  })});
  if (!res.ok) { console.error(`FAIL: api/jmap HTTP ${res.status}: ${await res.text()}`); process.exit(1); }
  return (await res.json()).methodResponses;
};

// 1. session advertises the contacts capability
const session = await (await fetch(`${BASE}/.well-known/jmap`, { headers: H })).json();
const CAP = 'urn:ietf:params:jmap:contacts';
assert(CAP in session.capabilities, 'session capabilities include contacts');
const acctCap = session.accounts[ACCT].accountCapabilities[CAP];
assert(acctCap?.maxAddressBooksPerCard === 1 && acctCap?.mayCreateAddressBook === true,
  `account capability object: ${JSON.stringify(acctCap)}`);
assert(session.primaryAccounts[CAP] === ACCT, 'primaryAccounts maps contacts to the account');

// 2. first AddressBook/get auto-creates the default book
let [[, ab]] = await jmap([['AddressBook/get', { accountId: ACCT, ids: null }, 'c0']]);
assert(ab.list.length >= 1, 'default address book exists');
const defaultBook = ab.list.find(b => b.isDefault);
assert(defaultBook && defaultBook.name === 'Contacts', `default book auto-created: ${JSON.stringify(ab.list)}`);
assert(defaultBook.myRights.mayWrite === true && defaultBook.shareWith === null, 'owner rights + unshared');
const state0 = ab.state;

// 3. AddressBook/set create + validation
const [[, abSet]] = await jmap([['AddressBook/set', { accountId: ACCT, create: {
  b1: { name: 'Work', description: 'colleagues' },
  bad: { name: '' },
}}, 'c1']]);
assert(abSet.created?.b1?.id, `Work book created: ${JSON.stringify(abSet.notCreated)}`);
assert(abSet.created.b1.isDefault === false, 'second book is not default');
assert(abSet.notCreated?.bad?.type === 'invalidProperties', 'empty name rejected');
const workId = abSet.created.b1.id;

// 4. AddressBook/changes sees the create
const [[, abCh]] = await jmap([['AddressBook/changes', { accountId: ACCT, sinceState: state0 }, 'c2']]);
assert(abCh.created.includes(workId), 'AddressBook/changes reports the new book');

// 5. ContactCard/set create (default book when addressBookIds omitted)
const [[, ccSet]] = await jmap([['ContactCard/set', { accountId: ACCT, create: {
  a: { name: { full: 'Ada Lovelace', components: [
        { kind: 'given', value: 'Ada' }, { kind: 'surname', value: 'Lovelace' }] },
       emails: { e1: { address: 'ada@example.com' } },
       uid: 'e2e-ada' },
  b: { name: { full: 'Charles Babbage' }, uid: 'e2e-charles',
       addressBookIds: { [workId]: true },
       phones: { p1: { number: '+44 20 7946 0958' } } },
  dupe: { name: { full: 'Ada Again' }, uid: 'e2e-ada' },
}}, 'c3']]);
assert(ccSet.created?.a?.id && ccSet.created?.b?.id, `cards created: ${JSON.stringify(ccSet.notCreated)}`);
assert(ccSet.created.a.created && ccSet.created.a.updated, 'server-set created/updated returned');
assert(ccSet.notCreated?.dupe?.type === 'invalidProperties', 'duplicate uid rejected');
const adaId = ccSet.created.a.id;
const charlesId = ccSet.created.b.id;
const cardState0 = ccSet.newState;

// 6. ContactCard/get round-trips the card + wire props
const [[, ccGet]] = await jmap([['ContactCard/get', { accountId: ACCT, ids: [adaId] }, 'c4']]);
const ada = ccGet.list[0];
assert(ada['@type'] === 'Card' && ada.version === '1.0' && ada.uid === 'e2e-ada', 'JSContact envelope');
assert(ada.addressBookIds[defaultBook.id] === true, 'card landed in the default book');
assert(ada.name.full === 'Ada Lovelace', 'name survives');

// 7. properties filtering
const [[, ccGetP]] = await jmap([['ContactCard/get', { accountId: ACCT, ids: [adaId], properties: ['uid'] }, 'c5']]);
assert(ccGetP.list[0].uid === 'e2e-ada' && ccGetP.list[0].id === adaId && !('name' in ccGetP.list[0]),
  'properties filter keeps id + requested only');

// 8. query filters
const q = async (filter, expect, label) => {
  const [[, r]] = await jmap([['ContactCard/query', { accountId: ACCT, filter, calculateTotal: true }, 'q']]);
  assert(JSON.stringify([...r.ids].sort()) === JSON.stringify([...expect].sort()),
    `${label}: got ${JSON.stringify(r.ids)}`);
};
await q({ inAddressBook: defaultBook.id }, [adaId], 'query inAddressBook');
await q({ email: 'ada@' }, [adaId], 'query email substring');
await q({ name: 'babbage' }, [charlesId], 'query name (component, case-insensitive LIKE)');
await q({ text: 'lovelace' }, [adaId], 'query free text');
await q({ uid: 'e2e-charles' }, [charlesId], 'query uid exact');
await q({ phone: '7946' }, [charlesId], 'query phone');
await q({ operator: 'OR', conditions: [{ email: 'ada@' }, { phone: '7946' }] }, [adaId, charlesId], 'operator OR');

// 9. unsupported filter/sort are rejected per RFC 8620 §5.5
const [badF] = await jmap([['ContactCard/query', { accountId: ACCT, filter: { zodiac: 'leo' } }, 'e1']]);
assert(badF[0] === 'error' && badF[1].type === 'unsupportedFilter', 'unknown filter property rejected');
const [badS] = await jmap([['ContactCard/query', { accountId: ACCT, sort: [{ property: 'shoeSize' }] }, 'e2']]);
assert(badS[0] === 'error' && badS[1].type === 'unsupportedSort', 'unknown sort property rejected');

// 10. sort by name
const [[, sorted]] = await jmap([['ContactCard/query', { accountId: ACCT,
  sort: [{ property: 'name', isAscending: true }] }, 'c6']]);
assert(sorted.ids[0] === adaId && sorted.ids[1] === charlesId, `name sort: ${JSON.stringify(sorted.ids)}`);

// 11. update: patch a nested property + move books
const [[, upd]] = await jmap([['ContactCard/set', { accountId: ACCT, update: {
  [adaId]: { 'name/full': 'Ada King, Countess of Lovelace', [`addressBookIds/${workId}`]: true,
             [`addressBookIds/${defaultBook.id}`]: null },
}}, 'c7']]);
assert(upd.updated && adaId in upd.updated, `update applied: ${JSON.stringify(upd.notUpdated)}`);
const [[, ccGet2]] = await jmap([['ContactCard/get', { accountId: ACCT, ids: [adaId] }, 'c8']]);
assert(ccGet2.list[0].name.full === 'Ada King, Countess of Lovelace', 'patched nested name/full');
assert(ccGet2.list[0].addressBookIds[workId] === true && !(defaultBook.id in ccGet2.list[0].addressBookIds),
  'moved to Work book');
await q({ inAddressBook: defaultBook.id }, [], 'default book now empty');

// 12. uid is immutable; two books rejected (maxAddressBooksPerCard 1)
const [[, updBad]] = await jmap([['ContactCard/set', { accountId: ACCT, update: {
  [adaId]: { uid: 'something-else' },
}}, 'c9']]);
assert(updBad.notUpdated?.[adaId]?.type === 'invalidProperties', 'uid change rejected');
const [[, updBad2]] = await jmap([['ContactCard/set', { accountId: ACCT, update: {
  [adaId]: { addressBookIds: { [workId]: true, [defaultBook.id]: true } },
}}, 'c10']]);
assert(updBad2.notUpdated?.[adaId]?.type === 'invalidProperties', 'two books rejected in v1');

// 13. ContactCard/changes delta
const [[, ccCh]] = await jmap([['ContactCard/changes', { accountId: ACCT, sinceState: cardState0 }, 'c11']]);
assert(ccCh.updated.includes(adaId) && !ccCh.created.includes(adaId), 'changes: ada updated since create-state');

// 14. destroy a non-empty book: refused, then removed with contents
const [[, dBad]] = await jmap([['AddressBook/set', { accountId: ACCT, destroy: [workId] }, 'c12']]);
assert(dBad.notDestroyed?.[workId]?.type === 'addressBookHasContents', 'non-empty destroy refused');
const [[, dOk]] = await jmap([['AddressBook/set', { accountId: ACCT, destroy: [workId],
  onDestroyRemoveContents: true }, 'c13']]);
assert(dOk.destroyed.includes(workId), `destroy with contents: ${JSON.stringify(dOk.notDestroyed)}`);
const [[, goneGet]] = await jmap([['ContactCard/get', { accountId: ACCT, ids: [adaId, charlesId] }, 'c14']]);
assert(goneGet.notFound.length === 2, 'cards in the destroyed book are gone');
const [[, ccCh2]] = await jmap([['ContactCard/changes', { accountId: ACCT, sinceState: ccCh.newState }, 'c15']]);
assert(ccCh2.destroyed.includes(adaId) && ccCh2.destroyed.includes(charlesId),
  'changes reports the cascade destroys');

// 15. exactly one default book remains (promotion / steady state)
const [[, abFinal]] = await jmap([['AddressBook/get', { accountId: ACCT, ids: null }, 'c16']]);
assert(abFinal.list.filter(b => b.isDefault).length === 1, 'exactly one default book');

// 16. onSuccessSetIsDefault with a creation reference
const [[, abDef]] = await jmap([['AddressBook/set', { accountId: ACCT,
  create: { nb: { name: 'Family' } }, onSuccessSetIsDefault: '#nb' }, 'c17']]);
assert(abDef.created?.nb?.id, 'family book created');
const [[, abAfter]] = await jmap([['AddressBook/get', { accountId: ACCT, ids: [abDef.created.nb.id] }, 'c18']]);
assert(abAfter.list[0].isDefault === true, 'onSuccessSetIsDefault promoted the new book');

// 17. cleanup to steady state: destroy Family, default returns to Contacts
await jmap([['AddressBook/set', { accountId: ACCT, destroy: [abDef.created.nb.id] }, 'c19']]);
const [[, abEnd]] = await jmap([['AddressBook/get', { accountId: ACCT, ids: null }, 'c20']]);
assert(abEnd.list.filter(b => b.isDefault).length === 1, 'default book after cleanup');

// 18. stateMismatch guard
const [sm] = await jmap([['ContactCard/set', { accountId: ACCT, ifInState: '0', update: {} }, 'c21']]);
assert(sm[0] === 'error' && sm[1].type === 'stateMismatch', 'ifInState mismatch → stateMismatch');

console.log('E2E CONTACTS OK — all 18 checks passed');
