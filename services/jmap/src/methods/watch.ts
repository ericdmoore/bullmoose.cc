import { commitChanges, type ChangeEntry } from "@bullmoose/account-do";
import type { MethodRegistry } from "@bullmoose/jmap-core";
import { accountState, requireAccount, type RequestContext } from "./common";

/**
 * Watch (urn:bullmoose:params:jmap:agent) — CRUD over the watches a human
 * sets (s20 T1). The agent worker's cron FIRES them (`watches.ts`); this is
 * the surface that ARMS and CANCELS them. Deliberately small: `set` creates
 * and cancels, `get`/`query` list. A watch is never "edited" — you cancel one
 * and arm another, so its history (what you were waiting for, and when it
 * fired) stays an immutable record rather than a mutable setting.
 *
 * The three verbs a watch reduces to on this surface:
 *   create  → arm a new watch (status 'armed')
 *   cancel  → status 'cancelled' (the human changed their mind before it fired)
 *   read    → get/query the roster
 *
 * Firing, expiring and the proposal it produces are the cron's job, not a
 * client's — so `set` refuses to write `status: 'fired'`. A client cannot
 * fake a fire.
 */

interface WatchRow {
  id: string;
  account_id: string;
  owner: string;
  condition_type: string;
  condition_json: string;
  deadline_at: number;
  action_type: string;
  action_json: string;
  status: string;
  source_ref: string | null;
  created_at: number;
  fired_at: number | null;
  proposal_id: string | null;
}

const CONDITION_TYPES = new Set(["deadline", "no-reply-from"]);
const ACTION_TYPES = new Set(["notify", "draft-followup"]);

function toJmap(r: WatchRow): Record<string, unknown> {
  return {
    id: r.id,
    conditionType: r.condition_type,
    condition: safeJson(r.condition_json),
    deadlineAt: r.deadline_at,
    actionType: r.action_type,
    action: safeJson(r.action_json),
    status: r.status,
    sourceRef: r.source_ref,
    createdAt: r.created_at,
    firedAt: r.fired_at,
    proposalId: r.proposal_id,
  };
}

