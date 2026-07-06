import { MethodError, type MethodRegistry } from "@bullmoose/jmap-core";
import type { MailboxRow } from "@bullmoose/mailstore";
import { accountState, proxyChanges, requireAccount, storeFor, type RequestContext } from "./common";

export function registerMailboxMethods(registry: MethodRegistry<RequestContext>): void {
  registry.register("Mailbox/get", async (args, ctx) => {
    const access = requireAccount(ctx, args);
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
          totalThreads: counts.totalEmails, // TODO: real thread counts
          unreadThreads: counts.unreadEmails,
          myRights: {
            mayReadItems: true,
            mayAddItems: true,
            mayRemoveItems: true,
            maySetSeen: true,
            maySetKeywords: true,
            mayCreateChild: true,
            mayRename: true,
            mayDelete: r.role === null,
            maySubmit: true,
          },
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

  registry.register("Mailbox/changes", async (args, ctx) => proxyChanges(ctx, args, "Mailbox"));

  // himalaya enumerates folders via query, not get (§15 punch list).
  registry.register("Mailbox/query", async (args, ctx) => {
    const access = requireAccount(ctx, args);
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
    const limit =
      typeof args.limit === "number" ? Math.min(Math.max(1, args.limit), 256) : filtered.length;
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
