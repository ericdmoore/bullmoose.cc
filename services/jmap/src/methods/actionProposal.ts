import { MethodError, type MethodRegistry } from "@bullmoose/jmap-core";
import { commitChanges, type ChangeEntry } from "@bullmoose/account-do";
import type { ContactCardRow, JSContactCard } from "@bullmoose/mailstore";
import { authorizeAccount } from "../auth";
import {
  accountState,
  proxyChanges,
  requireAccount,
  setError,
  storeFor,
  type RequestContext,
  type SetError,
} from "./common";

/**
 * ActionProposal (urn:bullmoose:params:jmap:agent) — the human review surface
 * for agent-proposed work, and a READ MODEL over `agent_invocations`, not a
 * parallel store (s03.D/arch.md §1).
 *
 * The invocation is the single source of truth for "what is the agent doing"
 * (pending→running→done→failed, the optimistic claim, the SLA watchdog). This
 * collection JOINs `agent_proposals` (the proposal-specific fields, keyed by the
 * SAME (account_id, id) as the invocation) onto that invocation and projects the
 * arch shape. `agent` and the live invocation status are READ from the
 * invocation, never duplicated (invariant §8.5).
 *
 * ⚠️ Write choreography (the recurring bug in this repo — `agent.test.ts` docs,
 * `filenode.ts` header): a `/set` must mutate → commit the ActionProposal
 * changelog entry → return newState. A decision that lands the row but skips
 * `commitChanges` reads back on a direct `/get` and is INVISIBLE to `/changes`
 * (and therefore to push). `applyProposal` folds its own writes' entries into the
 * SAME commit so one newState covers the whole transaction.
 *
 * `ActionProposal/set` is the human decision surface: `update` only. Agents do
 * NOT create proposals here — the agent worker produces them (services/agent
 * `emitProposal`); a `create` on this method is refused. The three decision
 * verbs and how tier drives them (arch.md §2):
 *
 *   tier 1  reversible   → apply immediately, keep an undo handle
 *   tier 2  retractable  → enter the hold tray (status `held`, `holdUntil`);
 *                          the yank-window commit is s03.D T2, not this slice
 *   tier 3  irreversible → a human action every time. The guarantee is the
 *                          CAPABILITY WALL, not policy (arch.md §2): approving a
 *                          tier-3 egress requires the `send` scope, which agents
 *                          structurally lack (mcp-auth.md §12 step 10; there is
 *                          no send tool, `mcpTools.test.ts:124-128`). A policy
 *                          bug is then a nuisance, never a breach.
 *
 * needsInfo (s10 T3, decline-taxonomy.md) — the third verb, an ACTION and not
 * a reject: judgment cannot yet be rendered, the missing input is information,
 * and it is the PROPOSER's to supply. `status: "info-requested"` with a
 * required human-authored `question` takes a `pending` row out of the human's
 * queue, PAUSES the pre-decision clock (the remaining window is banked in
 * `expires_remaining_ms`; `expires_at` goes NULL so the deadline cannot lapse
 * while the ball is in the agent's court) and enqueues a NEW
 * `answer-info-request` agent invocation (costed — chronic rounds show up in
 * $/approved-action). The agent's answer (services/agent `answerInfoRequest`)
 * fills the open round in `amendments_json` — APPEND beside the originals,
 * never over them (the `editedPayload` discipline) — and returns the row to
 * `pending` with the clock resumed. ONE round per human action: only a fresh
 * human needsInfo re-opens the loop. It never writes `decision_json`, so a
 * learning pipeline can never mistake it for negative feedback.
 */

