// Address books, and WHICH ACCOUNT'S address books.
//
// ⚠️ Contacts is the one realm where "the primary account" is not a safe
// assumption, and getting this wrong is not a cosmetic bug — it is a blank
// screen for the people the sharing model was built for.
//
// Two server facts drive everything here:
//
//  1. `primaryAccounts` is the OWNER's account or nothing. `session.ts:61`
//     computes it as `principal.accounts.find(a => !a.granted)?.accountId ?? ""`
//     — so a principal who reaches contacts ONLY through a grant has an empty
//     string there, and `client.primaryAccountId(CONTACTS_CAP)` throws
//     (`JmapClient.ts:176-181`). The account list is the truth; the primary is
//     a preference. `contactsAccounts()` below reads the list.
//
//  2. A grant can be narrower than the account. `allowedBookIds`
//     (`packages/auth-core/src/principal.ts:345-354`) restricts a grant-reached
//     principal to named AddressBook ids, and `AddressBook/get` filters the
//     list to them (contacts.ts:76-77). So the books that come back ARE the
//     books this session may see — there is no "and N more" to discover, and
//     no way to count what was withheld. The UI must therefore never phrase an
//     empty or short list as a fact about the account.
//
// The same two facts make `myRights` load-bearing rather than decorative:
// the owner gets all-true (contacts.ts:97), a sharee gets `mayWrite` from its
// grant with `mayShare`/`mayDelete` clamped off (contacts.ts:90-96), and
// `AddressBook/set` refuses grant-reached callers outright with `forbidden`
// (contacts.ts:118-122). Offer only what the rights allow.

import { CONTACTS_CAP, hasCapability } from "../jmap/capabilities";
import type { JmapClient } from "../jmap/JmapClient";
import type { Session } from "../jmap/types";
import type { AddressBook } from "./types";

/** An account this session can reach contacts in. */
export interface ContactsAccount {
  id: string;
  /** The account's own name — an address, for a shared account. */
  name: string;
  /**
   * Owner (`isPersonal`) vs reached through a grant. This is what decides
   * whether address-book MANAGEMENT is offered at all: `AddressBook/set`
   * throws `forbidden` for granted access before it looks at anything else.
   */
  isPersonal: boolean;
  isReadOnly: boolean;
  /** `primaryAccounts["urn:ietf:params:jmap:contacts"]` pointed here. */
  isPrimary: boolean;
}

/**
 * Every account whose capabilities advertise contacts, primary first.
 *
 * A book-scoped grant advertises ONLY the contacts capability
 * (`session.ts:41`), which is precisely the session this function exists for:
 * such an account carries no mail and would never appear if we asked the mail
 * side who the user is.
 */
