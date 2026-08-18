// AGENT-TO-AGENT HANDOFF (s17) — the arithmetic of one binding giving work to
// another, and the only thing that makes CJ a chief of staff rather than
// another mailbox agent.
//
//   A HANDOFF IS AN INVOCATION ONE BINDING CREATES FOR ANOTHER, INSIDE AN
//   AUTHORITY ENVELOPE THAT CAN ONLY NARROW.
//
// `agent-integration.md` §4 deferred `agents:invoke` on two conditions — a
// chain-depth cap and a shared budget — and s11 T7's Job DAG supplies both
// plus monotonic attenuation. This module is what turns that from "a Job could
// express it" into "a Job enforces it", and it is deliberately PURE: every
// refusal below is a table-testable function of its inputs, exactly like
// `attenuation.ts`, so `handoff.test.ts` can walk the whole space including
// the transitive property (A→B→C cannot exceed A) that is the entire point.
//
// ── WHAT THIS MODULE ADDS OVER `attenuateChild` ────────────────────────────
//
// `attenuateChild` already refuses to amplify. What it cannot do alone is
// cross a binding, because crossing one substitutes MORE than capability
// (`.plans/s17-chief-of-staff/agents-invoke.md`): the receiving binding has
// its own ceiling, its own privacy floor, its own governing book, its own
// month's money and its own operator. So a handoff is `attenuateChild`
// against a ceiling this module BUILDS:
//
//   ceiling(handoff) = effective(sender node) ∩ ceiling(receiving binding)
//                      with privacy = tighter(sender's stamp, receiver's floor)
//
// The intersection is the whole safety argument, and it runs in BOTH
// directions on purpose:
//
//   • the receiver cannot LEND reach. A binding whose `jobs` ceiling is wide
//     (or unset) does not widen work handed to it — the sender's effective
//     authority is the other factor, and `∩` cannot grow.
//   • the sender cannot BORROW reach. A sender that holds `files.read` cannot
//     acquire `payments.charge` by handing work to a colleague who holds it.
//
// Stated once, so nobody has to re-derive it: **a handoff is an intersection,
// never a union, and it is checked again at USE time** — `effectiveNodeAuthority`
// (nodeAuthority.ts) re-folds `(⋂ every binding the chain crosses) ∩ env(root)
// ∩ … ∩ env(node)` from the rows on every call, so the stored envelope is one
// TERM of the answer rather than the answer. That is what makes transitivity
// arithmetic instead of a promise the write path makes to itself.
//
// ── THE OPERATOR PLANE: RECIPROCAL, AND FAIL-CLOSED ────────────────────────
//
// Nobody could hand work to anybody before this module existed, so the safe
// default is that nobody can after it either. A handoff needs BOTH halves of a
// reciprocal permission declared in `agent_bindings.config_json.jobs.handoff`:
//
//   sender    { "mayHandTo":   ["allen"] }     "CJ may hand work to Allen"
//   receiver  { "acceptsFrom": ["cj"] }        "Allen accepts work from CJ"
//
// Absent, empty or malformed on EITHER side refuses. This is the one place in
// the tree where an unset key does not read as "unset ceiling", and the
// asymmetry is deliberate: `jobs.tools` unset means a binding that never heard
// of Jobs must still be able to run one, while `jobs.handoff` unset means a
// binding whose operator never agreed to agent-to-agent delegation does not
// silently acquire it on deploy day. A ceiling that has never been declared is
// a ceiling nobody chose; a HANDOFF that has never been declared is an
// authority nobody granted.
//
// Both halves are required because either alone is the confused-deputy shape:
// sender-only lets a compromised CJ push work at any colleague, and
// receiver-only lets any binding conscript a colleague that opted in for one
// specific relationship.
//
// ── LOOPS AND DEPTH: BOTH BOUNDED, BOTH LOUD ───────────────────────────────
//
// `jobs.max_depth` already bounds NODE depth. It does not bound BINDING
// crossings, and those are the expensive kind: five nodes under one binding is
// a decomposition, five bindings in a row is an authority chain nobody can
// hold in their head, each hop of which can only be audited by walking every
// one above it. So there is a second, tighter cap here (`HANDOFF_MAX_HOPS`),
// and a cycle rule strictly stronger than "no repeat immediately":
//
//   NO BINDING MAY APPEAR TWICE IN ONE CHAIN.
//
// A→B→A is refused, and so is A→B→C→A. That is stronger than a bare cycle
// check needs to be, and it is the right strength: revisiting a binding can
// only ever re-narrow (the fold already intersects it once), so a legitimate
// use for it does not exist, while a laundering use — bounce work through a
// colleague and back to escape a term — is exactly what someone would try.
// Both refuse LOUDLY, with an axis and a reason, never by silently dropping
// the hop.

