import type { MethodRegistry } from "@bullmoose/jmap-core";
import { accountState, requireAccount, storeFor, type RequestContext } from "./common";

export function registerIdentityMethods(registry: MethodRegistry<RequestContext>): void {
  registry.register("Identity/get", async (args, ctx) => {
    const access = await requireAccount(ctx, args, "read");
    const store = storeFor(ctx);

    let identities = await store.getIdentities(access.accountId);
    // Until provisioning seeds the identities table, synthesize one from
    // the principal so sending works out of the box for the dev account.
    if (identities.length === 0) {
      identities = [
        { id: "identity_default", email: ctx.principal.username, name: access.name },
      ];
    }

    const requested =
      args.ids === null || args.ids === undefined ? null : (args.ids as string[]);
    const list = identities
      .filter((i) => requested === null || requested.includes(i.id))
      .map((i) => ({
        id: i.id,
        name: i.name,
        email: i.email,
        replyTo: null,
        bcc: null,
        textSignature: "",
        htmlSignature: "",
        mayDelete: false,
      }));
    const found = new Set(list.map((i) => i.id));

    return {
      accountId: access.accountId,
      state: await accountState(ctx, access.accountId),
      list,
      notFound: (requested ?? []).filter((id) => !found.has(id)),
    };
  });
}
