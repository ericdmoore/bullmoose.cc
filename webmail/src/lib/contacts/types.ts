// The contacts wire shapes, as the SERVER actually stores and returns them.
//
// The one thing to internalise before touching anything else in this folder:
// **a ContactCard is a JSContact Card (RFC 9553), not a row of flat strings.**
// `services/jmap/src/methods/contacts.ts:609-615` returns the stored blob
// verbatim with `id` and `addressBookIds` stapled on, and the blob is the
// lossless source of truth (`packages/mailstore/src/index.ts:166-183`). So:
//
//   • `name` is `{ full, components: [{ kind, value }] }` — not `firstName`.
//   • `emails` / `phones` / `addresses` / `organizations` / `notes` are
//     **objects keyed by an opaque id**, not arrays. The key is meaningful:
//     CardDAV round-trips Apple's `itemN.X-ABLABEL` grouping through it
//     (`packages/contacts-core/src/index.ts:287-294`), so rebuilding a map
//     with fresh keys silently reshuffles a synced card's labels.
//   • an `Address` is itself `{ components: [{ kind, value }] }`.
//
// A form that flattens any of that cannot round-trip, which is why `form.ts`
// edits a subset and patches only what changed rather than rewriting the card.
//
// These types mirror the server the way `../mail/types.ts` does, and for the
// same reason: `@bullmoose/mailstore` is Worker source and cannot be dragged
// into a DOM/Preact bundle. Keep them in sync by hand; the demo backend
// (`demo.ts`) is the executable half of that promise.

/** RFC 9670 rights, as `AddressBook/get` computes them (contacts.ts:84-99). */
export interface AddressBookRights {
  mayRead: boolean;
  mayWrite: boolean;
  mayShare: boolean;
  mayDelete: boolean;
}

/**
 * An address book. `myRights` is the ONLY honest source for what this session
 * may do with it: for the owner it is all-true (`OWNER_RIGHTS`,
 * contacts.ts:49-54), and for a grant-reached viewer `mayWrite` follows the
 * per-book grant while `mayShare`/`mayDelete` are clamped off server-side.
 *
 * `shareWith` is null for a sharee by design (RFC 9670) — reading it as
 * "shared with nobody" would be exactly wrong.
 */
export interface AddressBook {
  id: string;
  name: string;
  description: string | null;
  sortOrder: number;
  isDefault: boolean;
  isSubscribed: boolean;
  shareWith: Record<string, AddressBookRights> | null;
  myRights: AddressBookRights;
}

/** One `{ kind, value }` component of a structured `name` or `address`. */
export interface CardComponent {
  kind: string;
  value?: string;
  [extra: string]: unknown;
}

export interface CardName {
  full?: string;
  components?: CardComponent[];
  [extra: string]: unknown;
}

/**
 * One entry in a keyed JSContact map (an EmailAddress, Phone, Note, …).
 * Left open on purpose: `pref`, `contexts`, `label`, `features` and anything
 * a future RFC adds must survive an edit that only touched the address.
 */
export type CardEntry = Record<string, unknown>;

/** A JSContact Card as `ContactCard/get` returns it. */
export interface ContactCard {
  /** JMAP id (`cc_…`). Server-set and immutable (contacts.ts:463-465). */
  id: string;
  /**
   * JSContact uid. Also immutable (contacts.ts:466-468) — and the identity
   * that GROUP MEMBERSHIP is expressed in, which is why nothing here treats
   * `id` and `uid` as interchangeable. See `groups.ts`.
   */
  uid?: string;
  "@type"?: string;
  version?: string;
  created?: string;
  updated?: string;
  /** individual | group | org | location | device | application. */
  kind?: string;
  name?: CardName;
  nicknames?: Record<string, CardEntry>;
  organizations?: Record<string, CardEntry>;
  titles?: Record<string, CardEntry>;
  emails?: Record<string, CardEntry>;
  phones?: Record<string, CardEntry>;
  addresses?: Record<string, CardEntry>;
  notes?: Record<string, CardEntry>;
  links?: Record<string, CardEntry>;
  media?: Record<string, CardEntry>;
  /** uid → true. Present only on group cards (RFC 9553 §2.1.5). */
  members?: Record<string, boolean>;
  /** JMAP-side membership. Exactly one key is true — see `books.ts`. */
  addressBookIds?: Record<string, boolean>;
  [extra: string]: unknown;
}

/** An RFC 8620 §5.3 PatchObject for `ContactCard/set update`. */
export type CardPatch = Record<string, unknown>;

/**
 * What `Foo/set` says when it refuses one object (RFC 8620 §5.3). Kept
 * structurally identical to the mail side's failure reporting
 * (`../mail/triage.ts:95-111`) so both screens can explain a refusal instead
 * of showing a generic error.
 */
export interface SetError {
  type: string;
  description?: string;
  properties?: string[];
}