import {
  tightestPrivacy,
  type AttenuatedChild,
  type NodeAuthority,
  type NodeCeiling,
  type Refusal,
} from "./attenuation.js";
import { intersectAuthority } from "./useAuthority.js";
import type { PrivacyClass } from "./mayClaim.js";

/**
 * How many BINDINGS one Job's authority chain may span, root included.
 *
 * 2 = CJ hands to Allen, and Allen may hand on once more. A third crossing is
 * refused. The number is small on purpose and it is not the node-depth cap:
 * `jobs.max_depth` bounds how deep a decomposition goes, this bounds how many
 * separately-administered ceilings one piece of work passes under. Each
 * crossing is a term in an intersection that a human has to be able to reason
 * about when something goes wrong, and "which of these six agents narrowed the
 * budget?" is not a question anyone should have to answer at 2am.
 */
export const HANDOFF_MAX_HOPS = 2;

/**
 * The reciprocal allowlists, as one binding declares them. Binding NAMES, not
 * ids: this is human-authored operator config, `agent_bindings.name` is what
 * `AgentBinding/get` serves and what the roster shows, and an id is not
 * something anybody types. The resolver that turns a name into a row is the
 * caller's, and it must refuse an AMBIGUOUS name rather than pick one — see
 * `services/agent/src/handoff.ts`.
 */
export interface HandoffPolicy {
  mayHandTo: readonly string[];
  acceptsFrom: readonly string[];
}

/** The empty policy — what every binding has until an operator says otherwise. */
export const NO_HANDOFF: HandoffPolicy = { mayHandTo: [], acceptsFrom: [] };

/**
 * Read `config_json.jobs.handoff`. Anything that is not an array of non-empty
 * strings degrades to EMPTY, i.e. to "no handoff" — garbage can only ever
 * remove a permission here, never add one. (Contrast `bindingCeiling`, where
 * garbage degrades to an UNSET ceiling; the difference is argued in the module
 * header and it is the difference between a bound and a grant.)
 */
export function parseHandoffPolicy(handoff: unknown): HandoffPolicy {
  if (typeof handoff !== "object" || handoff === null || Array.isArray(handoff)) return NO_HANDOFF;
  const h = handoff as { mayHandTo?: unknown; acceptsFrom?: unknown };
  return { mayHandTo: names(h.mayHandTo), acceptsFrom: names(h.acceptsFrom) };
}

function names(v: unknown): readonly string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string" || item.length === 0) continue;
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

/** The binding doing the handing, as the policy check needs it. */
export interface HandoffSender {
  bindingId: string;
  bindingName: string;
  policy: HandoffPolicy;
}

/** The binding being handed to — its ceiling, its floor, its switch, its policy. */
export interface HandoffReceiver {
  bindingId: string;
  bindingName: string;
  /** `bindingCeiling(...).authority` for the RECEIVING binding. */
  authority: NodeAuthority;
  /** `config_json.privacyFloor`, or null if it declares none. */
  privacyFloor: PrivacyClass | null;
  policy: HandoffPolicy;
  /**
   * The 008 kill switch, as a fact rather than a verdict. A DISABLED receiver
   * does NOT refuse the handoff — see `HandoffPlan.waiting`.
   */
  enabled: boolean;
}

