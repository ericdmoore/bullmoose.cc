// s31 rung 3b — the repetition detector that EARNS its offers (s03.D T5's
// missing piece): "you've archived this sender five times — shall I?" The
// agent-offered twin of the language on-ramp, compiling through the same
// template→backtest→proposal machinery as every other rule.
//
// Three disciplines carry the design:
//
//   ALWAYS AN OFFER, NEVER THE GRANT. The rung-3 grant covers rule changes
//   a HUMAN initiated; a sweep-initiated rule auto-applying under it would
//   be exactly the accrual "given, never accrued" forbids. Every row this
//   file emits is `pending`.
//
//   HONEST LANGUAGE. The trigger evidence is archiving, but the engine's
//   only remedial action is HOLD (reject|pass is the whole dialect) — so
//   the offer says "held at the boundary", never "filed to archive". An
//   offer that promises an action the engine cannot perform is the
//   confidently-wrong rendering again.
//
//   DECLINES SUPPRESS. Any prior sieve-rule proposal that names the sender
//   — approved, declined, expired, anything — means this sweep never asks
//   again. "Should not have offered" (wrongAction) is a lesson the decline
//   taxonomy exists to teach, and re-offering unlearns it.

import { validateSieveRules, type SieveRule } from "@bullmoose/mailstore";
import { emitProposal } from "./proposals.js";
import { backtestRule, ruleSentence, templateRule } from "./ruleVerb.js";
import { VERB_PROPOSAL_EXPIRY_MS } from "./mailVerbs.js";
import type { Env } from "./models.js";
import type { EmailRow } from "@bullmoose/mailstore";

/** The plan's own number: five archives earn one question. */
export const REPETITION_THRESHOLD = 5;
/** Look-back window for the count — old habits are not fresh evidence. */
export const REPETITION_WINDOW_MS = 30 * 24 * 60 * 60_000;
/** Offers per account per sweep. A first deploy over a year of archiving
 *  must not flood the tray; the cap is LOGGED, never silent. */
export const REPETITION_OFFER_CAP = 3;

export const REPETITION_OFFER_KIND = "repetition-offer";

interface Candidate {
  account_id: string;
  sender: string;
  archived: number;
  exemplar_id: string;
}

/**
 * Repeated manual archiving, per (account, sender). Archive-role membership
 * is the signal precisely because the MACHINES do not use it: boundary
 * holds land in the junk-role mailbox, so archive is where human filing
 * shows. (A human who archives via a rule-less client is indistinguishable
 * from one who archives by hand — and either way the repetition is real.)
 */
async function findCandidates(env: Env, now: number): Promise<Candidate[]> {
  const { results } = await env.DB.prepare(
    `SELECT e.account_id,
            lower(json_extract(e.from_json, '$[0].email')) AS sender,
            COUNT(*) AS archived,
            MAX(e.id) AS exemplar_id
       FROM emails e
       JOIN email_mailboxes em ON em.account_id = e.account_id AND em.email_id = e.id
       JOIN mailboxes m ON m.account_id = e.account_id AND m.id = em.mailbox_id
      WHERE m.role = 'archive' AND e.received_at > ? AND sender IS NOT NULL
      GROUP BY e.account_id, sender
     HAVING archived >= ?
      ORDER BY archived DESC`,
  )
    .bind(now - REPETITION_WINDOW_MS, REPETITION_THRESHOLD)
    .all<Candidate>();
  return results ?? [];
}

/** The bouncer binding that will CARRY the offer — offers compile through
 *  the boundary agent's machinery, so an account without one gets no offer
 *  (nothing would exist to own the conversation that follows). */
async function bouncerFor(env: Env, accountId: string): Promise<{ id: string; name: string } | null> {
  const row = await env.DB.prepare(
    `SELECT b.id, b.name FROM agent_bindings b
      WHERE b.account_id = ? AND b.enabled = 1 AND b.config_json LIKE '%"pipeline":"bouncer"%'
      LIMIT 1`,
  )
    .bind(accountId)
    .first<{ id: string; name: string }>();
  return row ?? null;
}

/** Any prior sieve-rule proposal naming the sender suppresses — declines
 *  most of all. LIKE over payload_json is deliberate: template rules embed
 *  the sender verbatim, and a false SUPPRESS costs one unasked question
 *  while a false ASK re-teaches an unlearned lesson. */
