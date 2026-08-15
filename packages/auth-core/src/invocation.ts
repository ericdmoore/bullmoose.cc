import { AGENT_MARKER_SCOPE, verifyTokenSecret } from "./index";
import { reachableAccounts, type AccountAccess, type Principal } from "./principal";

/**
 * PER-INVOCATION TOKENS — `bmi_<12hex>_<48hex>`, the second credential type.
 *
 * `.plans/s17-chief-of-staff/per-invocation-tokens.md` is the design and the
 * decision record; this is the grammar and the identity half of it.
 *
 * ── WHY A SECOND GRAMMAR, AND WHY IT MUST STAY SEPARATE ────────────────────
 * A delegated invocation carries an authority ENVELOPE — `{tools, credentials,
 * budgetMicros}`, folded down its chain by `@bullmoose/scheduling`. Two
 * surfaces need to enforce it (the MCP tool surface, the Bureau's credential
 * gate) and neither could, because both authorize a BEARER: a principal, not an
 * invocation. So the envelope had no consumer.
 *
 * The obvious fix — hand the runtime an ordinary `bm_` token and let it name
 * its invocation — leaks on day one. A credential `verifyBearer` accepts is,
 * by construction, accepted by EVERY surface, and the envelope's vocabulary
 * (MCP tool names, `vault_credentials.name` handles, micro-USD) is understood
 * by NONE of them. An invocation token whose envelope reads
 * `credentials: ["aws-mcp"]` would enumerate and delete the principal's entire
 * vault through `GET`/`DELETE /vault/credentials`, which gate on the `vault`
 * scope and nothing else. Same class at CalDAV/CardDAV and at JMAP.
 *
 * So the grammar is the enforcement. `parseToken` (`./index`) is a strict
 * ANCHORED `/^bm_…$/` and the single chokepoint every reader funnels through —
 * including `authenticateVault`'s hand-rolled copy — so every surface that
 * predates invocations, AND every future surface written by anyone who reuses
 * `verifyBearer`/`parseToken`, refuses a `bmi_` token with no line of code
 * being written. That property is asserted, not assumed:
 * `invocation.test.ts` presents one to the vault, to JMAP and to CalDAV and
 * requires a 401 from each.
 *
 * ⚠️ DO NOT relax `parseToken` to accept `bmi_`, and do not "unify" the two
 * parsers. The mutual exclusion IS the security property. A single parser with
 * a `kind` field would hand every existing gate a credential it believes it
 * understands.
 *
 * ── WHAT THE ROW CARRIES, AND WHAT IT DELIBERATELY DOES NOT ────────────────
 * `agent_invocation_tokens` is `(id, invocation_id, account_id, principal_id,
 * secret_hash, issued_at, expires_at)`. No envelope copy. No scope list. It
 * carries an IDENTITY — "I am acting as invocation X" — and the AUTHORITY is
 * recomputed per request from rows the holder cannot write
 * (`effectiveNodeAuthority`, @bullmoose/scheduling). Freezing the envelope onto
 * this row would re-create the bug `useAuthority.ts` was written against: a
 * gate that trusts a column trusts whoever last wrote it, and narrowing a
 * binding mid-flight would stop biting work already in the queue.
 *
 * ── LIFETIME IS DERIVED ────────────────────────────────────────────────────
 * `resolveInvocationToken` JOINs `agent_invocations` and requires
 * `status = 'running'`, and JOINs `agent_bindings` and requires `enabled = 1`.
 * So `finish()` kills the token on the next check with zero bookkeeping, and
 * the 008 kill switch reaches a token that is already open — the same
 * "revocation works by making a token stop resolving" property the whole s04
 * resolution rests on. `expires_at` is a belt against a row `failStaleRunning`
 * never sweeps, not the primary control.
 *
 * ── PLANES ─────────────────────────────────────────────────────────────────
 * This is the one module in `auth-core` that reads DATA-plane rows
 * (`agent_invocation_tokens`, `agent_invocations`, `agent_bindings`), because
 * an invocation is a data-plane object. The resolver touches nothing else, so
 * it is correct on a shard even if the control plane is ever split off; the
 * MINT reads `accounts.principal_id` once, which every worker in the tree
 * already does off the same `DB` binding.
 */

/**
 * How long a minted token stays valid regardless of its invocation's status.
 *
 * A belt, not the control — see the header. `failStaleRunning` sweeps `running`
 * rows after its own (longer) window, so this bounds the gap where a row is
 * stuck `running` and its token would otherwise resolve forever.
 */