/**
 * What this Job's authority chain already crosses, ROOT-FIRST, INCLUDING the
 * handing node's own binding. Supplied by the caller from the same walk
 * `effectiveNodeAuthority` does (`delegationPath`, nodeAuthority.ts), so the
 * loop rule and the fold can never disagree about what the chain is.
 */
export interface HandoffChain {
  bindingIds: readonly string[];
}

/**
 * Provenance — the record that survives the hop, written by the harness onto
 * the created node's `context_json.handoff` and read back by every surface
 * that wants to say *"CJ handed this to Allen, and here is why"*.
 *
 * It is CONTEXT, not a new table, deliberately. The Activity realm (s23) reads
 * decided `ActionProposal` rows, and a proposal already carries `rationale` and
 * `evidence[]` — the two fields whose whole job is "the agent's why" and "what
 * it looked at". A parallel handoff log would be a second store of a fact the
 * invocation row already holds, and the one surface that would have to read it
 * is the one surface that already reads proposals.
 */
export interface HandoffProvenance {
  from: { invocationId: string; bindingId: string; bindingName: string };
  to: { bindingId: string; bindingName: string };
  /** The sender's own words. REQUIRED — a handoff with no why is not legible. */
  reason: string;
  /** Which crossing this is, 1-based. `HANDOFF_MAX_HOPS` is the last legal one. */
  hop: number;
  /** Epoch ms the hop was made. */
  at: number;
}

/** How long a `reason` may be before it is refused. Provenance, not an essay. */
export const HANDOFF_REASON_MAX = 500;

/**
 * The route, authorized and narrowed — everything a handoff needs EXCEPT the
 * task itself, which goes through `attenuatePlan` against `ceiling` so the
 * per-axis rules and the Job's batch caps stay one implementation.
 */
export interface HandoffPlan {
  /** The narrowed ceiling: sender ∩ receiver, on the RECEIVER's binding. */
  ceiling: NodeCeiling;
  provenance: HandoffProvenance;
  hop: number;
  /**
   * The receiving binding is DISABLED — the work is still created and it
   * WAITS.
   *
   * This is the composition #199 asks for. `bindingDisabledSql` already makes
   * a pending row on a disabled binding claimable by nobody, and the Settings
   * copy promises exactly that: *"Disabling holds queued work; nothing is
   * cancelled."* A handoff that REFUSED here would make a disabled colleague
   * behave differently from a busy one — the sender would have to decide what
   * to do about it, and the two things it could do (bounce the work back, or
   * drop it) are both worse than waiting. Bouncing re-runs work under the
   * SENDER's authority, which is the escalation the intersection exists to
   * prevent; dropping loses it silently. So the row is written, it sits
   * `pending`, and the instant an operator re-enables the binding it is
   * claimable with no requeue and nothing cancelled.
   *
   * Reported rather than swallowed: `waiting` is how the caller tells a human
   * "handed to Allen, who is currently switched off" instead of leaving them
   * to wonder why nothing happened.
   */
  waiting: boolean;
}

export type HandoffResult = { ok: true; plan: HandoffPlan } | { ok: false; refusals: Refusal[] };

export interface HandoffArgs {
  sender: HandoffSender;
  /**
   * The EFFECTIVE ceiling of the handing node — `effectiveNodeCeiling`, never
   * the node's stored `authority_json`. A row's own column is a claim; the
   * fold is the fact, and handing off is a USE of delegated authority.
   */
  senderCeiling: NodeCeiling;
  receiver: HandoffReceiver;
  chain: HandoffChain;
  /** The sender's why, in its own words. Required, bounded, recorded. */
  reason: string;
  /** The handing node's id — the `from` of the provenance record. */
  fromInvocationId: string;
  /** Wall clock, epoch ms. Injected so provenance is deterministic in tests. */
  now: number;
}

/**
 * AUTHORIZE AND NARROW ONE HOP.
 *
 * Returns the ceiling a handed-off task must attenuate against, or every
 * reason it may not exist. Order matters only for readability: every check
 * runs, and all refusals are returned together, for the same reason
 * `attenuateChild` returns every violated axis — an operator whose config is
 * missing BOTH halves of the reciprocal permission should learn that once.
 */
