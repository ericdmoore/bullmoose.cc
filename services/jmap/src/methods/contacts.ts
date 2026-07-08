import { MethodError, type MethodRegistry } from "@bullmoose/jmap-core";
import { commitChanges, type ChangeEntry } from "@bullmoose/account-do";
import type {
  AddressBookRow,
  ContactCardRow,
  ContactFilter,
  ContactFilterCondition,
  ContactSort,
  JSContactCard,
  Mailstore,
} from "@bullmoose/mailstore";
import { hasScope } from "@bullmoose/auth-core";
import { accountAccess, allowedBookIds, type AccountAccess } from "../auth";
import {
  accountState,
  proxyChanges,
  requireAccount,
  setError,
  storeFor,
  type RequestContext,
  type SetError,
} from "./common";

/**
 * JMAP for Contacts (RFC 9610): AddressBook/get·set·changes,
 * ContactCard/get·set·query·changes over JSContact (RFC 9553).
 *
 * Storage model (devPlan-handoff §5 Phase 1): card_json is the lossless
 * source of truth; uid/addressBookId/name_full/timestamps are extracted
 * columns. One address book per card in v1 — advertised via
 * maxAddressBooksPerCard: 1 — with the full addressBookIds set kept in
 * the blob so the constraint can lift later without a migration.
 *
 * Every mutation commits through the AccountDO changelog (collections
 * "AddressBook" / "ContactCard") and bumps the touched books' DAV ctag.
 * Writes need the "contacts" scope ("mail"-scoped tokens pass; a
 * read/draft agent token can read but not edit the address book).
 */

/**
 * Sharing (Phase 3): AddressBook.shareWith/myRights are a FACADE over
 * the grant model — one AddressBook-scoped grant row per sharee. The
 * owner edits shareWith through AddressBook/set; sharees reach the book
 * through their grants (requireAccount domain "contacts"), see only
 * shared books, and read shareWith as null per RFC 9670. Rights map to
 * scopes: mayRead = ["read"], +mayWrite = +["contacts"];
 * mayShare/mayDelete stay owner-only in v1 (server-clamped, spec-legal).
 */
const OWNER_RIGHTS = {
  mayRead: true,
  mayWrite: true,
  mayShare: true,
  mayDelete: true,
} as const;

interface BookRights {
  mayRead: boolean;
  mayWrite: boolean;
  mayShare: boolean;
  mayDelete: boolean;
}

const BOOK_SERVER_SET = ["id", "isDefault", "myRights"] as const;
const MAX_BOOK_NAME_OCTETS = 255;

