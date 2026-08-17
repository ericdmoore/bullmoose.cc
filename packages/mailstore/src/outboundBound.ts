import { Mailstore } from "./index";
import { normalizeAddress } from "./governance";

/**
 * The outbound bound (s10 T1) — `allowedSenders`' twin, one gate for EVERY
 * agent send. A binding's reach is its governing address book
 * (`agent_bindings.recipients_book_id`), resolved server-side so a
 * compromised agent cannot even enumerate it. Fail-closed on the Bureau's
 * invariant-5 model (services/bureau/src/binding.ts): no book configured, or
 * book missing, or a recipient not in it ⇒ the send is refused — never
 * "unrestricted".
 *
 * Matching is normalized EXACT equality against the book's effective
 * membership (cards' emails + one level of contact-group expansion): lowercase
 * both sides, no LIKE, no substring, no plus-tag folding — `bob+x@` does NOT
 * match `bob@` (devPlan s10 T1). Contact search may scan loosely; an
 * allowlist must not.
 *
 * ## Why this lives in a package rather than in `services/agent`
 *
 * It was born in `services/agent/src/outbound.ts`, next to its only caller.
 * It is not agent-only: the approval path egresses from `services/jmap`
 * (`actionProposal.ts` → `applyProposal` → SUBMIT), and that is a DIFFERENT
 * worker. A second copy of the decision is how two enforcement points come to
 * disagree, so the decision lives here — beside `bookMembership`, the thing it
 * actually asks about — and both workers import the one function. Its whole
 * dependency surface is `DB` + `BLOBS` (see `OutboundBoundEnv`), so nothing
 * agent-shaped rides along into jmap.
 *
 * Reached through the `@bullmoose/mailstore/outboundBound` subpath rather than
 * the package index (the `@bullmoose/auth-core/principal` pattern): this module
 * imports `Mailstore` FROM the index, so re-exporting it there would make the
 * cycle real instead of merely survivable.
 *
 * ## Why it must be re-derived AT EGRESS, never carried from the draft
 *
 * Same argument as `effectiveNodeAuthority` (@bullmoose/scheduling): a check
 * performed at issue is a check the holder keeps forever. Between an agent
 * DRAFTING a reply and a human APPROVING it — and, for tier 2, between that
 * approval and the hold-tray sweep committing it — the governing book can be
 * narrowed, the binding can be disabled or deleted, and the approver can amend
 * the recipient (`agent_proposals.edited_payload_json`, which REPLACES the
 * payload wholesale and is validated only as "an object"). Narrowing has to
 * bite work already in the queue, and it only does if the binding and its book
 * are resolved from the database at the moment of send. Every caller therefore
 * passes the recipients it is ABOUT to hand the relay, not the ones the draft
 * was written against.
 */

/**
 * The bindings this decision needs, and nothing else. Both
 * `services/agent`'s and `services/jmap`'s `Env` satisfy it structurally, so
 * neither worker has to widen anything to call in.
 */
export interface OutboundBoundEnv {
  DB: D1Database;
  BLOBS: R2Bucket;
}

/** The binding whose reach is being asked about. */
export interface OutboundBoundJob {
  account_id: string;
  binding_id: string;
}

/**
 * The typed refusal `assertOutboundAllowed` throws, on the `BookWriteRefused`
 * model (governance.ts). The message carries the whole story; the TYPE is what
 * lets each protocol map it to its own shape — JMAP surfaces it as a
 * `forbidden` SetError instead of the `serverFail` a bare `Error` collapses
 * into, so an approver is told their book refused the recipient rather than
 * that the server broke.
 */
export class OutboundRefused extends Error {
  constructor(public readonly refusal: string) {
    super(`outbound bound: ${refusal}`);
    this.name = "OutboundRefused";
  }
}

/**
 * Why a send must not happen, or null when every recipient is in the book.
 * Callers refuse-and-note (the invocation-level skip, mirroring the
 * allowedSenders gate) or throw (the belt directly in front of the relay).
 */
export async function outboundRefusal(
  env: OutboundBoundEnv,
  job: OutboundBoundJob,
  recipients: string[],
): Promise<string | null> {
  const binding = await env.DB.prepare(
    `SELECT recipients_book_id, enabled FROM agent_bindings WHERE account_id = ? AND id = ?`,
  )
    .bind(job.account_id, job.binding_id)
    .first<{ recipients_book_id: string | null; enabled: number }>();
  if (!binding) {
    return `fail-closed: binding ${job.binding_id} does not exist`;
  }
  // A DISABLED binding is one whose reach has been revoked. The drain already
  // filters `enabled = 1`, so on the agent's own paths this is belt to a
  // brace — but the APPROVAL path never goes through the drain: a proposal
  // drafted while the binding was live can be approved, or swept out of the
  // hold tray, long after it was switched off. "Off" has to mean off at the
  // relay too, or disabling a binding is advice rather than a control.
  if (Number(binding.enabled) !== 1) {
    return `fail-closed: binding ${job.binding_id} is disabled`;
  }
  if (!binding.recipients_book_id) {
    return "fail-closed: no governing book (agent_bindings.recipients_book_id is unset)";
  }
  const bookId = binding.recipients_book_id;
  const book = await env.DB.prepare(`SELECT id FROM address_books WHERE account_id = ? AND id = ?`)
    .bind(job.account_id, bookId)
    .first<{ id: string }>();
  if (!book) return `fail-closed: governing book ${bookId} does not exist`;

  const members = await new Mailstore(env.DB, env.BLOBS).bookMembership(job.account_id, bookId);
  const denied = recipients.map(normalizeAddress).filter((r) => !members.has(r));
  if (denied.length > 0) {
    return `recipient(s) not in the governing book: ${denied.join(", ")}`;
  }
  return null;
}

/** The belt in front of the relay: every SUBMIT call sits behind this. */
export async function assertOutboundAllowed(
  env: OutboundBoundEnv,
  job: OutboundBoundJob,
  recipients: string[],
): Promise<void> {
  const refusal = await outboundRefusal(env, job, recipients);
  if (refusal) throw new OutboundRefused(refusal);
}
