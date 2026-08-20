// Groups — what they actually are on this server, which was an open question.
//
// ── The model (read the source, not the analogy) ──────────────────────────
//
// A group is **a ContactCard like any other**, distinguished by two JSContact
// properties (RFC 9553):
//
//   kind:    "group"
//   members: { "<member card's uid>": true, … }
//
// It is NOT an AddressBook, and it is NOT a property on the member cards.
// Three independent confirmations in this repo:
//
//   • `ContactCard/query` accepts `kind` and `hasMember` as filter conditions
//     (`services/jmap/src/methods/contacts.ts:1033-1049`), and the mailstore
//     implements `hasMember` as "the card's `$.members` map has this KEY"
//     (`packages/mailstore/src/index.ts:1791-1794`). Both are card-level.
//   • `kind` defaults to `individual` when absent, in SQL
//     (`COALESCE(json_extract(c.card_json,'$.kind'),'individual')`,
//     mailstore:1786-1790) — so groupness is a value of a card column-ish
//     property, with no separate table anywhere in `data-plane.sql`.
//   • Nothing in `AddressBook/*` mentions membership at all; books carry
//     name/description/sortOrder/isDefault/isSubscribed/ctag and nothing else
//     (`AddressBookRow`, mailstore:154-164).
//
// **The keys of `members` are UIDs, not JMAP ids.** RFC 9553 §2.1.5: "Each key
// in the set is the uid property value of the member". This is the detail that
// makes group code look wrong when it is right — `ContactCard/get` takes `id`
// (`cc_…`), membership speaks `uid` (`urn:uuid:…`), and the two are different
// strings for the same card (contacts.ts:399, 378). Hence `loadGroupMembers`
// below resolves uid → card through a query rather than a get.
//
// ── ⚠️ The gap: groups do NOT round-trip over CardDAV ─────────────────────
//
// This is a real finding rather than a caveat, and it was found by reading the
// converter both directions:
//
//   • **In:** `cardFromBlock` has a `case "KIND"` (contacts-core:447-452) and
//     **no MEMBER case at all**. Anything unmapped falls to
//     `default: vCardProps.push(jcard(p))` (contacts-core:466), the lossless
//     verbatim tail. So a member line arriving from a DAV client is stored on
//     the card but never becomes `members`.
//   • **Out:** `serializeVcard` emits neither `KIND` nor `MEMBER`
//     (`X-ABSHOWAS:COMPANY` for `kind === "org"` is the only kind-ish output,
//     contacts-core:704). So `members` written here reaches no DAV client.
//   • And the server advertises **vCard 3.0** (`dav.ts:339`,
//     contacts-core:731), where Apple/CardDAV groups are
//     `X-ADDRESSBOOKSERVER-KIND` / `X-ADDRESSBOOKSERVER-MEMBER` — strings that
//     appear NOWHERE in this repository.
//
// Net effect, and the reason `GROUP_SYNC_CAVEAT` is rendered rather than
// buried: there are two disjoint group models. A group made in Apple Contacts
// rides through as opaque `vCardProps` (it keeps working in Apple Contacts,
// because the tail is re-emitted verbatim — contacts-core:713-728 — but it is
// invisible to `kind`/`hasMember`). A group made here is invisible to Apple
// Contacts. Closing that is converter work in `packages/contacts-core`, not
// screen work, so this section does the JMAP-native thing and SAYS SO.

import type { JmapClient } from "../jmap/JmapClient";
import { CARD_LIST_PROPERTIES, loadCards, type ContactFilter } from "./cards";
import { pointerToken } from "./form";
import { describeBatchOutcome, type BulkVerb } from "./selection";
import type { CardPatch, ContactCard } from "./types";
import type { BatchFailure } from "./write";

/** JSContact `kind` for a group card. */
export const GROUP_KIND = "group";

/** The sentence the group view carries. See the header for the evidence. */
export const GROUP_SYNC_CAVEAT =
  "Groups here are JMAP-native and do not sync to CardDAV clients: the vCard converter " +
  "(packages/contacts-core) maps neither MEMBER nor X-ADDRESSBOOKSERVER-MEMBER, so a group " +
  "made in the browser is invisible in Apple Contacts, and a group made in Apple Contacts is " +
  "carried through untouched but is invisible here. Cards themselves round-trip normally.";

export function isGroup(card: Pick<ContactCard, "kind">): boolean {
  return card.kind === GROUP_KIND;
}

/** The member uids of a group, in stored order. Non-groups have none. */
export function memberUids(card: Pick<ContactCard, "members">): string[] {
  const members = card.members;
  if (members === null || typeof members !== "object") return [];
  return Object.entries(members)
    .filter(([, present]) => present === true)
    .map(([uid]) => uid);
}

export function isMember(group: Pick<ContactCard, "members">, uid: string): boolean {
  return group.members?.[uid] === true;
}