export function registerContactsMethods(registry: MethodRegistry<RequestContext>): void {
  // ---- AddressBook ---------------------------------------------------

  registry.register("AddressBook/get", async (args, ctx) => {
    const access = await requireAccount(ctx, args, "read", "contacts");
    const store = storeFor(ctx);
    const readable = allowedBookIds(access, "read");
    if (!access.granted) await ensureDefaultBook(ctx, store, access.accountId);

    const ids = args.ids === null || args.ids === undefined ? undefined : (args.ids as string[]);
    let rows = await store.getAddressBooks(access.accountId, ids);
    if (readable) rows = rows.filter((r) => readable.has(r.id));
    const found = new Set(rows.map((r) => r.id));

    // Owners see who each book is shared with; sharees see null (RFC 9670).
    const shareWith = access.granted ? null : await loadShareWith(ctx, access.accountId);
    const writable = access.granted ? allowedBookIds(access, "contacts") : null;

    return {
      accountId: access.accountId,
      state: await accountState(ctx, access.accountId),
      list: rows.map((r) =>
        bookToJmap(r, {
          shareWith: shareWith?.get(r.id) ?? null,
          myRights: access.granted
            ? {
                mayRead: true,
                mayWrite: writable === null || writable.has(r.id),
                mayShare: false,
                mayDelete: false,
              }
            : OWNER_RIGHTS,
        }),
      ),
      notFound: (ids ?? []).filter((id) => !found.has(id)),
    };
  });

  registry.register("AddressBook/changes", async (args, ctx) => {
    const res = await proxyChanges(ctx, args, "AddressBook");
    const access = accountAccess(ctx.principal, res.accountId as string);
    const readable = access?.granted ? allowedBookIds(access, "read") : null;
    if (!readable) return res;
    return {
      ...res,
      created: (res.created as string[]).filter((id) => readable.has(id)),
      updated: (res.updated as string[]).filter((id) => readable.has(id)),
    };
  });

  registry.register("AddressBook/set", async (args, ctx) => {
    const access = await requireAccount(ctx, args, "contacts", "contacts");
    if (access.granted) {
      // v1: sharees edit contents (per mayWrite), never the books
      // themselves or their sharing.
      throw new MethodError("forbidden", "only the account owner manages address books");
    }
    const store = storeFor(ctx);

    const oldState = await accountState(ctx, access.accountId);
    if (typeof args.ifInState === "string" && args.ifInState !== oldState) {
      throw new MethodError("stateMismatch");
    }

    const created: Record<string, Record<string, unknown>> = {};
    const notCreated: Record<string, SetError> = {};
    const updated: Record<string, null> = {};
    const notUpdated: Record<string, SetError> = {};
    const destroyed: string[] = [];
    const notDestroyed: Record<string, SetError> = {};

    const bookEntry: ChangeEntry = { collection: "AddressBook", created: [], updated: [], destroyed: [] };
    const cardEntry: ChangeEntry = { collection: "ContactCard", created: [], updated: [], destroyed: [] };

    const books = await store.getAddressBooks(access.accountId);
    const byId = new Map(books.map((b) => [b.id, b]));
    let hasDefault = books.some((b) => b.isDefault);

    // -- create --
    const createSpecs = (args.create as Record<string, Record<string, unknown>> | undefined) ?? {};
    for (const [cid, spec] of Object.entries(createSpecs)) {
      try {
        const { shareWith, ...bookSpec } = spec;
        const row = validateNewBook(bookSpec, !hasDefault);
        await store.insertAddressBook(access.accountId, row);
        if (shareWith !== undefined && shareWith !== null) {
          await replaceShareWith(ctx, access, row.id, validateShareWithObject(shareWith));
        }
        byId.set(row.id, row);
        if (row.isDefault) hasDefault = true;
        bookEntry.created.push(row.id);
        created[cid] = { id: row.id, isDefault: row.isDefault, myRights: OWNER_RIGHTS };
      } catch (err) {
        notCreated[cid] = toSetError(err);
      }
    }

    // -- update --
    const updateSpecs = (args.update as Record<string, Record<string, unknown>> | undefined) ?? {};
    for (const [id, patch] of Object.entries(updateSpecs)) {
      try {
        const row = byId.get(id);
        if (!row) throw new NotFound();
        const { columns, share } = validateBookPatch(patch);
        await store.updateAddressBook(access.accountId, id, columns);
        if (share) await applyShareWithPatch(ctx, access, id, share);
        bookEntry.updated.push(id);
        updated[id] = null;
      } catch (err) {
        notUpdated[id] = toSetError(err);
      }
    }

    // -- destroy --
    const onDestroyRemoveContents = args.onDestroyRemoveContents === true;
    let destroyedDefault = false;
    for (const id of (args.destroy as string[] | undefined) ?? []) {
      try {
        const row = byId.get(id);
        if (!row) throw new NotFound();
        const cardIds = await store.cardIdsInBook(access.accountId, id);
        if (cardIds.length > 0 && !onDestroyRemoveContents) {
          throw new SetErrorSignal("addressBookHasContents");
        }
        // v1 is single-book-per-card, so removing a card from its only
        // book (RFC 9610 onDestroyRemoveContents) destroys the card.
        for (const cardId of cardIds) {
          await store.destroyContactCard(access.accountId, cardId);
          cardEntry.destroyed.push(cardId);
        }
        await store.deleteAddressBook(access.accountId, id);
        // A destroyed book takes its sharing with it.
        await ctx.env.DB.prepare(
          `DELETE FROM grants WHERE target_account_id = ? AND collection = 'AddressBook'
             AND collection_id = ?`,
        )
          .bind(access.accountId, id)
          .run();
        byId.delete(id);
        if (row.isDefault) destroyedDefault = true;
        bookEntry.destroyed.push(id);
        destroyed.push(id);
      } catch (err) {
        notDestroyed[id] = toSetError(err);
      }
    }

    // -- onSuccessSetIsDefault (only when every requested op succeeded) --
    const allSucceeded =
      Object.keys(notCreated).length + Object.keys(notUpdated).length + Object.keys(notDestroyed).length === 0;
    const onSuccessRaw = args.onSuccessSetIsDefault;
    let defaultApplied = false;
    if (allSucceeded && typeof onSuccessRaw === "string") {
      const target = onSuccessRaw.startsWith("#")
        ? (created[onSuccessRaw.slice(1)]?.id as string | undefined)
        : onSuccessRaw;
      if (target && byId.has(target)) {
        const previous = [...byId.values()].find((b) => b.isDefault && b.id !== target);
        await store.setDefaultAddressBook(access.accountId, target);
        for (const touched of [previous?.id, target]) {
          if (touched && !bookEntry.created.includes(touched)) bookEntry.updated.push(touched);
        }
        defaultApplied = true;
      }
    }
    // The default book was destroyed and nothing replaced it: promote the
    // oldest survivor so exactly one default remains (RFC 9610 §2).
    if (destroyedDefault && !defaultApplied && byId.size > 0) {
      const oldest = [...byId.values()].sort((a, b) => a.createdAt - b.createdAt)[0]!;
      await store.setDefaultAddressBook(access.accountId, oldest.id);
      if (!bookEntry.created.includes(oldest.id)) bookEntry.updated.push(oldest.id);
    }

    const newState = await commitContactEntries(ctx, access.accountId, [bookEntry, cardEntry]);

    return {
      accountId: access.accountId,
      oldState,
      newState,
      created,
      notCreated,
      updated,
      notUpdated,
      destroyed,
      notDestroyed,
    };
  });

  // ---- ContactCard ---------------------------------------------------

  registry.register("ContactCard/get", async (args, ctx) => {
    const access = await requireAccount(ctx, args, "read", "contacts");
    const store = storeFor(ctx);
    const readable = allowedBookIds(access, "read");

    const ids = args.ids === null || args.ids === undefined ? undefined : (args.ids as string[]);
    const properties = Array.isArray(args.properties) ? (args.properties as string[]) : null;

    // Skinny fast path: id/uid/addressBookIds come from columns — no
    // card_json parse. Sync-shaped scans over thousands of photo-bearing
    // cards must not pay the blob cost (free-tier CPU budget).
    let list: Record<string, unknown>[];
    let found: Set<string>;
    if (properties && properties.every((p) => p === "id" || p === "uid" || p === "addressBookIds")) {
      let refs = await store.getContactCardRefs(access.accountId, ids);
      if (readable) refs = refs.filter((r) => readable.has(r.addressBookId));
      found = new Set(refs.map((r) => r.id));
      list = refs.map((r) => {
        const picked: Record<string, unknown> = { id: r.id };
        if (properties.includes("uid")) picked.uid = r.uid;
        if (properties.includes("addressBookIds")) picked.addressBookIds = { [r.addressBookId]: true };
        return picked;
      });
    } else {
      let rows = await store.getContactCards(access.accountId, ids);
      if (readable) rows = rows.filter((r) => readable.has(r.addressBookId));
      found = new Set(rows.map((r) => r.id));
      list = rows.map((row) => {
        const full = cardToJmap(row);
        if (!properties) return full;
        const picked: Record<string, unknown> = { id: full.id };
        for (const p of properties) if (p in full) picked[p] = full[p];
        return picked;
      });
    }

    return {
      accountId: access.accountId,
      state: await accountState(ctx, access.accountId),
      list,
      notFound: (ids ?? []).filter((id) => !found.has(id)),
    };
  });

  registry.register("ContactCard/changes", async (args, ctx) => {
    const res = await proxyChanges(ctx, args, "ContactCard");
    const access = accountAccess(ctx.principal, res.accountId as string);
    const readable = access?.granted ? allowedBookIds(access, "read") : null;
    if (!readable) return res;
    // Restricted viewers only learn about cards in their shared books.
    // Destroys pass through: membership is gone, and a destroyed id only
    // tells the client to drop it from cache.
    const candidates = [...(res.created as string[]), ...(res.updated as string[])];
    if (candidates.length === 0) return res;
    const refs = await storeFor(ctx).getContactCardRefs(res.accountId as string, candidates);
    const visible = new Set(refs.filter((r) => readable.has(r.addressBookId)).map((r) => r.id));
    return {
      ...res,
      created: (res.created as string[]).filter((id) => visible.has(id)),
      updated: (res.updated as string[]).filter((id) => visible.has(id)),
    };
  });

  registry.register("ContactCard/set", async (args, ctx) => {
    const access = await requireAccount(ctx, args, "contacts", "contacts");
    const store = storeFor(ctx);
    // Sharees (mayWrite) edit cards only inside their shared books.
    const writable = allowedBookIds(access, "contacts");

    const oldState = await accountState(ctx, access.accountId);
    if (typeof args.ifInState === "string" && args.ifInState !== oldState) {
      throw new MethodError("stateMismatch");
    }

    const created: Record<string, Record<string, unknown>> = {};
    const notCreated: Record<string, SetError> = {};
    const updated: Record<string, null> = {};
    const notUpdated: Record<string, SetError> = {};
    const destroyed: string[] = [];
    const notDestroyed: Record<string, SetError> = {};

    const cardEntry: ChangeEntry = { collection: "ContactCard", created: [], updated: [], destroyed: [] };
    const ctagBooks = new Set<string>();

    const books = new Map(
      (await store.getAddressBooks(access.accountId)).map((b) => [b.id, b]),
    );

    // -- create (two-phase: validate everything, then do the D1 work in
    //    two batched calls — a 25-card import chunk must not pay ~50
    //    sequential D1 round-trips against the per-request CPU budget) --
    const createSpecs = (args.create as Record<string, Record<string, unknown>> | undefined) ?? {};
    const pending: Array<{ cid: string; row: ContactCardRow }> = [];
    const pendingUids = new Set<string>();
    for (const [cid, spec] of Object.entries(createSpecs)) {
      try {
        const { id, ...rest } = spec;
        if (id !== undefined) {
          throw new SetErrorSignal("invalidProperties", "id is server-set", ["id"]);
        }
        let bookId: string;
        if (rest.addressBookIds === undefined) {
          if (writable) {
            // Restricted writer with exactly one shared book: use it.
            if (writable.size !== 1) {
              throw new SetErrorSignal("invalidProperties", "addressBookIds is required", [
                "addressBookIds",
              ]);
            }
            bookId = [...writable][0]!;
          } else {
            bookId = await ensureDefaultBook(ctx, store, access.accountId);
          }
        } else {
          bookId = singleBookId(rest.addressBookIds, books);
        }
        if (writable && !writable.has(bookId)) {
          throw new SetErrorSignal("forbidden", "no write grant on this address book");
        }
        delete rest.addressBookIds;

        const card = rest as JSContactCard;
        card["@type"] = "Card";
        if (card.version === undefined) card.version = "1.0";
        if (card.uid === undefined) card.uid = `urn:uuid:${crypto.randomUUID()}`;
        if (typeof card.uid !== "string" || card.uid.length === 0) {
          throw new SetErrorSignal("invalidProperties", "uid must be a non-empty string", ["uid"]);
        }
        if (pendingUids.has(card.uid)) {
          throw new SetErrorSignal("invalidProperties", `uid already in use: ${card.uid}`, ["uid"]);
        }

        const now = Date.now();
        const nowIso = new Date(now).toISOString();
        if (typeof card.created !== "string" || Number.isNaN(Date.parse(card.created))) {
          card.created = nowIso;
        }
        card.updated = nowIso;
        card.addressBookIds = { [bookId]: true };

        pendingUids.add(card.uid);
        pending.push({
          cid,
          row: {
            id: `cc_${crypto.randomUUID()}`,
            addressBookId: bookId,
            uid: card.uid,
            card,
            nameFull: deriveNameFull(card),
            createdAt: Date.parse(card.created),
            updatedAt: now,
          },
        });
      } catch (err) {
        notCreated[cid] = toSetError(err);
      }
    }
    if (pending.length > 0) {
      const uidTaken = await store.contactCardIdsByUids(
        access.accountId,
        pending.map((p) => p.row.uid),
      );
      const toInsert = pending.filter((p) => {
        if (!uidTaken.has(p.row.uid)) return true;
        notCreated[p.cid] = {
          type: "invalidProperties",
          description: `uid already in use: ${p.row.uid}`,
          properties: ["uid"],
        };
        return false;
      });
      let inserted = toInsert;
      try {
        await store.insertContactCards(access.accountId, inserted.map((p) => p.row));
      } catch {
        // Batch is transactional; isolate the failing card(s) per-card.
        inserted = [];
        for (const p of toInsert) {
          try {
            await store.insertContactCard(access.accountId, p.row);
            inserted.push(p);
          } catch (err) {
            notCreated[p.cid] = toSetError(err);
          }
        }
      }
      for (const p of inserted) {
        ctagBooks.add(p.row.addressBookId);
        cardEntry.created.push(p.row.id);
        created[p.cid] = {
          id: p.row.id,
          uid: p.row.uid,
          created: p.row.card.created,
          updated: p.row.card.updated,
        };
      }
    }

    // -- update --
    const updateSpecs = (args.update as Record<string, Record<string, unknown>> | undefined) ?? {};
    for (const [id, patch] of Object.entries(updateSpecs)) {
      try {
        const [row] = await store.getContactCards(access.accountId, [id]);
        // Out-of-grant cards read as absent — don't leak their existence.
        if (!row || (writable && !writable.has(row.addressBookId))) throw new NotFound();

        const patched = applyCardPatch(cardToJmap(row), patch);
        if (patched.id !== row.id) {
          throw new SetErrorSignal("invalidProperties", "id is immutable", ["id"]);
        }
        if (patched.uid !== row.uid) {
          throw new SetErrorSignal("invalidProperties", "uid is immutable", ["uid"]);
        }
        const bookId = singleBookId(patched.addressBookIds, books);
        if (writable && !writable.has(bookId)) {
          throw new SetErrorSignal("forbidden", "no write grant on the target address book");
        }

        const card = { ...patched } as JSContactCard;
        delete (card as Record<string, unknown>).id;
        card.addressBookIds = { [bookId]: true };
        card.updated = new Date().toISOString();

        await store.updateContactCard(access.accountId, {
          id: row.id,
          addressBookId: bookId,
          uid: row.uid,
          card,
          nameFull: deriveNameFull(card),
          createdAt: row.createdAt,
          updatedAt: Date.parse(card.updated),
        });
        ctagBooks.add(row.addressBookId);
        ctagBooks.add(bookId);
        cardEntry.updated.push(id);
        updated[id] = null;
      } catch (err) {
        notUpdated[id] = toSetError(err);
      }
    }

    // -- destroy --
    for (const id of (args.destroy as string[] | undefined) ?? []) {
      try {
        const [row] = await store.getContactCards(access.accountId, [id]);
        if (!row || (writable && !writable.has(row.addressBookId))) throw new NotFound();
        await store.destroyContactCard(access.accountId, id);
        ctagBooks.add(row.addressBookId);
        cardEntry.destroyed.push(id);
        destroyed.push(id);
      } catch (err) {
        notDestroyed[id] = toSetError(err);
      }
    }

    await store.bumpAddressBookCtags(access.accountId, ctagBooks);
    const newState = await commitContactEntries(ctx, access.accountId, [cardEntry]);

    return {
      accountId: access.accountId,
      oldState,
      newState,
      created,
      notCreated,
      updated,
      notUpdated,
      destroyed,
      notDestroyed,
    };
  });

  registry.register("ContactCard/query", async (args, ctx) => {
    const access = await requireAccount(ctx, args, "read", "contacts");
    const store = storeFor(ctx);
    const readable = allowedBookIds(access, "read");

    const filter = (args.filter as ContactFilter | null | undefined) ?? null;
    if (filter) validateContactFilter(filter);

    const sort = validateContactSort(args.sort);

    const result = await store.queryContactCards(access.accountId, {
      filter,
      sort,
      position: typeof args.position === "number" ? args.position : 0,
      limit: typeof args.limit === "number" ? args.limit : undefined,
      calculateTotal: args.calculateTotal === true,
      ...(readable ? { restrictToBooks: [...readable] } : {}),
    });

    return {
      accountId: access.accountId,
      queryState: await accountState(ctx, access.accountId),
      canCalculateChanges: false,
      position: result.position,
      ids: result.ids,
      ...(args.calculateTotal === true ? { total: result.total ?? 0 } : {}),
    };
  });

  // Advertised canCalculateChanges: false — conformant clients re-query.
  registry.register("ContactCard/queryChanges", async () => {
    throw new MethodError("cannotCalculateChanges");
  });
}

