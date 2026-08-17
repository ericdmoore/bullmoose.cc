import { MethodError, mailCapability, type MethodRegistry } from "@bullmoose/jmap-core";
import { commitChanges, type ChangeEntry } from "@bullmoose/account-do";
import type { Mailstore, MailboxRow } from "@bullmoose/mailstore";
import {
  accountState,
  proxyChanges,
  requireAccount,
  requireAccountScopes,
  setError,
  storeFor,
  type RequestContext,
  type SetError,
} from "./common";

/**
 * Roles this server understands. `role` is what ingest and submission key
 * on (ingest files inbound mail into "inbox", EmailSubmission treats
 * "drafts" as submittable), so an arbitrary string would be a label
 * pretending to be a contract. These six are exactly what provisioning
 * seeds; the unique index in data-plane.sql keeps them one-per-account.
 */
const KNOWN_ROLES = new Set(["inbox", "sent", "drafts", "trash", "junk", "archive"]);

/**
 * Properties the server owns; a client that sends them gets told so rather
 * than having them silently dropped. `role` is deliberately NOT here: it is
 * settable on CREATE (a client rebuilding a folder set may legitimately ask
 * for "archive") and immutable on UPDATE, because re-roling an existing
 * mailbox is how you would launder a custom folder into the Inbox.
 */
const MAILBOX_SERVER_SET = ["id", "totalEmails", "unreadEmails", "totalThreads", "unreadThreads", "myRights"] as const;

export function registerMailboxMethods(registry: MethodRegistry<RequestContext>): void {
  registry.register("Mailbox/get", async (args, ctx) => {
    const access = await requireAccount(ctx, args, "read");
    const store = storeFor(ctx);

    const ids = args.ids === null || args.ids === undefined ? undefined : (args.ids as string[]);
    const rows = await store.getMailboxes(access.accountId, ids);
    const found = new Set(rows.map((r) => r.id));

    const list = await Promise.all(
      rows.map(async (r) => {
        const counts = await store.mailboxCounts(access.accountId, r.id);
        return {
          id: r.id,
          name: r.name,
          parentId: r.parentId,
          role: r.role,
          sortOrder: r.sortOrder,
          totalEmails: counts.totalEmails,
          unreadEmails: counts.unreadEmails,
          // Real COUNT(DISTINCT thread_id), not a copy of the message count.
          // RFC 8621 §2 lists all four as required server-set properties, so
          // omitting the pair rather than fixing it would trade one spec
          // deviation for another; mailboxCounts documents what each means.
          totalThreads: counts.totalThreads,
          unreadThreads: counts.unreadThreads,
          // Single-sourced with Mailbox/set, which now enforces these:
          // mayDelete: role === null is the role-mailbox protection.
          myRights: rightsFor(r),
          isSubscribed: true,
        };
      }),
    );

    return {
      accountId: access.accountId,
      state: await accountState(ctx, access.accountId),
      list,
      notFound: (ids ?? []).filter((id) => !found.has(id)),
    };
  });

  registry.register("Mailbox/set", mailboxSet);

  registry.register("Mailbox/changes", async (args, ctx) => proxyChanges(ctx, args, "Mailbox"));

  // himalaya enumerates folders via query, not get (§15 punch list).
  registry.register("Mailbox/query", async (args, ctx) => {
    const access = await requireAccount(ctx, args, "read");
    const store = storeFor(ctx);
    const rows = await store.getMailboxes(access.accountId);

    const filtered = applyMailboxFilter(rows, args.filter);

    const sortSpecs = (args.sort as Array<{ property?: string; isAscending?: boolean }> | undefined) ?? [
      { property: "sortOrder", isAscending: true },
    ];
    filtered.sort((a, b) => {
      for (const s of sortSpecs) {
        const dir = s.isAscending === false ? -1 : 1;
        const cmp =
          s.property === "name"
            ? a.name.localeCompare(b.name)
            : a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);
        if (cmp !== 0) return cmp * dir;
      }
      return 0;
    });

    const position = Math.max(0, typeof args.position === "number" ? args.position : 0);
    const limit = typeof args.limit === "number" ? Math.min(Math.max(1, args.limit), 256) : filtered.length;
    const ids = filtered.slice(position, position + limit).map((r) => r.id);

    return {
      accountId: access.accountId,
      queryState: await accountState(ctx, access.accountId),
      canCalculateChanges: false,
      position,
      ids,
      ...(args.calculateTotal === true ? { total: filtered.length } : {}),
    };
  });

  // We advertise canCalculateChanges: false, so a conformant client falls
  // back to re-running the query; answer the method anyway per spec.
  registry.register("Mailbox/queryChanges", async () => {
    throw new MethodError("cannotCalculateChanges");
  });
}

