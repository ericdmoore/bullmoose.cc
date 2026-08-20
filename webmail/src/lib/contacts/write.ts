// Writes: `ContactCard/set` and `AddressBook/set`, with optimistic concurrency.
//
// ── `ifInState` here is an ACCOUNT state, not a collection state ───────────
//
// Both `/set` methods compare `ifInState` against `accountState(ctx, accountId)`
// (`services/jmap/src/methods/contacts.ts:125-128` and `:323-326`), and that
// function reads ONE state string per account from the AccountDO changelog
// (`services/jmap/src/methods/common.ts:144-148`). Every collection shares it,
// so a message arriving in the inbox advances the same counter a contact edit
// is guarded by.
//
// That makes naïve `ifInState` on every write actively bad UX: on a busy
// account most edits would fail with `stateMismatch` for reasons that have
// nothing to do with contacts. But dropping it is worse — that is the lost
// update the mail side deliberately guards against (`../mail/triage.ts:126-132`).
//
// So `saveCardEdit` does read-verify-write: re-read the card, confirm the
// properties being patched still hold the values the form was built from, take
// the state from THAT read, and write. The window is one round trip, and a
// `stateMismatch` inside it is retried once — because the re-read has already
// proven the card itself did not change, which is the only thing a contacts
// write can actually lose.

import { DEFAULT_MAX_OBJECTS_IN_SET } from "../jmap/capabilities";
import type { JmapClient } from "../jmap/JmapClient";
import { deepEqual } from "./form";
import type { AddressBook, CardPatch, ContactCard, SetError } from "./types";

/** A method-level refusal — the whole call, not one object. */
export interface WriteRefusal {
  type: string;
  description?: string;
  /** Something a person can act on, not a JMAP error type. */
  message: string;
}

export interface CardWriteResult {
  /** Set on a successful create. */
  id?: string;
  /** Thread into the next write's `ifInState`. */
  newState?: string;
  /** The server ran the call and refused this object. */
  error?: SetError;
  /** The server refused the whole call. */
  refusal?: WriteRefusal;
}

export interface WriteOptions {
  ifInState?: string;
}

/**
 * Turn a refusal into a sentence. Mirrors `describeRefusal`
 * (`../mail/triage.ts:200-220`) so both sections explain a scope failure the
 * same way, with the contacts-specific cases spelled out:
 *
 *  • `forbidden` on `AddressBook/set` is almost always the owner-only rule —
 *    a grant-reached session may edit cards but never books (contacts.ts:118-122).
 *  • `forbidden` on `ContactCard/set` is the `contacts` scope, or a write
 *    aimed at a book outside `allowedBookIds` (contacts.ts:370-372).
 */
export function describeContactRefusal(
  detail: { type?: string; description?: string },
  what: "card" | "book",
): WriteRefusal {
  const type = detail.type ?? "error";
  const message =
    type === "forbidden"
      ? what === "book"
        ? "Only the account owner can create, rename or delete address books. " +
          "You can still add and edit the cards inside the books shared with you."
        : "This session is not allowed to change contacts. The action needs the " +
          "“contacts” permission on a book you can write to."
      : type === "stateMismatch"
        ? "Something else in this account changed while you were editing. " + "Reload and try again."
        : type === "accountNotFound"
          ? "That account is no longer reachable from this session."
          : detail.description || `The server refused: ${type}.`;
  return {
    type,
    ...(detail.description ? { description: detail.description } : {}),
    message,
  };
}

/** One `Foo/set` call, reduced to the single object it acted on. */
async function setOne(
  client: JmapClient,
  method: "ContactCard/set" | "AddressBook/set",
  args: Record<string, unknown>,
  op: "create" | "update" | "destroy",
  key: string,
  what: "card" | "book",
): Promise<CardWriteResult> {
  const [response] = await client.request([[method, args, "w0"]]);
  if (!response) return { refusal: describeContactRefusal({}, what) };
  if (response[0] === "error") {
    return { refusal: describeContactRefusal(response[1] as { type?: string }, what) };
  }

  const result = response[1] as {
    created?: Record<string, { id?: string }>;
    notCreated?: Record<string, SetError>;
    updated?: Record<string, unknown>;
    notUpdated?: Record<string, SetError>;
    destroyed?: string[];
    notDestroyed?: Record<string, SetError>;
    newState?: string;
  };
  const newState = typeof result.newState === "string" ? { newState: result.newState } : {};

  if (op === "create") {
    const made = result.created?.[key];
    if (made?.id) return { id: made.id, ...newState };
    return { error: result.notCreated?.[key] ?? { type: "serverFail" }, ...newState };
  }
  if (op === "update") {
    if (result.updated && key in result.updated) return { ...newState };
    return { error: result.notUpdated?.[key] ?? { type: "serverFail" }, ...newState };
  }
  if ((result.destroyed ?? []).includes(key)) return { ...newState };
  return { error: result.notDestroyed?.[key] ?? { type: "serverFail" }, ...newState };
}

