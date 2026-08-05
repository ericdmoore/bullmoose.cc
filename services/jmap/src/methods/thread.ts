import { MethodError, type MethodRegistry } from "@bullmoose/jmap-core";
import { accountState, requireAccount, storeFor, type RequestContext } from "./common";

export function registerThreadMethods(registry: MethodRegistry<RequestContext>): void {
  registry.register("Thread/get", async (args, ctx) => {
    const access = await requireAccount(ctx, args, "read");
    if (!Array.isArray(args.ids)) {
      throw new MethodError("invalidArguments", "Thread/get requires ids");
    }
    const ids = args.ids as string[];
    const store = storeFor(ctx);

    const list: Array<{ id: string; emailIds: string[] }> = [];
    const notFound: string[] = [];
    for (const id of ids) {
      const emailIds = await store.getThreadEmailIds(access.accountId, id);
      if (emailIds.length === 0) notFound.push(id);
      else list.push({ id, emailIds });
    }

    return {
      accountId: access.accountId,
      state: await accountState(ctx, access.accountId),
      list,
      notFound,
    };
  });
}
