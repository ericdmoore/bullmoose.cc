import { MethodError, type MethodRegistry } from "@bullmoose/jmap-core";
import { commitChanges, type ChangeEntry } from "@bullmoose/account-do";
import { QUARANTINE_ROLE, type ContactCardRow, type JSContactCard, type Mailstore } from "@bullmoose/mailstore";
import {
  budgetExhaustedSql,
  budgetMonthStartMs,
  budgetPeriodKey,
  jobBudgetExhaustedSql,
} from "@bullmoose/scheduling";
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
 * readers — so the invariant lives here until there is a pipeline to put it in.
 *
 * ⚠️ THE INVARIANT GAINS A THIRD EXCLUSION (s11 T9): **a declined
 * `budget-overrun` is not negative feedback about the agent.** It joins
 * `tookItMyself` and `needsInfo` outside the negative signal, and for a sharper
 * reason than either: it is not a judgment about the agent's work AT ALL. The
 * proposal says "this binding is out of money and N invocations are waiting" —
 * declining says "not this month", which is a statement about the human's
 * wallet. Training on it would teach an agent to stop proposing work the human
 * WANTED but could not afford in August, which is reward poisoning with extra
 * steps. Enforced structurally rather than documented: `NO_FAULT_KINDS` below
 * refuses a reject `reason` on those kinds entirely, so the negative signal
 * cannot be written in the first place — the same discipline that keeps
 * `needsInfo` out of this enum. */
const REJECT_REASONS = new Set(["wrongContent", "wrongAction", "unsafe"]);

/**
 * s12 — the mid-band batch (services/agent `midBandProposal.ts` mints it under
 * this exact string; the two packages do not share a module, so the kind is
 * spelled here and pinned by `actionProposalHeldMail.test.ts`).
 *
 * Approve RELEASES the held messages to the Inbox as human rescues (ham
 * labels); decline CONFIRMS the shunts (spam labels). Both are answers, and
 * both clear the question from the queue — which is the whole point: what the
 * doorman cannot decide becomes a decision, not a folder.
 */
const HELD_MAIL_REVIEW = "held-mail-review";

/**
 * Kinds whose DECLINE says nothing about the agent, and which therefore may not
 * carry a reject reason (s11 T9; decline-taxonomy.md's excluded-from-negative-
 * signal rule). A `budget-overrun` decline is "keep waiting" — the work is not
 * cancelled, no invocation changes status, and `decision_json` records the
 * decider and an optional note, never a fault.
 *
 * This is where the invariant is ENFORCED on the write path, so the first RL
 * consumer inherits it whether or not it reads this comment: it cannot find a
 * `reason` on one of these rows, because none can be written.
 *
 * ⚠️ A FOURTH EXCLUSION (s12): a declined `held-mail-review` is not negative
 * feedback either — it is an ANSWER. The proposal asks "the boundary could not
 * judge these; spam or not?", so declining says "yes, spam, confirm the shunt",
 * which is the agent being RIGHT to ask. `wrongAction` on it would teach a
 * doorman to stop asking about mail it cannot judge, i.e. to guess — the exact
 * behaviour the mid-band proposal exists to replace.
 */
