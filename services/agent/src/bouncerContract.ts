/**
 * s12-C contract: the storage/training/graduation wave (built in parallel)
 * exposes these two writes; bouncer@'s conversations (wave 2-D, bouncer.ts)
 * are built AGAINST this contract. Everything in this file is a stub to be
 * reconciled at merge — each function keeps the contract's shape and does the
 * minimal honest thing against the tables that already exist (s12 1-A DDL),
 * with the pieces that belong to C marked inline.
 */

/** What a Bayes training label is recorded against. Wave 2-D always passes
 * the EVIDENCE message (the forwarded payload), never the wrapper. */
import { recordBayesLabel as storeRecordBayesLabel } from "@bullmoose/mailstore";

export interface BayesLabelMessage {
  sender: string;
  subject: string;
  text: string;
  /** The stored email, when the evidence matched one (quarantined/recent). */
  emailId?: string | null;
}

export interface RecordedBayesLabel {
  accountId: string;
  label: "spam" | "ham";
  sender: string;
  subject: string;
  emailId: string | null;
}

// s12-C contract: test observability for the stub ONLY. C's implementation
// persists per-account Bayes state; until it lands, tests assert against this
// journal (and the console line is the runtime trace).
export const __recordedBayesLabels: RecordedBayesLabel[] = [];
export function __resetRecordedBayesLabels(): void {
  __recordedBayesLabels.length = 0;
}

/**
 * The per-account Bayes training write — quarantine rescues and bouncer@'s
 * FN reports are the filter's labeled corrections. Delegates to the mailstore
 * training write (wave 2-C); the journal stays as test observability so the
 * conversation tests can assert labels without reading Bayes internals.
 */
export async function recordBayesLabel(
  db: D1Database,
  accountId: string,
  msg: BayesLabelMessage,
  label: "spam" | "ham",
): Promise<void> {
  __recordedBayesLabels.push({
    accountId,
    label,
    sender: msg.sender,
    subject: msg.subject,
    emailId: msg.emailId ?? null,
  });
  const at = msg.sender.lastIndexOf("@");
  await storeRecordBayesLabel(
    db,
    accountId,
    {
      from: msg.sender,
      fromDomain: at < 0 ? "" : msg.sender.slice(at + 1),
      subject: msg.subject,
      textBody: msg.text,
      headers: {},
      sizeBytes: msg.text.length,
      hasAttachments: false,
    },
    label,
  );
}

/** The environment slice the deny write needs. */
export interface DenyEnv {
  DB: D1Database;
  ROUTES: KVNamespace;
}

/**
 * s12-C contract: addDenyDomain(env, domain, source, evidence).
 *
 * DELTA for merge reconciliation: `tenantId` is threaded as an explicit
 * parameter — `domain_deny_list` is PRIMARY KEY (tenant_id, domain) and this
 * worker serves every tenant, so the contract's env-only shape cannot name
 * the row. Fold however C resolved this at merge.
 *
 * Upsert semantics: a re-add refreshes source/evidence (a human directive
 * OVER a graduated row upgrades its provenance — the human's intent is the
 * stronger fact) but never duplicates.
 */
export async function addDenyDomain(
  env: DenyEnv,
  tenantId: string,
  domain: string,
  source: "directive" | "graduated" | "feed",
  evidence: string | null,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO domain_deny_list (tenant_id, domain, added_at, source, evidence)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (tenant_id, domain) DO UPDATE SET source = excluded.source, evidence = excluded.evidence`,
  )
    .bind(tenantId, domain, Date.now(), source, evidence)
    .run();
  await invalidateBoundaryBloom(env.ROUTES);
}

/**
 * s12-C contract: the bloom REBUILD after a blocked-entry ADD belongs to C's
 * wiring (`rebuildBoundaryBloom`, services/ingest/src/boundary.ts — a stale
 * bloom is a false negative, the one error class blooms cannot have). Until
 * that is callable from here, deleting the pointer is the safe equivalent:
 * `loadBloom` returns null when no pointer is published, and a null bloom
 * means the exact checks run UNCONDITIONALLY — strictly more work per
 * message, never a missed block. Replace with the rebuild at merge.
 */
export async function invalidateBoundaryBloom(routes: KVNamespace): Promise<void> {
  try {
    await routes.delete("boundary:bloom:current");
  } catch (err) {
    console.error(
      `bloom invalidation failed (exact checks may miss new entries until rebuild): ${err}`,
    );
  }
}
