// s12 wave 2-C — storage for the cascade's per-account MACHINE state:
// stage 3's sieve ruleset and stage 4's Bayes filter, one D1 row each.
//
// The contract surface bouncer@'s mailbox side (wave 2-D) consumes:
//
//   listSieveRules(db, accountId)            → SieveRule[]   (fail-open [])
//   putSieveRules(db, accountId, rules)      → void          (refuses garbage)
//   recordBayesLabel(db, accountId, msg, l)  → void          (load→train→save)
//
// plus the loaders the ingest cascade wires into stages 3–4. Every READ here
// fails open — a shard that predates the s12 2-C migrations, a row that will
// not parse, or an oversized state all degrade to "no rules / no state"
// (DefaultCase), with a console.error so the degrade is visible. WRITES throw:
// a training label or a ruleset that silently vanished would be worse than an
// error the caller can see.

import {
  VOCAB_CAP,
  bayesTrain,
  emptyBayesState,
  prunedTokens,
  type BayesState,
  type BoundaryMessage,
  type SieveMatch,
  type SieveRule,
} from "@bullmoose/boundary";

/**
 * The most state_json bytes a row may carry and still load. D1 caps a single
 * bound value at ~2 MB (capacity-and-scaling.md §2.5), so anything past that
 * could never have been written by this module — treat it as corrupt and load
 * null (stage 4 skips; fail open). `saveBayesState` prunes below this bound.
 */
export const BAYES_STATE_MAX_BYTES = 2_000_000;

// ---------------------------------------------------------------------------
// Sieve rules — ONE JSON document per account (§17's "JSON ruleset in D1").

/** Thrown by `putSieveRules` when the payload is not a valid ruleset. */
export class SieveRulesInvalid extends Error {
  constructor(reason: string) {
    super(`invalid sieve ruleset: ${reason}`);
    this.name = "SieveRulesInvalid";
  }
}

const SIEVE_FIELDS = new Set(["from", "fromDomain", "subject"]);

function validateMatch(m: unknown, at: string): void {
  if (typeof m !== "object" || m === null) throw new SieveRulesInvalid(`${at} is not an object`);
  const match = m as Record<string, unknown>;
  switch (match.kind) {
    case "contains":
    case "glob":
      if (!SIEVE_FIELDS.has(match.field as string)) {
        throw new SieveRulesInvalid(`${at} names unknown field ${JSON.stringify(match.field)}`);
      }
      if (typeof match.value !== "string")
        throw new SieveRulesInvalid(`${at} value must be a string`);
      return;
    case "headerPresent":
      if (typeof match.name !== "string" || match.name === "") {
        throw new SieveRulesInvalid(`${at} header name must be a non-empty string`);
      }
      return;
    case "headerContains":
    case "headerGlob":
      if (typeof match.name !== "string" || match.name === "") {
        throw new SieveRulesInvalid(`${at} header name must be a non-empty string`);
      }
      if (typeof match.value !== "string")
        throw new SieveRulesInvalid(`${at} value must be a string`);
      return;
    default:
      throw new SieveRulesInvalid(`${at} has unknown kind ${JSON.stringify(match.kind)}`);
  }
}

/**
 * Validate an arbitrary value against the SieveRule[] shape. Exported so the
 * mailbox surface (wave 2-D) can validate a proposed ruleset before deciding,
 * with EXACTLY the acceptance rule the write path enforces. Returns the value,
 * typed; throws `SieveRulesInvalid` naming the first offense.
 */
export function validateSieveRules(rules: unknown): SieveRule[] {
  if (!Array.isArray(rules)) throw new SieveRulesInvalid("not an array");
  const ids = new Set<string>();
  rules.forEach((rule, i) => {
    const at = `rules[${i}]`;
    if (typeof rule !== "object" || rule === null)
      throw new SieveRulesInvalid(`${at} is not an object`);
    const r = rule as Record<string, unknown>;
    if (typeof r.id !== "string" || r.id === "") {
      throw new SieveRulesInvalid(`${at} id must be a non-empty string`);
    }
    if (ids.has(r.id)) throw new SieveRulesInvalid(`${at} duplicates id ${JSON.stringify(r.id)}`);
    ids.add(r.id);
    if (r.action !== "reject" && r.action !== "pass") {
      throw new SieveRulesInvalid(`${at} action must be 'reject' or 'pass'`);
    }
    if (!Array.isArray(r.all)) throw new SieveRulesInvalid(`${at} .all must be an array`);
    (r.all as unknown[]).forEach((m, j) => validateMatch(m, `${at}.all[${j}]`));
  });
  return rules as SieveRule[];
}

/**
 * The account's stored ruleset, in evaluation order. Fail-open on EVERYTHING:
 * missing table (pre-migration shard), unreadable row, non-ruleset JSON — all
 * are "no rules configured" with a console.error, never a delivery error. The
 * honest cost: an operator cannot distinguish "no rules" from "rules table
 * broken" from this return value alone — the log line is the tell.
 */