// ---- helpers -------------------------------------------------------------

class NotFound extends Error {}

/** Carries an RFC 8620 SetError through the per-object try/catch. */
class SetErrorSignal extends Error {
  constructor(
    public type: string,
    public description?: string,
    public properties?: string[],
  ) {
    super(description ?? type);
  }
}

function toSetError(err: unknown): SetError {
  if (err instanceof NotFound) return setError("notFound");
  if (err instanceof SetErrorSignal) {
    return {
      type: err.type,
      ...(err.description ? { description: err.description } : {}),
      ...(err.properties ? { properties: err.properties } : {}),
    };
  }
  if (err instanceof MethodError) return setError("invalidProperties", err.description ?? err.type);
  return setError("serverFail", String(err));
}

function bookToJmap(
  r: AddressBookRow,
  view: { shareWith: Record<string, BookRights> | null; myRights: BookRights },
): Record<string, unknown> {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    sortOrder: r.sortOrder,
    isDefault: r.isDefault,
    isSubscribed: r.isSubscribed,
    shareWith: view.shareWith,
    myRights: view.myRights,
  };
}

/** The wire ContactCard: the stored JSContact card + JMAP id/addressBookIds. */
function cardToJmap(row: ContactCardRow): Record<string, unknown> {
  return {
    ...row.card,
    id: row.id,
    addressBookIds: { [row.addressBookId]: true },
  };
}

