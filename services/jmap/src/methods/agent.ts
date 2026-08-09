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

  /**
   * AgentInvocation/set — three branches:
   *
   *   create   on-demand trigger (sVOL 007). Queue a `pending` invocation for a
   *            chosen binding against an existing email; the drain (CLI runner
   *            or cloud worker) picks it up over the changelog with NO new
   *            trigger type — `services/agent` gates on status+enabled, not
   *            `trigger_on`. This is the "Human → agent invoke on a thread"
   *            capability `s03.D-coexistence/devPlan.md:42-46` depends on.
   *   update   claim/complete: { id: { status: "running"|"done"|"failed", result? } }
   *   destroy  purge an invocation (pending|done|failed) — a `running` one is
   *            refused, since a runtime is mid-flight on it.
   *
   * `draft` scope gates the whole method: creating an invocation causes an agent
   * to draft or send, which is exactly what `draft` means (unit 007 §4). Post
   * common/001 that is advisory — a `mail` token (the mint default) satisfies
   * `draft` — but declared correctly. Note the flat-set semantics of common/027:
   * a `send`- or `delete`-only token does NOT satisfy `draft`.
   *
   * SAFETY INTERLOCK (008 kill switch): create REFUSES a binding whose
   * `enabled = 0`. Both drain paths gate on `enabled` and neither cancels a
   * queued row, so an invocation against a disabled binding would sit `pending`
   * forever — a held black hole. Handing a human an on-demand trigger while
   * ignoring the off switch is the ordering hazard 007 was sequenced after 008
   * to avoid; the refusal is the interlock.
   */
  registry.register("AgentInvocation/set", async (args, ctx) => {
    const access = await requireAccount(ctx, args, "draft");
    const oldState = await accountState(ctx, access.accountId);
    const created: Record<string, Record<string, unknown>> = {};
    const notCreated: Record<string, SetError> = {};
    const updated: Record<string, null> = {};
    const notUpdated: Record<string, SetError> = {};
    const destroyed: string[] = [];
    const notDestroyed: Record<string, SetError> = {};

    // ---- create: on-demand invocation ----
    const create = (args.create as Record<string, Record<string, unknown>> | undefined) ?? {};
    for (const [cid, props] of Object.entries(create)) {
      const bindingId = typeof props.bindingId === "string" ? props.bindingId : undefined;
      const bindingName = typeof props.bindingName === "string" ? props.bindingName : undefined;
      if (!bindingId && !bindingName) {
        notCreated[cid] = {
          type: "invalidProperties",
          description: "one of bindingId | bindingName is required",
          properties: ["bindingId", "bindingName"],
        };
        continue;
      }

      // Resolve the binding within THIS account and read its kill-switch state
      // in one query — a binding on another account is simply not found here.
      const binding = await ctx.env.DB.prepare(
        bindingId
          ? `SELECT id, name, enabled FROM agent_bindings WHERE account_id = ? AND id = ?`
          : `SELECT id, name, enabled FROM agent_bindings WHERE account_id = ? AND name = ?`,
      )
        .bind(access.accountId, bindingId ?? bindingName)
        .first<{ id: string; name: string; enabled: number }>();
      if (!binding) {
        notCreated[cid] = setError(
          "notFound",
          `no such binding "${bindingId ?? bindingName}" on this account`,
        );
        continue;
      }
      // THE INTERLOCK. A disabled binding is a clean refusal, distinct from
      // "no such binding" — the drain would never touch the row.
      if (binding.enabled !== 1) {
        notCreated[cid] = setError(
          "forbidden",
          `binding "${binding.name}" is disabled (008 kill switch) — ` +
            `re-enable it before invoking: bullmoose admin agent enable ${binding.id}`,
        );
        continue;
      }

      // v1 requires an emailId: the cloud runtime hard-requires email context
      // (`services/agent/src/index.ts` — `if (!job.email_id) …failed`), so a
      // no-email invocation is marked failed within one drain cycle. This is
      // the "invoke on a thread" framing s03.D T3 asks for.
      const emailId = typeof props.emailId === "string" ? props.emailId : undefined;
      if (!emailId) {
        notCreated[cid] = {
          type: "invalidProperties",
          description: "emailId is required — invoke acts on an existing message",
          properties: ["emailId"],
        };
        continue;
      }
      const email = await ctx.env.DB.prepare(
        `SELECT id FROM emails WHERE account_id = ? AND id = ?`,
      )
        .bind(access.accountId, emailId)
        .first<{ id: string }>();
      if (!email) {
        notCreated[cid] = {
          type: "invalidProperties",
          description: `email "${emailId}" not found in this account`,
          properties: ["emailId"],
        };
        continue;
      }

      // context_json mirrors ingest's shape but omits `envelopeTo`: an
      // on-demand invocation has no envelope, and inventing one would mis-steer
      // the ledger digest-target selection. The human's reason rides in `note`.
      const threadId = typeof props.threadId === "string" ? props.threadId : undefined;
      const note = typeof props.note === "string" ? props.note : undefined;
      const context: Record<string, unknown> = { emailId };
      if (threadId) context.threadId = threadId;
      if (note) context.note = note;
      if (props.params !== undefined) context.params = props.params;

      const invId = `inv_${crypto.randomUUID()}`;
      const createdAt = Date.now();
      await ctx.env.DB.prepare(
        `INSERT INTO agent_invocations
           (id, account_id, binding_id, binding_name, status, email_id, context_json, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
        .bind(invId, access.accountId, binding.id, binding.name, emailId, JSON.stringify(context), createdAt)
        .run();
      created[cid] = {
        id: invId,
        bindingId: binding.id,
        bindingName: binding.name,
        status: "pending",
        emailId,
        createdAt: new Date(createdAt).toISOString(),
      };
    }

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

    // ---- destroy: purge an invocation ----
    const destroy = Array.isArray(args.destroy) ? (args.destroy as string[]) : [];
    for (const id of destroy) {
      const row = await ctx.env.DB.prepare(
        `SELECT status FROM agent_invocations WHERE account_id = ? AND id = ?`,
      )
        .bind(access.accountId, id)
        .first<{ status: string }>();
      if (!row) {
        notDestroyed[id] = setError("notFound", "no such invocation");
        continue;
      }
      // A `running` row is being processed by a runtime whose terminal UPDATE
      // would then hit zero rows and log nothing — and `failStaleRunning` only
      // sweeps rows that still exist. Refuse; let it reach a terminal state.
      if (row.status === "running") {
        notDestroyed[id] = setError(
          "forbidden",
          "cannot destroy a running invocation — wait for it to finish or fail",
        );
        continue;
      }
      await ctx.env.DB.prepare(
        `DELETE FROM agent_invocations WHERE account_id = ? AND id = ?`,
      )
        .bind(access.accountId, id)
        .run();
      destroyed.push(id);
    }

    let newState = oldState;
    const createdIds = Object.values(created).map((c) => c.id as string);
    const updatedIds = Object.keys(updated);
    if (createdIds.length + updatedIds.length + destroyed.length > 0) {
      ({ newState } = await commitChanges(ctx.env.ACCOUNT_DO, access.accountId, [
        {
          collection: "AgentInvocation",
          created: createdIds,
          updated: updatedIds,
          destroyed,
        },
      ]));
    }
    return {
      accountId: access.accountId,
      oldState,
      newState,
      created,
      notCreated,
      updated,
      notUpdated,
      destroyed,
      notDestroyed,
    };
  });

  registry.register("AgentInvocation/changes", async (args, ctx) =>
    proxyChanges(ctx, args, "AgentInvocation"),
  );
}
