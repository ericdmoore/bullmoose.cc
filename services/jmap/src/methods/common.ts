import { MethodError } from "@bullmoose/jmap-core";
import { accountStub } from "@bullmoose/account-do";
import { Mailstore } from "@bullmoose/mailstore";
import { accountAccess, principalHasScope, type AccountAccess, type Principal } from "../auth";
import type { Env } from "../index";

export interface RequestContext {
  env: Env;
  principal: Principal;
}

/**
 * Resolve + authorize the account for a method call. `scope` is the verb
 * this method needs ("read" | "draft" | "send" | ...); the "mail" scope
 * covers all mail verbs. Grant-scoped tokens (agents!) fail here with
 * `forbidden` before touching any data.
 */
export function requireAccount(
  ctx: RequestContext,
  args: Record<string, unknown>,
  scope: string,
): AccountAccess {
  const accountId = args.accountId;
  if (typeof accountId !== "string") {
    throw new MethodError("invalidArguments", "accountId is required");
  }
  const access = accountAccess(ctx.principal, accountId);
  if (!access) throw new MethodError("accountNotFound");
  if (!principalHasScope(ctx.principal, scope)) {
    throw new MethodError("forbidden", `token lacks the "${scope}" scope`);
  }
  return access;
}

export function storeFor(ctx: RequestContext): Mailstore {
  return new Mailstore(ctx.env.DB, ctx.env.BLOBS);
}

export async function accountState(ctx: RequestContext, accountId: string): Promise<string> {
  const res = await accountStub(ctx.env.ACCOUNT_DO, accountId).fetch("https://do/state");
  const { state } = (await res.json()) as { state: string };
  return state;
}

/** Forward a Foo/changes call to the account's Durable Object changelog. */
export async function proxyChanges(
  ctx: RequestContext,
  args: Record<string, unknown>,
  collection: "Email" | "Mailbox" | "Thread" | "EmailSubmission" | "AgentInvocation",
): Promise<Record<string, unknown>> {
  const access = requireAccount(ctx, args, "read");
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

/** RFC 8620 SetError shape used across /set methods. */
export interface SetError {
  type: string;
  description?: string;
  properties?: string[];
}

export const setError = (type: string, description?: string): SetError =>
  description ? { type, description } : { type };
