import { MethodError, type MethodRegistry } from "@bullmoose/jmap-core";
import { accountState, requireAccount, storeFor, type RequestContext } from "./common";

export function registerThreadMethods(registry: MethodRegistry<RequestContext>): void {
  /**
   * RFC 8621 §3.2. Registered — and answering `cannotCalculateChanges` — rather
   * than absent, because those are DIFFERENT claims to a client:
   *
   *   absent                 → `unknownMethod`: this server does not speak that
   *                            part of the spec, and a strict client may treat
   *                            the session as non-conformant.
   *   cannotCalculateChanges → RFC 8620 §5.2's sanctioned "I cannot compute this
   *                            delta"; the client re-queries, a path it must
   *                            already have.
   *
   * We genuinely cannot compute it — threads are derived from emails and no
   * thread-level state is tracked — so this is the honest answer rather than a
   * missing one. What it must NOT do is return an empty delta: that is a lie the
   * client cannot detect (the same reasoning as filenode.ts:117).
   *
   * sVOL 027 closes here. The unit was graded I0 on the assumption that building
   * it meant COMPUTING deltas; it does not.
   */
  registry.register("Thread/changes", async (args, ctx) => {
    // Gate first: a caller with no access must not learn which error this method
    // would otherwise have returned.
    await requireAccount(ctx, args, "read");
    throw new MethodError("cannotCalculateChanges");
  });

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