// ── cards ─────────────────────────────────────────────────────────────────

export async function createCard(
  client: JmapClient,
  accountId: string,
  spec: Record<string, unknown>,
  opts: WriteOptions = {},
): Promise<CardWriteResult> {
  return setOne(
    client,
    "ContactCard/set",
    { accountId, ...ifInState(opts), create: { c0: spec } },
    "create",
    "c0",
    "card",
  );
}

export async function updateCard(
  client: JmapClient,
  accountId: string,
  id: string,
  patch: CardPatch,
  opts: WriteOptions = {},
): Promise<CardWriteResult> {
  return setOne(
    client,
    "ContactCard/set",
    { accountId, ...ifInState(opts), update: { [id]: patch } },
    "update",
    id,
    "card",
  );
}

export async function destroyCard(
  client: JmapClient,
  accountId: string,
  id: string,
  opts: WriteOptions = {},
): Promise<CardWriteResult> {
  return setOne(client, "ContactCard/set", { accountId, ...ifInState(opts), destroy: [id] }, "destroy", id, "card");
}

// ── bulk: one call per CHUNK, never one call per card ─────────────────────
//
// `ContactCard/set` takes `destroy: [ids]` and `update: { id: patch }` as
// SETS, so deleting 412 cards is a handful of requests, not 412 of them. The
// naive loop is not merely slow: 412 sequential round trips from a browser
// against your own Worker is a self-inflicted denial of service, and the
// account-wide state counter (see this file's header) advances on every one of
// them, so a concurrent edit elsewhere is fighting 412 moving targets instead
// of one.
//
// Two deliberate choices:
//
//  • **No `ifInState`.** The header explains why account-wide state makes
//    naïve optimistic concurrency actively bad UX for contacts; at 412 objects
//    it is worse, because a mismatch would refuse the WHOLE chunk for a reason
//    that has nothing to do with any card in it. `saveCardEdit`'s read-verify-
//    write is the guard for edits that could LOSE something. A destroy loses
//    nothing that a state check would have saved, and a book move rewrites one
//    property that nothing else on this screen touches.
//
//  • **Chunks run in sequence, and a method-level refusal stops the run.** If
//    the server refuses a whole call — `forbidden`, `accountNotFound` — every
//    later chunk would be refused for the same reason, so they are reported as
//    failed rather than sent. The caller gets one list of what happened, and
//    it always adds up to the number of ids it passed in.

/** One id the server refused, with the reason already in plain language. */
export interface BatchFailure {
  id: string;
  message: string;
}

/**
 * What a batched write actually did. `done` and `failed` together account for
 * every id passed in — that total is the contract callers report from, and it
 * is what makes "never a bare done" possible upstream.
 */
export interface BatchWriteResult {
  /** Ids the server confirmed. */
  done: string[];
  /** Ids it refused, individually or as collateral of a refused call. */
  failed: BatchFailure[];
  /** The state after the last chunk that landed. */
  newState?: string;
}

export interface BatchOptions {
  /** Objects per `/set` call. Defaults to the RFC 8620 floor; callers should
   *  pass the live session's `maxObjectsInSet` (`../jmap/capabilities.ts`). */
  chunkSize?: number;
}