async function alreadyAsked(env: Env, accountId: string, sender: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS hit FROM agent_proposals
      WHERE account_id = ? AND kind = 'sieve-rule' AND payload_json LIKE ? LIMIT 1`,
  )
    .bind(accountId, `%${sender}%`)
    .first<{ hit: number }>();
  return row !== null;
}

/** A rulebook rule already naming the sender suppresses the same way. */
async function alreadyRuled(env: Env, accountId: string, sender: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT rules_json FROM sieve_rules WHERE account_id = ?`)
    .bind(accountId)
    .first<{ rules_json: string }>();
  if (!row) return false;
  return row.rules_json.toLowerCase().includes(sender);
}

async function exemplarRow(env: Env, accountId: string, emailId: string): Promise<EmailRow | null> {
  const row = await env.DB.prepare(`SELECT id, subject, from_json, preview FROM emails WHERE account_id = ? AND id = ?`)
    .bind(accountId, emailId)
    .first<{ id: string; subject: string; from_json: string; preview: string }>();
  if (!row) return null;
  return {
    id: row.id,
    subject: row.subject,
    from: JSON.parse(row.from_json),
    preview: row.preview,
  } as unknown as EmailRow;
}

/**
 * The sweep. Emits at most REPETITION_OFFER_CAP pending offers per account
 * per run; what the cap drops is logged (no silent truncation) and will be
 * found again next sweep if still true.
 */
export async function proposeRepetitionOffers(env: Env, nowMs = Date.now()): Promise<number> {
  const candidates = await findCandidates(env, nowMs);
  const perAccount = new Map<string, number>();
  let offered = 0;
  for (const c of candidates) {
    const used = perAccount.get(c.account_id) ?? 0;
    if (used >= REPETITION_OFFER_CAP) {
      console.log(
        `repetition sweep: ${c.account_id} at the per-sweep offer cap (${REPETITION_OFFER_CAP}) — ` +
          `${c.sender} (${c.archived} archived) waits for the next sweep`,
      );
      continue;
    }
    if (await alreadyAsked(env, c.account_id, c.sender)) continue;
    if (await alreadyRuled(env, c.account_id, c.sender)) continue;
    const bouncer = await bouncerFor(env, c.account_id);
    if (!bouncer) continue;
    const exemplar = await exemplarRow(env, c.account_id, c.exemplar_id);
    if (!exemplar) continue;
    const bare = templateRule(exemplar);
    if (!bare) continue;

    const carrierId = `inv_${crypto.randomUUID()}`;
    const rule: SieveRule = validateSieveRules([{ id: carrierId, ...bare }])[0]!;
    const blast = await backtestRule(env, c.account_id, rule, exemplar.id);

    await env.DB.prepare(
      `INSERT INTO agent_invocations
         (id, account_id, binding_id, binding_name, status, context_json,
          created_at, claimed_at, done_at, cost_micros, result_json)
       VALUES (?, ?, ?, ?, 'done', ?, ?, ?, ?, 0, ?)`,
    )
      .bind(
        carrierId,
        c.account_id,
        bouncer.id,
        bouncer.name,
        JSON.stringify({ kind: REPETITION_OFFER_KIND, sender: c.sender, archived: c.archived }),
        nowMs,
        nowMs,
        nowMs,
        JSON.stringify({ kind: REPETITION_OFFER_KIND, composed: "template" }),
      )
      .run();

    await emitProposal(
      env,
      { id: carrierId, account_id: c.account_id },
      {
        kind: "sieve-rule",
        tier: 2,
        subject: { realm: "Email", objectId: exemplar.id },
        payload: {
          verb: "rule",
          rule,
          blastRadius: blast,
          composed: "template",
          offer: { sender: c.sender, archived: c.archived, windowDays: 30 },
        },
        rationale:
          `You've archived ${c.archived} messages from ${c.sender} in the last 30 days — ` +
          `want them held at the boundary instead? This would ${ruleSentence(rule)}. ` +
          `Backtested: would have held ${blast.caught} of ${blast.tested} recent messages` +
          (blast.answeredCaught > 0 ? ` — ${blast.answeredCaught} you replied to` : "") +
          `. Held mail stays rescuable; nothing is deleted.`,
        evidence: [{ realm: "Email", objectId: exemplar.id, note: `the newest of the ${c.archived} archived` }],
        expiresInMs: VERB_PROPOSAL_EXPIRY_MS,
      },
    );
    perAccount.set(c.account_id, used + 1);
    offered++;
  }
  return offered;
}