// ---- Mailbox/set -----------------------------------------------------

/**
 * Which scopes a `Mailbox/set` call needs, derived from its own arguments.
 *
 * Pure — no ctx, no D1 — so the mapping is testable without a harness, the
 * same shape as `requiredScopesForEmailSet` (email.ts).
 *
 * `hasScope` treats the mail verbs as a flat set (read, annotate, draft, move,
 * send, delete — independent; the only implication is that any write implies
 * read, common/027), so the choice of verb per operation IS the gate. Folder
 * management is mail ORGANISATION, which is
 * what `move` names — charging `draft` (compose) would let a token scoped to
 * write drafts restructure the whole tree, and charging `annotate` (flag)
 * would be worse. Destroy takes `delete` because with
 * `onDestroyRemoveEmails: true` it permanently destroys mail: exactly the
 * escalation `requiredScopesForEmailSet` exists to prevent, and it would be
 * reopened here if a destroy cost less than `Email/set`'s destroy.
 */
export function requiredScopesForMailboxSet(args: Record<string, unknown>): string[] {
  const need = new Set<string>();
  const create = args.create as Record<string, unknown> | undefined;
  const update = args.update as Record<string, unknown> | undefined;
  const destroy = args.destroy as string[] | undefined;

  if (create && Object.keys(create).length > 0) need.add("move");
  if (update && Object.keys(update).length > 0) need.add("move");
  if (destroy && destroy.length > 0) need.add("delete");
  return [...need];
}

/**
 * RFC 8621 §2.5 Mailbox/set.
 *
 * The read path has advertised this policy since day one and could not
 * enforce it: `mailCapability` promises maxMailboxDepth/maxSizeMailboxName/
 * mayCreateTopLevelMailbox and `Mailbox/get` returns mayCreateChild,
 * mayRename and mayDelete: role === null. Every limit below is read off
 * those same constants rather than re-invented, so the session object and
 * the write path cannot drift apart.
 *
 * The tree is loaded once and mutated IN MEMORY alongside the D1 writes, so
 * every check (sibling-name uniqueness, depth, cycles, "has children") runs
 * against the POST-mutation tree. One /set may legally create a parent and
 * its child, rename a folder into a name a sibling just vacated, or reparent
 * a subtree — checking against the table as it was when the method started
 * would get all three wrong.
 */