/** Rejection reasons — the no-thanks signal (arch.md §3), as revised by
 * decline-taxonomy.md. A reason earns its place only if it changes what the
 * agent does NEXT, so each of the three steers a different correction:
 *
 *   wrongContent  right target, wrong output (the reply was bad, the event
 *                 details off) → fix GENERATION, keep the trigger.
 *   wrongAction   wrong target: it should not have proposed this KIND of thing
 *                 at all → fix SELECTION / policy. The loudest, and rare by
 *                 design — frequent `wrongAction` is a miscalibrated binding
 *                 (a config fix, s10-agents), not a per-proposal correction.
 *   unsafe        it leaked private information, or made a commitment on the
 *                 human's behalf. CATEGORICALLY SEPARATE from the other two: a
 *                 HARD negative, weighted heavily, never tolerated repeated —
 *                 not a stronger flavour of "no".
 *
 * `notNow` is RETIRED (decline-taxonomy.md). It was a grab-bag of three
 * different gradients under one label — "I'll do it myself" (POSITIVE on
 * selection → `tookItMyself`), "not due yet" (neutral, a scheduling signal →
 * edit `due_at` on the row, s11 T1, which records nothing) and "meh, later" (a
 * weak negative that collapses into a real reason). It was never a quality
 * judgment at all, which is why it read as confusing. New decisions may not
 * carry it.
 *
 * HISTORY IS NOT REWRITTEN. Retiring a reason narrows the WRITE path only.
 * Rows whose `decision_json` already carries `reason: "notNow"` keep it
 * verbatim — no migration, no backfill — and `proposalToJmap` projects
 * `decision` unvalidated, so a legacy decision still reads. A recorded human
 * decision is a fact; rewriting one to fit a later taxonomy would be exactly
 * the audit hole this codebase refuses everywhere else. Clients render an
 * unrecognized reason AS ITSELF, marked retired (webmail rows.ts
 * `describeReason`, cli-go `proposal.ReasonLabel`).
 *
 * `needsInfo` is deliberately NOT in this set (decline-taxonomy.md): it is an
 * ACTION (`status: "info-requested"`), never a reject reason, so it can never
 * land in a rejection record — the taxonomy's invariant excludes
 * tookItMyself/needsInfo from the negative signal, and the enum is where that
 * invariant is enforced on the write path.
 *
 * ⚠️ THE RL INVARIANT, for whoever writes the first consumer: `unsafe` is the
 * categorically-separate hard negative and must be weighted as such, never
 * averaged in with wrongContent/wrongAction; `needsInfo` and `tookItMyself`
 * must stay OUT of the negative signal entirely. Nothing reads these reasons
 * for learning or scoring today — this enum and the render paths are the only
 * readers — so the invariant lives here until there is a pipeline to put it in. */
const REJECT_REASONS = new Set(["wrongContent", "wrongAction", "unsafe"]);

/**
 * The tier-2 post-approval retraction window. A tier-2 approve enters the hold
 * tray with `holdUntil = now + this`; committing out of the tray (and the
 * yank-before-commit UI) is s03.D T2. Distinct clock from `expiresAt` (the
 * pre-decision deadline) — conflating them is a bug (s07 §T0).
 */
const HOLD_WINDOW_MS = 5 * 60_000;

/** The JOINed read-model row: proposal columns + the invocation it hangs off. */
interface ProposalJoinRow {
  id: string;
  account_id: string;
  kind: string;
  tier: number;
  subject_json: string;
  payload_json: string;
  edited_payload_json: string | null;
  rationale: string;
  evidence_json: string;
  status: string;
  decision_json: string | null;
  created_at: number;
  decided_at: number | null;
  hold_until: number | null;
  expires_at: number | null;
  // needsInfo (s10 T3): the open question, the append-only Q&A rounds, and
  // the banked (paused) remainder of the pre-decision clock.
  question: string | null;
  amendments_json: string | null;
  expires_remaining_ms: number | null;
  // projected from agent_invocations — the single source of truth (§8.5):
  binding_id: string;
  binding_name: string;
  inv_status: string;
  claimed_at: number | null;
  email_id: string | null;
}

const SELECT_JOIN = `
  SELECT p.id, p.account_id, p.kind, p.tier, p.subject_json, p.payload_json,
         p.edited_payload_json, p.rationale, p.evidence_json, p.status,
         p.decision_json, p.created_at, p.decided_at, p.hold_until, p.expires_at,
         p.question, p.amendments_json, p.expires_remaining_ms,
         inv.binding_id, inv.binding_name, inv.status AS inv_status,
         inv.claimed_at, inv.email_id
    FROM agent_proposals p
    JOIN agent_invocations inv
      ON inv.account_id = p.account_id AND inv.id = p.id`;

