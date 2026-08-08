import type { MethodRegistry } from "@bullmoose/jmap-core";
import type { AccountAccess } from "../auth";
import type { IdentityRow, Mailstore } from "@bullmoose/mailstore";
import { accountState, requireAccount, storeFor, type RequestContext } from "./common";

/**
 * The account's sending identities — the single authoritative answer to
 * "which addresses may this account send as", shared by `Identity/get`
 * and `EmailSubmission/set` so the two cannot drift.
 *
 * Until provisioning seeds the identities table, synthesize one from the
 * principal so sending works out of the box for the dev account — but
 * **only when the table is empty**. On a provisioned account the rows are
 * authoritative; offering `identity_default` alongside them would smuggle
 * the *login* email in as a sender, and on a grant-reached account that
 * login email belongs to a different person entirely.
 */
export async function resolveIdentities(
  ctx: RequestContext,
  access: AccountAccess,
  store: Mailstore,
): Promise<IdentityRow[]> {
  const rows = await store.getIdentities(access.accountId);
  if (rows.length > 0) return rows;
  return [{ id: "identity_default", email: ctx.principal.username, name: access.name }];
}

export function registerIdentityMethods(registry: MethodRegistry<RequestContext>): void {
  registry.register("Identity/get", async (args, ctx) => {
    const access = await requireAccount(ctx, args, "read");
    const store = storeFor(ctx);

    const identities = await resolveIdentities(ctx, access, store);

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