async function mailboxSet(args: Record<string, unknown>, ctx: RequestContext): Promise<Record<string, unknown>> {
  const access = await requireAccountScopes(ctx, args, requiredScopesForMailboxSet(args));
  if (access.granted) {
    // Same call as AddressBook/set and Calendar/set: a sharee may act on
    // the CONTENTS it was granted, never on the container layout.
    throw new MethodError("forbidden", "only the account owner manages mailboxes");
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

  const mbEntry: ChangeEntry = { collection: "Mailbox", created: [], updated: [], destroyed: [] };
  const emailEntry: ChangeEntry = { collection: "Email", created: [], updated: [], destroyed: [] };
  /** Mailboxes whose counts moved because their contents did. */
  const countsTouched = new Set<string>();

  const tree = new Map((await store.getMailboxes(access.accountId)).map((r) => [r.id, r]));
  /** creationId → new mailbox id, for `parentId: "#c1"` within one call. */
  const byCreationId = new Map<string, string>();

  // -- create --
  const createSpecs = (args.create as Record<string, Record<string, unknown>> | undefined) ?? {};
  for (const [cid, spec] of Object.entries(createSpecs)) {
    try {
      const row = validateNewMailbox(spec, tree, byCreationId);
      await store.insertMailbox(access.accountId, row);
      tree.set(row.id, row);
      byCreationId.set(cid, row.id);
      mbEntry.created.push(row.id);
      // RFC 8620 §5.3: echo every property the server set. A new mailbox is
      // empty, so the counts are known without querying for them.
      created[cid] = {
        id: row.id,
        role: row.role,
        totalEmails: 0,
        unreadEmails: 0,
        totalThreads: 0,
        unreadThreads: 0,
        myRights: rightsFor(row),
        isSubscribed: true,
      };
    } catch (err) {
      notCreated[cid] = toSetError(err);
    }
  }

  // -- update (rename / reparent / reorder; RFC 8621 treats all three as
  //    plain patchable properties, so one patch may do all of them) --
  const updateSpecs = (args.update as Record<string, Record<string, unknown>> | undefined) ?? {};
  for (const [id, patch] of Object.entries(updateSpecs)) {
    try {
      const row = tree.get(id);
      if (!row) throw new NotFound();
      const columns = validateMailboxPatch(patch, row, tree, byCreationId);
      if (Object.keys(columns).length > 0) {
        await store.updateMailbox(access.accountId, id, columns);
        tree.set(id, { ...row, ...columns });
      }
      mbEntry.updated.push(id);
      updated[id] = null;
    } catch (err) {
      notUpdated[id] = toSetError(err);
    }
  }

  // -- destroy --
  const onDestroyRemoveEmails = args.onDestroyRemoveEmails === true;
  for (const id of (args.destroy as string[] | undefined) ?? []) {
    try {
      const row = tree.get(id);
      if (!row) throw new NotFound();
      if (row.role !== null) {
        // Mailbox/get has always told clients mayDelete: role === null.
        // Enforcing it here is what makes that claim true — and it is what
        // keeps ingest's ensureRoleMailbox from silently re-creating the
        // Inbox under a NEW id on the next delivery, orphaning every client
        // that cached the old one.
        throw new SetErrorSignal("forbidden", `mailbox has the "${row.role}" role and cannot be destroyed`);
      }
      if ([...tree.values()].some((m) => m.parentId === id)) {
        throw new SetErrorSignal("mailboxHasChild");
      }

      const emailIds = await store.emailIdsInMailbox(access.accountId, id);
      if (emailIds.length > 0 && !onDestroyRemoveEmails) {
        throw new SetErrorSignal("mailboxHasEmail");
      }
      await removeEmailsFromMailbox(store, access.accountId, id, emailIds, emailEntry, countsTouched);

      await store.deleteMailbox(access.accountId, id);
      tree.delete(id);
      countsTouched.delete(id);
      mbEntry.destroyed.push(id);
      destroyed.push(id);
    } catch (err) {
      notDestroyed[id] = toSetError(err);
    }
  }

  for (const mb of countsTouched) {
    if (!mbEntry.created.includes(mb) && !mbEntry.updated.includes(mb)) mbEntry.updated.push(mb);
  }

  const newState = await commitMailboxEntries(ctx, access.accountId, [mbEntry, emailEntry]);
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
}

/**
 * RFC 8621 §2.5 onDestroyRemoveEmails: emails are removed FROM the mailbox,
 * and destroyed only if that leaves them in no mailbox at all.
 *
 * Not "destroy everything inside": `maxMailboxesPerEmail` is null, so a
 * message may be filed in several folders and deleting one of them must not
 * take the message with it. The zero-mailbox case must destroy rather than
 * unlink, because applyEmailPatch (email.ts) declares an email in no mailbox
 * invalid — a bare `DELETE FROM email_mailboxes` would leave `emails` rows
 * that no query reaches and no client can delete.
 */
async function removeEmailsFromMailbox(
  store: Mailstore,
  accountId: string,
  mailboxId: string,
  emailIds: string[],
  emailEntry: ChangeEntry,
  countsTouched: Set<string>,
): Promise<void> {
  if (emailIds.length === 0) return;
  const rows = await store.getEmailRows(accountId, emailIds);
  for (const emailId of emailIds) {
    const row = rows.get(emailId);
    const remaining = (row?.mailboxIds ?? []).filter((m) => m !== mailboxId);
    if (remaining.length === 0) {
      await store.destroyEmail(accountId, emailId);
      emailEntry.destroyed.push(emailId);
    } else {
      await store.replaceEmailSets(accountId, emailId, { mailboxIds: remaining });
      emailEntry.updated.push(emailId);
      for (const mb of remaining) countsTouched.add(mb);
    }
  }
}

/**
 * The step that fails silently if skipped (_context.md §3). Mailboxes carry
 * no ctag — mail has no DAV surface — so there is no bumpCtags leg here, but
 * the changelog commit is not optional: without it the row lands in D1,
 * reads back fine on Mailbox/get, and is invisible to Mailbox/changes, so
 * the CLI mirror and every incremental client keep showing the old list.
 * That presents as a sync bug and is a write-path bug.
 *
 * Skips the DO round-trip when every entry is empty, like
 * commitCalendarEntries — a no-op /set should not burn a state bump.
 */
async function commitMailboxEntries(ctx: RequestContext, accountId: string, entries: ChangeEntry[]): Promise<string> {
  const nonEmpty = entries.filter((e) => e.created.length + e.updated.length + e.destroyed.length > 0);
  if (nonEmpty.length === 0) return accountState(ctx, accountId);
  const { newState } = await commitChanges(ctx.env.ACCOUNT_DO, accountId, nonEmpty);
  return newState;
}

// ---- validation ------------------------------------------------------

class NotFound extends Error {}

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
  // mailboxes_role is a UNIQUE index, so a role that collides between the
  // in-memory pre-check and the INSERT arrives as a raw D1 exception. It is
  // a bad property, not a server fault — say so on the offending object.
  if (/UNIQUE constraint/i.test(String(err))) {
    return { type: "invalidProperties", description: String(err), properties: ["role"] };
  }
  if (err instanceof MethodError) return setError("invalidProperties", err.description ?? err.type);
  return setError("serverFail", String(err));
}