export function registerActionProposalMethods(registry: MethodRegistry<RequestContext>): void {
  registry.register("ActionProposal/get", async (args, ctx) => {
    const access = await requireAccount(ctx, args, "read");
    const ids = args.ids === null || args.ids === undefined ? undefined : (args.ids as string[]);
    const properties = Array.isArray(args.properties) ? (args.properties as string[]) : null;

    let rows: ProposalJoinRow[];
    if (ids === undefined) {
      const { results } = await ctx.env.DB.prepare(
        `${SELECT_JOIN} WHERE p.account_id = ? ORDER BY p.created_at DESC LIMIT 256`,
      )
        .bind(access.accountId)
        .all<ProposalJoinRow>();
      rows = results;
    } else if (ids.length === 0) {
      rows = [];
    } else {
      const marks = ids.map(() => "?").join(",");
      const { results } = await ctx.env.DB.prepare(
        `${SELECT_JOIN} WHERE p.account_id = ? AND p.id IN (${marks})`,
      )
        .bind(access.accountId, ...ids)
        .all<ProposalJoinRow>();
      rows = results;
    }
    const found = new Set(rows.map((r) => r.id));
    const dueAt = await invocationDueAt(ctx, access.accountId, rows.map((r) => r.id));

    return {
      accountId: access.accountId,
      state: await accountState(ctx, access.accountId),
      list: rows.map((r) => pickProps(proposalToJmap(r, dueAt.get(r.id) ?? null), properties)),
      notFound: (ids ?? []).filter((id) => !found.has(id)),
    };
  });

  registry.register("ActionProposal/query", async (args, ctx) => {
    const access = await requireAccount(ctx, args, "read");
    const filter = (args.filter as Record<string, unknown> | null | undefined) ?? null;
    if (filter) {
      for (const key of Object.keys(filter)) {
        if (key !== "status") {
          throw new MethodError("unsupportedFilter", `unknown filter property "${key}"`);
        }
      }
    }
    // Optional status filter: a single status or a set. The default queue is
    // everything, newest first — the client narrows to `pending`/`held`.
    const wanted =
      filter && filter.status !== undefined
        ? Array.isArray(filter.status)
          ? (filter.status as string[])
          : [filter.status as string]
        : null;

    let sql = `SELECT id FROM agent_proposals WHERE account_id = ?`;
    const binds: unknown[] = [access.accountId];
    if (wanted) {
      sql += ` AND status IN (${wanted.map(() => "?").join(",")})`;
      binds.push(...wanted);
    }
    sql += ` ORDER BY created_at DESC LIMIT 256`;
    const { results } = await ctx.env.DB.prepare(sql)
      .bind(...binds)
      .all<{ id: string }>();

    return {
      accountId: access.accountId,
      queryState: await accountState(ctx, access.accountId),
      canCalculateChanges: false,
      position: 0,
      ids: results.map((r) => r.id),
    };
  });

  registry.register("ActionProposal/changes", async (args, ctx) =>
    proxyChanges(ctx, args, "ActionProposal"),
  );

  // Advertised canCalculateChanges: false — conformant clients re-query.
  registry.register("ActionProposal/queryChanges", async () => {
    throw new MethodError("cannotCalculateChanges");
  });

  registry.register("ActionProposal/set", async (args, ctx) => {
    // Base gate: reviewing/deciding is a `draft`-tier mail action, the same
    // scope AgentInvocation/set takes. A tier-3 APPROVE additionally demands the
    // `send` scope below — the capability wall (arch.md §2).
    const access = await requireAccount(ctx, args, "draft", "mail");

    const oldState = await accountState(ctx, access.accountId);
    if (typeof args.ifInState === "string" && args.ifInState !== oldState) {
      throw new MethodError("stateMismatch");
    }

    // Agents produce proposals through the worker (services/agent), never here.
    if (args.create && Object.keys(args.create as object).length > 0) {
      throw new MethodError(
        "invalidArguments",
        "ActionProposal has no create: proposals are produced by the agent worker, " +
          "not created over JMAP. ActionProposal/set is the human decision surface (update).",
      );
    }

    const updated: Record<string, null> = {};
    const notUpdated: Record<string, SetError> = {};
    const destroyed: string[] = [];
    const notDestroyed: Record<string, SetError> = {};
    const propEntry: ChangeEntry = { collection: "ActionProposal", created: [], updated: [], destroyed: [] };
    const applyEntries: ChangeEntry[] = [];

    const updateSpecs = (args.update as Record<string, Record<string, unknown>> | undefined) ?? {};
    for (const [id, patch] of Object.entries(updateSpecs)) {
      try {
        const row = await loadProposal(ctx, access.accountId, id);
        if (!row) throw new NotFound();
        // T1 decides only from `pending`. `held` (post-approval hold tray) and
        // the terminal states are not re-decidable here — that is T2's yank.
        if (row.status !== "pending") {
          throw new SetErrorSignal("invalidProperties", `proposal is ${row.status}, not pending`, ["status"]);
        }

        // ---- s11 T1: due-date CORRECTION — not a decision ----
        // The boundary's extracted `due_at` is a proposal the human can see
        // and fix (readme caution 3), so a status-free `{ dueAt }` patch is
        // the correction verb: it writes the INVOCATION (due_at lives there —
        // it is the work's deadline, the field the scheduler reads, not a
        // proposal clock) and leaves the row pending and undecided. Same
        // discipline as editedPayload: the human's word lands as its own
        // first-class write, never entangled with a verdict — which is why a
        // patch carrying BOTH is refused rather than half-applied.
        if (patch.dueAt !== undefined && patch.status === undefined) {
          const dueAtMs = parseDueAt(patch.dueAt);
          await ctx.env.DB.prepare(
            `UPDATE agent_invocations SET due_at = ? WHERE account_id = ? AND id = ?`,
          )
            .bind(dueAtMs, access.accountId, id)
            .run();
          // Both collections moved: the invocation carries the value, the
          // proposal projects it — commit choreography or the correction is
          // invisible to /changes (this file's header).
          applyEntries.push({ collection: "AgentInvocation", created: [], updated: [id], destroyed: [] });
          propEntry.updated.push(id);
          updated[id] = null;
          continue;
        }
        if (patch.dueAt !== undefined) {
          throw new SetErrorSignal(
            "invalidProperties",
            "dueAt is a correction, not part of a decision — send it in its own update, without status",
            ["dueAt"],
          );
        }

        const status = patch.status;
        if (status !== "approved" && status !== "rejected" && status !== "info-requested") {
          throw new SetErrorSignal(
            "invalidProperties",
            'status must be "approved", "rejected" or "info-requested"',
            ["status"],
          );
        }

        // ---- needsInfo (s10 T3): an action, not a reject ----
        if (status === "info-requested") {
          // Only `question` rides on this verb. Refusing a `decision` here is
          // the RL invariant made structural: needsInfo must never produce a
          // rejection record (decline-taxonomy.md), and an editedPayload
          // belongs to approve, not to a question.
          if (patch.decision !== undefined || patch.editedPayload !== undefined) {
            throw new SetErrorSignal(
              "invalidProperties",
              "needsInfo carries only a question — no decision (it is not a reject) and no editedPayload",
              ["status"],
            );
          }
          const question = typeof patch.question === "string" ? patch.question.trim() : "";
          if (question.length === 0) {
            throw new SetErrorSignal(
              "invalidProperties",
              "needsInfo requires a non-empty human-authored question",
              ["question"],
            );
          }
          const now = Date.now();
          // PAUSE the pre-decision clock: bank the remaining window and NULL
          // the deadline, so the sweep cannot lapse a proposal while the ball
          // is in the agent's court. The answer path restores
          // expires_at = now + expires_remaining_ms (proposals.ts).
          const remaining = row.expires_at !== null ? Math.max(0, row.expires_at - now) : null;
          // APPEND the open round. rationale/evidence_json are the agent's
          // originals and are never rewritten (the editedPayload discipline).
          const amendments = safeJsonArray(row.amendments_json ?? "[]");
          amendments.push({
            question,
            answer: null,
            askedAt: new Date(now).toISOString(),
            answeredAt: null,
            askedBy: ctx.principal.username,
          });
          await ctx.env.DB.prepare(
            `UPDATE agent_proposals SET status = 'info-requested', question = ?,
               amendments_json = ?, expires_at = NULL, expires_remaining_ms = ?
             WHERE account_id = ? AND id = ? AND status = 'pending'`,
          )
            .bind(question, JSON.stringify(amendments), remaining, access.accountId, id)
            .run();

          // The answer round is a NEW invocation for the proposal's binding —
          // it goes through the ordinary drain (claim, run, finish) and is
          // COSTED, so chronic needsInfo rounds show up in $/approved-action.
          const answerInvId = `inv_${crypto.randomUUID()}`;
          await ctx.env.DB.prepare(
            `INSERT INTO agent_invocations
               (id, account_id, binding_id, binding_name, status, email_id, context_json, created_at)
             VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
          )
            .bind(
              answerInvId,
              access.accountId,
              row.binding_id,
              row.binding_name,
              row.email_id,
              JSON.stringify({ kind: "answer-info-request", proposalId: id, question }),
              now,
            )
            .run();
          applyEntries.push({
            collection: "AgentInvocation",
            created: [answerInvId],
            updated: [],
            destroyed: [],
          });
          propEntry.updated.push(id);
          updated[id] = null;
          continue;
        }

        // The human's edit is captured SEPARATELY and never overwrites the
        // agent's original payload — that retention is what lets a later score
        // tell "approved clean" from "approved after edit" (s07 §T4).
        const editedPayload = patch.editedPayload;
        if (editedPayload !== undefined && (editedPayload === null || typeof editedPayload !== "object")) {
          throw new SetErrorSignal("invalidProperties", "editedPayload must be an object", ["editedPayload"]);
        }
        const decision = buildDecision(ctx, patch.decision);

        const now = Date.now();
        if (status === "rejected") {
          await ctx.env.DB.prepare(
            `UPDATE agent_proposals SET status = 'rejected', decided_at = ?,
               decision_json = ?, edited_payload_json = COALESCE(?, edited_payload_json)
             WHERE account_id = ? AND id = ?`,
          )
            .bind(
              now,
              JSON.stringify(decision),
              editedPayload !== undefined ? JSON.stringify(editedPayload) : null,
              access.accountId,
              id,
            )
            .run();
          propEntry.updated.push(id);
          updated[id] = null;
          continue;
        }

        // ---- approve ----
        if (row.kind === "grant-request" && ctx.agent?.binding === row.binding_name) {
          // CJ-cannot-self-approve (s10 T3): the approver of a grant-request
          // must not be the principal that benefits. When an agent binding
          // drove this call (ctx.agent — the s03 bridge populates it) and it
          // IS the proposal's binding, the agent is approving its own
          // widening — refused. A human decision (ctx.agent absent) is always
          // fine, and so is a DIFFERENT binding with bounded approval
          // authority (CJ approving photos@'s ask) — recorded as itself via
          // decision.by, never indistinguishable from a human.
          throw new SetErrorSignal(
            "forbidden",
            `a grant-request cannot be approved by its beneficiary: binding "${row.binding_name}" ` +
              "may not approve its own widening (s10 T3). A human, or a differently-bound " +
              "approver, must decide.",
            ["status"],
          );
        }
        if (row.tier === 3) {
          // THE CAPABILITY WALL. Approving a tier-3 (irreversible egress) is a
          // human action every time: it requires the `send` scope, which an
          // agent token structurally lacks. This reuses the exact gate the real
          // send path uses — no separate policy layer to get wrong.
          const send = authorizeAccount(ctx.principal, access.accountId, "send", "mail");
          if (!send.ok) {
            throw new SetErrorSignal(
              "forbidden",
              "approving a tier-3 proposal requires the send capability (a human action); " +
                "an agent token cannot auto-commit irreversible egress",
              ["status"],
            );
          }
        }

        if (row.tier === 2) {
          // Enter the hold tray. The commit-out-of-tray (and yank-before-commit)
          // is s03.D T2 — deliberately NOT done here, so nothing egresses before
          // the retraction UI exists.
          await ctx.env.DB.prepare(
            `UPDATE agent_proposals SET status = 'held', decided_at = ?, hold_until = ?,
               decision_json = ?, edited_payload_json = COALESCE(?, edited_payload_json)
             WHERE account_id = ? AND id = ?`,
          )
            .bind(
              now,
              now + HOLD_WINDOW_MS,
              JSON.stringify(decision),
              editedPayload !== undefined ? JSON.stringify(editedPayload) : null,
              access.accountId,
              id,
            )
            .run();
          propEntry.updated.push(id);
          updated[id] = null;
          continue;
        }

        // tier 1 (immediate, reversible) and tier 3 (human already authorized):
        // apply now. The applied write stamps provenance (the approved-proposal
        // application is an agent write — .feedback common/033).
        const effectivePayload =
          editedPayload !== undefined
            ? (editedPayload as Record<string, unknown>)
            : safeJson(row.payload_json);
        const { entries, undo } = await applyProposal(ctx, access, row, effectivePayload);
        applyEntries.push(...entries);

        await ctx.env.DB.prepare(
          `UPDATE agent_proposals SET status = 'approved', decided_at = ?,
             decision_json = ?, edited_payload_json = COALESCE(?, edited_payload_json)
           WHERE account_id = ? AND id = ?`,
        )
          .bind(
            now,
            JSON.stringify({ ...decision, ...(undo ? { undo } : {}) }),
            editedPayload !== undefined ? JSON.stringify(editedPayload) : null,
            access.accountId,
            id,
          )
          .run();
        propEntry.updated.push(id);
        updated[id] = null;
      } catch (err) {
        notUpdated[id] = toSetError(err);
      }
    }

    // Destroy: purge a decided proposal (housekeeping). A pending one is refused
    // — decide it, don't drop it (the queue is the point).
    for (const id of (args.destroy as string[] | undefined) ?? []) {
      try {
        const row = await loadProposal(ctx, access.accountId, id);
        if (!row) throw new NotFound();
        if (row.status === "pending") {
          throw new SetErrorSignal("forbidden", "decide a pending proposal rather than destroying it");
        }
        await ctx.env.DB.prepare(`DELETE FROM agent_proposals WHERE account_id = ? AND id = ?`)
          .bind(access.accountId, id)
          .run();
        propEntry.destroyed.push(id);
        destroyed.push(id);
      } catch (err) {
        notDestroyed[id] = toSetError(err);
      }
    }

    // ONE commit for the whole transaction — the proposal transition plus any
    // writes its application produced — so a single newState is authoritative.
    const entries = [propEntry, ...applyEntries].filter(
      (e) => e.created.length + e.updated.length + e.destroyed.length > 0,
    );
    let newState = oldState;
    if (entries.length > 0) {
      ({ newState } = await commitChanges(ctx.env.ACCOUNT_DO, access.accountId, entries));
    }

    return {
      accountId: access.accountId,
      oldState,
      newState,
      created: {},
      notCreated: {},
      updated,
      notUpdated,
      destroyed,
      notDestroyed,
    };
  });
}

// ---- apply ----------------------------------------------------------------

/**
 * Perform the write an approved proposal describes, returning the changelog
 * entries for the caller to fold into the single commit, plus an undo handle for
 * reversible (tier-1) applications. Provenance is stamped through the Mailstore
 * write path: the approving human is the principal, and the agent binding +
 * invocation the proposal projects over ride along, so the applied write is
 * attributable to "the human approved the agent's proposal" rather than landing
 * NULL (.feedback common/033).
 */
async function applyProposal(
  ctx: RequestContext,
  access: { accountId: string; tenantId: string },
  row: ProposalJoinRow,
  payload: Record<string, unknown>,
): Promise<{ entries: ChangeEntry[]; undo?: Record<string, unknown> }> {
  const provCtx: RequestContext = {
    ...ctx,
    agent: { binding: row.binding_name, invocation: row.id },
  };
  const store = storeFor(provCtx);

  switch (row.kind) {
    case "create-contact": {
      const card = payload.card as JSContactCard | undefined;
      if (!card || typeof card !== "object") {
        throw new SetErrorSignal("invalidProperties", "create-contact payload needs a `card`", ["payload"]);
      }
      const { id: bookId, change } = await store.ensureDefaultAddressBook(access.accountId);
      const now = Date.now();
      const nowIso = new Date(now).toISOString();
      const built: JSContactCard = { ...card };
      built["@type"] = "Card";
      if (built.version === undefined) built.version = "1.0";
      if (built.uid === undefined) built.uid = `urn:uuid:${crypto.randomUUID()}`;
      built.created = typeof built.created === "string" ? built.created : nowIso;
      built.updated = nowIso;
      built.addressBookIds = { [bookId]: true };
      const cardRow: ContactCardRow = {
        id: `cc_${crypto.randomUUID()}`,
        addressBookId: bookId,
        uid: built.uid as string,
        card: built,
        nameFull: typeof built.name?.full === "string" ? built.name.full : null,
        davName: null,
        createdAt: now,
        updatedAt: now,
      };
      // An approved-proposal write is still an AGENT write at the chokepoint —
      // the human's approval rides as `authorization`, which is what a
      // propose/governed book accepts and RECORDS (via_proposal_id, s10 T2).
      await store.insertContactCard(access.accountId, cardRow, {
        principal: ctx.principal.username,
        kind: "agent",
        binding: row.binding_name,
        invocation: row.id,
        authorization: { proposalId: row.id },
      });
      const entries: ChangeEntry[] = [
        { collection: "ContactCard", created: [cardRow.id], updated: [], destroyed: [] },
      ];
      if (change) {
        entries.push({ collection: "AddressBook", created: change === "created" ? [bookId] : [], updated: change === "updated" ? [bookId] : [], destroyed: [] });
      }
      // The undo handle a tier-1 application keeps (arch.md §2).
      return { entries, undo: { action: "destroy-contact", cardId: cardRow.id } };
    }

    case "reply-draft": {
      // The irreversible egress (tier 3, human-approved). Relay the drafted MIME
      // through the submit worker, then record a Sent copy whose provenance the
      // Mailstore stamps. There is no undo — that irreversibility is exactly why
      // it is tier 3.
      const to = str(payload.to);
      const self = str(payload.self);
      const blobId = str(payload.blobId);
      const subject = str(payload.subject) ?? "";
      const text = str(payload.text) ?? "";
      if (!to || !self || !blobId) {
        throw new SetErrorSignal("invalidProperties", "reply-draft payload needs to/self/blobId", ["payload"]);
      }
      const res = await ctx.env.SUBMIT.fetch("https://submit.internal/internal/submit", {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-token": ctx.env.INTERNAL_TOKEN },
        body: JSON.stringify({
          accountId: access.accountId,
          tenantId: access.tenantId,
          blobId,
          envelope: { mailFrom: self, rcptTo: [to] },
        }),
      });
      if (!res.ok) {
        throw new SetErrorSignal("serverFail", `submit relay failed (${res.status})`);
      }
      const now = Date.now();
      const sentMailbox = await store.ensureRoleMailbox(access.accountId, "sent", "Sent");
      const emailId = `e_${crypto.randomUUID()}`;
      await store.insertEmail(access.accountId, {
        id: emailId,
        blobId,
        threadId: await store.resolveThreadId(access.accountId, str(payload.inReplyTo) ?? null),
        messageId: str(payload.messageId) ?? `${crypto.randomUUID()}@${self.split("@")[1] ?? "localhost"}`,
        inReplyTo: str(payload.inReplyTo) ?? null,
        subject,
        from: [{ name: row.binding_name, email: self }],
        to: [{ email: to }],
        cc: [],
        bcc: [],
        preview: text.slice(0, 256),
        bodyText: text,
        size: text.length,
        receivedAt: now,
        hasAttachment: false,
        attachments: [],
        mailboxIds: [sentMailbox],
        keywords: ["$seen", "$agent"],
      });
      return {
        entries: [
          { collection: "Email", created: [emailId], updated: [], destroyed: [] },
          { collection: "Mailbox", created: [], updated: [sentMailbox], destroyed: [] },
        ],
      };
    }

    case "grant-request": {
      // Two shapes share this kind. The ORIGINAL contract stands for
      // scope-style asks ({scope, target, durationDays, …}): the queue is
      // unified (arch.md §1), but MINTING the grant is provision's job (s04),
      // reached by watching approved grant-request proposals — the decision is
      // recorded here; no local write.
      //
      // An ALLOWLIST WIDENING (s10 T3) is the exception, discriminated by
      // grantType: "recipient" — "let me email <address>". Its "minting" IS a
      // contact write into the governing book, applied here THROUGH the
      // mailstore chokepoint with the proposal as authorization
      // ({proposalId} → via_proposal_id, the s10 T1/T2 contract), so the T2
      // chain links the membership change to the rationale, evidence and
      // approver that produced it.
      if (str(payload.grantType) !== "recipient") return { entries: [] };
      const bookId = str(payload.bookId);
      const address = str(payload.address);
      if (!bookId || !address) {
        throw new SetErrorSignal(
          "invalidProperties",
          "a recipient grant-request payload needs bookId + address",
          ["payload"],
        );
      }
      const book = await ctx.env.DB.prepare(
        `SELECT id FROM address_books WHERE account_id = ? AND id = ?`,
      )
        .bind(access.accountId, bookId)
        .first<{ id: string }>();
      if (!book) {
        throw new SetErrorSignal(
          "invalidProperties",
          `address book "${bookId}" not found in this account`,
          ["payload"],
        );
      }
      const now = Date.now();
      const nowIso = new Date(now).toISOString();
      const name = str(payload.name);
      const card: JSContactCard = {
        "@type": "Card",
        version: "1.0",
        uid: `urn:uuid:${crypto.randomUUID()}`,
        created: nowIso,
        updated: nowIso,
        ...(name ? { name: { full: name } } : {}),
        emails: { primary: { address } },
        addressBookIds: { [bookId]: true },
      };
      const cardRow: ContactCardRow = {
        id: `cc_${crypto.randomUUID()}`,
        addressBookId: bookId,
        uid: card.uid as string,
        card,
        nameFull: name,
        davName: null,
        createdAt: now,
        updatedAt: now,
      };
      // The chokepoint write. An approved widening is still an AGENT write —
      // the human's approval rides as `authorization`, whose proposalId T2
      // stamps as via_proposal_id on the membership-log row.
      await store.insertContactCard(access.accountId, cardRow, {
        principal: ctx.principal.username,
        kind: "agent",
        binding: row.binding_name,
        invocation: row.id,
        authorization: { proposalId: row.id },
      });
      await store.bumpAddressBookCtags(access.accountId, [bookId]);
      return {
        entries: [{ collection: "ContactCard", created: [cardRow.id], updated: [], destroyed: [] }],
        // The undo handle a tier-1 application keeps (arch.md §2).
        undo: { action: "destroy-contact", cardId: cardRow.id },
      };
    }

    default:
      throw new SetErrorSignal(
        "invalidProperties",
        `approving a "${row.kind}" proposal is not applied in this slice (s03.D T1)`,
        ["kind"],
      );
  }
}

// ---- helpers --------------------------------------------------------------

class NotFound extends Error {}

class SetErrorSignal extends Error {
  constructor(
    public type: string,
    public description?: string,
    public properties?: string[],
  ) {
    super(description ?? type);
  }
}

function toSetError(err: unknown): SetError {
  if (err instanceof NotFound) return setError("notFound");
  if (err instanceof SetErrorSignal) {
    return {
      type: err.type,
      ...(err.description ? { description: err.description } : {}),
      ...(err.properties ? { properties: err.properties } : {}),
    };
  }
  if (err instanceof MethodError) return setError("invalidProperties", err.description ?? err.type);
  return setError("serverFail", String(err));
}

async function loadProposal(
  ctx: RequestContext,
  accountId: string,
  id: string,
): Promise<ProposalJoinRow | null> {
  return (
    (await ctx.env.DB.prepare(`${SELECT_JOIN} WHERE p.account_id = ? AND p.id = ?`)
      .bind(accountId, id)
      .first<ProposalJoinRow>()) ?? null
  );
}

/**
 * s11 T1 — `due_at` for a set of invocations, read via a SEPARATE tolerant
 * statement instead of a new name in SELECT_JOIN. Deliberate: the
 * `invocation-due-at` migration is NOT a deploy blocker (infra/migrations.mjs),
 * so a shard that predates it must render "no deadline" on every row rather
 * than fail every proposal read. Contrast proposal-needsinfo-columns, whose
 * columns the JOIN names and which therefore IS a blocker.
 */
async function invocationDueAt(
  ctx: RequestContext,
  accountId: string,
  ids: string[],
): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  try {
    const marks = ids.map(() => "?").join(",");
    const { results } = await ctx.env.DB.prepare(
      `SELECT id, due_at FROM agent_invocations WHERE account_id = ? AND id IN (${marks})`,
    )
      .bind(accountId, ...ids)
      .all<{ id: string; due_at: number | null }>();
    return new Map(
      results.filter((r) => r.due_at !== null).map((r) => [r.id, r.due_at as number]),
    );
  } catch {
    return new Map(); // pre-migration shard: every row reads "no deadline"
  }
}

/**
 * The correction's value: null clears (back to never-urgent), an ISO date
 * string sets. Anything else is refused — a deadline that does not parse must
 * not silently become "no deadline".
 */
function parseDueAt(raw: unknown): number | null {
  if (raw === null) return null;
  if (typeof raw === "string") {
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return ms;
  }
  throw new SetErrorSignal(
    "invalidProperties",
    "dueAt must be null (no deadline) or an ISO 8601 date string",
    ["dueAt"],
  );
}

/** The decision record (arch.md §3): who + reason enum + optional free text.
 *
 * The WRITE path is strict — only the live enum lands, so a retired reason
 * (`notNow`) is refused here and cannot enter a new record. The READ path
 * (`proposalToJmap`) is deliberately not: history keeps whatever it was
 * recorded with. Strict in, tolerant out. */
function buildDecision(ctx: RequestContext, raw: unknown): Record<string, unknown> {
  const decision: Record<string, unknown> = { by: ctx.principal.username };
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    if (r.reason !== undefined) {
      if (typeof r.reason !== "string" || !REJECT_REASONS.has(r.reason)) {
        throw new SetErrorSignal(
          "invalidProperties",
          "decision.reason must be wrongContent | wrongAction | unsafe",
          ["decision"],
        );
      }
      decision.reason = r.reason;
    }
    if (r.note !== undefined) {
      if (typeof r.note !== "string") {
        throw new SetErrorSignal("invalidProperties", "decision.note must be a string", ["decision"]);
      }
      decision.note = r.note;
    }
  }
  return decision;
}

function proposalToJmap(r: ProposalJoinRow, dueAt: number | null = null): Record<string, unknown> {
  return {
    id: r.id,
    agent: r.binding_name, // read from the invocation (§8.5), not stored twice
    kind: r.kind,
    tier: r.tier,
    subject: safeJson(r.subject_json),
    payload: safeJson(r.payload_json),
    editedPayload: r.edited_payload_json ? safeJson(r.edited_payload_json) : null,
    rationale: r.rationale,
    evidence: safeJsonArray(r.evidence_json),
    status: r.status,
    // Projected VERBATIM and unvalidated, on purpose: a decision recorded
    // under an older taxonomy (`reason: "notNow"`, retired — see
    // REJECT_REASONS) must still read. The enum narrows what may be WRITTEN,
    // never what may be read back; clients mark an unrecognized reason retired
    // rather than dropping or remapping it.
    decision: r.decision_json ? safeJson(r.decision_json) : null,
    createdAt: new Date(r.created_at).toISOString(),
    decidedAt: r.decided_at ? new Date(r.decided_at).toISOString() : null,
    holdUntil: r.hold_until ? new Date(r.hold_until).toISOString() : null,
    // NULL while a needsInfo round is open — the clock is banked in
    // expires_remaining_ms, not running (s10 T3).
    expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
    // s11 T1 — the THIRD clock: the WORK's deadline, projected from the
    // invocation (tolerantly — see invocationDueAt). NULL = never-urgent.
    dueAt: dueAt !== null ? new Date(dueAt).toISOString() : null,
    // needsInfo (s10 T3): the open question and the append-only Q&A dialogue.
    question: r.question ?? null,
    amendments: safeJsonArray(r.amendments_json ?? "[]"),
    // the read-model surface projected from the invocation:
    invocationStatus: r.inv_status,
    claimedAt: r.claimed_at ? new Date(r.claimed_at).toISOString() : null,
  };
}

function pickProps(full: Record<string, unknown>, properties: string[] | null): Record<string, unknown> {
  if (!properties) return full;
  const picked: Record<string, unknown> = { id: full.id };
  for (const p of properties) if (p in full) picked[p] = full[p];
  return picked;
}

function safeJson(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function safeJsonArray(s: string): unknown[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
