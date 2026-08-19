// THE DELEGATION CONTRACT (s20 T6) — a Goal's authority envelope, as data.
//
// A Goal is not a container of related stuff. It is a CONTRACT with done-ness:
// a sentence the human wants to be true ("get three structural engineers
// willing to evaluate the attic"), bounded by four clauses the docs' own
// Delegation primitive names — **may / may not / escalate when / done when** —
// and it decomposes into a workflow with approval checkpoints along the way.
//
// This module is the pure half: the clauses, what they COMPILE to, and the
// refusals they produce. It deliberately invents no enforcement machinery,
// because the whole point of the reframing is that the machinery already
// exists and the contract is a face over it:
//
//   may.tools      → the root node's `authority.tools`, and therefore every
//                    descendant's by monotonic attenuation (attenuation.ts).
//   may.contact    → the recipient bound. THE ONE AXIS `attenuateChild` DOES
//                    NOT HAVE, because a task's recipient lives in its context
//                    rather than in its envelope — so it is checked here, over
//                    the task list, at both ends of the plan checkpoint.
//   budgetUsd      → `jobs.budget_micros`, the aggregate the claim gate weighs
//                    (jobBudgetExhaustedSql) and `attenuatePlan` reserves
//                    against. ONE number, ONE meaning: it bounds what the
//                    system SPENDS pursuing the goal.
//   escalateWhen   → a Watch on the Job itself (s20 T1's engine, unchanged):
//                    condition `deadline`, action `notify`.
//   doneWhen       → a SENTENCE, and it stays one. No derivation can decide
//                    whether three engineers are "willing"; the derived job
//                    status answers "did the work finish", which is a
//                    different question, and conflating them would be the
//                    system marking its own homework.
//
// ── The honesty rule this file exists to hold ─────────────────────────────
// A clause that compiles to nothing is a clause that lies. `mayNot` is
// therefore explicitly modelled as PROSE the human reads at the checkpoint —
// it is not silently treated as an enforced deny-list — and `budgetUsd` is
// documented as agent spend rather than being quietly re-used as "the money
// you may promise a contractor", which nothing here can see, let alone bound.

import type { Refusal } from "./attenuation.js";
import type { JobStatus } from "./jobGraph.js";

/** micro-USD per USD. The unit every budget in this schema is denominated in. */
const MICROS_PER_USD = 1_000_000;

/** A dollar bound, as the machinery counts money. */
export function usdToMicros(usd: number): number {
  return Math.round(usd * MICROS_PER_USD);
}

/** …and back, for a surface that has to say "$750" to a person. */
export function microsToUsd(micros: number): number {
  return micros / MICROS_PER_USD;
}

/**
 * THE CHECKPOINT CLASSES — and the reason they are a closed set.
 *
 * "Checkpoints thin by CLASS, not globally" (s20 T6). Early, everything stops:
 * the sketch, each email, the summary. Repetition→policy graduates a class
 * ("scheduling emails to direct reports auto-send") — never the whole goal at
 * once, because a goal that graduated wholesale is exactly the silently-
 * widening autonomy the product exists to prevent.
 *
 *   plan     the decomposition itself: may these tasks be created?
 *   email    an outbound message the goal wants to send.
 *   summary  the compiled answer at the end of a join.
 */
export const CHECKPOINT_CLASSES = ["plan", "email", "summary"] as const;
export type CheckpointClass = (typeof CHECKPOINT_CLASSES)[number];

/** Manual = a human decides every time. Auto = the class has graduated. */
export type CheckpointMode = "manual" | "auto";

/** One class's setting, with the provenance of the last change to it. */
export interface CheckpointSetting {
  mode: CheckpointMode;
  /** Who graduated (or demoted) it. Absent = never changed from the default. */
  by?: string;
  at?: number;
}

export type CheckpointPolicy = Record<CheckpointClass, CheckpointSetting>;

/**
 * Everything manual — the state every goal starts in, and the only state
 * anything reaches without a human explicitly saying otherwise.
 */
export function defaultCheckpoints(): CheckpointPolicy {
  return { plan: { mode: "manual" }, email: { mode: "manual" }, summary: { mode: "manual" } };
}

