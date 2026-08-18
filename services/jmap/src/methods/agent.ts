import { MethodError, type MethodRegistry } from "@bullmoose/jmap-core";
import { commitChanges } from "@bullmoose/account-do";
import { issueInvocationToken, resolveInvocationToken, type InvocationIdentity } from "@bullmoose/auth-core/invocation";
import { isAgentPrincipal } from "@bullmoose/auth-core/principal";
import {
  ESCALATION_WINDOW_NO_HISTORY_MS,
  bindingEscalationWindowMs,
  budgetMonthStartMs,
  claimGateBinds,
  claimGateSql,
  normalizeClaimant,
} from "@bullmoose/scheduling";
import { accountState, proxyChanges, requireAccount, setError, type RequestContext, type SetError } from "./common";

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
   * `enabled = 0`. Nothing cancels a queued row, so an invocation against a
   * disabled binding would sit `pending` forever — a held black hole. Handing
   * a human an on-demand trigger while ignoring the off switch is the ordering
   * hazard 007 was sequenced after 008 to avoid; the refusal is the interlock.
   *
   * The CLAIM honors the same switch (s26 T2 follow-up): `claimGateSql` folds
   * `bindingDisabledSql`, outside the `isFree` short-circuit, so the rows
   * queued BEFORE a human flipped the switch stop being claimable too — by the
   * free fleet claimant as much as by the paid cloud. That is what makes
   * Settings→Agents' "Disabling holds queued work; nothing is cancelled" true
   * of both halves: refused, not failed, and claimable again the moment the
   * binding is re-enabled. See `bindingDisabledSql` for why an off switch is
   * not shaped like a budget.
   *
   * MANDATORY RULE 2 (s17 (d)): an `agent`-marked bearer may not CREATE without
   * presenting `invocationToken` — the credential its own claim returned — and
   * the created row then inherits the presented node's `job_id`, `parent_id`,
   * `depth`, `authority_json` and `privacy`. This is what closes gap 3: create
   * COPIES an envelope rather than intersecting one, so it is the one surface
   * where naming an invocation you do not hold would be an escalation rather
   * than a further narrowing. See `resolveCausingNode` for the whole argument.
   * Unmarked principals — humans, the `bullmoose agent invoke` CLI path,
   * third-party clients — are untouched.
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
    // MANDATORY RULE 2 (s17 (d)) — resolved ONCE for the whole create batch,
    // and only when there is a create (a claim-only call must cost no extra
    // read). `causing` is the node this create is CAUSED BY; `causingRefusal`
    // is why there isn't one, reported per-creation-id in the JMAP way.
    const { causing, causingRefusal } =
      Object.keys(create).length === 0
        ? { causing: null, causingRefusal: null }
        : await resolveCausingNode(ctx, args, access.accountId);
    for (const [cid, props] of Object.entries(create)) {
      if (causingRefusal) {
        notCreated[cid] = setError("forbidden", causingRefusal);
        continue;
      }
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
        notCreated[cid] = setError("notFound", `no such binding "${bindingId ?? bindingName}" on this account`);
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
      // SAME BINDING AS THE CAUSING NODE — `attenuateChild`'s identity rule
      // (attenuation.ts §identity: a child may not run on a binding other than
      // its parent's), enforced here because this path COPIES an envelope
      // rather than going through `attenuateChild`.
      //
      // It is not decoration. `effectiveNodeAuthority` folds the acting node's
      // OWN binding leniently (absent or corrupt config = unset ceiling) and
      // every ANCESTOR's binding fail-closed, so a copied row on a different
      // binding is bounded by its ancestors — EXCEPT when the causing node is
      // the ROOT, where there are no ancestors and the fold becomes
      // `ceiling(new binding) ∩ envelope`. A wider second binding on the same
      // account would then hand the copy more than the node it came from had.
      // One line closes it: the copy runs where the original ran.
      if (causing && binding.id !== causing.node.binding_id) {
        notCreated[cid] = setError(
          "forbidden",
          `this invocationToken acts for an invocation on binding ${causing.node.binding_id}; ` +
            `an invocation it causes must run on the same binding, not "${binding.name}"`,
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
      const email = await ctx.env.DB.prepare(`SELECT id FROM emails WHERE account_id = ? AND id = ?`)
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
      if (causing) {
        // THE INHERIT (s17 (d) rule 2) — byte-for-byte the shape
        // `actionProposal.ts`'s needsInfo continuation uses, and for the same
        // stated rule: an invocation CAUSED by a delegated node carries that
        // node's envelope.
        //
        //   job_id        the round belongs to the same Job. Without it the row
        //                 is `job_id IS NULL`, which is precisely how the fold
        //                 is told "there is no delegation here" — attenuation
        //                 SIDESTEPPED rather than exceeded, the harder failure
        //                 to see.
        //   parent_id     the node's own parent, so this is a SIBLING and not a
        //                 descendant. A descendant at depth + 1 would let N
        //                 creates buy N levels of `maxDepth`.
        //   depth         copied for the same reason.
        //   authority_json the same envelope. Never narrowed (this is the
        //                 node's own work continuing) and never widened — the
        //                 fold re-intersects it against every ancestor and
        //                 every binding at USE time, so a copy can only ever
        //                 restate what the chain already allows.
        //   privacy       rides along on the facet axis: it narrows the
        //                 claimant set and never widens it, so a pinned Job
        //                 cannot spawn an unpinned sibling whose work the paid
        //                 cloud may claim.
        //
        // Deliberately NOT copied, exactly as the needsInfo round does not:
        // `due_at` (it WIDENS the claimant set — a past deadline is what lets
        // the backstop claim outside the policy gate), `requires_json` (a fit
        // vector for the node's own work; inheriting "needs vision" would
        // strand this one) and `needs_json` (inheriting satisfied — or failed —
        // dependencies would block it on work it does not consume).
        //
        // THE DEFAULTCASE SURVIVES BY CONSTRUCTION: for an ordinary,
        // non-delegated causing node every one of these columns is NULL, so the
        // copy yields NULL and this is exactly the ungated invocation create has
        // always produced. There is no branch here to get wrong.
        const res = await ctx.env.DB.prepare(
          `INSERT INTO agent_invocations
             (id, account_id, binding_id, binding_name, status, email_id, context_json, created_at,
              job_id, parent_id, depth, authority_json, privacy)
           SELECT ?, ?, ?, ?, 'pending', ?, ?, ?,
                  node.job_id, node.parent_id, node.depth, node.authority_json, node.privacy
             FROM agent_invocations node
            WHERE node.account_id = ? AND node.id = ?`,
        )
          .bind(
            invId,
            access.accountId,
            binding.id,
            binding.name,
            emailId,
            JSON.stringify(context),
            createdAt,
            access.accountId,
            causing.invocationId,
          )
          .run();
        if ((res.meta.changes ?? 0) !== 1) {
          // The node vanished between `resolveInvocationToken` and here. Fail
          // rather than fall back to an envelope-less INSERT: "I cannot read the
          // thing that would bound this" is answered `no` everywhere else in
          // s17, and the permissive fallback is exactly the bug.
          notCreated[cid] = setError(
            "forbidden",
            "the causing invocation disappeared mid-request — refusing to create an " +
              "invocation whose authority envelope cannot be inherited",
          );
          continue;
        }
      } else {
        await ctx.env.DB.prepare(
          `INSERT INTO agent_invocations
             (id, account_id, binding_id, binding_name, status, email_id, context_json, created_at)
           VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
        )
          .bind(invId, access.accountId, binding.id, binding.name, emailId, JSON.stringify(context), createdAt)
          .run();
      }
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
      const still = await ctx.env.DB.prepare(`SELECT status FROM agent_invocations WHERE account_id = ? AND id = ?`)
        .bind(access.accountId, id)
        .first<{ status: string }>();
      notUpdated[id] =
        still?.status === "pending"
          ? setError("forbidden", "claim refused: this claimant is not eligible for this invocation yet (fit/policy)")
          : setError("notFound", "no such invocation (or already claimed)");
    }

    // ---- destroy: purge an invocation ----
    const destroy = Array.isArray(args.destroy) ? (args.destroy as string[]) : [];
    for (const id of destroy) {
      const row = await ctx.env.DB.prepare(`SELECT status FROM agent_invocations WHERE account_id = ? AND id = ?`)
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
        notDestroyed[id] = setError("forbidden", "cannot destroy a running invocation — wait for it to finish or fail");
        continue;
      }
      await ctx.env.DB.prepare(`DELETE FROM agent_invocations WHERE account_id = ? AND id = ?`)
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

  registry.register("AgentInvocation/changes", async (args, ctx) => proxyChanges(ctx, args, "AgentInvocation"));
}

/**
 * MANDATORY RULE 2 (s17 (d)) — WHICH NODE CAUSED THIS CREATE, AND MAY THIS
 * CALLER CREATE AT ALL.
 *
 * ── WHY MINTING, AND NOT A SELF-ASSERTED ID ────────────────────────────────
 * Every other s17 gate could have been built on a self-asserted `invocationId`,
 * because the envelope only ever NARROWS: naming someone else's invocation at
 * MCP or at the Bureau only intersects you with their envelope, and you already
 * passed your own standing check. `create` is the one place that reasoning
 * fails, because create **copies** the envelope onto a new row rather than
 * intersecting it. An agent that could name a node it does not hold would name
 * the ROOT PLANNER instead of its own leaf and mint a sibling carrying the
 * root's wide envelope — intra-Job envelope-hopping, which is exactly the threat
 * model a root-with-narrow-children design exists to stop. Possession of the
 * minted token is what makes "the presented node" and "the caller's own node"
 * the same sentence, and it is why gap 3 closes here and could not close by
 * propagation.
 *
 * ── THE THREE ANSWERS ──────────────────────────────────────────────────────
 *   token presented    → it must RESOLVE (live: `status='running'`, binding
 *                        `enabled=1`, unexpired) and must be on THIS account.
 *                        The create then inherits from it, whoever the caller
 *                        is: presenting a token means "this create is caused by
 *                        that node", and that is true for a human debugging a
 *                        Job as much as for an agent.
 *   no token, marked   → REFUSED. The rule.
 *   no token, unmarked → today's behavior, byte for byte. Humans, the
 *                        `bullmoose agent invoke` CLI path, third-party clients.
 *
 * The predicate is `isAgentPrincipal(ctx.principal)` — the BEARER's marker —
 * and deliberately not `ctx.agent`, which is in-process provenance the trusted
 * harness stamps on its own bridge calls (`jmapBridge.ts`, `commitHeld.ts`).
 * Rule 2 is about what a credential may do, and provenance is not a credential.
 *
 * The account check is not redundant with `requireAccount`: that authorized the
 * BEARER for the target account, and this authorizes the TOKEN, which is bound
 * to exactly one account (the one its binding lives on). A runtime holding a
 * grant on two accounts must not inherit account A's envelope into account B —
 * where the row would be, and the fold's chain walk is `account_id`-scoped, so
 * the copied `parent_id` would dangle and deny at use time. Refusing here says
 * so at the create instead of stranding the row.
 */
async function resolveCausingNode(
  ctx: RequestContext,
  args: Record<string, unknown>,
  accountId: string,
): Promise<{ causing: InvocationIdentity | null; causingRefusal: string | null }> {
  const presented = typeof args.invocationToken === "string" ? args.invocationToken : null;

  if (!presented) {
    if (isAgentPrincipal(ctx.principal)) {
      return {
        causing: null,
        causingRefusal:
          "an agent-marked token may not create an invocation on its own authority — pass " +
          "`invocationToken`, the credential this invocation's claim returned in " +
          "updated[id].invocationToken, so the new row inherits this node's authority envelope",
      };
    }
    return { causing: null, causingRefusal: null };
  }

  const causing = await resolveInvocationToken(ctx.env.DB, presented);
  if (!causing) {
    // One refusal for every way it can fail — expired, finished, revoked
    // binding, wrong secret, not a token at all. Distinguishing them would tell
    // a prober which of those is true about a token they do not hold. Note the
    // token itself is never echoed into a SetError.
    return {
      causing: null,
      causingRefusal:
        "invocationToken does not resolve — it is malformed, expired, or its invocation is " +
        "no longer running (or its binding has been disabled)",
    };
  }
  if (causing.accountId !== accountId) {
    return {
      causing: null,
      causingRefusal: "invocationToken acts for an invocation on a different account",
    };
  }
  return { causing, causingRefusal: null };
}
