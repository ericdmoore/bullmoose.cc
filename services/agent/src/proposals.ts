import { commitChanges } from "@bullmoose/account-do";
import { buildMime } from "@bullmoose/mime";
import type { Mailstore } from "@bullmoose/mailstore";
import type { Env } from "./models.js";

/**
 * The proposal producer (s03.D T1, arch.md §1–2).
 *
 * For anything ABOVE tier 1 the agent worker EMITS a pending proposal rather
 * than performing the write — the human decides in the queue
 * (`ActionProposal/set`). A proposal is a READ MODEL over the invocation: its id
 * IS the invocation id (`agent_proposals` PK == `agent_invocations` PK), so the
 * two never drift and `agent`/status project straight off the invocation.
 *
 * This module only INSERTS the proposal-specific row and commits the
 * `ActionProposal` changelog entry (so `/changes` and push see it — the choreography
 * the JMAP `/set` side also honours). The invocation is finished by the caller.
 */

/** A proposal a run wants a human to decide. `rationale` is ALWAYS present
 * (invariant §8.3); `evidence` is what the agent looked at. */
export interface ProposalSpec {
  kind: string;
  tier: 1 | 2 | 3;
  /** What it acts on. */
  subject: { realm: string; objectId: string };
  /** Kind-specific — the AGENT's version (the source of truth). */
  payload: Record<string, unknown>;
  rationale: string;
  evidence: Array<{ realm: string; objectId: string; note?: string }>;
  /** Pre-decision deadline; the sweep flips `pending`→`expired` past it. */
  expiresInMs?: number;
}

/** How long a human has to decide before a proposal expires (default). */
const DEFAULT_EXPIRY_MS = 7 * 24 * 3600_000;

/** Just enough of the drain `Job` to key a proposal to its invocation. */
interface ProposalJob {
  id: string;
  account_id: string;
  tenant_id: string;
  binding_name: string;
}

/**
 * Insert the proposal row (keyed to the invocation) and commit its changelog
 * entry. Returns the proposal id, which is the invocation id.
 */
export async function emitProposal(
  env: Env,
  job: Pick<ProposalJob, "id" | "account_id">,
  spec: ProposalSpec,
): Promise<string> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO agent_proposals
       (id, account_id, kind, tier, subject_json, payload_json, rationale,
        evidence_json, status, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  )
    .bind(
      job.id,
      job.account_id,
      spec.kind,
      spec.tier,
      JSON.stringify(spec.subject),
      JSON.stringify(spec.payload),
      spec.rationale,
      JSON.stringify(spec.evidence),
      now,
      now + (spec.expiresInMs ?? DEFAULT_EXPIRY_MS),
    )
    .run();

  await commitChanges(env.ACCOUNT_DO, job.account_id, [
    { collection: "ActionProposal", created: [job.id], updated: [], destroyed: [] },
  ]);
  return job.id;
}

/**
 * The reply pipeline's tier-2 producer: instead of relaying a `send`-mode reply
 * (auto-egress with no human in the loop), build the MIME, park the bytes in R2,
 * and emit a `reply-draft` proposal carrying everything the eventual send needs.
 * The drafted text lives in the proposal `payload` (the source of truth); it is
 * NOT written to a mailbox here — the old-client Drafts projection is s03.D T4.
 */
export async function proposeReply(
  env: Env,
  store: Mailstore,
  job: ProposalJob,
  r: {
    selfAddress: string;
    to: string;
    origSubject: string;
    origMessageId: string | null;
    text: string;
    model?: string;
    sourceEmailId: string;
  },
): Promise<string> {
  const now = Date.now();
  const subject = /^re:/i.test(r.origSubject) ? r.origSubject : `Re: ${r.origSubject}`;
  const messageId = `${crypto.randomUUID()}@${r.selfAddress.split("@")[1] ?? "localhost"}`;
  const raw = buildMime({
    from: [{ name: job.binding_name, email: r.selfAddress }],
    to: [{ email: r.to }],
    subject,
    messageId,
    inReplyTo: r.origMessageId,
    date: new Date(now),
    text: r.text,
    extraHeaders: [
      "Auto-Submitted: auto-replied",
      "X-Auto-Response-Suppress: All",
      ...(r.model ? [`X-Bullmoose-Model: ${r.model}`] : []),
      `X-Bullmoose-Invocation: ${job.id}`,
    ],
  });
  const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
  const blobId = await store.putBlob(job.tenant_id, job.account_id, buf);

  return emitProposal(env, job, {
    kind: "reply-draft",
    tier: 2,
    subject: { realm: "Email", objectId: r.sourceEmailId },
    payload: {
      to: r.to,
      self: r.selfAddress,
      subject,
      text: r.text,
      blobId,
      inReplyTo: r.origMessageId,
      messageId,
      ...(r.model ? { model: r.model } : {}),
      mode: "send",
    },
    rationale:
      `Drafted a reply to ${r.to} re: "${r.origSubject}"` +
      `${r.model ? ` via ${r.model}` : ""}. Sending a reply is tier-2 (retractable) — ` +
      "it waits for your approval before it goes out.",
    evidence: [{ realm: "Email", objectId: r.sourceEmailId, note: "the message being replied to" }],
  });
}

/**
 * The expiry sweep (the pre-decision clock, s07 §T0). A `pending` proposal past
 * its `expires_at` is a chance the human has lost — flip it to `expired` and
 * commit so `/changes` reflects it. Runs on the worker's `scheduled` hook beside
 * `failStaleRunning`; a different clock from `hold_until` (post-approval).
 */
export async function expireStaleProposals(env: Env): Promise<void> {
  const now = Date.now();
  const { results } = await env.DB.prepare(
    `SELECT id, account_id FROM agent_proposals
      WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < ?`,
  )
    .bind(now)
    .all<{ id: string; account_id: string }>();
  if (results.length === 0) return;

  await env.DB.prepare(
    `UPDATE agent_proposals SET status = 'expired'
      WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < ?`,
  )
    .bind(now)
    .run();

  const byAccount = new Map<string, string[]>();
  for (const r of results) {
    const arr = byAccount.get(r.account_id) ?? [];
    arr.push(r.id);
    byAccount.set(r.account_id, arr);
  }
  for (const [accountId, ids] of byAccount) {
    await commitChanges(env.ACCOUNT_DO, accountId, [
      { collection: "ActionProposal", created: [], updated: ids, destroyed: [] },
    ]);
  }
}