export function planHandoff(args: HandoffArgs): HandoffResult {
  const { sender, senderCeiling, receiver, chain, reason, fromInvocationId, now } = args;
  const refusals: Refusal[] = [];
  const key = "(handoff)";
  const refuse = (axis: Refusal["axis"], requested: string, ceiling: string, why: string) =>
    refusals.push({ key, axis, requested, ceiling, why });

  // ---- the hop must actually cross, and stay on one account ---------------
  if (receiver.bindingId === sender.bindingId) {
    refuse(
      "identity",
      receiver.bindingId,
      `any binding but ${sender.bindingId}`,
      "a handoff crosses bindings — handing to yourself is an ordinary child task, and expandPlan already creates those",
    );
  }
  // Cross-ACCOUNT delegation is not buildable today and must not look like it
  // is: `delegationChain`, `expandPlan`, `insertChildren` and the `jobs` table
  // are `account_id`-scoped in every query, and `principalForInvocation`
  // deliberately drops grant-reached accounts. A handoff therefore stays
  // within one account, and says so rather than half-working.
  if (senderCeiling.accountId.length === 0) {
    refuse("identity", "(none)", "an account", "a handoff needs the account its chain runs on");
  }

  // ---- provenance is mandatory -------------------------------------------
  const trimmed = typeof reason === "string" ? reason.trim() : "";
  if (trimmed.length === 0) {
    refuse(
      "handoff",
      typeof reason === "string" ? "(empty)" : String(reason),
      "a non-empty reason",
      "a handoff with no stated reason is not legible in the Activity feed, and 'why did my agent give this to another agent' is the whole question that surface answers",
    );
  } else if (trimmed.length > HANDOFF_REASON_MAX) {
    refuse(
      "handoff",
      `${trimmed.length} chars`,
      `at most ${HANDOFF_REASON_MAX}`,
      "the reason is provenance, not payload — a bounded sentence a human reads on the approval row",
    );
  }

  // ---- the reciprocal permission, both halves -----------------------------
  if (!sender.policy.mayHandTo.includes(receiver.bindingName)) {
    refuse(
      "handoff",
      receiver.bindingName,
      `[${sender.policy.mayHandTo.join(", ")}]`,
      `${sender.bindingName} may not hand work to ${receiver.bindingName} — add it to this binding's config_json.jobs.handoff.mayHandTo`,
    );
  }
  if (!receiver.policy.acceptsFrom.includes(sender.bindingName)) {
    refuse(
      "handoff",
      sender.bindingName,
      `[${receiver.policy.acceptsFrom.join(", ")}]`,
      `${receiver.bindingName} does not accept work from ${sender.bindingName} — add it to that binding's config_json.jobs.handoff.acceptsFrom`,
    );
  }

  // ---- loops: no binding twice in one chain -------------------------------
  if (chain.bindingIds.includes(receiver.bindingId)) {
    refuse(
      "handoff",
      receiver.bindingId,
      `not already in [${chain.bindingIds.join(" → ")}]`,
      "this binding is already in the delegation chain — a cycle. Handing work back to a binding it has already passed under can only re-narrow (the fold intersects that ceiling once already), so it buys nothing legitimate and is exactly the shape of an attempt to launder a term away",
    );
  }

  // ---- depth: how many bindings this chain already spans ------------------
  const spanned = new Set(chain.bindingIds).size;
  const hop = spanned === 0 ? 1 : spanned;
  if (hop > HANDOFF_MAX_HOPS) {
    refuse(
      "handoff",
      `crossing ${hop}`,
      String(HANDOFF_MAX_HOPS),
      "the chain-depth cap agent-integration.md §4 asks for, counted in BINDINGS rather than nodes — a delegation this long is an authority chain no human can audit",
    );
  }

  if (refusals.length > 0) return { ok: false, refusals };

  // ---- the narrowing ------------------------------------------------------
  // Everything below is `∩`. Nothing here can produce a value wider than
  // either input on any axis, which is the property the tests prove
  // transitively.
  const ceiling: NodeCeiling = {
    accountId: senderCeiling.accountId,
    // The child runs under the RECEIVER, and `attenuateChild`'s identity axis
    // is what then holds the task to it.
    bindingId: receiver.bindingId,
    jobId: senderCeiling.jobId,
    depth: senderCeiling.depth,
    authority: intersectAuthority(senderCeiling.authority, receiver.authority),
    // The floor rule across an administrative boundary: the tighter of what
    // the work already carries and what the receiving operator declared.
    privacy: tightestPrivacy(senderCeiling.privacy, receiver.privacyFloor),
    // Urgency is NOT intersected, because urgency has no receiver-side term:
    // `attenuateChild` already refuses a child due before its parent (urgency
    // buys the paid cloud), and a receiving binding has no `dueAt` of its own
    // to narrow against. The sender's deadline rides across unchanged.
    dueAt: senderCeiling.dueAt,
  };

  return {
    ok: true,
    plan: {
      ceiling,
      hop,
      waiting: !receiver.enabled,
      provenance: {
        from: { invocationId: fromInvocationId, bindingId: sender.bindingId, bindingName: sender.bindingName },
        to: { bindingId: receiver.bindingId, bindingName: receiver.bindingName },
        reason: trimmed,
        hop,
        at: now,
      },
    },
  };
}