const utf8Octets = (s: string): number => new TextEncoder().encode(s).length;

/** Depth of a mailbox in the tree; a top-level mailbox is depth 1. */
function depthOf(tree: Map<string, MailboxRow>, id: string | null): number {
  let depth = 0;
  let cursor = id;
  // Bounded by the advertised limit + slack: a pre-existing cycle (which
  // this method now prevents, but older rows predate it) must not hang.
  for (let i = 0; cursor !== null && i <= mailCapability.maxMailboxDepth + 1; i++) {
    const row = tree.get(cursor);
    if (!row) break;
    depth++;
    cursor = row.parentId;
  }
  return depth;
}

/**
 * Height of the subtree rooted at `id`; a leaf is 1. `seen` guards against
 * a cycle in pre-existing rows — this method refuses to create one, but it
 * is not the only thing that has ever written parent_id, and an unbounded
 * recursion here would hang the request rather than fail it.
 */
function subtreeHeight(tree: Map<string, MailboxRow>, id: string, seen = new Set<string>()): number {
  if (seen.has(id)) return 1;
  seen.add(id);
  const children = [...tree.values()].filter((m) => m.parentId === id);
  if (children.length === 0) return 1;
  return 1 + Math.max(...children.map((c) => subtreeHeight(tree, c.id, seen)));
}

/** Resolve a client-supplied parentId, including a `#creationId` back-ref. */
function resolveParentId(
  raw: unknown,
  tree: Map<string, MailboxRow>,
  byCreationId: Map<string, string>,
): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") {
    throw new SetErrorSignal("invalidProperties", "parentId must be an Id or null", ["parentId"]);
  }
  const id = raw.startsWith("#") ? byCreationId.get(raw.slice(1)) : raw;
  if (id === undefined || !tree.has(id)) {
    throw new SetErrorSignal("invalidProperties", `no such mailbox: ${raw}`, ["parentId"]);
  }
  return id;
}