/**
 * WHICH CLASSES CAN ACTUALLY GRADUATE TODAY, and why the list is short.
 *
 * `plan` is the checkpoint s20 T6 built, so flipping it to `auto` really does
 * change behaviour: the planner expands its sketch directly, which is exactly
 * what s11 T7 did before this task existed. The other two have no enforcement
 * point yet — a side-effectful leaf still exits via `/approvals` and a tier-3
 * egress still meets the capability wall — so recording them as `auto` would
 * be a setting that renders as autonomy and delivers none.
 *
 * A UI toggle that lies about how much authority you just handed over is the
 * single worst bug this surface could ship, so the write path refuses it and
 * the goal view says which classes are still manual BECAUSE NOTHING WIRES THEM
 * rather than because you have not gotten around to it.
 */
export const GRADUABLE_CLASSES: readonly CheckpointClass[] = ["plan"];

export function isCheckpointClass(v: unknown): v is CheckpointClass {
  return typeof v === "string" && (CHECKPOINT_CLASSES as readonly string[]).includes(v);
}

/**
 * The four clauses. Every field is untrusted input — a contract arrives from a
 * client, and one day from a model reading the human's own sentence.
 */
export interface GoalContract {
  /** may — the permissions the goal holds. */
  may: {
    /** Tool names, ⊆ the binding's. Empty = the goal uses no tools. */
    tools: string[];
    /**
     * Who the goal may write to: bare addresses, or `@domain` for a whole
     * domain. EMPTY MEANS NOBODY — least privilege, the attenuation.ts rule 2
     * reading, not "unset means anyone".
     */
    contact: string[];
  };
  /**
   * may not — the human's prohibitions, IN THEIR OWN WORDS, rendered at every
   * checkpoint. Deliberately not compiled into a deny-list: "don't commit me
   * to a date" is not a predicate this system can evaluate, and pretending it
   * were one would license the goal to do anything it could not parse.
   */
  mayNot: string[];
  /** escalate when — compiles to a Watch on the Job. null = no escalation. */
  escalateWhen: { afterMs: number; note?: string } | null;
  /** done when — the completion test, as a sentence. Never derived. */
  doneWhen: string;
  /** The aggregate the goal may SPEND, USD. null = the binding's cap only. */
  budgetUsd: number | null;
}

/** A contract as it arrives, with a reason when it cannot be read. */
export type ContractParse = { ok: true; contract: GoalContract } | { ok: false; why: string };

const strings = (v: unknown): string[] | null => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string") return null;
    const t = item.trim();
    if (t.length === 0) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
};

/**
 * Read a contract off the wire. Total and conservative: an unreadable clause
 * is a refusal, never a default — a goal whose `may` could not be parsed must
 * not fall back to a permissive envelope, which is how capability systems leak.
 */
export function parseGoalContract(raw: unknown): ContractParse {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, why: "a contract must be an object with may / mayNot / escalateWhen / doneWhen" };
  }
  const c = raw as Record<string, unknown>;
  const may = (c.may ?? {}) as Record<string, unknown>;
  if (typeof may !== "object" || may === null || Array.isArray(may)) {
    return { ok: false, why: "`may` must be an object with `tools` and `contact` lists" };
  }
  const tools = strings(may.tools);
  if (tools === null) return { ok: false, why: "`may.tools` must be a list of tool names" };
  const contact = strings(may.contact);
  if (contact === null) return { ok: false, why: "`may.contact` must be a list of addresses or @domains" };
  const mayNot = strings(c.mayNot);
  if (mayNot === null) return { ok: false, why: "`mayNot` must be a list of sentences" };

  const doneWhen = typeof c.doneWhen === "string" ? c.doneWhen.trim() : "";
  if (doneWhen.length === 0) {
    // The one clause with no defensible default. A delegation with no
    // done-ness is a standing instruction to keep going, which is precisely
    // the thing a Goal is supposed to replace.
    return { ok: false, why: "`doneWhen` is required — a delegation with no done-ness never ends" };
  }

  let escalateWhen: GoalContract["escalateWhen"] = null;
  if (c.escalateWhen !== undefined && c.escalateWhen !== null) {
    const e = c.escalateWhen as Record<string, unknown>;
    if (typeof e !== "object" || Array.isArray(e) || typeof e.afterMs !== "number" || !Number.isFinite(e.afterMs)) {
      return { ok: false, why: "`escalateWhen.afterMs` must be a duration in milliseconds" };
    }
    if (e.afterMs <= 0) return { ok: false, why: "`escalateWhen.afterMs` must be positive" };
    escalateWhen = {
      afterMs: Math.floor(e.afterMs),
      ...(typeof e.note === "string" && e.note.trim() ? { note: e.note.trim() } : {}),
    };
  }

  let budgetUsd: number | null = null;
  if (c.budgetUsd !== undefined && c.budgetUsd !== null) {
    if (typeof c.budgetUsd !== "number" || !Number.isFinite(c.budgetUsd) || c.budgetUsd < 0) {
      return { ok: false, why: "`budgetUsd` must be a non-negative number of dollars" };
    }
    budgetUsd = c.budgetUsd;
  }

  return { ok: true, contract: { may: { tools, contact }, mayNot, escalateWhen, doneWhen, budgetUsd } };
}