/**
 * Stamp provenance onto an attenuated child's context. The harness OWNS
 * `context.handoff` exactly as it owns `context.jobKey`: a task that supplies
 * its own is overwritten, so a planner cannot forge a chain it did not make.
 */
export function stampHandoff(child: AttenuatedChild, provenance: HandoffProvenance): AttenuatedChild {
  return { ...child, context: { ...child.context, handoff: provenance } };
}

/**
 * Read provenance back off a stored `context_json`. Strict — anything that is
 * not the exact shape `stampHandoff` writes reads as `null` (no handoff), for
 * the same reason `parseEnvelope` is strict: a half-parsed provenance record
 * would put a confident, wrong sentence in front of a human deciding whether
 * to approve an egress.
 */
export function parseHandoffProvenance(contextJson: string | null | undefined): HandoffProvenance | null {
  if (typeof contextJson !== "string" || contextJson.length === 0) return null;
  let v: unknown;
  try {
    v = JSON.parse(contextJson);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const h = (v as { handoff?: unknown }).handoff;
  if (typeof h !== "object" || h === null || Array.isArray(h)) return null;
  const o = h as Record<string, unknown>;
  const from = party(o.from, true);
  const to = party(o.to, false);
  if (from === null || to === null) return null;
  if (typeof o.reason !== "string" || o.reason.length === 0) return null;
  if (typeof o.hop !== "number" || !Number.isFinite(o.hop)) return null;
  if (typeof o.at !== "number" || !Number.isFinite(o.at)) return null;
  return { from: from as HandoffProvenance["from"], to, reason: o.reason, hop: o.hop, at: o.at };
}

function party(
  v: unknown,
  withInvocation: boolean,
): { bindingId: string; bindingName: string; invocationId?: string } | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.bindingId !== "string" || o.bindingId.length === 0) return null;
  if (typeof o.bindingName !== "string" || o.bindingName.length === 0) return null;
  if (withInvocation && (typeof o.invocationId !== "string" || o.invocationId.length === 0)) return null;
  return withInvocation
    ? { invocationId: o.invocationId as string, bindingId: o.bindingId, bindingName: o.bindingName }
    : { bindingId: o.bindingId, bindingName: o.bindingName };
}

/**
 * One sentence, for a proposal's rationale / an evidence note / a log line.
 * The chief-of-staff sentence, said the way a person would say it — this is
 * what "provenance survives the hop" means on the Activity page.
 */
export function describeHandoff(p: HandoffProvenance): string {
  return `${p.from.bindingName} handed this to ${p.to.bindingName} — ${p.reason}`;
}
