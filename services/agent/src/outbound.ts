import { Mailstore, normalizeAddress } from "@bullmoose/mailstore";
import type { Env } from "./models.js";

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
 */

/**
 * Why a send must not happen, or null when every recipient is in the book.
 * Callers refuse-and-note (the invocation-level skip, mirroring the
 * allowedSenders gate) or throw (the belt directly in front of the relay).
 */
export async function outboundRefusal(
  env: Env,
  job: { account_id: string; binding_id: string },
  recipients: string[],
): Promise<string | null> {
  const binding = await env.DB.prepare(
    `SELECT recipients_book_id FROM agent_bindings WHERE account_id = ? AND id = ?`,
  )
    .bind(job.account_id, job.binding_id)
    .first<{ recipients_book_id: string | null }>();
  if (!binding || !binding.recipients_book_id) {
    return "fail-closed: no governing book (agent_bindings.recipients_book_id is unset)";
  }
  const bookId = binding.recipients_book_id;
  const book = await env.DB.prepare(
    `SELECT id FROM address_books WHERE account_id = ? AND id = ?`,
  )
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
  env: Env,
  job: { account_id: string; binding_id: string },
  recipients: string[],
): Promise<void> {
  const refusal = await outboundRefusal(env, job, recipients);
  if (refusal) throw new Error(`outbound bound: ${refusal}`);
}