/**
 * A goal's default shape. Small on purpose: a first delegation that can fan out
 * to sixty-four nodes is not a delegation, it is a hope.
 *
 * `maxDepth: 2` leaves room for exactly one nested planner under the root —
 * enough that "decompose a sub-problem" is expressible, few enough that a
 * planner which keeps planning stops before anybody notices it did not.
 */
export const GOAL_DEFAULT_MAX_NODES = 8;
export const GOAL_DEFAULT_MAX_DEPTH = 2;

/**
 * THE COMPILE STEP — the contract, as the machinery's own vocabulary.
 *
 * Nothing here is new enforcement. It is a translation into the shapes
 * `startJobRows` already takes, which is the whole claim of T6: the delegation
 * primitive the docs describe was already implemented, it just had no face.
 *
 * ── THE PER-NODE SHARE, and the arithmetic that makes a $750 goal runnable ──
 *
 * The aggregate budget is a RESERVATION system (attenuation.ts `attenuatePlan`):
 * every node's DECLARED budget counts against the Job's total the moment the
 * row exists, before a cent is spent. So a root node that declared the whole
 * $750 would reserve the entire purse and refuse its own first task — the plan
 * would be rejected for a budget nothing had spent.
 *
 * The share is therefore `aggregate ÷ maxNodes`, and that choice states an
 * invariant worth having:
 *
 *   **a Job that fills its node cap exactly exhausts its purse, and can never
 *   exceed it** — N nodes × (total ÷ N) ≤ total, at every N the fan-out cap
 *   admits.
 *
 * It composes downward for free, because `attenuateChild` caps a child at its
 * parent: a nested planner's children inherit the same share, so depth cannot
 * multiply money any more than breadth can. And it needs no second cap to
 * enforce: the fan-out cap the Job already carries IS the divisor.
 */
export function compileContract(
  contract: GoalContract,
  maxNodes: number = GOAL_DEFAULT_MAX_NODES,
): {
  budgetMicros: number | null;
  /** What ONE node may declare — the aggregate divided by the fan-out cap. */
  perNodeMicros: number | null;
  authority: { tools: string[]; credentials: string[]; budgetMicros: number | null };
} {
  const budgetMicros = contract.budgetUsd === null ? null : usdToMicros(contract.budgetUsd);
  const nodes = Math.max(1, Math.floor(maxNodes));
  const perNodeMicros = budgetMicros === null ? null : Math.floor(budgetMicros / nodes);
  return {
    budgetMicros,
    perNodeMicros,
    authority: {
      tools: [...contract.may.tools],
      // Credentials are NOT expressible in a contract, deliberately. A
      // credential handle is an operator-plane fact (which vault entry this
      // binding may spend), and letting a goal name one would be a human
      // typing a permission into a sentence box. The binding's ceiling is the
      // only source, and the root's empty set narrows from it — rule 2.
      credentials: [],
      budgetMicros: perNodeMicros,
    },
  };
}