const NO_FAULT_KINDS = new Set(["budget-overrun", HELD_MAIL_REVIEW]);

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
        // Decisions happen from `pending` — with T2's one exception, now
        // built: a `held` row (post-approval hold tray) accepts exactly ONE
        // verb, `yanked`, while its window is open. Terminal states stay
        // terminal, and a held row still cannot be re-approved, re-rejected
        // or questioned — the human already decided; the tray only offers
        // the chance to take it back.
        if (row.status !== "pending" && !(row.status === "held" && patch.status === "yanked")) {
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
        if (status !== "approved" && status !== "rejected" && status !== "info-requested" && status !== "yanked") {
          throw new SetErrorSignal(
            "invalidProperties",
            'status must be "approved", "rejected", "info-requested" or "yanked"',
            ["status"],
          );
        }

        // ---- yank (s03.D T2): the retraction the hold window exists for ----
        //
        // Approving a tier-2 put it in the tray precisely so the human could
        // change their mind before it egresses. Yank is that change of mind:
        // legal ONLY from `held`, and only while the window is open — after
        // `hold_until` the sweep may already have committed, and a yank that
        // races a send must lose honestly rather than pretend it won.
        // A yank is neither an approval nor a decline for the learning loop:
        // the human approved the ACTION and retracted the MOMENT, so it
        // carries no wrongAction signal (the decline taxonomy's rule that a
        // reason earns its place only if it changes what the agent does next).
        if (status === "yanked") {
          if (row.status !== "held") {
            // Reachable only for `pending` (the gate above blocks terminal
            // states): yanking something not yet approved is a category
            // error — decline it instead.
            throw new SetErrorSignal(
              "invalidPatch",
              `only a held proposal can be yanked (this one is ${row.status}); a pending one is declined, not yanked`,
              ["status"],
            );
          }
          const yankNow = Date.now();
          if (row.hold_until !== null && yankNow >= row.hold_until) {
            throw new SetErrorSignal(
              "invalidPatch",
              "too late to yank — the hold window has closed; the commit sweep owns it now",
              ["status"],
            );
          }
          const yankDecision = buildDecision(ctx, patch.decision, row.kind);
          await ctx.env.DB.prepare(
            `UPDATE agent_proposals SET status = 'yanked', decided_at = ?, decision_json = ?
             WHERE account_id = ? AND id = ? AND status = 'held'`,
          )
            .bind(yankNow, JSON.stringify({ ...yankDecision, yankedFromHold: true }), access.accountId, id)
            .run();
          propEntry.updated.push(id);
          updated[id] = null;
          continue;
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
          //
          // ── s17: THE ROUND IS A CONTINUATION, AND IT INHERITS THE ENVELOPE ──
          //
          // It is minted `INSERT … SELECT … FROM agent_invocations node`, i.e.
          // FROM the very row it continues, because of the invariant s17's
          // use-time gate exists to hold: **an invocation caused by a delegated
          // node may never hold more authority than that node held.** This
          // statement used to copy `binding_id`/`binding_name` and nothing else,
          // so a node inside a Job — holding an envelope narrowed hop by hop —
          // could cause a fresh invocation carrying NO envelope at all. That row
          // read as `job_id IS NULL`, which `useGate.ts` correctly treats as
          // "not a delegation, nothing to enforce" (the DefaultCase). Attenuation
          // was not exceeded so much as SIDESTEPPED: one human question laundered
          // a narrowed node back up to the bare binding.
          //
          // A CONTINUATION, NOT A RE-DELEGATION — which is exactly why the four
          // graph columns are COPIED rather than computed:
          //   job_id       the same Job. The round is that Job's work, so it
          //                counts toward the Job's nodes and its aggregate
          //                budget, and the chain walk engages at all (the walk
          //                is keyed on job_id — an envelope on a job-less row
          //                would be a column nobody reads).
          //   parent_id    the continued node's OWN parent, so the round is its
          //                SIBLING rather than its child. The chain above it is
          //                then character-for-character the chain above the node
          //                it continues, so `binding ∩ root ∩ … ∩ round`
          //                collapses to exactly `effective(node)` — the same
          //                envelope, provably, not a re-derived approximation of
          //                it. It also keeps the chain LENGTH invariant: a
          //                child-of-the-node would add a hop per round, and
          //                enough rounds would trip MAX_CHAIN_HOPS and deny work
          //                that did nothing wrong.
          //   depth        the node's own depth, NOT depth + 1. A round answers
          //                a question about the node's own proposal; nothing was
          //                delegated, so there is no hop to count. Copying is
          //                also the only choice that cannot be farmed: at
          //                depth + 1 a chain of N questions would buy N levels
          //                of `maxDepth` (`expandPlan` guards on
          //                `parent.depth + 1`), and "ask your own agent a
          //                question N times" would be a depth ceiling escape.
          //                Copied, N rounds all sit at the node's depth and can
          //                delegate exactly as deep as the node could — which
          //                today is not at all, since a round dispatches to
          //                `answerInfoRequest`, never to the Job harness.
          //   authority_json  the same envelope. Never narrowed (the round is
          //                the node's own work continuing, and a round that
          //                could not afford to answer would wedge the proposal)
          //                and never widened — the fold re-intersects it against
          //                every ancestor and the binding at USE time, so a
          //                copied envelope can only ever restate what the chain
          //                already allows.
          // `privacy` rides along for the same reason, on the facet axis: the
          // round reads the proposal's rationale, evidence and payload — the
          // OUTPUT of pinned work — so a round that lost the pin would hand
          // exactly that text to the paid cloud. Privacy narrows the claimant
          // set and never widens it, which is why it is safe to copy blind.
          //
          // Deliberately NOT copied: `due_at` (it WIDENS the claimant set — a
          // past deadline is what lets the backstop claim outside the policy
          // gate — so the T9 stamp below stays the only writer of it),
          // `requires_json` (a fit vector for the node's own work; the round
          // only reads text, and inheriting "needs vision" would strand it), and
          // `needs_json` (the round's input is the proposal, which already
          // exists; inheriting satisfied — or failed — dependencies would block
          // it on work it does not consume).
          //
          // THE DEFAULTCASE SURVIVES BY CONSTRUCTION: for an ordinary,
          // non-delegated proposal every one of those columns is NULL on the
          // node, so copying them yields NULL and the round is exactly the
          // ungated invocation it has always been. There is no branch here to
          // get wrong.
          const answerInvId = `inv_${crypto.randomUUID()}`;
          const round = await ctx.env.DB.prepare(
            `INSERT INTO agent_invocations
               (id, account_id, binding_id, binding_name, status, email_id, context_json, created_at,
                job_id, parent_id, depth, authority_json, privacy)
             SELECT ?, ?, ?, ?, 'pending', ?, ?, ?,
                    node.job_id, node.parent_id, node.depth, node.authority_json, node.privacy
               FROM agent_invocations node
              WHERE node.account_id = ? AND node.id = ?`,
          )
            .bind(
              answerInvId,
              access.accountId,
              row.binding_id,
              row.binding_name,
              row.email_id,
              JSON.stringify({ kind: "answer-info-request", proposalId: id, question }),
              now,
              access.accountId,
              id,
            )
            .run();
          if ((round.meta.changes ?? 0) !== 1) {
            // The node vanished between `loadProposal`'s JOIN and here. Fail
            // rather than fall back to an envelope-less INSERT: "I cannot read
            // the thing that would bound this" is answered `no` everywhere else
            // in s17, and a proposal whose invocation is gone has already lost
            // the row every surface projects it from.
            throw new SetErrorSignal(
              "notFound",
              `the invocation behind proposal ${id} no longer exists — no answer round was enqueued`,
            );
          }
          // ⚠️ THE DEADLOCK s11 T9 FOUND, and it is not confined to T9's kind.
          //
          // The answer round is an ordinary invocation for the proposal's
          // binding, so it goes through the ordinary eligibility gate — and if
          // that binding's monthly budget is SPENT, the gate holds the paid
          // cloud off it exactly as it holds off every other invocation. The
          // round would sit unanswered until a free runtime appeared or the
          // month rolled, with the human's decision clock paused the whole
          // time. On a `budget-overrun` proposal that is absurd by
          // construction: "what would it cost?" cannot be answered because
          // there is no money to answer with, which is the dead end T9 exists
          // to close, reappearing one level up.
          //
          // The fix reuses T3 rather than inventing anything: stamp the round
          // past-due, and the overdue backstop — which claims OUTSIDE the
          // policy gate precisely so budget exhaustion cannot strand work —
          // picks it up on the next sweep. The answer handler is untouched, and
          // so is the round's cost accounting (chronic needsInfo still shows up
          // in $/approved-action, s10 T3).
          //
          // Guarded by the gate's OWN budget fragment, so the stamp lands only
          // on the rounds that would actually deadlock and its arithmetic can
          // never drift from the gate's: a binding under its cap (or covered by
          // an approved overage) leaves `due_at` NULL and behaves exactly as it
          // did before T9.
          //
          // s17 — AND NOW THE SECOND MONEY TERM, for the same reason. The round
          // inherits `job_id` above, so `claimGateSql` now also weighs the JOB's
          // aggregate budget against it (`jobBudgetExhaustedSql`, folded in
          // beside the binding's monthly cap). A Job that has spent its purse
          // would therefore hold the paid cloud off its own answer rounds —
          // T9's deadlock exactly, one cap over — so the guard is the OR of both
          // money terms rather than the monthly one alone. Composed from the
          // same exported fragments the gate folds, never hand-copied, so the
          // stamp cannot come to disagree with the gate about what "out of
          // money" means; `jobBudgetExhaustedSql` takes zero placeholders (the
          // graph is entirely in the rows), so no bind order moves. On a
          // job-less round the term is `EXISTS (… WHERE job.id = NULL)` = false,
          // which is the DefaultCase reading itself.
          const gateNow = Date.now();
          await ctx.env.DB.prepare(
            `UPDATE agent_invocations SET due_at = ?
              WHERE account_id = ? AND id = ?
                AND (${budgetExhaustedSql("agent_invocations")}
                     OR ${jobBudgetExhaustedSql("agent_invocations")})`,
          )
            .bind(
              gateNow,
              access.accountId,
              answerInvId,
              budgetMonthStartMs(gateNow),
              budgetPeriodKey(gateNow),
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
        const decision = buildDecision(ctx, patch.decision, row.kind);

        const now = Date.now();
        if (status === "rejected") {
          // ---- decline = keep waiting (s11 T9, for a budget-overrun) ----
          // THE TAXONOMY INVARIANT, at the decision site: declining a
          // `budget-overrun` records the decision and NOTHING ELSE. The waiting
          // invocations stay `pending` — no cancellation, no `failed`, no status
          // change of any kind — because the answer was "not this month", not
          // "you were wrong to ask". `NO_FAULT_KINDS` (above) has already
          // refused any reject reason, so nothing negative about the agent can
          // reach `decision_json`, and the first RL consumer inherits the
          // exclusion as a property of the data rather than as advice:
          // budget declines join tookItMyself/needsInfo outside the negative
          // signal (decline-taxonomy.md's "the rule a learning pipeline must not
          // break"). The work simply waits for the month to roll — which it was
          // already doing when the proposal was raised.
          //
          // ---- decline = CONFIRM THE SHUNTS (s12 held-mail-review) ----
          // The one kind whose decline is not "do nothing": here the verb is
          // an answer ("yes, that is spam"), so it writes the judgment the
          // hold never had — a 'shunted' chain row per message and a spam
          // label per message. The mail does not move (it is already in the
          // right place); what changes is that it is now DECIDED, which is
          // what stops the sweep asking about it again.
          if (row.kind === HELD_MAIL_REVIEW) {
            const original = emailIdList(safeJson(row.payload_json).emailIds) ?? [];
            applyEntries.push(
              ...(await confirmHeldBatch(ctx, access, row, original)),
            );
          }
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

    case "budget-overrun": {
      // s11 T9 — approve applies a BOUNDED OVERAGE, not a raised cap.
      //
      // The whole point of the kind: "spend a bit more this month" and "spend
      // more every month" are different decisions, so this writes a
      // period-scoped grant into `agent_budget_overages` and leaves
      // `config_json.budgets.spendPerMonth` untouched. Raising the cap
      // permanently is a CONFIG edit with its own route (`PATCH
      // /agent-bindings/{id}`), which is what keeps one click from silently
      // becoming standing policy.
      //
      // The gate reads this row directly: `budgetExhaustedSql` compares the
      // period's spend against `cap + SUM(amount_micros)`, so the approval is a
      // real widening of the claimant set the moment it lands — no cache, no
      // second source of truth, and the pure `budgetExhausted()` twin agrees by
      // test.
      const bindingId = str(payload.bindingId);
      const periodKey = str(payload.periodKey);
      const amount = payload.overageMicros;
      if (!bindingId || !periodKey || typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
        throw new SetErrorSignal(
          "invalidProperties",
          "a budget-overrun payload needs bindingId, periodKey and a positive overageMicros " +
            "(the BOUND — an unbounded overage is a raised cap by another name)",
          ["payload"],
        );
      }
      // THE PERIOD BOUNDARY, said out loud. The proposal's `expiresAt` is the
      // period end, so a pending one should never survive the roll — but the
      // expiry sweep is a cron and this is the authoritative check. An overage
      // keyed to a finished month would be inert (the gate only sums the
      // CURRENT period), and silently writing an inert grant while reporting
      // "approved" is exactly the kind of lie this codebase refuses.
      if (periodKey !== budgetPeriodKey(Date.now())) {
        throw new SetErrorSignal(
          "invalidProperties",
          `this overage was asked for ${periodKey}, which has ended — the budget has since reset, ` +
            "so there is nothing to lift. The work it was about is claimable again.",
          ["payload"],
        );
      }
      const binding = await ctx.env.DB.prepare(
        `SELECT id FROM agent_bindings WHERE account_id = ? AND id = ?`,
      )
        .bind(access.accountId, bindingId)
        .first<{ id: string }>();
      if (!binding) {
        throw new SetErrorSignal(
          "invalidProperties",
          `binding "${bindingId}" not found in this account`,
          ["payload"],
        );
      }
      await ctx.env.DB.prepare(
        `INSERT INTO agent_budget_overages
           (account_id, binding_id, period_key, amount_micros, proposal_id, approved_by, approved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (account_id, binding_id, period_key, proposal_id) DO NOTHING`,
      )
        .bind(
          access.accountId,
          bindingId,
          periodKey,
          Math.floor(amount),
          row.id,
          ctx.principal.username,
          Date.now(),
        )
        .run();
      // The grant is REVERSIBLE, which is what makes this tier 1 honest: the
      // undo handle deletes the row and the cap snaps back. Money already spent
      // under it is not recoverable — that asymmetry is precisely why the grant
      // is bounded and period-scoped instead of a cap edit.
      return {
        entries: [],
        undo: { action: "revoke-overage", bindingId, periodKey, proposalId: row.id },
      };
    }

    case HELD_MAIL_REVIEW: {
      // s12 — approve RELEASES the batch. Each release is a `rescueQuarantined`
      // and not some new verb: a human pulling held mail into the inbox IS the
      // rescue path (the move, the 'rescued' chain row naming what it was
      // rescued from, the graduated-domain demotion, and the ham label that
      // makes the escape hatch feed the filter). Reusing it means the human's
      // answer here and the human's answer in bouncer@'s false-positive
      // conversation are the same event, recorded the same way.
      const asked = emailIdList(safeJson(row.payload_json).emailIds);
      if (!asked || asked.length === 0) {
        throw new SetErrorSignal(
          "invalidProperties",
          "a held-mail-review payload needs a non-empty emailIds array",
          ["payload"],
        );
      }
      const chosen = emailIdList(payload.emailIds);
      if (!chosen) {
        throw new SetErrorSignal(
          "invalidProperties",
          "a held-mail-review payload needs a non-empty emailIds array",
          ["payload"],
        );
      }
      // PARTIAL RELEASE, and it needs no new verb: an edited `emailIds` is the
      // human saying "these ones". The edit may only NARROW the batch — this
      // proposal is about the messages it named, and an id from outside it has
      // no rationale, no evidence and no chain row behind it here.
      const outside = chosen.filter((id) => !asked.includes(id));
      if (outside.length > 0) {
        throw new SetErrorSignal(
          "invalidProperties",
          `held-mail-review emailIds may only NARROW the batch this proposal named; ` +
            `${outside.slice(0, 3).join(", ")} ${outside.length === 1 ? "was" : "were"} not in it`,
          ["payload"],
        );
      }

      const releasedIds: string[] = [];
      const touchedMailboxes = new Set<string>();
      for (const emailId of chosen) {
        const { rescued } = await store.rescueQuarantined(
          access.accountId,
          emailId,
          ctx.principal.username,
        );
        // Not rescued = it is no longer held (a race, or an answer that landed
        // first). The rescue path already refuses to write a second chain row;
        // reporting only what actually moved keeps the changelog honest.
        if (rescued) releasedIds.push(emailId);
      }
      // The complement is CONFIRMED, not left in limbo. A partial approve is
      // one decision about the whole batch — "release these, the rest are
      // spam" — so the messages the human did not pick get the same judgment a
      // decline writes. Leaving them held-and-unanswered would rebuild the
      // pile one edit at a time.
      const confirmedIds = await confirmHeldEmails(
        store,
        access.accountId,
        asked.filter((id) => !chosen.includes(id)),
        ctx.principal.username,
      );

      for (const id of await roleMailboxIds(ctx, access.accountId)) touchedMailboxes.add(id);
      const entries: ChangeEntry[] = [];
      const touchedEmails = [...releasedIds, ...confirmedIds];
      if (touchedEmails.length > 0) {
        entries.push({ collection: "Email", created: [], updated: touchedEmails, destroyed: [] });
        entries.push({
          collection: "Mailbox",
          created: [],
          updated: [...touchedMailboxes],
          destroyed: [],
        });
      }
      // No `undo` handle. A released message is undone by moving it back — an
      // ordinary Email/set the human can already make — and a handle naming an
      // "un-release" nothing implements would be a promise this codebase
      // cannot keep. The reversibility that makes this tier 1 is real; the
      // machine affordance for it is `move`, not a proposal replay.
      return { entries };
    }

    default:
      throw new SetErrorSignal(
        "invalidProperties",
        `approving a "${row.kind}" proposal is not applied in this slice (s03.D T1)`,
        ["kind"],
      );
  }
}

/** The two mailboxes a held-mail decision can touch, for the changelog. */
async function roleMailboxIds(ctx: RequestContext, accountId: string): Promise<string[]> {
  const { results } = await ctx.env.DB.prepare(
    `SELECT id FROM mailboxes WHERE account_id = ? AND role IN ('inbox', ?)`,
  )
    .bind(accountId, QUARANTINE_ROLE)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

/** Confirm every still-held message in the list; returns the ones that moved
 * from undecided to decided (a raced answer simply does not count twice). */
async function confirmHeldEmails(
  store: Mailstore,
  accountId: string,
  emailIds: string[],
  actor: string,
): Promise<string[]> {
  const confirmed: string[] = [];
  for (const emailId of emailIds) {
    const res = await store.confirmQuarantined(accountId, emailId, actor);
    if (res.confirmed) confirmed.push(emailId);
  }
  return confirmed;
}

/** The decline path's application: confirm the whole batch, and report the
 * mailboxes for the caller's single commit. */
async function confirmHeldBatch(
  ctx: RequestContext,
  access: { accountId: string; tenantId: string },
  row: ProposalJoinRow,
  emailIds: string[],
): Promise<ChangeEntry[]> {
  if (emailIds.length === 0) return [];
  const store = storeFor({ ...ctx, agent: { binding: row.binding_name, invocation: row.id } });
  const confirmed = await confirmHeldEmails(
    store,
    access.accountId,
    emailIds,
    ctx.principal.username,
  );
  if (confirmed.length === 0) return [];
  return [
    { collection: "Email", created: [], updated: confirmed, destroyed: [] },
    {
      collection: "Mailbox",
      created: [],
      updated: await roleMailboxIds(ctx, access.accountId),
      destroyed: [],
    },
  ];
}

/** A payload `emailIds`: a non-empty array of strings, or null. Absent, empty
 * and "a string that looks like a list" are all null — a decision that acts on
 * nothing must be refused rather than silently succeed. */
function emailIdList(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  if (!v.every((x) => typeof x === "string" && x.length > 0)) return null;
  return v as string[];
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
function buildDecision(ctx: RequestContext, raw: unknown, kind: string): Record<string, unknown> {
  const decision: Record<string, unknown> = { by: ctx.principal.username };
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    if (r.reason !== undefined) {
      if (NO_FAULT_KINDS.has(kind)) {
        // s11 T9 — the invariant, enforced. See NO_FAULT_KINDS.
        throw new SetErrorSignal(
          "invalidProperties",
          `a "${kind}" decision carries no reject reason: declining it means "not this month", ` +
            "not a judgment about the agent's work, and recording a fault here would poison any " +
            "learning loop that later reads decisions (decline-taxonomy.md). Use decision.note " +
            "for a free-text why.",
          ["decision"],
        );
      }
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
    // s10 T7 — WHICH account this row came off. Redundant inside a single
    // /get response (whose envelope already carries `accountId`) and
    // load-bearing the moment a client merges the queues of every account a
    // human can reach: a supervisor sees Emily's ask beside Allen's, and
    // "which agent, on which account" must survive the merge. Carrying it on
    // the ROW rather than reconstructing it client-side is what keeps the Go
    // CLI's `--json` honest — one raw server line per proposal, no field the
    // client invented.
    accountId: r.account_id,
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

// ---- the hold-tray commit sweep (s03.D T2) --------------------------------

/**
 * Commit every `held` proposal whose retraction window has closed.
 *
 * This is the other half of the tier-2 approve: `status='held'` was written
 * with the note "commit-out-of-tray is s03.D T2 — deliberately NOT done here,
 * so nothing egresses before the retraction UI exists". The retraction verb
 * now exists (`yanked`, above), so this is that commit. Found the honest way:
 * EditorEmily answered a draft request in five seconds and her reply sat
 * `pending` for two days — and even approving it would only have parked it in
 * a tray nothing ever emptied.
 *
 * ## Who runs it, and as whom
 *
 * The agent worker's cron calls this through the jmapBridge pattern (the
 * method layer running in-process — one implementation of the choreography,
 * never two). There is no acting human at sweep time, so provenance uses the
 * decision's `by`: the applied write is attributable to "the human approved
 * the agent's proposal", exactly as a direct tier-1/3 apply records it
 * (.feedback common/033). The sweep's own ctx principal is never written.
 *
 * ## Failure posture
 *
 * A row whose apply fails (submit relay down, mailbox gone) STAYS `held` and
 * is retried next sweep — the row, not the attempt, is the source of truth,
 * the same posture as the drain. Failures are returned and logged loudly by
 * the caller; a bounded batch keeps one poisoned row from starving the rest.
 * Yank races commit at the `status='held'` guard on the UPDATE: whichever
 * lands first wins, and the loser's UPDATE changes zero rows.
 */
export async function commitDueHeldProposals(
  ctx: RequestContext,
  opts: { now?: number; limit?: number } = {},
): Promise<{ committed: string[]; failed: Array<{ id: string; error: string }> }> {
  const now = opts.now ?? Date.now();
  const limit = opts.limit ?? 25;
  const committed: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];

  const { results } = await ctx.env.DB.prepare(
    `${SELECT_JOIN} WHERE p.status = 'held' AND p.hold_until IS NOT NULL AND p.hold_until <= ?
     ORDER BY p.hold_until ASC LIMIT ?`,
  )
    .bind(now, limit)
    .all<ProposalJoinRow & { tenant_id?: string }>();

  for (const row of results) {
    try {
      // The account's tenant, for the submit envelope. Looked up per row —
      // the sweep crosses accounts, so nothing about it may assume one.
      const acct = await ctx.env.DB.prepare(`SELECT tenant_id FROM accounts WHERE id = ?`)
        .bind(row.account_id)
        .first<{ tenant_id: string }>();
      if (!acct) throw new Error(`account ${row.account_id} not found`);
      const access = { accountId: row.account_id, tenantId: acct.tenant_id };

      // Provenance: the write belongs to the human whose approval it executes.
      const decision = safeJson(row.decision_json ?? "{}");
      const approver = typeof decision.by === "string" && decision.by ? decision.by : "system:hold-commit";
      const commitCtx: RequestContext = {
        ...ctx,
        principal: { username: approver, scopes: [], accounts: [] },
      };

      const payload =
        row.edited_payload_json !== null ? safeJson(row.edited_payload_json) : safeJson(row.payload_json);
      const { entries } = await applyProposal(commitCtx, access, row, payload);

      // Flip held → approved ONLY if a yank has not raced us; a zero-row
      // UPDATE means the human won and the apply above must be treated as
      // the bug it would be — which cannot happen for egress kinds, because
      // the yank guard checks hold_until BEFORE now. Belt and braces: the
      // status guard makes the race explicit rather than silent.
      const res = await ctx.env.DB.prepare(
        `UPDATE agent_proposals SET status = 'approved', decision_json = ?
         WHERE account_id = ? AND id = ? AND status = 'held'`,
      )
        .bind(JSON.stringify({ ...decision, committedAt: now }), row.account_id, row.id)
        .run();
      if ((res.meta?.changes ?? 0) === 0) {
        failed.push({ id: row.id, error: "yank raced the commit; status was no longer held" });
        continue;
      }

      const allEntries = [
        // "ActionProposal", exactly — the first draft wrote "AgentProposal"
        // and the /changes test caught it: a wrong collection name commits
        // fine, reads fine on /get, and is invisible to /changes and push.
        { collection: "ActionProposal", created: [], updated: [row.id], destroyed: [] },
        ...entries,
      ].filter((e) => e.created.length + e.updated.length + e.destroyed.length > 0);
      if (allEntries.length > 0) {
        await commitChanges(ctx.env.ACCOUNT_DO, row.account_id, allEntries);
      }
      committed.push(row.id);
    } catch (err) {
      failed.push({ id: row.id, error: String(err).slice(0, 200) });
    }
  }

  return { committed, failed };
}