function validateNewBook(spec: Record<string, unknown>, becomeDefault: boolean): AddressBookRow {
  for (const p of BOOK_SERVER_SET) {
    if (spec[p] !== undefined) {
      throw new SetErrorSignal("invalidProperties", `${p} is server-set`, [p]);
    }
  }
  const name = spec.name;
  if (typeof name !== "string" || name.length === 0 || utf8Octets(name) > MAX_BOOK_NAME_OCTETS) {
    throw new SetErrorSignal("invalidProperties", "name must be a 1..255-octet string", ["name"]);
  }
  const description = spec.description ?? null;
  if (description !== null && typeof description !== "string") {
    throw new SetErrorSignal("invalidProperties", "description must be a string or null", ["description"]);
  }
  const sortOrder = spec.sortOrder ?? 0;
  if (typeof sortOrder !== "number" || !Number.isInteger(sortOrder) || sortOrder < 0) {
    throw new SetErrorSignal("invalidProperties", "sortOrder must be an unsigned int", ["sortOrder"]);
  }
  const now = Date.now();
  return {
    id: `ab_${crypto.randomUUID()}`,
    name,
    description,
    sortOrder,
    isDefault: becomeDefault,
    isSubscribed: spec.isSubscribed !== false,
    ctag: 0,
    createdAt: now,
    updatedAt: now,
  };
}