export function registerWatchMethods(registry: MethodRegistry<RequestContext>): void {
  registry.register("Watch/get", async (args, ctx) => {
    const access = await requireAccount(ctx, args, "read");
    const ids = args.ids === null || args.ids === undefined ? undefined : (args.ids as string[]);
    let rows: WatchRow[];
    if (ids === undefined) {
      rows = (
        await ctx.env.DB.prepare(
          `SELECT * FROM watches WHERE account_id = ? ORDER BY created_at DESC LIMIT 256`,
        )
          .bind(access.accountId)
          .all<WatchRow>()
      ).results;
    } else if (ids.length === 0) {
      rows = [];
    } else {
      const marks = ids.map(() => "?").join(",");
      rows = (
        await ctx.env.DB.prepare(`SELECT * FROM watches WHERE account_id = ? AND id IN (${marks})`)
          .bind(access.accountId, ...ids)
          .all<WatchRow>()
      ).results;
    }
    const found = new Set(rows.map((r) => r.id));
    return {
      accountId: access.accountId,
      state: await accountState(ctx, access.accountId),
      list: rows.map(toJmap),
      notFound: (ids ?? []).filter((id) => !found.has(id)),
    };
  });

  registry.register("Watch/query", async (args, ctx) => {
    const access = await requireAccount(ctx, args, "read");
    const filter = (args.filter as { status?: string } | null | undefined) ?? null;
    // Only ARMED is the default view — a roster of watches is "what am I
    // waiting on", not a graveyard of fired ones. A client asks for a
    // terminal status explicitly.
    const status = filter?.status;
    const rows = status
      ? (
          await ctx.env.DB.prepare(
            `SELECT id FROM watches WHERE account_id = ? AND status = ? ORDER BY deadline_at ASC LIMIT 256`,
          )
            .bind(access.accountId, status)
            .all<{ id: string }>()
        ).results
      : (
          await ctx.env.DB.prepare(
            `SELECT id FROM watches WHERE account_id = ? AND status = 'armed' ORDER BY deadline_at ASC LIMIT 256`,
          )
            .bind(access.accountId)
            .all<{ id: string }>()
        ).results;
    return {
      accountId: access.accountId,
      queryState: await accountState(ctx, access.accountId),
      ids: rows.map((r) => r.id),
    };
  });

  registry.register("Watch/set", async (args, ctx) => {
    // A watch is agent-facing plumbing over the account's own mail, so it
    // needs a WRITE scope — `annotate` is the lightest mail-write verb, and
    // arming a watch is morally a flag on a message. (Not `read`: setting
    // one enrolls the account in future cron work on the human's behalf.)
    const access = await requireAccount(ctx, args, "annotate");
    const created: Record<string, Record<string, unknown>> = {};
    const notCreated: Record<string, { type: string; description?: string }> = {};
    const updated: Record<string, null> = {};
    const notUpdated: Record<string, { type: string; description?: string }> = {};
    const entry: ChangeEntry = { collection: "Watch", created: [], updated: [], destroyed: [] };

    // ---- create ----
    const createSpec = (args.create as Record<string, Record<string, unknown>> | undefined) ?? {};
    for (const [cid, spec] of Object.entries(createSpec)) {
      const conditionType = String(spec.conditionType ?? "");
      const actionType = String(spec.actionType ?? "");
      const deadlineAt = Number(spec.deadlineAt);
      if (!CONDITION_TYPES.has(conditionType)) {
        notCreated[cid] = {
          type: "invalidProperties",
          description: `unknown conditionType "${conditionType}"`,
        };
        continue;
      }
      if (!ACTION_TYPES.has(actionType)) {
        notCreated[cid] = {
          type: "invalidProperties",
          description: `unknown actionType "${actionType}"`,
        };
        continue;
      }
      if (!Number.isFinite(deadlineAt) || deadlineAt <= 0) {
        notCreated[cid] = {
          type: "invalidProperties",
          description: "deadlineAt (epoch ms) is required",
        };
        continue;
      }
      // A no-reply watch is meaningless without someone to wait on.
      const condition = (spec.condition as Record<string, unknown>) ?? {};
      if (conditionType === "no-reply-from" && typeof condition.sender !== "string") {
        notCreated[cid] = {
          type: "invalidProperties",
          description: "no-reply-from needs condition.sender",
        };
        continue;
      }
      const id = `w_${crypto.randomUUID()}`;
      await ctx.env.DB.prepare(
        `INSERT INTO watches
           (id, account_id, owner, condition_type, condition_json, deadline_at,
            action_type, action_json, status, source_ref, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'armed', ?, ?)`,
      )
        .bind(
          id,
          access.accountId,
          ctx.principal.username,
          conditionType,
          JSON.stringify(condition),
          deadlineAt,
          actionType,
          JSON.stringify((spec.action as Record<string, unknown>) ?? {}),
          typeof spec.sourceRef === "string" ? spec.sourceRef : null,
          Date.now(),
        )
        .run();
      created[cid] = { id, status: "armed" };
      entry.created.push(id);
    }

    // ---- update: cancel only ----
    const updateSpec = (args.update as Record<string, Record<string, unknown>> | undefined) ?? {};
    for (const [id, patch] of Object.entries(updateSpec)) {
      if (patch.status !== "cancelled") {
        notUpdated[id] = {
          type: "invalidProperties",
          description:
            'the only update a client may make is status: "cancelled" — firing is the cron\'s job',
        };
        continue;
      }
      // Cancel only an armed watch, and never a fired/expired one: a fired
      // watch already produced its proposal, and "cancelling" it would be a
      // lie about egress that already happened.
      const res = await ctx.env.DB.prepare(
        `UPDATE watches SET status = 'cancelled' WHERE account_id = ? AND id = ? AND status = 'armed'`,
      )
        .bind(access.accountId, id)
        .run();
      if ((res.meta?.changes ?? 0) === 0) {
        notUpdated[id] = {
          type: "invalidProperties",
          description: "no armed watch with that id (already fired, cancelled or unknown)",
        };
        continue;
      }
      updated[id] = null;
      entry.updated.push(id);
    }

    const oldState = await accountState(ctx, access.accountId);
    if (entry.created.length + entry.updated.length > 0) {
      await commitChanges(ctx.env.ACCOUNT_DO, access.accountId, [entry]);
    }
    return {
      accountId: access.accountId,
      oldState,
      newState: await accountState(ctx, access.accountId),
      created,
      notCreated,
      updated,
      notUpdated,
      destroyed: [],
      notDestroyed: {},
    };
  });
}

function safeJson(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