/**
 * Add a member.
 *
 * Two shapes, and the difference is not stylistic: `applyCardPatch` walks the
 * path and throws `patch path "members/x" does not exist` when the parent is
 * absent (contacts.ts:988-996). So the FIRST member has to be written as a
 * whole `members` object, and only then can later ones be single-path patches
 * that cannot clobber a concurrent addition.
 *
 * The uid is escaped as an RFC 6901 pointer token — a uid may contain `/`
 * (vCard permits a URI uid), and an unescaped one would silently address the
 * wrong path (`pointerToken`, form.ts).
 */
export function addMemberPatch(group: Pick<ContactCard, "members" | "kind">, uid: string): CardPatch {
  return addMembersPatch(group, [uid]);
}

/**
 * Add MANY members in one patch (s34).
 *
 * This is the whole reason a bulk "Add to group" is cheap where a bulk delete
 * is not: membership lives on the GROUP's card, so adding 412 contacts to a
 * group is **one `ContactCard/set update` of one object** — not 412 writes,
 * and not even the chunked handful that `destroyCards` needs. The 412 cards
 * themselves are never written at all.
 *
 * The same two shapes as the single-member version, for the same reason, and
 * the choice between them is the concurrency story:
 *
 *   • The group already HAS members → one path patch per uid in a single
 *     PatchObject (`{"members/a": true, "members/b": true}`). Path patches
 *     touch only the keys they name, so a member somebody else added while
 *     this bar was open survives.
 *   • The group is EMPTY → the whole `members` object, because
 *     `applyCardPatch` throws `patch path "members/x" does not exist` when the
 *     parent is absent (contacts.ts:988-996). That shape CAN clobber a
 *     concurrent first-add, which is exactly what `saveCardEdit`'s
 *     read-verify-write exists to catch — so the caller routes through it.
 *
 * Uids already in the group are dropped: re-asserting `true` would be a no-op
 * on the server but a lie in the patch, and the caller reports them as
 * "already members" rather than as additions. An all-redundant add returns an
 * empty patch, which `saveCardEdit` treats as "nothing to do".
 */
export function addMembersPatch(group: Pick<ContactCard, "members" | "kind">, uids: readonly string[]): CardPatch {
  const fresh = [...new Set(uids)].filter((uid) => !isMember(group, uid));
  if (fresh.length === 0) return {};
  if (memberUids(group).length === 0) {
    // RFC 9553 §2.1.5: a card with `members` MUST have `kind: "group"`, so a
    // card being turned into a group declares both in the same patch.
    return {
      members: Object.fromEntries(fresh.map((uid) => [uid, true])),
      ...(isGroup(group) ? {} : { kind: GROUP_KIND }),
    };
  }
  return Object.fromEntries(fresh.map((uid) => [`members/${pointerToken(uid)}`, true]));
}

/**
 * Remove a member. Removing the LAST one drops the whole `members` property
 * rather than leaving `{}` behind: an empty map is not a shape RFC 9553
 * defines, and `kind: "group"` is what keeps the card a (now empty) group.
 */
export function removeMemberPatch(group: Pick<ContactCard, "members">, uid: string): CardPatch {
  const remaining = memberUids(group).filter((u) => u !== uid);
  if (remaining.length === 0) return { members: null };
  return { [`members/${pointerToken(uid)}`]: null };
}

/** A new group card. `members` and `kind` are set together, per RFC 9553. */
export function groupCreateSpec(name: string, uids: string[] = [], bookId?: string): Record<string, unknown> {
  return {
    kind: GROUP_KIND,
    name: { full: name.trim() },
    ...(uids.length > 0 ? { members: Object.fromEntries(uids.map((uid) => [uid, true])) } : {}),
    ...(bookId ? { addressBookIds: { [bookId]: true } } : {}),
  };
}

// ── planning a bulk add ────────────────────────────────────────────────────
//
// Membership speaks **uid**, the list speaks **id**, and the two are different
// strings for the same card (see the header). So a bulk add has a translation
// step, and that step is where a contact can quietly go missing — which is the
// one thing it must not do.

/** What a bulk "add these to that group" resolves to, with nothing dropped. */
export interface GroupAddPlan {
  /** Cards that will be added, and the uid each contributes. */
  add: Array<{ id: string; uid: string }>;
  /** Cards already in the group. Not failures — the intent is already true. */
  already: string[];
  /** Cards that CANNOT be added, each with a reason a person can act on. */
  refused: BatchFailure[];
}

/**
 * The sentence a card without a uid earns.
 *
 * A uid is server-set and IMMUTABLE (`contacts.ts:466-468`) — `ContactCard/set`
 * refuses to create or update one — so the client cannot mint a uid for an
 * existing card, and there is no repair to offer here beyond saying what is
 * true. (Cards created through this app always get one; a uid-less card comes
 * from an import or an older row.) The alternative — silently skipping it —
 * would tell someone their contact is in a group when it is not, and that is
 * the failure mode this whole outcome-reporting design exists to prevent.
 *
 * The same sentence the detail pane already shows for the single-card case.
 */
export const NO_UID_REFUSAL = "this card has no uid, so no group can name it";

/** A selected id that is no longer in the loaded list — reachable after a
 *  partial failure re-queries page 1 with a retained selection. */