/** ShareWith mutations extracted from an AddressBook/set patch. */
interface ShareOps {
  /** Full replace via the "shareWith" path (null = unshare everyone). */
  replace?: Record<string, BookRights> | null;
  /** "shareWith/<acct>" entries: rights object or null (remove). */
  entries: Array<{ acct: string; rights: BookRights | null }>;
  /** "shareWith/<acct>/<right>" boolean flips. */
  bits: Array<{ acct: string; right: keyof BookRights; value: boolean }>;
}

function validateBookPatch(patch: Record<string, unknown>): {
  columns: { name?: string; description?: string | null; sortOrder?: number; isSubscribed?: boolean };
  share: ShareOps | null;
} {
  const columns: {
    name?: string;
    description?: string | null;
    sortOrder?: number;
    isSubscribed?: boolean;
  } = {};
  const share: ShareOps = { entries: [], bits: [] };
  let touchedShare = false;

  for (const [path, value] of Object.entries(patch)) {
    if (path === "shareWith" || path.startsWith("shareWith/")) {
      touchedShare = true;
      const tokens = path.split("/");
      if (tokens.length === 1) {
        share.replace = value === null ? null : validateShareWithObject(value);
      } else if (tokens.length === 2) {
        share.entries.push({
          acct: tokens[1]!,
          rights: value === null ? null : validateRights(value),
        });
      } else if (tokens.length === 3 && typeof value === "boolean") {
        const right = tokens[2] as keyof BookRights;
        if (!["mayRead", "mayWrite", "mayShare", "mayDelete"].includes(right)) {
          throw new SetErrorSignal("invalidProperties", `unknown right "${tokens[2]}"`, [path]);
        }
        share.bits.push({ acct: tokens[1]!, right, value });
      } else {
        throw new SetErrorSignal("invalidProperties", `unsupported patch path "${path}"`, [path]);
      }
      continue;
    }
    switch (path) {
      case "name":
        if (typeof value !== "string" || value.length === 0 || utf8Octets(value) > MAX_BOOK_NAME_OCTETS) {
          throw new SetErrorSignal("invalidProperties", "name must be a 1..255-octet string", ["name"]);
        }
        columns.name = value;
        break;
      case "description":
        if (value !== null && typeof value !== "string") {
          throw new SetErrorSignal("invalidProperties", "description must be a string or null", ["description"]);
        }
        columns.description = value as string | null;
        break;
      case "sortOrder":
        if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
          throw new SetErrorSignal("invalidProperties", "sortOrder must be an unsigned int", ["sortOrder"]);
        }
        columns.sortOrder = value;
        break;
      case "isSubscribed":
        if (typeof value !== "boolean") {
          throw new SetErrorSignal("invalidProperties", "isSubscribed must be a boolean", ["isSubscribed"]);
        }
        columns.isSubscribed = value;
        break;
      default:
        throw new SetErrorSignal("invalidProperties", `unsupported patch path "${path}"`, [path]);
    }
  }
  return { columns, share: touchedShare ? share : null };
}

