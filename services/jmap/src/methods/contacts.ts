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

/** Owner rights; shareWith lands with the Phase 3 grant model. */
const OWNER_RIGHTS = {
  mayRead: true,
  mayWrite: true,
  mayShare: true,
  mayDelete: true,
} as const;

const BOOK_SERVER_SET = ["id", "isDefault", "myRights"] as const;
const MAX_BOOK_NAME_OCTETS = 255;

export function registerContactsMethods(registry: MethodRegistry<RequestContext>): void {
  // ---- AddressBook ---------------------------------------------------

  registry.register("AddressBook/get", async (args, ctx) => {
    const access = requireAccount(ctx, args, "read");
    const store = storeFor(ctx);
    await ensureDefaultBook(ctx, store, access.accountId);

    const ids = args.ids === null || args.ids === undefined ? undefined : (args.ids as string[]);
    const rows = await store.getAddressBooks(access.accountId, ids);
    const found = new Set(rows.map((r) => r.id));

    return {
      accountId: access.accountId,
      state: await accountState(ctx, access.accountId),
      list: rows.map(bookToJmap),
      notFound: (ids ?? []).filter((id) => !found.has(id)),
    };
  });

  registry.register("AddressBook/changes", async (args, ctx) => proxyChanges(ctx, args, "AddressBook"));

  registry.register("AddressBook/set", async (args, ctx) => {
    const access = requireAccount(ctx, args, "contacts");
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
        const row = validateNewBook(spec, !hasDefault);
        await store.insertAddressBook(access.accountId, row);
        byId.set(row.id, row);
        if (row.isDefault) hasDefault = true;
        bookEntry.created.push(row.id);
        created[cid] = { id: row.id, isDefault: row.isDefault, myRights: OWNER_RIGHTS, shareWith: null };
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
        await store.updateAddressBook(access.accountId, id, validateBookPatch(patch));
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
    const access = requireAccount(ctx, args, "read");
    const store = storeFor(ctx);

    const ids = args.ids === null || args.ids === undefined ? undefined : (args.ids as string[]);
    const properties = Array.isArray(args.properties) ? (args.properties as string[]) : null;

    // Skinny fast path: id/uid/addressBookIds come from columns — no
    // card_json parse. Sync-shaped scans over thousands of photo-bearing
    // cards must not pay the blob cost (free-tier CPU budget).
    let list: Record<string, unknown>[];
    let found: Set<string>;
    if (properties && properties.every((p) => p === "id" || p === "uid" || p === "addressBookIds")) {
      const refs = await store.getContactCardRefs(access.accountId, ids);
      found = new Set(refs.map((r) => r.id));
      list = refs.map((r) => {
        const picked: Record<string, unknown> = { id: r.id };
        if (properties.includes("uid")) picked.uid = r.uid;
        if (properties.includes("addressBookIds")) picked.addressBookIds = { [r.addressBookId]: true };
        return picked;
      });
    } else {
      const rows = await store.getContactCards(access.accountId, ids);
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

  registry.register("ContactCard/changes", async (args, ctx) => proxyChanges(ctx, args, "ContactCard"));

  registry.register("ContactCard/set", async (args, ctx) => {
    const access = requireAccount(ctx, args, "contacts");
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

    const cardEntry: ChangeEntry = { collection: "ContactCard", created: [], updated: [], destroyed: [] };
    const ctagBooks = new Set<string>();

    const books = new Map(
      (await store.getAddressBooks(access.accountId)).map((b) => [b.id, b]),
    );

    // -- create --
    const createSpecs = (args.create as Record<string, Record<string, unknown>> | undefined) ?? {};
    for (const [cid, spec] of Object.entries(createSpecs)) {
      try {
        const { id, ...rest } = spec;
        if (id !== undefined) {
          throw new SetErrorSignal("invalidProperties", "id is server-set", ["id"]);
        }
        let bookId: string;
        if (rest.addressBookIds === undefined) {
          bookId = await ensureDefaultBook(ctx, store, access.accountId);
        } else {
          bookId = singleBookId(rest.addressBookIds, books);
        }
        delete rest.addressBookIds;

        const card = rest as JSContactCard;
        card["@type"] = "Card";
        if (card.version === undefined) card.version = "1.0";
        if (card.uid === undefined) card.uid = `urn:uuid:${crypto.randomUUID()}`;
        if (typeof card.uid !== "string" || card.uid.length === 0) {
          throw new SetErrorSignal("invalidProperties", "uid must be a non-empty string", ["uid"]);
        }
        if (await store.contactCardIdByUid(access.accountId, card.uid)) {
          throw new SetErrorSignal("invalidProperties", `uid already in use: ${card.uid}`, ["uid"]);
        }

        const now = Date.now();
        const nowIso = new Date(now).toISOString();
        if (typeof card.created !== "string" || Number.isNaN(Date.parse(card.created))) {
          card.created = nowIso;
        }
        card.updated = nowIso;
        card.addressBookIds = { [bookId]: true };

        const row: ContactCardRow = {
          id: `cc_${crypto.randomUUID()}`,
          addressBookId: bookId,
          uid: card.uid,
          card,
          nameFull: deriveNameFull(card),
          createdAt: Date.parse(card.created),
          updatedAt: now,
        };
        await store.insertContactCard(access.accountId, row);
        ctagBooks.add(bookId);
        cardEntry.created.push(row.id);
        created[cid] = { id: row.id, uid: card.uid, created: card.created, updated: card.updated };
      } catch (err) {
        notCreated[cid] = toSetError(err);
      }
    }

    // -- update --
    const updateSpecs = (args.update as Record<string, Record<string, unknown>> | undefined) ?? {};
    for (const [id, patch] of Object.entries(updateSpecs)) {
      try {
        const [row] = await store.getContactCards(access.accountId, [id]);
        if (!row) throw new NotFound();

        const patched = applyCardPatch(cardToJmap(row), patch);
        if (patched.id !== row.id) {
          throw new SetErrorSignal("invalidProperties", "id is immutable", ["id"]);
        }
        if (patched.uid !== row.uid) {
          throw new SetErrorSignal("invalidProperties", "uid is immutable", ["uid"]);
        }
        const bookId = singleBookId(patched.addressBookIds, books);

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
        if (!row) throw new NotFound();
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
    const access = requireAccount(ctx, args, "read");
    const store = storeFor(ctx);

    const filter = (args.filter as ContactFilter | null | undefined) ?? null;
    if (filter) validateContactFilter(filter);

    const sort = validateContactSort(args.sort);

    const result = await store.queryContactCards(access.accountId, {
      filter,
      sort,
      position: typeof args.position === "number" ? args.position : 0,
      limit: typeof args.limit === "number" ? args.limit : undefined,
      calculateTotal: args.calculateTotal === true,
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

function bookToJmap(r: AddressBookRow): Record<string, unknown> {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    sortOrder: r.sortOrder,
    isDefault: r.isDefault,
    isSubscribed: r.isSubscribed,
    shareWith: null,
    myRights: OWNER_RIGHTS,
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
  if (spec.shareWith !== undefined && spec.shareWith !== null) {
    throw new SetErrorSignal("invalidProperties", "sharing lands with the grant model", ["shareWith"]);
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

function validateBookPatch(patch: Record<string, unknown>): {
  name?: string;
  description?: string | null;
  sortOrder?: number;
  isSubscribed?: boolean;
} {
  const out: ReturnType<typeof validateBookPatch> = {};
  for (const [path, value] of Object.entries(patch)) {
    switch (path) {
      case "name":
        if (typeof value !== "string" || value.length === 0 || utf8Octets(value) > MAX_BOOK_NAME_OCTETS) {
          throw new SetErrorSignal("invalidProperties", "name must be a 1..255-octet string", ["name"]);
        }
        out.name = value;
        break;
      case "description":
        if (value !== null && typeof value !== "string") {
          throw new SetErrorSignal("invalidProperties", "description must be a string or null", ["description"]);
        }
        out.description = value as string | null;
        break;
      case "sortOrder":
        if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
          throw new SetErrorSignal("invalidProperties", "sortOrder must be an unsigned int", ["sortOrder"]);
        }
        out.sortOrder = value;
        break;
      case "isSubscribed":
        if (typeof value !== "boolean") {
          throw new SetErrorSignal("invalidProperties", "isSubscribed must be a boolean", ["isSubscribed"]);
        }
        out.isSubscribed = value;
        break;
      default:
        throw new SetErrorSignal("invalidProperties", `unsupported patch path "${path}"`, [path]);
    }
  }
  return out;
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
