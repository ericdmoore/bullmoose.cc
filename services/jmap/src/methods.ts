import { MethodError, MethodRegistry } from "@bullmoose/jmap-core";
import { accountStub } from "@bullmoose/account-do";
import { Mailstore } from "@bullmoose/mailstore";
import { accountAccess, type Principal } from "./auth";
import type { Env } from "./index";

export interface RequestContext {
  env: Env;
  principal: Principal;
}

function requireAccount(ctx: RequestContext, args: Record<string, unknown>) {
  const accountId = args.accountId;
  if (typeof accountId !== "string") {
    throw new MethodError("invalidArguments", "accountId is required");
  }
  const access = accountAccess(ctx.principal, accountId);
  if (!access) throw new MethodError("accountNotFound");
  return access;
}

async function accountState(ctx: RequestContext, accountId: string): Promise<string> {
  const res = await accountStub(ctx.env.ACCOUNT_DO, accountId).fetch("https://do/state");
  const { state } = (await res.json()) as { state: string };
  return state;
}

/**
 * Method registry for the MVP surface. Grows toward:
 * Email/get|query|changes|set, Thread/get, EmailSubmission/set,
 * Identity/get, Mailbox/set|query|changes.
 */
export function buildRegistry(): MethodRegistry<RequestContext> {
  const registry = new MethodRegistry<RequestContext>();

  registry.register("Core/echo", async (args) => args);

  registry.register("Mailbox/get", async (args, ctx) => {
    const access = requireAccount(ctx, args);
    const store = new Mailstore(ctx.env.DB, ctx.env.BLOBS);

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

  registry.register("Mailbox/changes", async (args, ctx) => {
    return proxyChanges(ctx, args, "Mailbox");
  });

  registry.register("Email/changes", async (args, ctx) => {
    return proxyChanges(ctx, args, "Email");
  });

  return registry;
}

/** Forward a Foo/changes call to the account's Durable Object changelog. */
async function proxyChanges(
  ctx: RequestContext,
  args: Record<string, unknown>,
  collection: "Email" | "Mailbox",
): Promise<Record<string, unknown>> {
  const access = requireAccount(ctx, args);
  const since = args.sinceState;
  if (typeof since !== "string") {
    throw new MethodError("invalidArguments", "sinceState is required");
  }

  const url = new URL("https://do/changes");
  url.searchParams.set("collection", collection);
  url.searchParams.set("since", since);
  if (typeof args.maxChanges === "number") {
    url.searchParams.set("maxChanges", String(args.maxChanges));
  }

  const res = await accountStub(ctx.env.ACCOUNT_DO, access.accountId).fetch(url);
  if (res.status === 409) throw new MethodError("cannotCalculateChanges");
  if (!res.ok) throw new MethodError("serverFail", `changelog returned ${res.status}`);

  const body = (await res.json()) as Record<string, unknown>;
  return { accountId: access.accountId, ...body };
}
