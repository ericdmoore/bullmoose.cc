import { MethodError, type MethodRegistry } from "@bullmoose/jmap-core";
import { commitChanges } from "@bullmoose/account-do";
import { issueInvocationToken } from "@bullmoose/auth-core/invocation";
import {
  ESCALATION_WINDOW_NO_HISTORY_MS,
  bindingEscalationWindowMs,
  budgetMonthStartMs,
  claimGateBinds,
  claimGateSql,
  normalizeClaimant,
} from "@bullmoose/scheduling";
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
    // s11 T3 — `alerted: true` narrows to invocations the watchdog MARKED
    // (past due_at and unclaimable: pinned, or beyond the cloud's declared
    // capabilities). The marker is what makes "no past-due invocation sits
    // pending silently" a queryable fact rather than a log line someone has to
    // have been watching for; it composes with `status`, which still applies.
    const alerted = args.alerted === true;
    const { results } = await ctx.env.DB.prepare(
      `SELECT id FROM agent_invocations
       WHERE account_id = ? AND status = ?${alerted ? " AND alert_kind IS NOT NULL" : ""}
       ORDER BY created_at LIMIT 64`,
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
        // s11 capability facets, FEATURE-DETECTED: `requires_json` is the T6
        // facet column ({vision?, contextTokens?, tools?}). The SELECT * above
        // yields it iff the migration has run; on a pre-T6 database this is
        // undefined → null, and a null `requires` tells claimants "no facets —
        // claim exactly as today" (jobs-and-facets §1 DefaultCase: facets
        // tighten, never strand). The fleet host's client-side narrowing
        // (packages/cli/src/agent.ts fitsRequirements) reads this field.
        requires: typeof r.requires_json === "string" ? JSON.parse(r.requires_json) : null,
        // s11 T3, FEATURE-DETECTED the same way: the watchdog's alert marker.
        // 'overdue-pinned' (privacy beats liveness, decision 0) and
        // 'overdue-unfit' mean this invocation's due_at passed while nobody who
        // could claim it was available. Those two are NOTICES: there is no verb,
        // which is exactly why they are markers on the run and not
        // ActionProposals. 's11 T9's 'budget-stranded:<YYYY-MM>' is the
        // exception that proves the rule — a human choice DOES exist there
        // ("spend anyway?"), so the marker rides beside a `budget-overrun`
        // proposal as its once-per-period idempotence key rather than instead of
        // one. Projected as an opaque string either way: this is a read model,
        // and validating a marker here would only add a place to drift.
        alert:
          typeof r.alert_kind === "string"
            ? {
                kind: r.alert_kind,
                at: typeof r.alert_at === "number" ? new Date(r.alert_at).toISOString() : null,
              }
            : null,
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
   *   update   claim/complete: { id: { status: "running"|"done"|"failed", result? } }.
   *            A claim (→ running) may carry a top-level `claimant` argument
   *            beside `update` — { isFree: boolean, capabilities?: {vision?,
   *            contextTokens?, tools?} } — and passes the s11 T2 eligibility
   *            gate folded into the guarded UPDATE (see T2-FIT-CONTRACT below).
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
    // `null` for every transition but the CLAIM, which now answers with the
    // per-invocation token it just minted (s17). JMAP's `updated` map is
    // "id → the properties the server set, or null if none" — the token IS a
    // property the server set on this invocation, and it is the only place the
    // plaintext ever appears. See `issueInvocationToken`.
    const updated: Record<string, { invocationToken: string } | null> = {};
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

    // T2-FIT-CONTRACT (s11 devPlan T2) — LIVE. The claim's guarded UPDATE
    // carries the full three-term gate (jobs-and-facets §6):
    //   eligible = authority(grants)          ← requireAccount above
    //            ∧ fit(capabilities, facets)  ← claimGateSql, below
    //            ∧ policy(due_at, budget, now)← claimGateSql, below
    // The claimant declares `{ isFree, capabilities }` in an AgentInvocation/set
    // `claimant` argument beside `update` (the fleet host sends isFree:true +
    // its fleet.json vector; the cloud drain claims through its own SQL with
    // isFree:false). Absent declaration = paid, no vector — conservative for
    // policy, while an undeclared VECTOR claims as today (fit's DefaultCase;
    // see @bullmoose/scheduling fit()). Both fit and policy are enforced IN
    // the UPDATE's WHERE, so a hostile claimant that self-filters generously
    // still cannot claim outside its set — its preference (which eligible row
    // to take first) stays client-side, its eligibility does not. The declared
    // identity is recorded on the claim (claimant_free, claimant_caps_json):
    // trust-but-audit — isFree is fit-shaped, not authority-shaped, so a lie
    // earns work, never permissions, and the score catches it from the record.
    const claimant = normalizeClaimant(args.claimant);
    const update = (args.update as Record<string, Record<string, unknown>> | undefined) ?? {};
    for (const [id, patch] of Object.entries(update)) {
      const status = patch.status;
      if (status !== "running" && status !== "done" && status !== "failed") {
        notUpdated[id] = setError("invalidProperties", "status must be running|done|failed");
        continue;
      }
      const resultJson = patch.result !== undefined ? JSON.stringify(patch.result) : null;

      if (status !== "running") {
        // Completion (done|failed) is a runtime finishing its own claim —
        // never eligibility-gated, and (as before) not state-guarded.
        const res = await ctx.env.DB.prepare(
          `UPDATE agent_invocations
           SET status = ?, result_json = COALESCE(?, result_json), done_at = ?
           WHERE account_id = ? AND id = ?`,
        )
          .bind(status, resultJson, Date.now(), access.accountId, id)
          .run();
        if ((res.meta.changes ?? 0) > 0) updated[id] = null;
        else notUpdated[id] = setError("notFound", "no such invocation");
        continue;
      }

      // The claim. Optimistic-concurrency-guarded (only pending → running, so
      // two runtimes can't both claim) AND eligibility-gated in the same WHERE.
      // The row read first is advisory only — it feeds the escalation-window
      // computation (a per-binding median, unbindable as pure SQL); every
      // enforced predicate reads the row's columns inside the UPDATE itself.
      const row = await ctx.env.DB.prepare(
        `SELECT binding_id, due_at FROM agent_invocations WHERE account_id = ? AND id = ?`,
      )
        .bind(access.accountId, id)
        .first<{ binding_id: string; due_at: number | null }>();
      if (!row) {
        notUpdated[id] = setError("notFound", "no such invocation");
        continue;
      }
      // The window is only consulted for a paid claim on due work; skip the
      // history scan otherwise and bind the (unread) default.
      const windowMs =
        !claimant.isFree && row.due_at !== null
          ? await bindingEscalationWindowMs(ctx.env.DB, access.accountId, row.binding_id)
          : ESCALATION_WINDOW_NO_HISTORY_MS;
      const now = Date.now();
      const res = await ctx.env.DB.prepare(
        `UPDATE agent_invocations
         SET status = 'running',
             result_json = COALESCE(?, result_json),
             claimed_at = ?,
             claimant_free = ?,
             claimant_caps_json = ?
         WHERE account_id = ? AND id = ? AND status = 'pending'${claimGateSql("agent_invocations")}`,
      )
        .bind(
          resultJson,
          now,
          claimant.isFree ? 1 : 0,
          claimant.capabilities !== null ? JSON.stringify(claimant.capabilities) : null,
          access.accountId,
          id,
          ...claimGateBinds({
            now,
            claimant,
            escalationWindowMs: windowMs,
            monthStartMs: budgetMonthStartMs(now),
          }),
        )
        .run();
      if ((res.meta.changes ?? 0) > 0) {
        // THE MINT (s17). Guarded on `changes` alone, deliberately: the winner
        // of an atomic `pending → running` UPDATE is by construction the only
        // party entitled to act as this invocation, so "who may hold the
        // token" needs no second check — it is the same predicate that already
        // decided who may run the work. A loser of the race falls through to
        // the `notUpdated` branch below and mints nothing.
        //
        // The plaintext is returned ONCE, here, and never stored. A shard that
        // predates `agent_invocation_tokens` throws on the INSERT; the claim
        // itself has already committed and must not be undone for it, so the
        // mint degrades to the `null` this response carried before s17 rather
        // than failing a claim the runtime is now responsible for finishing.
        let invocationToken: string | null = null;
        try {
          invocationToken = await issueInvocationToken(ctx.env.DB, {
            invocationId: id,
            accountId: access.accountId,
          });
        } catch (err) {
          console.warn(`invocation token mint failed for ${id}: ${String(err)}`);
        }
        updated[id] = invocationToken ? { invocationToken } : null;
        continue;
      }
      // Zero changes: raced/gone, or refused by the gate. Distinguish them —
      // a still-pending row means the gate said no, and telling the claimant
      // "notFound" would send it chasing a phantom race.
      const still = await ctx.env.DB.prepare(
        `SELECT status FROM agent_invocations WHERE account_id = ? AND id = ?`,
      )
        .bind(access.accountId, id)
        .first<{ status: string }>();
      notUpdated[id] =
        still?.status === "pending"
          ? setError(
              "forbidden",
              "claim refused: this claimant is not eligible for this invocation yet (fit/policy)",
            )
          : setError("notFound", "no such invocation (or already claimed)");
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