/**
 * THE DECOMPOSITION, DERIVED FROM THE CONTRACT — the stand-in for a model
 * planner, and an honest one.
 *
 * "get three structural engineers willing to evaluate the attic" with three
 * addresses in `may.contact` decomposes into three outreach tasks and one join
 * that compiles what came back. That is not a guess about what the human
 * wants; it is the contract read literally — the reach it granted, one message
 * each, and an answer at the end.
 *
 * It runs INSIDE the planner node, not at goal-creation time, which keeps s11
 * T7's progressive revelation intact: the plan is produced at runtime, as part
 * of the work, and is treated as untrusted data on the way back regardless of
 * whether a function or a model wrote it. The day a model writes it, this
 * function is what it replaces and nothing else moves.
 *
 * `@domain` entries produce NO task: a domain is a permission, not a person,
 * and inventing an address inside it would be exactly the confident wrongness
 * the whole approvals apparatus exists to catch. A contract with no concrete
 * address therefore yields an empty plan, and an empty plan is refused — which
 * reads, correctly, as "you have told me who I MAY write to but not who to".
 */
export function sketchFromContract(contract: GoalContract): { tasks: Array<Record<string, unknown>> } {
  const addresses = contract.may.contact.filter((c) => !c.startsWith("@") && c.includes("@"));
  const tasks: Array<Record<string, unknown>> = addresses.map((to, i) => ({
    key: `reach-${i + 1}`,
    context: { kind: "job-node", op: "outreach", to },
  }));
  if (tasks.length > 0) {
    tasks.push({
      key: "compile",
      needs: tasks.map((t) => t.key as string),
      context: { kind: "job-node", op: "summarize" },
    });
  }
  return { tasks };
}

/**
 * Is this address inside the contract's reach?
 *
 * Two forms, and no third: an exact address, or `@domain` for everyone there.
 * Not globs, not regexes, not substring matching — a recipient bound you have
 * to reason about is a recipient bound that will be wrong at 2am, and every
 * near-miss here is an email to a stranger.
 */
export function contactAllowed(patterns: readonly string[], address: string): boolean {
  const target = address.trim().toLowerCase();
  if (!target.includes("@")) return false;
  const domain = target.slice(target.indexOf("@"));
  return patterns.some((p) => {
    const pat = p.trim().toLowerCase();
    if (pat.length === 0) return false;
    return pat.startsWith("@") ? pat === domain : pat === target;
  });
}

/** One task, as far as the CONTRACT is concerned. Everything else is
 *  `attenuateChild`'s business, and this module does not repeat it. */
export interface ContractTask {
  key?: unknown;
  tools?: unknown;
  budgetMicros?: unknown;
  context?: unknown;
}

const contractRefusal = (
  key: string,
  axis: Refusal["axis"],
  requested: string,
  ceiling: string,
  why: string,
): Refusal => ({
  key,
  axis,
  requested,
  ceiling,
  why,
});

/**
 * THE CONTRACT'S OWN REFUSALS over a task list — the axes the envelope cannot
 * carry, checked in the same shape everything else refuses in.
 *
 * Called at BOTH ends of the plan checkpoint, and that is the point: once when
 * the planner emits its sketch (so a human is never shown a plan that cannot
 * run), and again when an approval applies it (because the human's REDLINE is
 * untrusted input too — the venue moved, the checks did not). A recipient
 * typed into an edited sketch is exactly as untrusted as one a model wrote.
 */
export function contractRefusals(contract: GoalContract, tasks: readonly ContractTask[]): Refusal[] {
  const refusals: Refusal[] = [];
  for (const task of tasks) {
    const key = typeof task.key === "string" && task.key ? task.key : "(unnamed)";
    const ctx = (typeof task.context === "object" && task.context !== null ? task.context : {}) as Record<
      string,
      unknown
    >;
    // A task that writes to somebody names them in `to`. Anything else is not
    // an outbound task and has no recipient to bound.
    const to = typeof ctx.to === "string" ? ctx.to.trim() : "";
    if (to.length > 0 && !contactAllowed(contract.may.contact, to)) {
      refusals.push(
        contractRefusal(
          key,
          "identity",
          to,
          contract.may.contact.length > 0 ? `[${contract.may.contact.join(", ")}]` : "(nobody)",
          "the goal's contract does not permit writing to this recipient",
        ),
      );
    }
  }
  return refusals;
}

/**
 * MONOTONIC ATTENUATION, at the contract layer: a sub-goal may narrow its
 * parent's contract and may never exceed it, on every axis a contract carries.
 *
 * `attenuateChild` proves this for tools, credentials, budget, privacy and
 * urgency on the NODE envelope. This is the same invariant stated over the
 * human-facing object, and it exists because the two can otherwise drift: a
 * face that shows a wider contract than the envelope enforces would teach a
 * person to trust a bound the system does not hold, which is worse than
 * showing no bound at all.
 */