export const INVOCATION_TOKEN_TTL_MS = 15 * 60_000;

/** The `bmi_` grammar, anchored, and deliberately NOT a superset of `bm_`. */
const INVOCATION_TOKEN_RE = /^bmi_([0-9a-f]{12})_([0-9a-f]{48})$/;

export interface MintedInvocationToken {
  /** Public row id, embedded in the token string. */
  id: string;
  /** The full `bmi_...` string — returned once, at the claim, never stored. */
  token: string;
  /** SHA-256 hex of the secret part — the only thing stored. */
  secretHash: string;
}

export async function mintInvocationToken(): Promise<MintedInvocationToken> {
  const id = randomHex(6);
  const secret = randomHex(24);
  return { id: `it_${id}`, token: `bmi_${id}_${secret}`, secretHash: await sha256Hex(secret) };
}

export interface ParsedInvocationToken {
  id: string;
  secret: string;
}

/**
 * The twin of `parseToken`, and its complement: a string is at most one of
 * these two shapes, never both. `bm_` and `bmi_` cannot collide — `bmi_…`
 * fails `^bm_([0-9a-f]{12})_` on the `i`, which is not hex.
 */
export function parseInvocationToken(raw: string): ParsedInvocationToken | null {
  const m = INVOCATION_TOKEN_RE.exec(raw.trim());
  return m ? { id: `it_${m[1]}`, secret: m[2] as string } : null;
}

/**
 * MINT ON CLAIM. Called from the two `pending → running` UPDATEs, and only
 * where `changes === 1` — the winner of that guarded update is by construction
 * the only party entitled to the token.
 *
 * Returns the plaintext ONCE (the caller hands it back in the claim response)
 * or `null` when the account is gone, which fails the mint closed rather than
 * writing a token whose principal cannot be resolved.
 */
