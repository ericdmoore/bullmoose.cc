import type { MethodRegistry } from "@bullmoose/jmap-core";
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
}