export async function listSieveRules(db: D1Database, accountId: string): Promise<SieveRule[]> {
  try {
    const row = await db
      .prepare(`SELECT rules_json FROM sieve_rules WHERE account_id = ?`)
      .bind(accountId)
      .first<{ rules_json: string }>();
    if (!row) return [];
    return validateSieveRules(JSON.parse(row.rules_json));
  } catch (err) {
    console.error(
      `sieve rules for ${accountId} degraded to none (${err instanceof Error ? err.message : err})`,
    );
    return [];
  }
}

/**
 * Replace the account's ruleset. Validated against the SieveRule shape first —
 * garbage is REFUSED (`SieveRulesInvalid`), because a rules write is user
 * intent and half-storing it would make stage 3 silently diverge from what the
 * author believes is configured. Storage errors also throw (writes are loud).
 */
export async function putSieveRules(
  db: D1Database,
  accountId: string,
  rules: SieveRule[],
): Promise<void> {
  const validated = validateSieveRules(rules);
  await db
    .prepare(
      `INSERT INTO sieve_rules (account_id, rules_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (account_id) DO UPDATE SET rules_json = excluded.rules_json,
                                              updated_at = excluded.updated_at`,
    )
    .bind(accountId, JSON.stringify(validated), Date.now())
    .run();
}

// ---------------------------------------------------------------------------
// Bayes state — one JSON BayesState per account, VOCAB_CAP-pruned on save.

function isBayesState(v: unknown): v is BayesState {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.spamCount === "number" &&
    s.spamCount >= 0 &&
    typeof s.hamCount === "number" &&
    s.hamCount >= 0 &&
    typeof s.tokens === "object" &&
    s.tokens !== null
  );
}

/**
 * The account's trained filter state, or null when there is none to be had:
 * no row, missing table, corrupt JSON, wrong shape, or a row larger than
 * `BAYES_STATE_MAX_BYTES` (checked BEFORE parsing — an oversized row must not
 * buy a multi-MB JSON.parse on the delivery hot path). Null means stage 4
 * skips — fail open, logged when the cause is damage rather than absence.
 */
export async function loadBayesState(
  db: D1Database,
  accountId: string,
): Promise<BayesState | null> {
  let json: string;
  try {
    const row = await db
      .prepare(`SELECT state_json FROM bayes_state WHERE account_id = ?`)
      .bind(accountId)
      .first<{ state_json: string }>();
    if (!row) return null;
    json = row.state_json;
  } catch (err) {
    console.error(
      `bayes state for ${accountId} degraded to none (${err instanceof Error ? err.message : err})`,
    );
    return null;
  }
  if (json.length > BAYES_STATE_MAX_BYTES) {
    console.error(`bayes state for ${accountId} oversized (${json.length} bytes): loading null`);
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(json);
    if (!isBayesState(parsed)) throw new Error("not a BayesState shape");
    return parsed;
  } catch (err) {
    console.error(
      `bayes state for ${accountId} corrupt, loading null (${err instanceof Error ? err.message : err})`,
    );
    return null;
  }
}

/**
 * Persist a state, pruned to the package's VOCAB_CAP on EVERY save — the cap
 * is enforced here, not trusted to have held upstream. If the serialized form
 * still exceeds the byte bound (pathological token lengths), the cap halves
 * until it fits: deterministic, and strictly better than writing a row the
 * loader would refuse. Storage errors throw (writes are loud).
 */
export async function saveBayesState(
  db: D1Database,
  accountId: string,
  state: BayesState,
): Promise<void> {
  let cap = VOCAB_CAP;
  let tokens = prunedTokens(state.tokens, cap);
  let json = JSON.stringify({ spamCount: state.spamCount, hamCount: state.hamCount, tokens });
  while (json.length > BAYES_STATE_MAX_BYTES && cap > 1024) {
    cap = Math.floor(cap / 2);
    tokens = prunedTokens(tokens, cap);
    json = JSON.stringify({ spamCount: state.spamCount, hamCount: state.hamCount, tokens });
  }
  await db
    .prepare(
      `INSERT INTO bayes_state (account_id, state_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (account_id) DO UPDATE SET state_json = excluded.state_json,
                                              updated_at = excluded.updated_at`,
    )
    .bind(accountId, json, Date.now())
    .run();
}

/**
 * Fold one labeled message into the account's filter — the ONE training
 * entry point (rescues label ham; bouncer@ false-negative reports label spam;
 * classifier verdicts only behind LLM_LABELS_TRAIN). Loads the state (absent
 * → a fresh empty one: the first label CREATES the filter), trains via the
 * pure engine, saves prune-capped. Read-side damage degrades to the empty
 * state (a label must not be dropped because the old row was corrupt — the
 * corrupt row was already lost); the WRITE throws on failure.
 */
export async function recordBayesLabel(
  db: D1Database,
  accountId: string,
  msg: BoundaryMessage,
  label: "spam" | "ham",
): Promise<void> {
  const state = (await loadBayesState(db, accountId)) ?? emptyBayesState();
  await saveBayesState(db, accountId, bayesTrain(state, msg, label));
}

export type { BayesState, BoundaryMessage, SieveMatch, SieveRule };