export function contactsAccounts(session: Session): ContactsAccount[] {
  const primaryId = session.primaryAccounts[CONTACTS_CAP] ?? "";
  const out: ContactsAccount[] = [];
  for (const [id, account] of Object.entries(session.accounts)) {
    if (!hasCapability({ capabilities: account.accountCapabilities }, CONTACTS_CAP)) continue;
    out.push({
      id,
      name: account.name,
      isPersonal: account.isPersonal,
      isReadOnly: account.isReadOnly,
      isPrimary: id === primaryId,
    });
  }
  // Own account first, then shared ones by name — the same "mine, then other
  // people's" ordering the console uses, so a shared account can never be
  // mistaken for your own by position alone.
  return out.sort((a, b) => {
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
    if (a.isPersonal !== b.isPersonal) return a.isPersonal ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Which account the page should open on. Undefined when the session reaches
 * no contacts account at all, which is a real state (a `mail`-only grant) and
 * must render as a sentence rather than as an exception.
 */
export function defaultContactsAccount(session: Session): ContactsAccount | undefined {
  return contactsAccounts(session)[0];
}

/**
 * Load every address book in one call. `ids: null` = all (RFC 8620 §5.1);
 * there is no `AddressBook/query` on this server (sVOL 022, "two capability
 * edges", `.plans/sVOL-CapSurNoun/022…md:104-108`) and none is needed — an
 * account has a handful of books.
 *
 * `AddressBook/get` also CREATES the default book on first touch for an owner
 * (contacts.ts:73), so a brand-new account returns one book rather than none.
 * A sharee never triggers that, which is correct: it is not their account.
 */
export async function loadAddressBooks(client: JmapClient, accountId: string): Promise<AddressBook[]> {
  const result = await client.requestOne("AddressBook/get", { accountId, ids: null });
  return ((result.list as AddressBook[] | undefined) ?? []).map(normalizeBook).sort(compareBooks);
}

/**
 * Defensive: a book with no `myRights` must read as "may do nothing", never as
 * "may do everything". The failure mode of the other default is a delete
 * button on someone else's shared book.
 */
function normalizeBook(raw: AddressBook): AddressBook {
  return {
    ...raw,
    description: raw.description ?? null,
    sortOrder: raw.sortOrder ?? 0,
    isDefault: raw.isDefault === true,
    isSubscribed: raw.isSubscribed !== false,
    shareWith: raw.shareWith ?? null,
    myRights: {
      mayRead: raw.myRights?.mayRead !== false,
      mayWrite: raw.myRights?.mayWrite === true,
      mayShare: raw.myRights?.mayShare === true,
      mayDelete: raw.myRights?.mayDelete === true,
    },
  };
}

/** Default book first, then the server's `sortOrder`, then name. */
export function compareBooks(a: AddressBook, b: AddressBook): number {
  if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return a.name.localeCompare(b.name);
}

/** The books a new or moved card may land in. */
export function writableBooks(books: AddressBook[]): AddressBook[] {
  return books.filter((b) => b.myRights.mayWrite);
}

/**
 * Where a new card goes when the user has not picked a book. The server would
 * pick for us — `ensureDefaultBook` for an owner, or the single writable book
 * for a restricted writer (contacts.ts:356-367) — but it REFUSES when a
 * restricted writer has more than one, and the UI should not send a create it
 * can already tell will fail.
 */
export function defaultTargetBook(books: AddressBook[]): AddressBook | undefined {
  const writable = writableBooks(books);
  return writable.find((b) => b.isDefault) ?? writable[0];
}

/** The one book id a card belongs to (`maxAddressBooksPerCard: 1`). */
export function bookIdOf(addressBookIds: Record<string, boolean> | undefined): string | undefined {
  if (!addressBookIds) return undefined;
  return Object.entries(addressBookIds).find(([, present]) => present === true)?.[0];
}

export function bookName(books: AddressBook[], id: string | undefined): string | undefined {
  return books.find((b) => b.id === id)?.name;
}

/**
 * May this session write THIS card? The answer is a property of the card's
 * address book, not of the screen it is being edited from — and the case that
 * makes it matter is group membership: adding someone to a group writes the
 * GROUP's card, which can live in a different book with different rights
 * (`allowedBookIds` is per book, principal.ts:345-354). Gating that button on
 * the rights of the card you happen to be looking at would offer a write the
 * server then refuses.
 *
 * A card whose book is not in `books` is not writable: either it is outside
 * this grant, or the list is stale. Both mean "do not offer it".
 */
export function mayWriteCard(books: AddressBook[], card: { addressBookIds?: Record<string, boolean> }): boolean {
  const id = bookIdOf(card.addressBookIds);
  return books.find((b) => b.id === id)?.myRights.mayWrite === true;
}

/**
 * The sentence a restricted view has to carry.
 *
 * Rendering "3 address books" for a shared account states something this
 * session cannot know: `AddressBook/get` returned the books the grant names,
 * and nothing on the wire says how many were filtered out
 * (`allowedBookIds`, principal.ts:345-354). So say what is true — these are
 * the shared ones — instead of implying completeness. Owners get no note:
 * for them the list really is the account.
 */
export function bookScopeNote(account: ContactsAccount, books: AddressBook[]): string | undefined {
  if (account.isPersonal) return undefined;
  const n = books.length;
  return (
    `Shared account — you are seeing ${n === 1 ? "the one address book" : `the ${n} address books`} ` +
    `${account.name} shared with you, which may not be all of them. ` +
    `Address books themselves can only be created, renamed or deleted by their owner.`
  );
}
