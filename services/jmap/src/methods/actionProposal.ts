import { MethodError, type MethodRegistry } from "@bullmoose/jmap-core";
import { commitChanges, type ChangeEntry } from "@bullmoose/account-do";
import { buildMime } from "@bullmoose/mime";
import {
  QUARANTINE_ROLE,
  type ContactCardRow,
  type JSCalendarEventBlob,
  type JSContactCard,
  type Mailstore,
} from "@bullmoose/mailstore";
import { OutboundRefused, assertOutboundAllowed } from "@bullmoose/mailstore/outboundBound";
import {
  budgetExhaustedSql,
  budgetMonthStartMs,
  budgetPeriodKey,
  contractRefusals,
  describeRefusals,
  expandPlanRows,
  getJobNodeRow,
  jobBudgetExhaustedSql,
  parseGoalContract,
} from "@bullmoose/scheduling";
// The one definition of the fallback follow-up body/subject, shared with the
// fire-time compose (s20 wave 3) so an old-format (intent-only) proposal
// applies with byte-identical text to the compose fallback. A cross-service
// relative import on the commitHeld.ts precedent (agent → jmap, this is the
// mirror); it pulls only pure functions.
import { followupSubject, templateFollowupBody } from "../../../agent/src/watchCompose";
import { authorizeAccount } from "../auth";
// The ONE JSCalendar validator/normalizer, shared with `CalendarEvent/set`
// rather than re-typed: the `verb-schedule` case below writes an event when a
// human approves a proposed hold, and a second copy of "what is a legal start"
// is how the two paths drift apart.
import { buildEventRow } from "./calendars";
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
 * The capability wall says WHO may commit an egress. It says nothing about WHERE
 * the mail may go — that is the outbound bound (s10 T1,
 * @bullmoose/mailstore/outboundBound), re-derived from the binding's current
 * governing book inside `applyProposal` immediately before the relay, on both
 * the immediate-apply path and the hold-tray sweep. It is deliberately NOT
 * checked at decision time: the whole point is that it binds the send, and the
 * approver's own `editedPayload` is one of the things it has to bind.
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
/**
 * ⚠️ A FIFTH EXCLUSION (s26 T3): a declined `floor-request` is not negative
 * feedback either — it is a PREFERENCE. The proposal asks "may this agent read
 * mail back to <date>?" (the history floor, devPlan rule 1), and declining says
 * "no, the archive stays out of reach" — a statement about the human's mailbox,
 * never about the agent's work. Whether backfill fits is per-agent character
 * (crm@ perusing the whole archive makes sense; Allen re-reading three-year-old
 * spending does not), so the decline records taste, and a fault here would
 * teach an agent to stop asking for history the human merely didn't want read.
 */
const NO_FAULT_KINDS = new Set(["budget-overrun", HELD_MAIL_REVIEW, "watch-offer", "floor-request"]);

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
  // s07 T5's frozen cost, surfaced on the queue (Eric 2026-08-18): what this
  // proposal's invocation actually cost. NULL and 0 stay DISTINCT end to end —
  // 0 is "known free" (a carrier, the Workers AI allocation), NULL is "not
  // recorded" — the one honesty rule of the cost columns.
  cost_micros: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_provider: string | null;
  cost_model: string | null;
}