export const NOT_LOADED_REFUSAL = "this contact is no longer in the list — reload and try again";

/**
 * Resolve a selection into a plan. Every id passed in comes back in exactly
 * one of the three buckets, which is what lets the caller report an outcome
 * that adds up.
 */
export function planGroupAdd(
  cards: readonly ContactCard[],
  ids: readonly string[],
  group: Pick<ContactCard, "members">,
): GroupAddPlan {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const plan: GroupAddPlan = { add: [], already: [], refused: [] };
  const seen = new Set<string>();

  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const card = byId.get(id);
    if (!card) {
      plan.refused.push({ id, message: NOT_LOADED_REFUSAL });
      continue;
    }
    const uid = typeof card.uid === "string" && card.uid.length > 0 ? card.uid : undefined;
    if (uid === undefined) {
      plan.refused.push({ id, message: NO_UID_REFUSAL });
      continue;
    }
    if (isMember(group, uid)) plan.already.push(id);
    else plan.add.push({ id, uid });
  }

  return plan;
}

/** The bulk verb for a group add. `target` renders the "to “Family”" clause. */
export function addToGroupVerb(groupName: string): BulkVerb {
  return { done: "Added", failed: "could not be added", target: `\u201C${groupName}\u201D` };
}

/**
 * The outcome sentence for a bulk add. Same contract as every other bulk
 * report: never a bare "done", both sides of the count named, failures named
 * with their reason — plus one clause this verb needs and no other does.
 *
 * Contacts that were ALREADY in the group count as done, because the thing the
 * person asked for is true of them. But it is said out loud, because "Added 5
 * contacts" when only 3 moved is the kind of quiet rounding that makes a
 * report untrustworthy.
 */
export function describeGroupAdd(
  groupName: string,
  outcome: { done: readonly string[]; failed: readonly BatchFailure[]; already: readonly string[] },
  nameOf?: (id: string) => string,
): string {
  const base = describeBatchOutcome(addToGroupVerb(groupName), { done: outcome.done, failed: outcome.failed }, nameOf);
  const n = outcome.already.length;
  if (n === 0) return base;
  return `${base} ${n === 1 ? "One was" : `${n.toLocaleString()} were`} already a member.`;
}

/**
 * The filter for "cards whose uid is one of these". An OR of `uid` conditions
 * is the only way to ask: `ContactCard/get` addresses cards by `id`, and there
 * is no `uids` argument anywhere in RFC 9610.
 */
export function membersFilter(uids: string[]): ContactFilter | null {
  if (uids.length === 0) return null;
  if (uids.length === 1) return { uid: uids[0] as string };
  return { operator: "OR", conditions: uids.map((uid) => ({ uid })) };
}

/** The reverse lookup: which groups contain this card. */
export function groupsContainingFilter(uid: string): ContactFilter {
  return { hasMember: uid };
}

/**
 * Chunk size for member resolution. Two ceilings meet here: the server clamps
 * `limit` to 256 (mailstore:1737), and each `uid` condition becomes another
 * OR'd predicate in one statement — so a 2,000-member group is 20 requests,
 * not one query the worker has to plan.
 */
const MEMBER_CHUNK = 100;

/**
 * Resolve a group's members to cards, in the group's own member order.
 *
 * Members that resolve to nothing are DROPPED and reported separately, because
 * that state is reachable and meaningful: `ContactCard/set destroy` removes a
 * card without touching any group that names it (contacts.ts:499-511 destroys
 * the row and nothing else), so a group can point at a uid that no longer
 * exists. Rendering that as an absence would hide a dangling reference the
 * user is the only one who can fix.
 */
export async function loadGroupMembers(
  client: JmapClient,
  accountId: string,
  group: Pick<ContactCard, "members">,
): Promise<{ members: ContactCard[]; missing: string[] }> {
  const uids = memberUids(group);
  if (uids.length === 0) return { members: [], missing: [] };

  const found = new Map<string, ContactCard>();
  for (let i = 0; i < uids.length; i += MEMBER_CHUNK) {
    const chunk = uids.slice(i, i + MEMBER_CHUNK);
    const page = await loadCards(client, accountId, {
      filter: membersFilter(chunk),
      limit: chunk.length,
    });
    for (const card of page.cards) if (card.uid) found.set(card.uid, card);
  }

  return {
    members: uids.map((uid) => found.get(uid)).filter((c): c is ContactCard => c !== undefined),
    missing: uids.filter((uid) => !found.has(uid)),
  };
}

/**
 * Which groups this card belongs to. One `hasMember` query — the server-side
 * reverse index — rather than fetching every group and scanning its members
 * in the browser.
 */
export async function loadGroupsContaining(client: JmapClient, accountId: string, uid: string): Promise<ContactCard[]> {
  const page = await loadCards(client, accountId, {
    filter: groupsContainingFilter(uid),
    limit: 100,
  });
  return page.cards;
}

/** The list properties a group row needs — the same set, `members` included. */
export const GROUP_LIST_PROPERTIES = CARD_LIST_PROPERTIES;