/** Split into runs of at most `size`. `size < 1` would loop forever, so it
 *  clamps rather than trusting a capability object off the wire. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const step = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += step) out.push(items.slice(i, i + step));
  return out;
}

interface SetManyResponse {
  updated?: Record<string, unknown>;
  notUpdated?: Record<string, SetError>;
  destroyed?: string[];
  notDestroyed?: Record<string, SetError>;
  newState?: string;
}

/** The shared engine: chunk, send, and attribute every id to done or failed. */
async function setManyCards(
  client: JmapClient,
  accountId: string,
  ids: readonly string[],
  build: (batch: string[]) => Record<string, unknown>,
  op: "update" | "destroy",
  chunkSize: number,
): Promise<BatchWriteResult> {
  const done: string[] = [];
  const failed: BatchFailure[] = [];
  let newState: string | undefined;

  // De-duplicated: a Set-backed selection cannot repeat an id, but a caller
  // splicing two lists together can, and `destroy` would then report the
  // second copy as `notFound` — a failure invented by the client.
  const batches = chunk([...new Set(ids)], chunkSize);

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i] as string[];
    const [response] = await client.request([["ContactCard/set", { accountId, ...build(batch) }, "w0"]]);

    if (!response || response[0] === "error") {
      const refusal = describeContactRefusal((response?.[1] ?? {}) as { type?: string }, "card");
      // This chunk and every chunk after it: the refusal is about the call,
      // not about any card, so re-sending the rest would only repeat it.
      for (const remaining of batches.slice(i)) {
        for (const id of remaining) failed.push({ id, message: refusal.message });
      }
      return { done, failed, ...(newState === undefined ? {} : { newState }) };
    }

    const result = response[1] as SetManyResponse;
    if (typeof result.newState === "string") newState = result.newState;

    if (op === "destroy") {
      const confirmed = new Set(result.destroyed ?? []);
      for (const id of batch) {
        if (confirmed.has(id)) done.push(id);
        else failed.push({ id, message: describeSetError(result.notDestroyed?.[id] ?? { type: "serverFail" }, null) });
      }
    } else {
      const confirmed = result.updated ?? {};
      for (const id of batch) {
        if (id in confirmed) done.push(id);
        else failed.push({ id, message: describeSetError(result.notUpdated?.[id] ?? { type: "serverFail" }, null) });
      }
    }
  }

  return { done, failed, ...(newState === undefined ? {} : { newState }) };
}

/** Delete many cards. Final — there is no trash for a contact. */
export function destroyCards(
  client: JmapClient,
  accountId: string,
  ids: readonly string[],
  opts: BatchOptions = {},
): Promise<BatchWriteResult> {
  return setManyCards(
    client,
    accountId,
    ids,
    (batch) => ({ destroy: batch }),
    "destroy",
    opts.chunkSize ?? DEFAULT_MAX_OBJECTS_IN_SET,
  );
}

/**
 * Move many cards into one address book.
 *
 * "Which book am I in" is JMAP membership rather than JSContact content, so
 * the patch is the same one-property `addressBookIds` write the single-card
 * editor already sends (`ContactsApp`'s `save`) — `maxAddressBooksPerCard: 1`
 * makes `{ [bookId]: true }` the whole of it. Nothing else on the card is
 * touched, which is why this can go out un-guarded in bulk: there is no other
 * field for a concurrent edit to lose.
 */
export function moveCards(
  client: JmapClient,
  accountId: string,
  ids: readonly string[],
  bookId: string,
  opts: BatchOptions = {},
): Promise<BatchWriteResult> {
  const patch: CardPatch = { addressBookIds: { [bookId]: true } };
  return setManyCards(
    client,
    accountId,
    ids,
    (batch) => ({ update: Object.fromEntries(batch.map((id) => [id, patch])) }),
    "update",
    opts.chunkSize ?? DEFAULT_MAX_OBJECTS_IN_SET,
  );
}

/** A conflict `saveCardEdit` refused to resolve on the user's behalf. */
export interface CardConflict {
  /** The card as it is on the server NOW. */
  current: ContactCard;
  /** The properties whose stored value no longer matches what was edited. */
  properties: string[];
}

export interface SaveCardResult extends CardWriteResult {
  conflict?: CardConflict;
}

/**
 * Save an edit without silently overwriting someone else's.
 *
 * `base` is the card the form was read from. Every property the patch touches
 * is compared against a fresh read; if any has moved, nothing is written and
 * the caller gets both versions to show. Otherwise the write goes out guarded
 * by the state from that same read.
 *
 * The single retry exists because of the account-wide state described at the
 * top of this file: a `stateMismatch` on the first attempt frequently means
 * "unrelated mail arrived", and re-reading proves whether it meant anything.
 */