const SELECT_JOIN = `
  SELECT p.id, p.account_id, p.kind, p.tier, p.subject_json, p.payload_json,
         p.edited_payload_json, p.rationale, p.evidence_json, p.status,
         p.decision_json, p.created_at, p.decided_at, p.hold_until, p.expires_at,
         p.question, p.amendments_json, p.expires_remaining_ms,
         inv.binding_id, inv.binding_name, inv.status AS inv_status,
         inv.claimed_at, inv.email_id,
         inv.cost_micros, inv.tokens_in, inv.tokens_out,
         inv.provider AS cost_provider, inv.model AS cost_model
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
      const { results } = await ctx.env.DB.prepare(`${SELECT_JOIN} WHERE p.account_id = ? AND p.id IN (${marks})`)
        .bind(access.accountId, ...ids)
        .all<ProposalJoinRow>();
      rows = results;
    }
    const found = new Set(rows.map((r) => r.id));
    const dueAt = await invocationDueAt(
      ctx,
      access.accountId,
      rows.map((r) => r.id),
    );

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

  registry.register("ActionProposal/changes", async (args, ctx) => proxyChanges(ctx, args, "ActionProposal"));

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
    const propEntry: ChangeEntry = {
      collection: "ActionProposal",
      created: [],
      updated: [],
      destroyed: [],
    };
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
          await ctx.env.DB.prepare(`UPDATE agent_invocations SET due_at = ? WHERE account_id = ? AND id = ?`)
            .bind(dueAtMs, access.accountId, id)
            .run();
          // Both collections moved: the invocation carries the value, the
          // proposal projects it — commit choreography or the correction is
          // invisible to /changes (this file's header).
          applyEntries.push({
            collection: "AgentInvocation",
            created: [],
            updated: [id],
            destroyed: [],
          });
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
            throw new SetErrorSignal("invalidProperties", "needsInfo requires a non-empty human-authored question", [
              "question",
            ]);
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
          // read as `job_id IS NULL`, which `nodeAuthority.ts` (@bullmoose/scheduling) correctly treats as
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
            .bind(gateNow, access.accountId, answerInvId, budgetMonthStartMs(gateNow), budgetPeriodKey(gateNow))
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
            applyEntries.push(...(await confirmHeldBatch(ctx, access, row, original)));
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
          editedPayload !== undefined ? (editedPayload as Record<string, unknown>) : safeJson(row.payload_json);
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
      const entries: ChangeEntry[] = [{ collection: "ContactCard", created: [cardRow.id], updated: [], destroyed: [] }];
      if (change) {
        entries.push({
          collection: "AddressBook",
          created: change === "created" ? [bookId] : [],
          updated: change === "updated" ? [bookId] : [],
          destroyed: [],
        });
      }
      // The undo handle a tier-1 application keeps (arch.md §2).
      return { entries, undo: { action: "destroy-contact", cardId: cardRow.id } };
    }

    case "reply-draft": {
      // The irreversible egress. Relay the drafted MIME through the submit
      // worker, then record a Sent copy whose provenance the Mailstore stamps.
      // There is no undo handle here, unlike the tier-1 cases around it.
      //
      // TIER 2, NOT TIER 3. The only producer emits tier 2 (services/agent
      // `emitProposal`, proposals.ts:141), so an approve does not reach this
      // function at all: it parks the row in the hold tray, and this runs later
      // from `commitDueHeldProposals` when the retraction window closes. The
      // yank window is what stands in for the missing undo.
      //
      // That leaves the tier-3 CAPABILITY WALL (in `set`, above) guarding a
      // branch nothing currently produces — it is exercised only by a synthetic
      // row in actionProposal.test.ts:237. DO NOT delete it as dead code. It is
      // the structural guarantee that an agent token can never auto-commit
      // irreversible egress, and it is what any future tier-3 kind — or a
      // reclassification of this one — lands on. Costing nothing while unused is
      // the point; re-deriving it later means deriving it under pressure, as
      // policy rather than as capability.
      const to = str(payload.to);
      const self = str(payload.self);
      const blobId = str(payload.blobId);
      const subject = str(payload.subject) ?? "";
      const text = str(payload.text) ?? "";
      if (!to || !self || !blobId) {
        throw new SetErrorSignal("invalidProperties", "reply-draft payload needs to/self/blobId", ["payload"]);
      }
      // THE OUTBOUND BOUND, AT EGRESS (s10 T1 — the hardening gap its devPlan
      // left open). The agent checked its governing book when it DRAFTED this;
      // that check is worthless here, because everything it depended on can
      // have changed since:
      //
      //   • the book can have been NARROWED between draft and approve, or
      //     between approve and the hold-tray sweep that commits it (~5 min
      //     of window plus up to a cron interval);
      //   • the binding can have been disabled or deleted;
      //   • `editedPayload` can have REWRITTEN `to`. An approver may amend a
      //     proposal before approving it, the amendment replaces the payload
      //     wholesale, and `to` is just another key in it — so the human who
      //     retypes the recipient is, without the line below, editing their
      //     way straight past the agent's bound.
      //
      // So the binding's CURRENT `recipients_book_id` and its CURRENT
      // membership are re-derived here, against the recipient actually about
      // to be handed to the relay (`to` comes from the EFFECTIVE payload —
      // edited if edited), by the same one decision function the agent's own
      // three relay sites sit behind. Same reasoning as
      // `effectiveNodeAuthority`: narrowing must bite work already in the
      // queue, and a check performed at issue is a check the holder keeps
      // forever.
      //
      // Fail-closed and RECOVERABLE: this throws before the relay and before
      // any status write, so a refusal leaves a tier-1/3 row `pending` with a
      // `forbidden` SetError naming the recipient, and a tier-2 row `held` and
      // retried next sweep with the reason logged (`commitHeld.ts`). Nothing is
      // dropped, and nothing egresses.
      await assertOutboundAllowed(ctx.env, { account_id: access.accountId, binding_id: row.binding_id }, [to]);
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
        throw new SetErrorSignal("invalidProperties", "a recipient grant-request payload needs bookId + address", [
          "payload",
        ]);
      }
      const book = await ctx.env.DB.prepare(`SELECT id FROM address_books WHERE account_id = ? AND id = ?`)
        .bind(access.accountId, bookId)
        .first<{ id: string }>();
      if (!book) {
        throw new SetErrorSignal("invalidProperties", `address book "${bookId}" not found in this account`, [
          "payload",
        ]);
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
      const binding = await ctx.env.DB.prepare(`SELECT id FROM agent_bindings WHERE account_id = ? AND id = ?`)
        .bind(access.accountId, bindingId)
        .first<{ id: string }>();
      if (!binding) {
        throw new SetErrorSignal("invalidProperties", `binding "${bindingId}" not found in this account`, ["payload"]);
      }
      await ctx.env.DB.prepare(
        `INSERT INTO agent_budget_overages
           (account_id, binding_id, period_key, amount_micros, proposal_id, approved_by, approved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (account_id, binding_id, period_key, proposal_id) DO NOTHING`,
      )
        .bind(access.accountId, bindingId, periodKey, Math.floor(amount), row.id, ctx.principal.username, Date.now())
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
        throw new SetErrorSignal("invalidProperties", "a held-mail-review payload needs a non-empty emailIds array", [
          "payload",
        ]);
      }
      const chosen = emailIdList(payload.emailIds);
      if (!chosen) {
        throw new SetErrorSignal("invalidProperties", "a held-mail-review payload needs a non-empty emailIds array", [
          "payload",
        ]);
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
        const { rescued } = await store.rescueQuarantined(access.accountId, emailId, ctx.principal.username);
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

    case "watch-offer": {
      // s20 T1↔T4 — the agent-offered Watch. The sweep noticed a question you
      // sent that went unanswered and OFFERED to watch it (services/agent
      // waitingOn.ts); approving arms an ordinary `no-reply-from` Watch, the
      // same row `Watch/set` would write. Tier 1 and reversible: an armed watch
      // egresses nothing until it fires, and firing is itself only a proposal —
      // the undo simply cancels it.
      const p = safeJson(row.payload_json);
      const to = str(p.to);
      const threadId = str(p.threadId);
      const sentAt = Number(p.sentAt);
      const durationMs = Number(p.watchDurationMs);
      if (!to || !threadId || !Number.isFinite(sentAt) || !Number.isFinite(durationMs)) {
        throw new SetErrorSignal(
          "invalidProperties",
          "a watch-offer payload needs to/threadId/sentAt/watchDurationMs",
          ["payload"],
        );
      }
      const now = Date.now();
      const watchId = `w_${crypto.randomUUID()}`;
      await ctx.env.DB.prepare(
        `INSERT INTO watches
           (id, account_id, owner, condition_type, condition_json, deadline_at,
            action_type, action_json, status, source_ref, created_at)
         VALUES (?, ?, ?, 'no-reply-from', ?, ?, 'draft-followup', ?, 'armed', ?, ?)`,
      )
        .bind(
          watchId,
          access.accountId,
          ctx.principal.username,
          JSON.stringify({ sender: to, threadId }),
          now + durationMs,
          JSON.stringify({ to }),
          str(p.emailId) ?? null,
          // created_at is BACKDATED to the original send: `no-reply-from`
          // evaluates "did a reply arrive since `created_at`", and the honest
          // anchor is when you sent the message, not when you approved the
          // offer — otherwise a reply that landed between offer and approval
          // would be missed and the watch would fire spuriously.
          Number.isFinite(sentAt) ? sentAt : now,
        )
        .run();
      return {
        entries: [{ collection: "Watch", created: [watchId], updated: [], destroyed: [] }],
        // The undo handle a tier-1 application keeps (arch.md §2).
        undo: { action: "cancel-watch", watchId },
      };
    }

    case "watch-followup": {
      // s20 wave 3 — a fired watch's follow-up, applied at last. The fire
      // path (services/agent watches.ts) composes the body at fire time and
      // the payload arrives actionable ({to, subject, body, composed}); this
      // was the missing case that wedged every approved follow-up in the hold
      // tray ("not applied in this slice", retried forever).
      //
      // Approval creates a DRAFT in the Drafts mailbox, in the OWNER's voice
      // — the reply pipeline's draft-mode shape (services/agent index.ts
      // sendReply: MIME blob in R2, `$draft` + `$agent`, threaded onto the
      // watched message). It does NOT egress: nothing relays, the human sends
      // it from their own composer. That is why there is no
      // assertOutboundAllowed here — the outbound bound governs a BINDING's
      // reach, and this draft belongs to the human, not to a binding; their
      // own submission path keeps its own gates.
      //
      // OLD-FORMAT TOLERANCE, load-bearing: a watch that fired before
      // drafting-on-fire deployed carries the intent-only payload ({watchId,
      // conditionType, to, note} — no body). Those rows are live in the tray
      // RIGHT NOW; refusing them would re-create the wedge this case removes.
      // The template body/subject are synthesized here from the intent
      // fields — the same exported functions the fire-time fallback uses, so
      // the two formats converge on identical text.
      const to = str(payload.to);
      if (!to) {
        // No recipient = nobody to draft TO. Loud and visible (a tier-2 row
        // stays held and reports each sweep; the human yanks or declines) —
        // never a silent drop.
        throw new SetErrorSignal("invalidProperties", "a watch-followup payload needs a recipient (`to`)", ["payload"]);
      }
      const note = str(payload.note);
      const body = str(payload.body) ?? templateFollowupBody({ note });

      // The watched message, for threading and the Re: subject — tolerant,
      // it may have been deleted since the watch was armed.
      const subjectRef = safeJson(row.subject_json);
      const origId = subjectRef.realm === "Email" ? str(subjectRef.objectId) : null;
      const orig = origId
        ? await ctx.env.DB.prepare(`SELECT subject, message_id FROM emails WHERE account_id = ? AND id = ?`)
            .bind(access.accountId, origId)
            .first<{ subject: string | null; message_id: string | null }>()
        : null;
      const subject = str(payload.subject) ?? followupSubject(orig?.subject ?? null, note);

      // Whose voice: the account's primary sending identity (may_delete=0
      // sorts first — the provisioned primary), falling back to the watch's
      // owner. The approver's login name is the last resort, never the first:
      // on a grant-reached account it belongs to a different person.
      const idents = await store.getIdentities(access.accountId);
      let self = idents[0]?.email ?? null;
      let selfName = idents[0]?.name ?? "";
      if (!self) {
        const watchId = str(payload.watchId);
        const watch = watchId
          ? await ctx.env.DB.prepare(`SELECT owner FROM watches WHERE account_id = ? AND id = ?`)
              .bind(access.accountId, watchId)
              .first<{ owner: string }>()
          : null;
        self = watch && watch.owner.includes("@") ? watch.owner : ctx.principal.username;
        selfName = "";
      }

      return draftIntoDrafts(access, store, {
        to,
        subject,
        body,
        self,
        selfName,
        inReplyTo: orig?.message_id ?? null,
      });
    }

    case "verb-answer":
    case "verb-bring-in":
    case "goal-outreach":
    case "verb-compose": {
      // s20 T2 — the mail verbs. `Answer` and `Bring X into this` are the
      // human asking IN PLACE, on the message they are reading; the agent
      // worker (services/agent mailVerbs.ts) composed a draft and emitted this
      // proposal, and approving it puts the draft in the owner's own Drafts
      // mailbox — the SAME write an approved `watch-followup` performs, which
      // is why both share `draftIntoDrafts` rather than growing a second
      // almost-identical draft path that could drift.
      //
      // s20 T6 adds `goal-outreach` — a message a GOAL wants to send — as a
      // fourth label, on exactly the T3 reasoning below: the application is
      // byte-for-byte identical (a draft in your own Drafts, same keywords,
      // same undo), and the KIND stays separate because the queue tells a
      // person what they are looking at and the decline taxonomy needs to know
      // what it is learning about. "That is not the message I wanted" about a
      // goal's outreach is feedback on the GOAL, not on the compose verb.
      //
      // s20 T3 adds `verb-compose` — the composer's intent mode — as a THIRD
      // LABEL on this one case, not a fourth apply path. What approval does is
      // byte-for-byte what it does for an answer (a draft in your own Drafts,
      // same keywords, same undo), so a separate case would be a copy waiting
      // to drift; but the KIND is separate because "answer" would be a lie on
      // the approval row and in the decline taxonomy, and a kind is how the
      // queue tells a person what they are looking at. Two things differ, and
      // both are read off `row.kind` below: a compose NEVER threads, and it
      // never inherits a `Re:` subject from its background message.
      //
      // TIER 1 and applied here, immediately. Nothing egresses: the draft is
      // the owner's, their composer sends it, and their own submission path
      // keeps its own gates — so there is no `assertOutboundAllowed` for the
      // same reason `watch-followup` has none (the outbound bound governs a
      // BINDING's reach, and this draft belongs to a person).
      //
      // The DECLINE side is deliberately ordinary: neither kind is in
      // `NO_FAULT_KINDS`, because "that is not the reply I wanted"
      // (wrongContent) and "don't offer to do this" (wrongAction) are exactly
      // the corrections the s03.D taxonomy was built to carry, and a verb the
      // human pressed is the cleanest possible feedback signal there is.
      const to = str(payload.to);
      if (!to) {
        throw new SetErrorSignal("invalidProperties", `a ${row.kind} payload needs a recipient (\`to\`)`, ["payload"]);
      }
      const body = str(payload.body);
      if (!body) {
        // Loud, and it cannot wedge: a tier-1 approve fails in place with this
        // sentence and the row stays `pending` for the human to decline. An
        // empty draft is worse than an honest refusal.
        throw new SetErrorSignal("invalidProperties", `a ${row.kind} payload needs a drafted \`body\``, ["payload"]);
      }

      // The message the verb acted on — for threading and the fallback
      // subject. Tolerant: it may have been deleted since the ask.
      const verbRef = safeJson(row.subject_json);
      const verbOrigId = verbRef.realm === "Email" ? str(verbRef.objectId) : null;
      const verbOrig = verbOrigId
        ? await ctx.env.DB.prepare(`SELECT subject, message_id FROM emails WHERE account_id = ? AND id = ?`)
            .bind(access.accountId, verbOrigId)
            .first<{ subject: string | null; message_id: string | null }>()
        : null;
      // A compose carries its own subject (the model's, or one derived from
      // the human's own sentence). If it somehow arrives without one the draft
      // gets a BLANK subject for the human to write — never `Re: <the message
      // it was standing next to>`, which would announce a reply that isn't.
      // A compose and a goal's outreach both START a message; the two
      // message-view verbs continue one. Read once, used twice below.
      const startsAMessage = row.kind === "verb-compose" || row.kind === "goal-outreach";
      const subject = str(payload.subject) ?? (startsAMessage ? "" : followupSubject(verbOrig?.subject ?? null, null));

      // Whose voice: the account's primary sending identity (may_delete = 0
      // sorts first), and the approver's own login name only as the last
      // resort — the `watch-followup` rule, minus the watch lookup it has no
      // watch for.
      const verbIdents = await store.getIdentities(access.accountId);
      const self = verbIdents[0]?.email ?? ctx.principal.username;
      const selfName = verbIdents[0]?.name ?? "";

      return draftIntoDrafts(access, store, {
        to,
        subject,
        body,
        self,
        selfName,
        // A forward starts a message; everything else continues the
        // conversation it came from. Threading a forward `In-Reply-To` the
        // original would file it under a thread it is not part of — and the
        // same is true of a compose, whose subject row may point at the most
        // recent exchange with the recipient purely as BACKGROUND. "Ask Sergio
        // about selling assembled boards" is a new ask, not a reply to
        // whatever you last said to each other.
        inReplyTo: startsAMessage || str(payload.mode) === "forward" ? null : (verbOrig?.message_id ?? null),
      });
    }

    case "verb-schedule": {
      // s20 wave 6 — the SCHEDULE verb's landing place, and the whole reason
      // #202 shipped without the verb: "there is no `create-event` apply case
      // and no proposal-shaped path into `CalendarEvent`, so shipping the
      // button would mean shipping a kind whose approval has nowhere to land."
      // This is that case. The producer is services/agent `runScheduleVerb`.
      //
      // What approval writes: ONE event in the account's default calendar,
      // through `buildEventRow` — the SAME validator/normalizer
      // `CalendarEvent/set` create runs (exported from ./calendars for exactly
      // this second caller), so an event an approval writes and an event the
      // calendar UI writes cannot disagree about uid minting, the indexed
      // span, or what a legal `start` is.
      //
      // ## A HOLD, NOT A BOOKING — enforced here, not asked for politely
      //
      // Three properties are stamped by this case and are not the payload's to
      // set, because each is a claim the agent has no standing to make:
      //
      //   status: "tentative"      nobody has agreed to this yet. The human
      //                            promotes it in their calendar app when the
      //                            other side confirms.
      //   freeBusyStatus: "free"   a proposed slot does not get to say you are
      //                            busy. Blocking someone's availability on the
      //                            strength of an unanswered email is exactly
      //                            the "commitment nobody made" this verb is
      //                            built to avoid.
      //   participants[*]          recorded with `scheduleAgent: "none"`,
      //                            `expectReply: false` and NO `sendTo` — so
      //                            the blob names who the meeting is with and
      //                            carries no address any iTIP implementation
      //                            could deliver to. Nothing is invited.
      //
      // Together those are why this is TIER 1: the write is one row in the
      // owner's own calendar, it reaches nobody, and the undo handle deletes
      // it (`CalendarEvent/set { destroy }` is the method that honours it, the
      // `destroy-contact` precedent).
      //
      // ## The refusal that is a feature
      //
      // A `start` of null is the agent saying "the message named no time and I
      // will not invent one" (mailVerbs.ts `templateHold`). It fails HERE, in
      // place, with a sentence that says what to type — the row stays
      // `pending`, editable through `editedPayload` and declinable. That is
      // the #196-safe shape, not a wedge: an approve answers, the tray keeps
      // moving, and the human's edit is what lands.
      //
      // ## The capability wall
      //
      // `ActionProposal/set` gates on `("draft", "mail")`, and `mail` covers
      // exactly the six mail verbs — it does NOT cover `calendar`
      // (auth-core `hasScope`, common/001). So this case re-runs the same gate
      // `CalendarEvent/set` runs, against the approver's own token, and
      // refuses in place when it does not hold: approving a proposal must not
      // be a way to perform a write your token could not perform directly.
      // A webmail session asks for `calendar` at login
      // (`webmail/src/lib/app/oauth.ts` SESSION_SCOPES), so this bites a
      // mail-only pasted token and a delegate whose grant is scoped to
      // somebody's address book — which is precisely who it should bite.
      const calendarAuth = authorizeAccount(ctx.principal, access.accountId, "calendar", "calendar");
      if (!calendarAuth.ok) {
        throw new SetErrorSignal(
          "forbidden",
          calendarAuth.reason === "accountNotFound"
            ? "no such account"
            : `this hold writes to your calendar, and ${calendarAuth.detail} — nothing was written`,
        );
      }

      const start = str(payload.start);
      if (!start) {
        throw new SetErrorSignal(
          "invalidProperties",
          "this hold has no start time — the agent would not invent one. Edit a `start` into the payload " +
            '("2026-08-20T15:00:00", the wall clock in `timeZone`) and approve again, or decline.',
          ["payload"],
        );
      }
      const holdTitle = str(payload.title) ?? "";
      const attendees = (Array.isArray(payload.attendees) ? payload.attendees : [])
        .filter((a): a is string => typeof a === "string" && a.includes("@"))
        .map((a) => a.trim().toLowerCase());

      // Whose calendar this is — the `verb-answer` identity rule verbatim, and
      // used for one thing: dropping the owner from the participant list. You
      // are not an attendee of your own hold, and `needs-action` against your
      // own address would be a question addressed to nobody.
      const holdIdents = await store.getIdentities(access.accountId);
      const holdSelf = (holdIdents[0]?.email ?? ctx.principal.username).toLowerCase();
      const participants: Record<string, unknown> = {};
      let seat = 0;
      for (const address of [...new Set(attendees)]) {
        if (address === holdSelf) continue;
        seat += 1;
        participants[`p${seat}`] = {
          "@type": "Participant",
          email: address,
          roles: { attendee: true },
          participationStatus: "needs-action",
          expectReply: false,
          // The load-bearing field. "none" is RFC 8984 for "no scheduling
          // messages will be sent for this participant" — the blob says who
          // the hold is with without any client treating it as an invitation
          // to deliver.
          scheduleAgent: "none",
        };
      }

      const holdEvent: Record<string, unknown> = {
        title: holdTitle || "Hold",
        start,
        duration: str(payload.duration) ?? "PT30M",
        timeZone: str(payload.timeZone) ?? "Etc/UTC",
        status: "tentative",
        freeBusyStatus: "free",
        ...(str(payload.description) ? { description: str(payload.description) } : {}),
        ...(seat > 0 ? { participants } : {}),
      };

      const { id: calendarId, change: calendarChange } = await store.ensureDefaultCalendar(access.accountId);
      let eventRow;
      try {
        eventRow = buildEventRow(holdEvent as JSCalendarEventBlob, calendarId, null, null);
      } catch (err) {
        // `buildEventRow` throws calendars.ts's own SetErrorSignal (a Worker's
        // method modules do not share an error class), so its sentence is
        // re-signalled in this file's vocabulary rather than becoming an
        // opaque serverFail. Fails in place: an unresolvable timezone or a
        // malformed start leaves the row pending and says which field.
        const why = err instanceof Error ? err.message : String(err);
        throw new SetErrorSignal("invalidProperties", `this hold is not a valid calendar event: ${why}`, ["payload"]);
      }
      await store.insertCalendarEvents(access.accountId, [eventRow]);
      // CalDAV's sync token for the collection. `CalendarEvent/set` bumps it on
      // every write; an approval that skipped it would leave an Apple Calendar
      // client believing the calendar had not changed.
      await store.bumpCalendarCtags(access.accountId, [calendarId]);

      const holdEntries: ChangeEntry[] = [
        { collection: "CalendarEvent", created: [eventRow.id], updated: [], destroyed: [] },
      ];
      if (calendarChange) {
        holdEntries.push({
          collection: "Calendar",
          created: calendarChange === "created" ? [calendarId] : [],
          updated: calendarChange === "updated" ? [calendarId] : [],
          destroyed: [],
        });
      }
      return { entries: holdEntries, undo: { action: "destroy-event", eventId: eventRow.id } };
    }

    case "watch-notify": {
      // s20 T1 — a fired `notify` watch: the pure reminder. `fire()`
      // (services/agent watches.ts) emits it at TIER 1 and says exactly what
      // it is: "an FYI marker … reversible — clearing it touches nothing in
      // the world". Approving one therefore writes NOTHING, and that is the
      // case, not a stub: the decision itself — status `approved`,
      // `decided_at`, the decider in `decision_json` — IS the whole effect the
      // emit side promised. "Yes, I have seen my reminder."
      //
      // It is here because its ABSENCE was a bug of the same family as the
      // `watch-followup` wedge (s20 wave 3): a kind with no case fell to the
      // default throw, so approving a reminder answered `invalidProperties`
      // and the row stayed pending — a one-shot visible error rather than a
      // silent tray wedge, but the same "a producer emits a kind the applier
      // has never heard of" mistake. Every kind `emitProposal` can mint now
      // has a case.
      //
      // No `undo` handle, on the `held-mail-review` precedent: there is
      // nothing to undo, and a handle naming an action nothing implements
      // would be a promise this codebase cannot keep. The watch row is
      // already `fired` — closed by the sweep that raised this — and a
      // reminder that has been read cannot be un-read.
      return { entries: [] };
    }

    case "floor-request": {
      // s26 T3 — the history-floor approval (devPlan rule 1). The provision
      // worker minted the ask (`POST /agent-bindings/{id}/floor-request`);
      // approving writes `config_json.historyFloor` on the binding, which is
      // the bound the backfill verb reads. Tier 1 and honest about it: the
      // write moves a BOUND and nothing else — no invocation is minted, no
      // money moves, no mail is read — because backfill itself stays a
      // separate, budgeted admin call. The undo restores the previous floor
      // (null = "had none", which is distinct from 0 = "the epoch").
      const bindingId = str(payload.bindingId);
      const toEpochMs = payload.toEpochMs;
      if (!bindingId || typeof toEpochMs !== "number" || !Number.isFinite(toEpochMs) || toEpochMs <= 0) {
        throw new SetErrorSignal(
          "invalidProperties",
          "a floor-request payload needs bindingId and a positive epoch-ms toEpochMs",
          ["payload"],
        );
      }
      const binding = await ctx.env.DB.prepare(
        `SELECT id, config_json FROM agent_bindings WHERE account_id = ? AND id = ?`,
      )
        .bind(access.accountId, bindingId)
        .first<{ id: string; config_json: string }>();
      if (!binding) {
        throw new SetErrorSignal("invalidProperties", `binding "${bindingId}" not found in this account`, ["payload"]);
      }
      // The blob's pre-image, and the same refusal `PATCH /agent-bindings`
      // makes: a read-modify-write over an unparseable blob would destroy the
      // agent-specific remainder it exists to preserve.
      let cfg: Record<string, unknown>;
      try {
        const parsed = JSON.parse(binding.config_json || "{}") as unknown;
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
        cfg = parsed as Record<string, unknown>;
      } catch {
        throw new SetErrorSignal(
          "invalidProperties",
          `binding ${bindingId} has a config_json this approval cannot parse as an object — repair the row ` +
            "rather than letting an approval rewrite it blind",
          ["payload"],
        );
      }
      const previousFloorMs =
        typeof cfg.historyFloor === "number" && Number.isFinite(cfg.historyFloor) ? cfg.historyFloor : null;
      const nextJson = JSON.stringify({ ...cfg, historyFloor: Math.floor(toEpochMs) });
      const now = Date.now();
      // The lifecycle row and the config write ride ONE batch, both guarded on
      // the same pre-image (the patchAgentBinding pattern): a lost CAS leaves
      // neither a moved floor nor a chain row describing a move that never
      // happened. `via_proposal_id` is the WHY — this is exactly the column's
      // purpose (s10 T2).
      const results = await ctx.env.DB.batch([
        ctx.env.DB.prepare(
          `INSERT INTO binding_lifecycle
               (account_id, binding_id, event, old_value, new_value, actor, via_proposal_id, at)
             SELECT ?, ?, 'history-floor-changed', ?, ?, ?, ?, ?
              WHERE EXISTS (SELECT 1 FROM agent_bindings
                             WHERE account_id = ? AND id = ? AND config_json = ?)`,
        ).bind(
          access.accountId,
          bindingId,
          previousFloorMs === null ? null : String(previousFloorMs),
          String(Math.floor(toEpochMs)),
          ctx.principal.username,
          row.id,
          now,
          access.accountId,
          bindingId,
          binding.config_json,
        ),
        ctx.env.DB.prepare(
          `UPDATE agent_bindings SET config_json = ?
            WHERE account_id = ? AND id = ? AND config_json = ?`,
        ).bind(nextJson, access.accountId, bindingId, binding.config_json),
      ]);
      if ((results[results.length - 1]?.meta.changes ?? 0) === 0) {
        // The compare-and-swap lost — another writer touched config_json
        // between the read and this write. Nothing landed (the chain row
        // carried the same predicate); the approval fails loudly so the human
        // retries against the binding as it now is, rather than clobbering a
        // concurrent edit.
        throw new SetErrorSignal(
          "invalidProperties",
          `binding ${bindingId} changed while this approval was being applied — nothing was written; retry`,
          ["payload"],
        );
      }
      // No changelog entries: agent_bindings is admin-plane config, not a
      // synced collection (the budget-overrun precedent).
      return {
        entries: [],
        undo: { action: "restore-floor", bindingId, previousFloorMs },
      };
    }

    case "goal-plan": {
      // ── s20 T6 — THE PLAN-APPROVAL CHECKPOINT, APPLIED ────────────────────
      //
      // A NEW CLASS OF APPROVAL: every other case in this function gates
      // EGRESS — may this leave the building? This one gates EXECUTION — may
      // these tasks exist at all? Approving it CREATES THE TASKS, here, in the
      // same transaction as the decision, through the same `expandPlanRows`
      // a planner's own output goes through (@bullmoose/scheduling jobWrite.ts).
      //
      // That shared function is the point, and it is why this case is short.
      // We have wedged three producers this month by emitting a kind whose
      // apply case did not exist or did not do the thing; the way to not wedge
      // a fourth is to make approval call the SAME code path the auto route
      // calls, rather than a second implementation that agrees with it today.
      //
      // ── "EDIT IS APPROVAL, INLINE" — and why the ledger does not move ─────
      // The human redlines the sketch where the goal was expressed; an edit
      // that leaves nothing unresolved IS the approval, with no second "and do
      // you approve?" (readme principle 6). That venue change needs NOTHING
      // here, and that is the design: an inline redline sends the ordinary
      // `{ status: "approved", editedPayload }` this method has always taken,
      // so the same proposal, decision and provenance rows are written as if
      // it had gone through the queue. `payload` below is already the
      // effective payload — the human's edit when there is one, the agent's
      // original otherwise.
      //
      // ── THE EDIT IS UNTRUSTED, EXACTLY LIKE THE MODEL OUTPUT IT EDITS ────
      // Which is why both checks run again on this side. A redline that raises
      // a task's budget above the goal's, or points one at a recipient the
      // contract does not reach, is refused with nothing created and the row
      // left `pending` — monotonic attenuation does not have a "but a human
      // typed it" exception, because the whole reason the bound exists is that
      // the person approving cannot re-derive it in their head.
      const goalId = str(payload.goalId);
      const tasks = payload.tasks;
      if (!Array.isArray(tasks) || tasks.length === 0) {
        throw new SetErrorSignal("invalidProperties", "a goal-plan payload needs a non-empty `tasks` list", [
          "payload",
        ]);
      }

      // The planner node IS this proposal — a proposal's id is its
      // invocation's id — so the plan expands from the row that proposed it,
      // and the attenuation chain is re-folded from the binding down through
      // every hop by `expandPlanRows` itself.
      const planner = await getJobNodeRow(ctx.env, access.accountId, row.id);
      if (!planner || !planner.job_id) {
        throw new SetErrorSignal(
          "invalidProperties",
          "the planner node behind this plan no longer exists — nothing was created",
          ["payload"],
        );
      }
      if (goalId !== null && goalId !== planner.job_id) {
        // A payload naming a different goal than the node it hangs off would
        // be an approval applied to somebody else's workflow. The node wins;
        // the mismatch is refused rather than reconciled.
        throw new SetErrorSignal(
          "invalidProperties",
          `this plan names goal ${goalId} but its planner belongs to ${planner.job_id}`,
          ["payload"],
        );
      }

      const goal = await ctx.env.DB.prepare(
        `SELECT id, contract_json, cancelled_at FROM goals WHERE account_id = ? AND id = ?`,
      )
        .bind(access.accountId, planner.job_id)
        .first<{ id: string; contract_json: string; cancelled_at: number | null }>();
      if (!goal) {
        throw new SetErrorSignal("invalidProperties", `no goal ${planner.job_id} on this account`, ["payload"]);
      }
      if (goal.cancelled_at) {
        // Standing authority, revoked. An approval that landed after a cancel
        // would resurrect a delegation the human deliberately ended, which is
        // the one thing a revocation has to be able to promise.
        throw new SetErrorSignal(
          "invalidProperties",
          "this goal was cancelled — its authority is revoked, so its plan cannot be started",
          ["status"],
        );
      }
      let contract;
      try {
        contract = parseGoalContract(JSON.parse(goal.contract_json || "null") as unknown);
      } catch {
        contract = { ok: false as const, why: "the stored contract is not valid JSON" };
      }
      if (!contract.ok) {
        // An unreadable contract is an UNKNOWN bound, and an unknown bound is
        // never a permissive one — the rule the whole s17 gate is built on.
        throw new SetErrorSignal(
          "invalidProperties",
          `this goal's contract cannot be read (${contract.why}), so its plan cannot be authorized`,
          ["payload"],
        );
      }

      const contractRefused = contractRefusals(contract.contract, tasks as Array<Record<string, unknown>>);
      if (contractRefused.length > 0) {
        throw new SetErrorSignal(
          "invalidProperties",
          `the goal's contract refuses this plan: ${describeRefusals(contractRefused)}`,
          ["payload"],
        );
      }

      const expanded = await expandPlanRows(ctx.env, planner, { tasks });
      if (!expanded.ok) {
        // All-or-nothing, and it already is: `expandPlanRows` writes every
        // child or none. The row stays `pending`, so the human can redline
        // again rather than losing the sketch to a failed approval.
        throw new SetErrorSignal("invalidProperties", `the plan was refused: ${describeRefusals(expanded.refusals)}`, [
          "payload",
        ]);
      }

      return {
        entries: [
          {
            collection: "AgentInvocation",
            created: expanded.created.map((c) => c.id),
            updated: [],
            destroyed: [],
          },
        ],
        // A tier-1 undo handle that names a call which EXISTS (the watch-notify
        // rule: never promise an action nothing implements). `Goal/set
        // { status: "cancelled" }` fails every pending node of this goal, which
        // is exactly "un-create the tasks I just authorized".
        undo: { action: "cancel-goal", goalId: planner.job_id },
      };
    }

    case "goal-summary": {
      // s20 T6 — the compiled answer, and the ONE judgment no derivation can
      // make. A Job's status is a view over its tasks, so it can say "every
      // node finished"; it cannot say whether three structural engineers are
      // WILLING, because done-when is a sentence and reading it is a person's
      // job. Approving this proposal records that person's verdict on the goal
      // — the only reason this case writes anything at all.
      //
      // Deliberately NOT a `NO_FAULT_KIND`: declining a summary is "no, that
      // does not meet what I asked for", which is exactly the wrongContent
      // signal the decline taxonomy was built to carry, and the goal stays open.
      const summaryGoalId = str(payload.goalId);
      if (!summaryGoalId) {
        throw new SetErrorSignal("invalidProperties", "a goal-summary payload needs a `goalId`", ["payload"]);
      }
      const now = Date.now();
      const accepted = await ctx.env.DB.prepare(
        `UPDATE goals SET accepted_at = ?, accepted_by = ?
          WHERE account_id = ? AND id = ? AND cancelled_at IS NULL`,
      )
        .bind(now, ctx.principal.username, access.accountId, summaryGoalId)
        .run();
      if ((accepted.meta.changes ?? 0) === 0) {
        throw new SetErrorSignal(
          "invalidProperties",
          `goal ${summaryGoalId} is not open on this account — nothing was accepted`,
          ["payload"],
        );
      }
      return {
        entries: [{ collection: "Goal", created: [], updated: [summaryGoalId], destroyed: [] }],
        // Accepting is reversible in the only sense that matters: the verdict
        // is a fact about a human's reading, and clearing it puts the goal back
        // where it was without touching a single node.
        undo: { action: "reopen-goal", goalId: summaryGoalId },
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

/**
 * Write one DRAFT into the account's Drafts mailbox — the application four
 * approved kinds share (`watch-followup` since s20 wave 3, `verb-answer` and
 * `verb-bring-in` since T2, `verb-compose` since T3).
 *
 * All three end in the same place for the same reason: the artifact belongs to
 * the HUMAN, not to a binding. Nothing relays, so no `assertOutboundAllowed`
 * (the outbound bound governs a binding's reach); the MIME carries no
 * Auto-Submitted or X- headers, because the bytes stored here are the bytes
 * their own composer will send; and the undo handle is the plainest one there
 * is — the draft is a row, delete it.
 *
 * One function rather than three near-copies: the differences between the
 * callers are which voice signs it and whether it threads, and those are
 * ARGUMENTS. A second hand-maintained copy of this write is how the keywords,
 * the blob and the thread resolution come to disagree.
 */
async function draftIntoDrafts(
  access: { accountId: string; tenantId: string },
  store: Mailstore,
  o: {
    to: string;
    subject: string;
    body: string;
    /** The sending identity's address and display name. */
    self: string;
    selfName: string;
    /** The Message-ID this draft answers, or null to start a message. */
    inReplyTo: string | null;
  },
): Promise<{ entries: ChangeEntry[]; undo: Record<string, unknown> }> {
  const now = Date.now();
  const messageId = `${crypto.randomUUID()}@${o.self.split("@")[1] ?? "localhost"}`;
  const raw = buildMime({
    from: [{ name: o.selfName, email: o.self }],
    to: [{ email: o.to }],
    subject: o.subject,
    messageId,
    inReplyTo: o.inReplyTo,
    date: new Date(now),
    text: o.body,
  });
  const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
  const blobId = await store.putBlob(access.tenantId, access.accountId, buf);
  const draftsMailbox = await store.ensureRoleMailbox(access.accountId, "drafts", "Drafts");
  const emailId = `e_${crypto.randomUUID()}`;
  await store.insertEmail(access.accountId, {
    id: emailId,
    blobId,
    threadId: await store.resolveThreadId(access.accountId, o.inReplyTo),
    messageId,
    inReplyTo: o.inReplyTo,
    subject: o.subject,
    from: [{ name: o.selfName, email: o.self }],
    to: [{ email: o.to }],
    cc: [],
    bcc: [],
    preview: o.body.slice(0, 256),
    bodyText: o.body,
    size: raw.byteLength,
    receivedAt: now,
    hasAttachment: false,
    attachments: [],
    mailboxIds: [draftsMailbox],
    keywords: ["$draft", "$agent"],
  });
  return {
    entries: [
      { collection: "Email", created: [emailId], updated: [], destroyed: [] },
      { collection: "Mailbox", created: [], updated: [draftsMailbox], destroyed: [] },
    ],
    undo: { action: "destroy-email", emailId },
  };
}

/** The two mailboxes a held-mail decision can touch, for the changelog. */
async function roleMailboxIds(ctx: RequestContext, accountId: string): Promise<string[]> {
  const { results } = await ctx.env.DB.prepare(`SELECT id FROM mailboxes WHERE account_id = ? AND role IN ('inbox', ?)`)
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
  const confirmed = await confirmHeldEmails(store, access.accountId, emailIds, ctx.principal.username);
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
  // The outbound bound refused this send. `forbidden`, not `serverFail`: the
  // approver's book said no, the server is fine, and the tray should say so.
  if (err instanceof OutboundRefused) return setError("forbidden", err.message);
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

async function loadProposal(ctx: RequestContext, accountId: string, id: string): Promise<ProposalJoinRow | null> {
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
async function invocationDueAt(ctx: RequestContext, accountId: string, ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  try {
    const marks = ids.map(() => "?").join(",");
    const { results } = await ctx.env.DB.prepare(
      `SELECT id, due_at FROM agent_invocations WHERE account_id = ? AND id IN (${marks})`,
    )
      .bind(accountId, ...ids)
      .all<{ id: string; due_at: number | null }>();
    return new Map(results.filter((r) => r.due_at !== null).map((r) => [r.id, r.due_at as number]));
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
  throw new SetErrorSignal("invalidProperties", "dueAt must be null (no deadline) or an ISO 8601 date string", [
    "dueAt",
  ]);
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
        throw new SetErrorSignal("invalidProperties", "decision.reason must be wrongContent | wrongAction | unsafe", [
          "decision",
        ]);
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
    // The cost block (s07 T5 → the queue). Absent usage stays null — a client
    // must render "not recorded", never a flattering $0.
    costMicros: r.cost_micros,
    tokensIn: r.tokens_in,
    tokensOut: r.tokens_out,
    costModel: r.cost_model ? `${r.cost_provider ?? ""}${r.cost_provider ? "/" : ""}${r.cost_model}` : null,
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
 * A row whose apply fails (submit relay down, mailbox gone, the governing book
 * narrowed since the approval — `applyProposal` re-derives the outbound bound
 * at the relay, so this sweep is a full egress and gets the full gate) STAYS
 * `held` and is retried next sweep — the row, not the attempt, is the source of
 * truth, the same posture as the drain. Failures are returned and logged loudly
 * by the caller; a bounded batch keeps one poisoned row from starving the rest.
 * A book-refusal therefore parks rather than drops: re-widen the book and the
 * next sweep sends it; leave it narrowed and a human yanks it.
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

      const payload = row.edited_payload_json !== null ? safeJson(row.edited_payload_json) : safeJson(row.payload_json);
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