function validateName(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new SetErrorSignal("invalidProperties", "name must be a non-empty string", ["name"]);
  }
  // The session advertises maxSizeMailboxName in OCTETS (RFC 8620 §1.3),
  // so measure octets, not UTF-16 code units.
  if (utf8Octets(raw) > mailCapability.maxSizeMailboxName) {
    throw new SetErrorSignal("invalidProperties", `name must be at most ${mailCapability.maxSizeMailboxName} octets`, [
      "name",
    ]);
  }
  return raw;
}

/**
 * RFC 8621 §2.5: a mailbox name must be unique among its siblings. Nothing
 * in the schema enforces it. Compared case-insensitively: two siblings that
 * differ only in case render identically in every folder tree a human looks
 * at, so allowing both would be a trap, not a feature.
 */
function checkSiblingName(
  tree: Map<string, MailboxRow>,
  parentId: string | null,
  name: string,
  selfId: string | null,
): void {
  const clash = [...tree.values()].some(
    (m) => m.id !== selfId && m.parentId === parentId && m.name.toLowerCase() === name.toLowerCase(),
  );
  if (clash) {
    throw new SetErrorSignal("invalidProperties", `a mailbox named "${name}" already exists here`, ["name"]);
  }
}

function checkDepth(tree: Map<string, MailboxRow>, parentId: string | null, height: number): void {
  const depth = depthOf(tree, parentId) + height;
  if (depth > mailCapability.maxMailboxDepth) {
    throw new SetErrorSignal(
      "invalidProperties",
      `mailbox depth ${depth} exceeds maxMailboxDepth ${mailCapability.maxMailboxDepth}`,
      ["parentId"],
    );
  }
}

function validateSortOrder(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    throw new SetErrorSignal("invalidProperties", "sortOrder must be an unsigned int", ["sortOrder"]);
  }
  return raw;
}

/** isSubscribed has no column and Mailbox/get hardcodes true. */
function validateIsSubscribed(raw: unknown): void {
  if (raw !== true) {
    throw new SetErrorSignal("invalidProperties", "this server does not support unsubscribing from a mailbox", [
      "isSubscribed",
    ]);
  }
}

function validateNewMailbox(
  spec: Record<string, unknown>,
  tree: Map<string, MailboxRow>,
  byCreationId: Map<string, string>,
): MailboxRow {
  for (const p of MAILBOX_SERVER_SET) {
    if (spec[p] !== undefined) {
      throw new SetErrorSignal("invalidProperties", `${p} is server-set`, [p]);
    }
  }
  if (spec.isSubscribed !== undefined) validateIsSubscribed(spec.isSubscribed);

  const name = validateName(spec.name);
  const parentId = resolveParentId(spec.parentId, tree, byCreationId);
  // mayCreateTopLevelMailbox is advertised true, so parentId: null is fine.
  checkDepth(tree, parentId, 1);
  checkSiblingName(tree, parentId, name, null);

  let role: string | null = null;
  if (spec.role !== undefined && spec.role !== null) {
    if (typeof spec.role !== "string" || !KNOWN_ROLES.has(spec.role)) {
      throw new SetErrorSignal(
        "invalidProperties",
        `unknown role "${String(spec.role)}" (known: ${[...KNOWN_ROLES].join(", ")})`,
        ["role"],
      );
    }
    if ([...tree.values()].some((m) => m.role === spec.role)) {
      throw new SetErrorSignal("invalidProperties", `a mailbox with the "${spec.role}" role already exists`, ["role"]);
    }
    role = spec.role;
  }

  return {
    id: `mb_${crypto.randomUUID()}`,
    parentId,
    name,
    role,
    sortOrder: spec.sortOrder === undefined ? 0 : validateSortOrder(spec.sortOrder),
  };
}

