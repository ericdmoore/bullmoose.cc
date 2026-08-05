import { MethodError } from "@bullmoose/jmap-core";
import { accountStub } from "@bullmoose/account-do";
import { Mailstore } from "@bullmoose/mailstore";
import {
  authorizeAccount,
  type AccountAccess,
  type MethodDomain,
  type Principal,
} from "../auth";
import type { Env } from "../index";

export interface RequestContext {
  env: Env;
  principal: Principal;
}

/**
 * Resolve + authorize the account for a method call. `scope` is the verb
 * this method needs ("read" | "draft" | "send" | "contacts" | ...); the
 * "mail" scope covers all mail verbs. For owned accounts only the token's
 * scopes gate. For grant-reached accounts the effective rights are
 * token ∩ grant, the grant must cover the method's domain (an
 * AddressBook-scoped grant unlocks contacts methods only), and every
 * call is written to the grant_audit log.
 */
export async function requireAccount(
  ctx: RequestContext,
  args: Record<string, unknown>,
  scope: string,
  domain: MethodDomain = "mail",
): Promise<AccountAccess> {
  const accountId = args.accountId;
  if (typeof accountId !== "string") {
    throw new MethodError("invalidArguments", "accountId is required");
  }
  const decision = authorizeAccount(ctx.principal, accountId, scope, domain);
  if (!decision.ok) {
    if (decision.reason === "accountNotFound") throw new MethodError("accountNotFound");
    throw new MethodError("forbidden", decision.detail);
  }
  if (decision.auditGrant) {
    await ctx.env.DB.prepare(
      `INSERT INTO grant_audit (grant_id, principal, account_id, method, at)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(
        decision.auditGrant.grantId,
        ctx.principal.username,
        decision.access.accountId,
        `${domain}:${scope}`,
        Date.now(),
      )
      .run();
  }
  return decision.access;
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
  collection:
    | "Email"
    | "Mailbox"
    | "Thread"
    | "EmailSubmission"
    | "AgentInvocation"
    | "AddressBook"
    | "ContactCard"
    | "Calendar"
    | "CalendarEvent",
): Promise<Record<string, unknown>> {
  const domain =
    collection === "AddressBook" || collection === "ContactCard"
      ? "contacts"
      : collection === "Calendar" || collection === "CalendarEvent"
        ? "calendar"
        : "mail";
  const access = await requireAccount(ctx, args, "read", domain);
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