export async function saveCardEdit(
  client: JmapClient,
  accountId: string,
  base: ContactCard,
  patch: CardPatch,
  attempts = 2,
): Promise<SaveCardResult> {
  // A patch that touches a nested path (`members/<uid>`) is compared on its
  // root property, which is the granularity the server applies it at anyway.
  const touched = [...new Set(Object.keys(patch).map((p) => p.split("/")[0] as string))];
  if (touched.length === 0) return {};

  let lastRefusal: WriteRefusal | undefined;
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt++) {
    const read = await client.requestOne("ContactCard/get", { accountId, ids: [base.id] });
    const current = ((read.list as ContactCard[] | undefined) ?? [])[0];
    if (!current) {
      return { error: { type: "notFound", description: "This contact no longer exists." } };
    }
    const moved = touched.filter((p) => !deepEqual(current[p], base[p]));
    if (moved.length > 0) return { conflict: { current, properties: moved } };

    const state = typeof read.state === "string" ? read.state : undefined;
    const result = await updateCard(client, accountId, base.id, patch, {
      ...(state ? { ifInState: state } : {}),
    });
    if (result.refusal?.type !== "stateMismatch") return result;
    lastRefusal = result.refusal;
  }
  return { refusal: lastRefusal };
}

// ── address books ─────────────────────────────────────────────────────────

/**
 * Create a book. Owner-only: `AddressBook/set` throws `forbidden` for
 * grant-reached access before it reads a single argument (contacts.ts:117-122),
 * so callers should hide this behind `account.isPersonal` and treat a refusal
 * here as a bug in that gate rather than as a normal path.
 */
export async function createBook(
  client: JmapClient,
  accountId: string,
  name: string,
  opts: WriteOptions = {},
): Promise<CardWriteResult> {
  return setOne(
    client,
    "AddressBook/set",
    { accountId, ...ifInState(opts), create: { b0: { name: name.trim() } } },
    "create",
    "b0",
    "book",
  );
}

export async function renameBook(
  client: JmapClient,
  accountId: string,
  id: string,
  name: string,
  opts: WriteOptions = {},
): Promise<CardWriteResult> {
  return setOne(
    client,
    "AddressBook/set",
    { accountId, ...ifInState(opts), update: { [id]: { name: name.trim() } } },
    "update",
    id,
    "book",
  );
}

/**
 * Destroy a book. `withContents` maps to `onDestroyRemoveContents`
 * (contacts.ts:180-193) — without it a non-empty book comes back as
 * `addressBookHasContents` and nothing is lost, which is the confirmation
 * prompt the server gives you for free. With it, the cards are DESTROYED
 * rather than moved: v1 is one book per card, so there is nowhere else for
 * them to go.
 */
export async function destroyBook(
  client: JmapClient,
  accountId: string,
  id: string,
  withContents = false,
  opts: WriteOptions = {},
): Promise<CardWriteResult> {
  return setOne(
    client,
    "AddressBook/set",
    {
      accountId,
      ...ifInState(opts),
      destroy: [id],
      ...(withContents ? { onDestroyRemoveContents: true } : {}),
    },
    "destroy",
    id,
    "book",
  );
}

/** Explain a per-object SetError in the vocabulary of this screen. */
export function describeSetError(error: SetError, subject: AddressBook | ContactCard | null): string {
  switch (error.type) {
    case "notFound":
      return "That contact is no longer there — it may have been deleted from another client.";
    case "addressBookHasContents":
      return (
        `“${(subject as AddressBook | null)?.name ?? "This address book"}” still holds contacts. ` +
        "Deleting it deletes them too, because a card lives in exactly one book."
      );
    case "forbidden":
      return error.description ?? "The server refused that write.";
    case "invalidProperties":
      return error.description ?? `The server rejected: ${(error.properties ?? []).join(", ")}.`;
    default:
      return error.description ?? `The server refused: ${error.type}.`;
  }
}

function ifInState(opts: WriteOptions): Record<string, string> {
  return opts.ifInState ? { ifInState: opts.ifInState } : {};
}