// ---- shareWith ⇄ grants facade --------------------------------------------

function validateRights(raw: unknown): BookRights {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SetErrorSignal("invalidProperties", "rights must be an AddressBookRights object", [
      "shareWith",
    ]);
  }
  const r = raw as Record<string, unknown>;
  const rights: BookRights = {
    mayRead: r.mayRead !== false,
    mayWrite: r.mayWrite === true,
    mayShare: r.mayShare === true,
    mayDelete: r.mayDelete === true,
  };
  if (rights.mayShare || rights.mayDelete) {
    throw new SetErrorSignal(
      "forbidden",
      "mayShare/mayDelete are owner-only on this server",
      ["shareWith"],
    );
  }
  return rights;
}

function validateShareWithObject(raw: unknown): Record<string, BookRights> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SetErrorSignal("invalidProperties", "shareWith must be an Id[AddressBookRights] map", [
      "shareWith",
    ]);
  }
  const out: Record<string, BookRights> = {};
  for (const [acct, rights] of Object.entries(raw as Record<string, unknown>)) {
    out[acct] = validateRights(rights);
  }
  return out;
}

const scopesToRights = (scopes: string[]): BookRights => ({
  mayRead: true,
  mayWrite: hasScope(scopes, "contacts"),
  mayShare: false,
  mayDelete: false,
});

const rightsToScopes = (r: BookRights): string[] => [
  "read",
  ...(r.mayWrite ? ["contacts"] : []),
];

/** Owner view: bookId → {granteeAccountId: rights} for every shared book. */
async function loadShareWith(
  ctx: RequestContext,
  accountId: string,
): Promise<Map<string, Record<string, BookRights>>> {
  const { results } = await ctx.env.DB.prepare(
    `SELECT grantee_account_id, scopes, collection_id FROM grants
     WHERE target_account_id = ? AND collection = 'AddressBook'`,
  )
    .bind(accountId)
    .all<{ grantee_account_id: string; scopes: string; collection_id: string }>();
  const out = new Map<string, Record<string, BookRights>>();
  for (const r of results) {
    const book = out.get(r.collection_id) ?? {};
    book[r.grantee_account_id] = scopesToRights(JSON.parse(r.scopes) as string[]);
    out.set(r.collection_id, book);
  }
  return out;
}