export async function issueInvocationToken(
  db: D1Database,
  opts: { invocationId: string; accountId: string; now?: number },
): Promise<string | null> {
  const now = opts.now ?? Date.now();
  const account = await db
    .prepare(`SELECT principal_id FROM accounts WHERE id = ? AND deleted_at IS NULL`)
    .bind(opts.accountId)
    .first<{ principal_id: string }>();
  if (!account) return null;

  const minted = await mintInvocationToken();
  await db
    .prepare(
      `INSERT INTO agent_invocation_tokens
         (id, invocation_id, account_id, principal_id, secret_hash, issued_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      minted.id,
      opts.invocationId,
      opts.accountId,
      account.principal_id,
      minted.secretHash,
      now,
      now + INVOCATION_TOKEN_TTL_MS,
    )
    .run();
  return minted.token;
}

/**
 * Who a `bmi_` bearer IS. Never what it may do — that is
 * `effectiveNodeAuthority`, recomputed per request from the chain.
 *
 * `node` is the acting invocation's row, carried out of the same read so the
 * authority fold does not need a second one. It is the LIVE row: this resolves
 * per request, so a chain narrowed a millisecond ago bites the next call.
 */
export interface InvocationIdentity {
  tokenId: string;
  invocationId: string;
  accountId: string;
  principalId: string;
  expiresAt: number;
  node: {
    id: string;
    binding_id: string;
    job_id: string | null;
    parent_id: string | null;
    authority_json: string | null;
  };
}

export async function resolveInvocationToken(
  db: D1Database,
  raw: string,
  now = Date.now(),
): Promise<InvocationIdentity | null> {
  const parsed = parseInvocationToken(raw);
  if (!parsed) return null;

  // `status = 'running'` is the LIFETIME and `b.enabled = 1` is the 008 kill
  // switch, both as JOIN conditions rather than as post-checks: a token whose
  // invocation finished, or whose binding an operator has just revoked, must
  // fail to RESOLVE — not resolve-and-then-be-refused, which is one `if` away
  // from a caller that forgets it.
  const row = await db
    .prepare(
      `SELECT t.invocation_id, t.account_id, t.principal_id, t.secret_hash, t.expires_at,
              i.binding_id, i.job_id, i.parent_id, i.authority_json
         FROM agent_invocation_tokens t
         JOIN agent_invocations i
           ON i.account_id = t.account_id AND i.id = t.invocation_id
         JOIN agent_bindings b
           ON b.account_id = i.account_id AND b.id = i.binding_id
        WHERE t.id = ? AND i.status = 'running' AND b.enabled = 1`,
    )
    .bind(parsed.id)
    .first<{
      invocation_id: string;
      account_id: string;
      principal_id: string;
      secret_hash: string;
      expires_at: number;
      binding_id: string;
      job_id: string | null;
      parent_id: string | null;
      authority_json: string | null;
    }>();
  if (!row) return null;
  if (!(await verifyTokenSecret(parsed.secret, row.secret_hash))) return null;
  if (row.expires_at < now) return null;

  return {
    tokenId: parsed.id,
    invocationId: row.invocation_id,
    accountId: row.account_id,
    principalId: row.principal_id,
    expiresAt: row.expires_at,
    node: {
      id: row.invocation_id,
      binding_id: row.binding_id,
      job_id: row.job_id,
      parent_id: row.parent_id,
      authority_json: row.authority_json,
    },
  };
}

/**
 * THE STANDING SCOPES of an invocation token — the "before" the envelope is
 * ANDed after.
 *
 * The envelope is a DENIAL function, never a grant (`mayUse`: `tools: null`
 * means "no level declared this axis"), so a consumer must run its ordinary
 * standing check first and intersect. That check needs a scope list, and an
 * invocation has none of its own: scopes belong to `tokens` rows, and this
 * credential deliberately carries no scope column — a list on the row would be
 * a second thing the mint site has to get right, and the drain (which mints for
 * itself, with no bearer in hand) has nothing to copy from.
 *
 * So the standing set is declared HERE, in code the holder cannot write, and it
 * is the floor rather than an inheritance:
 *
 *   INCLUDED  read + the mail verbs an MCP tool actually declares
 *             (annotate/draft/move/delete), contacts, calendar — the union of
 *             `ToolDef.scope` over the live surface, and nothing beyond it.
 *   EXCLUDED  `vault` — the credential realm, and precisely the leak the
 *             `bmi_` grammar exists to prevent; `admin` — control plane;
 *             `send` — the one irreversible verb, and no tool declares it;
 *             `files` — no tool declares it either. `mail` is absent as a
 *             BUNDLE: it would smuggle `send` back in through `hasScope`.
 *   MARKED    `agent`, so `isAgentPrincipal` is true and the contact-write
 *             chokepoint refuses governed address books, exactly as it does
 *             for an agent-runtime `bm_` token.
 *
 * ⚠️ This set is COARSE on purpose and is not the narrowing. The narrowing is
 * `mayUse(effective(node), …)`, per tool, per request. Adding a scope here
 * widens every invocation token on the platform; adding it to a binding's
 * `config_json.jobs` widens one binding. Prefer the second.
 */
export const INVOCATION_STANDING_SCOPES: readonly string[] = [
  "read",
  "annotate",
  "draft",
  "move",
  "delete",
  "contacts",
  "calendar",
  AGENT_MARKER_SCOPE,
];

/**
 * The invocation's principal, reaching EXACTLY ONE account: its own.
 *
 * A `bm_` device token reaches every account its principal owns plus every
 * account a grant extends it to. An invocation acts on one account — the one
 * its binding lives on — so the reach is filtered to that account here rather
 * than left to each consumer to remember. A grant-reached account is dropped
 * outright: an invocation token is not a sharing credential.
 *
 * Returns null when the account no longer resolves (deleted, or the principal
 * is gone), which is the same fail-closed answer `verifyBearer` gives.
 */
export async function principalForInvocation(
  db: D1Database,
  identity: InvocationIdentity,
): Promise<Principal | null> {
  const row = await db
    .prepare(`SELECT login_email FROM principals WHERE id = ?`)
    .bind(identity.principalId)
    .first<{ login_email: string }>();
  if (!row) return null;

  const reach = await reachableAccounts(db, identity.principalId);
  const owned: AccountAccess | undefined = reach.find(
    (a) => a.accountId === identity.accountId && !a.granted,
  );
  if (!owned) return null;

  return {
    username: row.login_email,
    scopes: [...INVOCATION_STANDING_SCOPES],
    accounts: [owned],
  };
}

// ---- helpers ------------------------------------------------------------
//
// The COMPARE is `./index`'s `verifyTokenSecret` — one constant-time hash
// comparison in the tree, shared with `bm_`. Only the three byte helpers are
// local, because `index.ts` does not export them.

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return bytesToHex(buf);
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return bytesToHex(new Uint8Array(digest));
}

function bytesToHex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