export function attenuateContract(parent: GoalContract, child: GoalContract): Refusal[] {
  const refusals: Refusal[] = [];
  const overTools = child.may.tools.filter((t) => !parent.may.tools.includes(t));
  if (overTools.length > 0) {
    refusals.push(
      contractRefusal(
        "(sub-goal)",
        "tools",
        `[${child.may.tools.join(", ")}]`,
        `[${parent.may.tools.join(", ")}]`,
        `not held by the parent goal: ${overTools.join(", ")}`,
      ),
    );
  }
  // A recipient the parent could not write to is one the child may not either
  // — and `@domain` in the parent admits a specific address under it, because
  // that IS a narrowing.
  const overContact = child.may.contact.filter(
    (c) => !parent.may.contact.includes(c) && !(c.includes("@") && contactAllowed(parent.may.contact, c)),
  );
  if (overContact.length > 0) {
    refusals.push(
      contractRefusal(
        "(sub-goal)",
        "identity",
        `[${child.may.contact.join(", ")}]`,
        `[${parent.may.contact.join(", ")}]`,
        `beyond the parent goal's reach: ${overContact.join(", ")}`,
      ),
    );
  }
  if (parent.budgetUsd !== null && (child.budgetUsd === null || child.budgetUsd > parent.budgetUsd)) {
    refusals.push(
      contractRefusal(
        "(sub-goal)",
        "budget",
        child.budgetUsd === null ? "unbounded" : `$${child.budgetUsd}`,
        `$${parent.budgetUsd}`,
        "a sub-goal may not spend more than the goal it serves",
      ),
    );
  }
  return refusals;
}

// ---- the kinds, and which checkpoint class each one is -------------------

/** The plan-approval checkpoint: the sketch itself, as a proposal. */
export const GOAL_PLAN_KIND = "goal-plan";
/** An outbound message a goal wants to send (applies into your own Drafts). */
export const GOAL_OUTREACH_KIND = "goal-outreach";
/** A join node's compiled answer — the last milestone before done-ness. */
export const GOAL_SUMMARY_KIND = "goal-summary";

/**
 * Which checkpoint class a proposal belongs to, so the goal view can say
 * "3 of 4 email checkpoints are still manual" without a column to keep in
 * sync. Anything unrecognized is `null` — a proposal from outside the goal's
 * own vocabulary is not silently filed under a class it was never designed for.
 */
export function checkpointClassOf(kind: string): CheckpointClass | null {
  if (kind === GOAL_PLAN_KIND) return "plan";
  if (kind === GOAL_SUMMARY_KIND) return "summary";
  if (kind === GOAL_OUTREACH_KIND || kind === "verb-compose" || kind === "reply-draft" || kind === "start-thread") {
    return "email";
  }
  return null;
}

// ---- the derived status --------------------------------------------------

/**
 * A GOAL's status — derived, like a Job's, plus the two facts a Job cannot
 * know.
 *
 *   cancelled     the human revoked the standing authority. AUTHORED, not
 *                 derived: a cancelled goal whose nodes happen to be done is
 *                 not "done", and the fact that somebody stopped it is the
 *                 single most important thing about it.
 *   awaiting-plan a plan checkpoint is open. Without this the goal would read
 *                 `done` the instant its planner finished — every node done,
 *                 nothing failed — which is the most dangerous possible lie: a
 *                 goal that has DONE NOTHING reporting completion while its
 *                 whole workflow sits unapproved.
 *   accepted      the human said the done-when clause is met. Also authored:
 *                 no derivation can read "three engineers willing", and a
 *                 system that marked its own homework here would be the
 *                 done-ness claim without the done-ness.
 */
export type GoalStatus = "cancelled" | "awaiting-plan" | "accepted" | JobStatus;

export function deriveGoalStatus(o: {
  jobStatus: JobStatus;
  /** A `goal-plan` proposal still awaiting a decision. */
  planCheckpointOpen: boolean;
  cancelledAt?: number | null;
  acceptedAt?: number | null;
}): GoalStatus {
  if (o.cancelledAt) return "cancelled";
  if (o.planCheckpointOpen) return "awaiting-plan";
  if (o.acceptedAt) return "accepted";
  return o.jobStatus;
}