/**
 * RFC 8620 §5.3 PatchObject over a mailbox. Rename, reparent and reorder are
 * all plain property patches — there is no distinct "move" operation — so
 * this returns the column set and the caller applies it in one UPDATE.
 */
function validateMailboxPatch(
  patch: Record<string, unknown>,
  row: MailboxRow,
  tree: Map<string, MailboxRow>,
  byCreationId: Map<string, string>,
): { name?: string; parentId?: string | null; sortOrder?: number } {
  const out: { name?: string; parentId?: string | null; sortOrder?: number } = {};
  for (const [path, value] of Object.entries(patch)) {
    switch (path) {
      case "name":
        out.name = validateName(value);
        break;
      case "parentId":
        out.parentId = resolveParentId(value, tree, byCreationId);
        break;
      case "sortOrder":
        out.sortOrder = validateSortOrder(value);
        break;
      case "isSubscribed":
        validateIsSubscribed(value);
        break;
      case "role":
        // Renaming a role mailbox is fine — "Bin" instead of "Trash" is a
        // label change. Re-roling is not: role is the contract ingest and
        // submission dispatch on.
        throw new SetErrorSignal("invalidProperties", "role is immutable", ["role"]);
      default:
        throw new SetErrorSignal("invalidProperties", `unsupported patch path "${path}"`, [path]);
    }
  }

  const nextParent = out.parentId === undefined ? row.parentId : out.parentId;
  const nextName = out.name ?? row.name;

  if (out.parentId !== undefined && out.parentId !== row.parentId) {
    // A self-parent is one typo away, and getMailboxes would happily return
    // the row while every tree-building client spins. Walk to the root.
    const seen = new Set<string>();
    for (let cursor: string | null = out.parentId; cursor !== null;) {
      if (cursor === row.id) {
        throw new SetErrorSignal("invalidProperties", "parentId would create a cycle", ["parentId"]);
      }
      if (seen.has(cursor)) break; // pre-existing cycle; not this patch's doing
      seen.add(cursor);
      const parent: MailboxRow | undefined = tree.get(cursor);
      if (!parent) break;
      cursor = parent.parentId;
    }
    // The moved node brings its descendants: the limit applies to the
    // DEEPEST of them, not to the node being moved.
    checkDepth(tree, out.parentId, subtreeHeight(tree, row.id));
  }
  if (nextParent !== row.parentId || nextName.toLowerCase() !== row.name.toLowerCase()) {
    checkSiblingName(tree, nextParent, nextName, row.id);
  }
  return out;
}

function rightsFor(row: MailboxRow): Record<string, boolean> {
  return {
    mayReadItems: true,
    mayAddItems: true,
    mayRemoveItems: true,
    maySetSeen: true,
    maySetKeywords: true,
    mayCreateChild: true,
    mayRename: true,
    mayDelete: row.role === null,
    maySubmit: true,
  };
}

function applyMailboxFilter(rows: MailboxRow[], filter: unknown): MailboxRow[] {
  if (filter === null || filter === undefined) return [...rows];

  // FilterOperator: support AND by merging; OR/NOT are not needed for
  // folder listing and are rejected explicitly.
  if (typeof filter === "object" && "operator" in (filter as object)) {
    const op = filter as { operator: string; conditions: unknown[] };
    if (op.operator !== "AND") {
      throw new MethodError("invalidArguments", `Mailbox/query operator ${op.operator} unsupported`);
    }
    return op.conditions.reduce<MailboxRow[]>((acc, c) => applyMailboxFilter(acc, c), [...rows]);
  }

  const c = filter as {
    parentId?: string | null;
    role?: string | null;
    hasAnyRole?: boolean;
    name?: string;
  };
  return rows.filter((r) => {
    if (c.parentId !== undefined && r.parentId !== c.parentId) return false;
    if (c.role !== undefined && r.role !== c.role) return false;
    if (c.hasAnyRole !== undefined && (r.role !== null) !== c.hasAnyRole) return false;
    if (c.name !== undefined && !r.name.toLowerCase().includes(c.name.toLowerCase())) return false;
    return true;
  });
}