async function replaceShareWith(
  ctx: RequestContext,
  access: AccountAccess,
  bookId: string,
  desired: Record<string, BookRights>,
): Promise<void> {
  await applyShareWithPatch(ctx, access, bookId, { replace: desired, entries: [], bits: [] });
}

/** Materialize a shareWith mutation as grant upserts/deletes. */
async function applyShareWithPatch(
  ctx: RequestContext,
  access: AccountAccess,
  bookId: string,
  ops: ShareOps,
): Promise<void> {
  const { results } = await ctx.env.DB.prepare(
    `SELECT id, grantee_account_id, scopes FROM grants
     WHERE target_account_id = ? AND collection = 'AddressBook' AND collection_id = ?`,
  )
    .bind(access.accountId, bookId)
    .all<{ id: string; grantee_account_id: string; scopes: string }>();
  const current = new Map(results.map((r) => [r.grantee_account_id, r]));

  // Desired end state, starting from what exists.
  const desired = new Map<string, BookRights>();
  if (ops.replace === undefined) {
    for (const [acct, row] of current) {
      desired.set(acct, scopesToRights(JSON.parse(row.scopes) as string[]));
    }
  } else if (ops.replace !== null) {
    for (const [acct, rights] of Object.entries(ops.replace)) desired.set(acct, rights);
  }
  for (const e of ops.entries) {
    if (e.rights === null) desired.delete(e.acct);
    else desired.set(e.acct, e.rights);
  }
  for (const b of ops.bits) {
    const existing = desired.get(b.acct);
    if (!existing) {
      throw new SetErrorSignal("invalidProperties", `no shareWith entry for ${b.acct}`, [
        "shareWith",
      ]);
    }
    existing[b.right] = b.value;
    if (existing.mayShare || existing.mayDelete) {
      throw new SetErrorSignal("forbidden", "mayShare/mayDelete are owner-only on this server", [
        "shareWith",
      ]);
    }
    if (!existing.mayRead) desired.delete(b.acct); // no read = no access
  }

  // Validate grantees: real accounts, same tenant, not the owner itself.
  const grantees = [...desired.keys()];
  if (grantees.length > 0) {
    const marks = grantees.map(() => "?").join(",");
    const { results: acctRows } = await ctx.env.DB.prepare(
      `SELECT id, tenant_id FROM accounts WHERE id IN (${marks})`,
    )
      .bind(...grantees)
      .all<{ id: string; tenant_id: string }>();
    const known = new Map(acctRows.map((a) => [a.id, a.tenant_id]));
    for (const acct of grantees) {
      if (acct === access.accountId) {
        throw new SetErrorSignal("invalidProperties", "cannot share a book with its owner", [
          "shareWith",
        ]);
      }
      if (known.get(acct) !== access.tenantId) {
        throw new SetErrorSignal("invalidProperties", `unknown account: ${acct}`, ["shareWith"]);
      }
    }
  }

  // Diff → grant rows.
  const now = Date.now();
  for (const [acct, row] of current) {
    if (!desired.has(acct)) {
      await ctx.env.DB.prepare(`DELETE FROM grants WHERE id = ?`).bind(row.id).run();
    }
  }
  for (const [acct, rights] of desired) {
    const scopes = JSON.stringify(rightsToScopes(rights));
    const existing = current.get(acct);
    if (existing) {
      if (existing.scopes !== scopes) {
        await ctx.env.DB.prepare(`UPDATE grants SET scopes = ? WHERE id = ?`)
          .bind(scopes, existing.id)
          .run();
      }
    } else {
      await ctx.env.DB.prepare(
        `INSERT INTO grants (id, tenant_id, grantee_account_id, target_account_id, scopes,
           collection, collection_id, created_by, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, 'AddressBook', ?, ?, ?, NULL)`,
      )
        .bind(
          `g_${crypto.randomUUID()}`,
          access.tenantId,
          acct,
          access.accountId,
          scopes,
          bookId,
          ctx.principal.username,
          now,
        )
        .run();
    }
  }
}

/**
 * v1 constraint: exactly one address book per card (maxAddressBooksPerCard
 * is advertised as 1). Returns the single book id after validating it.
 */
function singleBookId(raw: unknown, books: Map<string, AddressBookRow>): string {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SetErrorSignal("invalidProperties", "addressBookIds must be an Id[Boolean] object", [
      "addressBookIds",
    ]);
  }
  const ids = Object.entries(raw as Record<string, unknown>)
    .filter(([, v]) => v === true)
    .map(([k]) => k);
  if (ids.length !== 1) {
    throw new SetErrorSignal(
      "invalidProperties",
      "this server supports exactly one address book per card (maxAddressBooksPerCard: 1)",
      ["addressBookIds"],
    );
  }
  const id = ids[0]!;
  if (!books.has(id)) {
    throw new SetErrorSignal("invalidProperties", `no such address book: ${id}`, ["addressBookIds"]);
  }
  return id;
}

