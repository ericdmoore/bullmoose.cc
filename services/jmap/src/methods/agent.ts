import { MethodError, type MethodRegistry } from "@bullmoose/jmap-core";
import { commitChanges } from "@bullmoose/account-do";
import {
  accountState,
  proxyChanges,
  requireAccount,
  setError,
  type RequestContext,
  type SetError,
} from "./common";

/**
 * AgentInvocation methods (urn:bullmoose:params:jmap:agent) — the
 * pull-based invocation queue from agent-integration.md §2. Runtimes
 * (bullmoose agent serve, cloud workers) watch the changelog for pending
 * work, claim it (pending → running), and complete it (running → done).
 * Claiming/completing cancels any armed watchdog for the same email.
 */
export function registerAgentMethods(registry: MethodRegistry<RequestContext>): void {
  registry.register("AgentInvocation/query", async (args, ctx) => {
    const access = await requireAccount(ctx, args, "read");
    const status = typeof args.status === "string" ? args.status : "pending";
    const { results } = await ctx.env.DB.prepare(
      `SELECT id FROM agent_invocations
       WHERE account_id = ? AND status = ? ORDER BY created_at LIMIT 64`,
    )
      .bind(access.accountId, status)
      .all<{ id: string }>();
    return {
      accountId: access.accountId,
      queryState: await accountState(ctx, access.accountId),
      canCalculateChanges: false,
      position: 0,
      ids: results.map((r) => r.id),
    };
  });

  registry.register("AgentInvocation/get", async (args, ctx) => {
    const access = await requireAccount(ctx, args, "read");
    if (!Array.isArray(args.ids)) {
      throw new MethodError("invalidArguments", "AgentInvocation/get requires ids");
    }
    const ids = args.ids as string[];
    if (ids.length === 0) {
      return {
        accountId: access.accountId,
        state: await accountState(ctx, access.accountId),
        list: [],
        notFound: [],
      };
    }
    const marks = ids.map(() => "?").join(",");
    const { results } = await ctx.env.DB.prepare(
      `SELECT * FROM agent_invocations WHERE account_id = ? AND id IN (${marks})`,
    )
      .bind(access.accountId, ...ids)
      .all<Record<string, unknown>>();
    const found = new Set(results.map((r) => r.id as string));
    return {
      accountId: access.accountId,
      state: await accountState(ctx, access.accountId),
      list: results.map((r) => ({
        id: r.id,
        bindingId: r.binding_id,
        bindingName: r.binding_name,
        status: r.status,
        emailId: r.email_id,
        context: JSON.parse((r.context_json as string) ?? "{}"),
        result: r.result_json ? JSON.parse(r.result_json as string) : null,
        note: r.note,
        createdAt: new Date(r.created_at as number).toISOString(),
      })),
      notFound: ids.filter((id) => !found.has(id)),
    };
  });

  // update only: { id: { status: "running"|"done"|"failed", result? } }
  registry.register("AgentInvocation/set", async (args, ctx) => {
    const access = await requireAccount(ctx, args, "draft");
    const oldState = await accountState(ctx, access.accountId);
    const updated: Record<string, null> = {};
    const notUpdated: Record<string, SetError> = {};

    const update = (args.update as Record<string, Record<string, unknown>> | undefined) ?? {};
    for (const [id, patch] of Object.entries(update)) {
      const status = patch.status;
      if (status !== "running" && status !== "done" && status !== "failed") {
        notUpdated[id] = setError("invalidProperties", "status must be running|done|failed");
        continue;
      }
      // Claim is optimistic-concurrency-guarded: only a pending invocation
      // can move to running (two runtimes can't both claim).
      const guard = status === "running" ? "AND status = 'pending'" : "";
      const res = await ctx.env.DB.prepare(
        `UPDATE agent_invocations
         SET status = ?,
             result_json = COALESCE(?, result_json),
             claimed_at = CASE WHEN ? = 'running' THEN ? ELSE claimed_at END,
             done_at = CASE WHEN ? IN ('done','failed') THEN ? ELSE done_at END
         WHERE account_id = ? AND id = ? ${guard}`,
      )
        .bind(
          status,
          patch.result !== undefined ? JSON.stringify(patch.result) : null,
          status,
          Date.now(),
          status,
          Date.now(),
          access.accountId,
          id,
        )
        .run();
      if ((res.meta.changes ?? 0) > 0) updated[id] = null;
      else notUpdated[id] = setError("notFound", "no such invocation (or already claimed)");
    }

    let newState = oldState;
    const ids = Object.keys(updated);
    if (ids.length > 0) {
      ({ newState } = await commitChanges(ctx.env.ACCOUNT_DO, access.accountId, [
        { collection: "AgentInvocation", updated: ids },
      ]));
    }
    return {
      accountId: access.accountId,
      oldState,
      newState,
      created: {},
      notCreated: {},
      updated,
      notUpdated,
      destroyed: [],
      notDestroyed: {},
    };
  });

  registry.register("AgentInvocation/changes", async (args, ctx) =>
    proxyChanges(ctx, args, "AgentInvocation"),
  );
}