/**
 * Resolve the default book, creating/promoting on first touch; commits
 * the resulting change so /changes clients see it.
 */
async function ensureDefaultBook(
  ctx: RequestContext,
  store: Mailstore,
  accountId: string,
): Promise<string> {
  const { id, change } = await store.ensureDefaultAddressBook(accountId);
  if (change) {
    await commitChanges(ctx.env.ACCOUNT_DO, accountId, [
      { collection: "AddressBook", [change]: [id] },
    ]);
  }
  return id;
}

async function commitContactEntries(
  ctx: RequestContext,
  accountId: string,
  entries: ChangeEntry[],
): Promise<string> {
  const nonEmpty = entries.filter(
    (e) => e.created.length + e.updated.length + e.destroyed.length > 0,
  );
  if (nonEmpty.length === 0) return accountState(ctx, accountId);
  const { newState } = await commitChanges(ctx.env.ACCOUNT_DO, accountId, nonEmpty);
  return newState;
}

/**
 * Apply an RFC 8620 §5.3 PatchObject to the wire-shape card. Paths are
 * JSON pointers without the leading "/"; null removes the key.
 */
function applyCardPatch(
  obj: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out = structuredClone(obj);
  for (const [path, value] of Object.entries(patch)) {
    const tokens = path
      .split("/")
      .map((t) => t.replaceAll("~1", "/").replaceAll("~0", "~"));
    if (tokens.length === 0 || tokens.some((t) => t.length === 0)) {
      throw new SetErrorSignal("invalidProperties", `bad patch path "${path}"`, [path]);
    }
    let parent: Record<string, unknown> = out;
    for (const t of tokens.slice(0, -1)) {
      const next = parent[t];
      if (next === null || typeof next !== "object" || Array.isArray(next)) {
        throw new SetErrorSignal(
          "invalidProperties",
          `patch path "${path}" does not exist`,
          [path],
        );
      }
      parent = next as Record<string, unknown>;
    }
    const leaf = tokens[tokens.length - 1]!;
    if (value === null) delete parent[leaf];
    else parent[leaf] = value;
  }
  return out;
}

/** Display/sort name: name.full, joined components, org, or first email. */
function deriveNameFull(card: JSContactCard): string | null {
  if (typeof card.name?.full === "string" && card.name.full.length > 0) return card.name.full;
  const components = card.name?.components;
  if (Array.isArray(components)) {
    const joined = components
      .filter((c) => c?.kind !== "separator" && typeof c?.value === "string")
      .map((c) => c.value)
      .join(" ")
      .trim();
    if (joined) return joined;
  }
  const orgs = card.organizations as Record<string, { name?: unknown }> | undefined;
  if (orgs && typeof orgs === "object") {
    for (const org of Object.values(orgs)) {
      if (typeof org?.name === "string" && org.name) return org.name;
    }
  }
  const emails = card.emails as Record<string, { address?: unknown }> | undefined;
  if (emails && typeof emails === "object") {
    for (const e of Object.values(emails)) {
      if (typeof e?.address === "string" && e.address) return e.address;
    }
  }
  return null;
}

const FILTER_CONDITION_KEYS = new Set<keyof ContactFilterCondition>([
  "inAddressBook",
  "uid",
  "kind",
  "hasMember",
  "createdBefore",
  "createdAfter",
  "updatedBefore",
  "updatedAfter",
  "text",
  "name",
  "nickname",
  "organization",
  "email",
  "phone",
  "note",
]);

/** RFC 8620 §5.5: reject any filter the server does not understand. */
function validateContactFilter(filter: ContactFilter): void {
  if ("operator" in filter) {
    if (!["AND", "OR", "NOT"].includes(filter.operator)) {
      throw new MethodError("unsupportedFilter", `operator ${String(filter.operator)}`);
    }
    if (!Array.isArray(filter.conditions)) {
      throw new MethodError("unsupportedFilter", "operator without conditions");
    }
    for (const c of filter.conditions) validateContactFilter(c);
    return;
  }
  for (const key of Object.keys(filter)) {
    if (!FILTER_CONDITION_KEYS.has(key as keyof ContactFilterCondition)) {
      throw new MethodError("unsupportedFilter", `unknown filter property "${key}"`);
    }
  }
}

function validateContactSort(raw: unknown): ContactSort[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new MethodError("unsupportedSort", "sort must be an array");
  return raw.map((s) => {
    const property = (s as { property?: unknown }).property;
    // "created"/"updated" are the RFC 9610 MUSTs; "name" is a vendor
    // convenience over the extracted full-name column.
    if (property !== "created" && property !== "updated" && property !== "name") {
      throw new MethodError("unsupportedSort", `unsupported sort property "${String(property)}"`);
    }
    return { property, isAscending: (s as { isAscending?: unknown }).isAscending !== false };
  });
}

function utf8Octets(s: string): number {
  return new TextEncoder().encode(s).length;
}
