import { effectiveScopes, hasScope, MAIL_SCOPES, REALM_SCOPES } from "@bullmoose/auth-core";
import {
  accountAccess,
  matchingGrants,
  type AccountAccess,
  type GrantRef,
  type MethodDomain,
  type Principal,
} from "@bullmoose/auth-core/principal";
import { ToolError } from "./jmapBridge.js";
import type { BindingConfig, Env } from "./models.js";
import type { ToolDef } from "./mcp.js";

/**
 * `help@` — self-introspection over MCP (sVOL unit `015`).
 *
 * Every other tool on this surface reads USER DATA. These read
 * AUTHORIZATION STATE: who can reach this account, under what scope, what
 * fired on delivery, and who actually showed up. That is a different kind
 * of thing and it is the entire substance of the unit — an introspection
 * surface that leaks is strictly worse than no introspection surface,
 * because the data it leaks is the map of everyone else's access.
 *
 * ## The disclosure boundary (build this first, not last)
 *
 * The existing MCP gate answers one question: *may you see this account?*
 * These tools need a second: *may you see this fact about **who else** can
 * see this account?* `authorizeAccount` cannot answer it — it returns `ok`
 * for a GRANT-REACHED account (`principal.ts:253-259`), so under the plain
 * gate `analyst@`, holding a one-job read grant on Eric's mail, could ask
 * "who can read Eric's account?" and walk out with Eric's whole grant
 * table: every other agent's binding, every other grantee's address. Each
 * of those rows is about a THIRD PARTY who never granted `analyst@`
 * anything. The delegation Eric authorised was "read my mail", not "read
 * my org chart".
 *
 * So:
 *
 * **Rule 1 — every returned row is justified by an account the caller
 * OWNS.** Not "can reach". `AccountAccess.granted` is present *iff* access
 * came through a grant rather than ownership (`principal.ts:24-26`), so
 * `access.granted === undefined` is an exact, already-computed ownership
 * test. `ownedAccount()` below is that one line, and it is the difference
 * between the two designs.
 *
 * **Rule 2 — "what can *I* do" is always answerable; "what can *others*
 * do" only about accounts I own.**
 *
 * | Question | Row source | Allowed |
 * |---|---|---|
 * | What can I reach?  | `grants WHERE grantee_account_id ∈ mine` | always |
 * | Who can reach me?  | `grants WHERE target_account_id ∈ my OWNED` | owner only |
 * | Who can reach X, X grant-reached | — | refused, with the reason |
 *
 * The asymmetry is deliberate and worth stating rather than discovering:
 * answering *"who can reach me"* necessarily discloses other principals'
 * addresses. That is correct — you are entitled to know who can read your
 * mail — but it IS a disclosure, and it is exactly why Rule 1 says *own*.
 *
 * **Rule 3 — never `SELECT *` from a control-plane table.** Enumerate
 * columns. `tokens` carries `secret_hash` (`control-plane.sql:66`) and
 * `agent_bindings` carries `config_json` (`data-plane.sql:107`), which
 * holds personas and model routing. `AgentInvocation/get` already does
 * `SELECT *` and hand-projects (`agent.ts:54,62-72`); copy the projection
 * discipline, not the `SELECT *`. Every query in this file names its
 * columns, which is what makes done-when #4 assertable by reading the
 * SELECT list rather than by grepping a fixture's output.
 *
 * **Rule 4 — no token enumeration.** "Which tokens exist and what are they
 * scoped to" is a credential-inventory question for a human session
 * (`s03.E`), not an agent's tool loop. `listTokens` exists in provision;
 * it is deliberately not projected here.
 *
 * **Rule 5 — reading the audit log is itself auditable.** These tools take
 * the ordinary `handleToolCall` path, so a grant-reached call writes its
 * `grant_audit` row (`mcp.ts:345-352`) BEFORE `run` executes. Refusing
 * inside `run` rather than in the dispatcher is therefore load-bearing: a
 * REFUSED enumeration attempt still lands in the audit log, which is
 * precisely the event an operator wants to see.
 *
 * ## Why this queries D1 and not the provision worker
 *
 * `GET /grants` and `GET /agent-bindings` (`provision/src/index.ts:100,117`)
 * are gated by one shared `ADMIN_TOKEN` and filter only on a caller-supplied
 * `?email=` (`listGrants:590-604`) — anyone holding that token reads every
 * grant in the deployment. Proxying them from here would hand an agent
 * admin-plane reach through a `read`-shaped door. The agent worker binds the
 * same D1 (`bullmoose-mail-shard0`) that both planes are applied to, so these
 * query it directly, always filtered by the authenticated principal.
 *
 * ## Effective permissions, never raw scope strings
 *
 * `hasScope` treats `mail` as a bundle of the six mail verbs
 * (`auth-core/src/index.ts:46,72-75`). A grant stored as `["mail"]` reported
 * back as the string "mail" reads as innocuous while conferring `send` and
 * `delete`. `effectiveScopes()` expands it THROUGH `hasScope` itself, so the
 * answer cannot drift from the gate that enforces it — the one tool whose job
 * is to explain authorization must not be the tool that misrepresents it.
 */

// ---- effective permissions -------------------------------------------------

/**
 * What a scope list ACTUALLY allows, derived by asking `hasScope` — the same
 * function every gate in the tree calls. Exported for `s03.E`, which has the
 * identical requirement on the WebUI (`s03.E/readme.md:41-43`).
 *
 * The body MOVED to `@bullmoose/auth-core` (s02 T3) and this is now a
 * re-export, kept so the many `introspectTools` callers do not all have to
 * change. It had been copied three times — here, `services/jmap/src/console.ts`
 * and `webmail/src/lib/console/scopes.ts` — and the OAuth consent screen
 * needed a fourth. Four independent expansions of what a permission MEANS,
 * against one `hasScope` that decides what it DOES, is a drift waiting to
 * mislead someone at exactly the moment they are granting access.
 */
export { effectiveScopes };

/** Scopes that deserve a sentence rather than a chip. */
const SCOPE_WARNINGS: Record<string, string> = {
  send: "send — can send mail from this account to third parties, with no human review step",
  delete: "delete — can permanently delete mail",
  vault: "vault — can act with third-party credentials stored in the vault",
  admin: "admin — control-plane access; this should never appear on a grant",
};

/**
 * `s03.E/readme.md:44-45`: surface dangerous COMBINATIONS, not just
 * individual permissions — "send + external MCP + WebFetch is an
 * exfiltration path even though each part looks fine alone". A
 * conversational surface is arguably better at this than a UI, because it
 * can say so in a sentence.
 */
function grantWarnings(scopes: string[], collection: string | null, expiresAt: number | null): string[] {
  const eff = effectiveScopes(scopes);
  const out: string[] = [];
  for (const s of eff) if (SCOPE_WARNINGS[s]) out.push(SCOPE_WARNINGS[s]!);
  if (collection === null) {
    out.push(
      "whole-account grant — not narrowed to one address book or calendar, so it covers " +
        "every domain its scopes allow",
    );
  }
  if (expiresAt === null) {
    out.push("no expiry — this grant stays live until someone deletes it");
  }
  if (eff.includes("send") && eff.includes("read")) {
    out.push(
      "read + send together is an exfiltration path: the holder can read this account's mail " +
        "and send it anywhere, in one hop, without anyone approving the message",
    );
  }
  return out;
}

/**
 * Third-party clients the OWNER of this account authorized (s02 T4).
 *
 * Read from the D1 mirror, never from the AS's KV: this worker deliberately
 * does not hold the token store (see oauthBridge.ts), and a disclosure answer
 * is exactly the wrong reason to give it one.
 *
 * The consent is per PRINCIPAL, not per account, because that is what the
 * human authorized — a connected client acts as the owner and reaches every
 * account the owner owns. Reporting it against each of those accounts is
 * therefore accurate rather than over-broad, and hiding it from any of them
 * would be the omission this branch exists to fix.
 *
 * Degrades to an empty list on a shard predating the migration, matching the
 * write side. That is the one case where "no connected apps" may be a
 * limitation rather than a fact, and it is why the note below says `unknown`
 * rather than claiming none.
 */
async function connectedClients(
  db: D1Database,
  principal: Principal,
  accountId: string,
): Promise<Array<Record<string, unknown>>> {
  // Only for an account the caller owns — `ownedAccount` already refused a
  // grant-reached one before we get here, and this query is scoped to the
  // caller's own principal, so it cannot report someone else's consents.
  void accountId;
  try {
    const { results } = await db
      .prepare(
        `SELECT client_id, client_name, redirect_host, scopes, created_at
         FROM oauth_consents
         WHERE principal_id = (SELECT id FROM principals WHERE login_email = ?)
           AND revoked_at IS NULL
         ORDER BY created_at DESC`,
      )
      .bind(principal.username)
      .all<{
        client_id: string;
        client_name: string | null;
        redirect_host: string | null;
        scopes: string;
        created_at: number;
      }>();
    return results.map((r) => ({
      clientId: r.client_id,
      name: r.client_name ?? r.client_id,
      // The anti-impersonation fact, kept where a human can see it after the
      // fact: CIMD cannot prevent a local process claiming to be Claude Code,
      // so where the codes went is the part worth remembering.
      codesDeliveredTo: r.redirect_host,
      scopes: JSON.parse(r.scopes) as string[],
      allows: effectiveScopes(JSON.parse(r.scopes) as string[]),
      connectedAt: r.created_at,
    }));
  } catch {
    return [];
  }
}

// ---- the disclosure gate ---------------------------------------------------

function requireAccountId(args: Record<string, unknown>): string {
  const v = args.accountId;
  if (typeof v !== "string" || v.length === 0) {
    throw new ToolError("accountId is required and must be a non-empty string.");
  }
  return v;
}

/**
 * Rule 1, as one function. Returns the access only when the caller OWNS the
 * account; refuses — with the reason, because an agent that is told why can
 * do something else — when the account is merely grant-reached.
 *
 * `handleToolCall` has already run `authorizeAccount` and it said yes, which
 * is exactly the shortcut this exists to defeat.
 */
function ownedAccount(principal: Principal, accountId: string): AccountAccess {
  const access = accountAccess(principal, accountId);
  if (!access) {
    // Unreachable through handleToolCall (it refuses with -32004 first), but
    // this module must not depend on that to stay safe.
    throw new ToolError(`No account ${accountId} is reachable by this token.`);
  }
  if (access.granted) {
    throw new ToolError(
      `Refused: you reach ${accountId} through a grant, not ownership, and this tool reports ` +
        "who ELSE can reach it. Those rows are about third parties who never granted you " +
        "anything — a grant to read an account is not a grant to read its access list. " +
        "Use my_access to see what YOUR grant on this account allows, or ask the account's " +
        "owner to run this themselves.",
      { refusal: "notOwner", accountId },
    );
  }
  return access;
}

const ownedIds = (principal: Principal): string[] =>
  principal.accounts.filter((a) => !a.granted).map((a) => a.accountId);

const clamp = (v: unknown, def: number, min: number, max: number): number => {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : def;
  return Math.min(Math.max(n, min), max);
};

const marksFor = (xs: readonly unknown[]): string => xs.map(() => "?").join(",");

// ---- shared query layer ----------------------------------------------------
//
// `s03.E` renders this same data behind a human session and will want the
// same queries. They live here as exported functions rather than inline in a
// tool body so that reuse is a rename, not a re-derivation.

/** `grants` columns that are safe to project. Rule 3 — enumerated, not `*`. */
const GRANT_COLUMNS =
  "g.id, g.grantee_account_id, g.target_account_id, g.scopes, g.collection, " +
  "g.collection_id, g.created_by, g.created_at, g.expires_at, g.revoked_at";

interface GrantRow {
  id: string;
  grantee_account_id: string;
  target_account_id: string;
  scopes: string;
  collection: string | null;
  collection_id: string | null;
  created_by: string;
  created_at: number;
  expires_at: number | null;
  revoked_at: number | null;
  other_name: string | null;
  other_email: string | null;
}

/**
 * One grant, rendered for a human. `allows` is the whole point: `scopes` is
 * what the row says, `allows` is what it does.
 */
function renderGrant(r: GrantRow, side: "grantee" | "target") {
  const scopes = JSON.parse(r.scopes) as string[];
  // Two independent ways a grant stops being live, and this checked only one
  // until s03.A made revocation a tombstone (UPDATE, not DELETE). Enforcement
  // was always right -- auth-core's principal.ts filters `revoked_at IS NULL`
  // on the resolution path -- so a revoked grant genuinely stopped working.
  // What was wrong was this surface SAYING it was still live, which is worse
  // than it sounds: the entire point of these tools is letting a human check
  // who can reach their mail.
  const live =
    r.revoked_at === null && (r.expires_at === null || r.expires_at > Date.now());
  return {
    grantId: r.id,
    [side === "grantee" ? "grantee" : "target"]: {
      accountId: side === "grantee" ? r.grantee_account_id : r.target_account_id,
      name: r.other_name,
      address: r.other_email,
    },
    scopes,
    allows: effectiveScopes(scopes),
    collection: r.collection,
    collectionId: r.collection_id,
    createdBy: r.created_by,
    createdAt: new Date(r.created_at).toISOString(),
    expiresAt: r.expires_at === null ? null : new Date(r.expires_at).toISOString(),
    revokedAt: r.revoked_at === null ? null : new Date(r.revoked_at).toISOString(),
    live,
    warnings: grantWarnings(scopes, r.collection, r.expires_at),
  };
}

/**
 * Grants where one of `accountIds` is the GRANTEE — "what can I reach".
 * The other side (the target) is resolved to a name and address, which the
 * caller already reaches by definition, so this discloses nothing new.
 */
export async function grantsAsGrantee(db: D1Database, accountIds: string[]): Promise<GrantRow[]> {
  if (accountIds.length === 0) return [];
  const { results } = await db.prepare(
    `SELECT ${GRANT_COLUMNS},
            (SELECT a.display_name FROM accounts a WHERE a.id = g.target_account_id) AS other_name,
            (SELECT i.email FROM identities i WHERE i.account_id = g.target_account_id LIMIT 1) AS other_email
     FROM grants g
     WHERE g.grantee_account_id IN (${marksFor(accountIds)})
       AND g.revoked_at IS NULL
     ORDER BY g.created_at DESC`,
  )
    .bind(...accountIds)
    .all<GrantRow>();
  return results;
}

/**
 * Grants where `accountId` is the TARGET — "who can reach me". OWNER ONLY;
 * the caller must have passed `ownedAccount()` first. This is the query that
 * discloses other principals' addresses.
 */
export async function grantsAsTarget(db: D1Database, accountId: string): Promise<GrantRow[]> {
  const { results } = await db.prepare(
    `SELECT ${GRANT_COLUMNS},
            (SELECT a.display_name FROM accounts a WHERE a.id = g.grantee_account_id) AS other_name,
            (SELECT i.email FROM identities i WHERE i.account_id = g.grantee_account_id LIMIT 1) AS other_email
     FROM grants g
     WHERE g.target_account_id = ?
       AND g.revoked_at IS NULL
     ORDER BY g.created_at DESC`,
  )
    .bind(accountId)
    .all<GrantRow>();
  return results;
}

// ---- agent bindings --------------------------------------------------------

/**
 * The field-level allowlist over `config_json` that `015`'s open question #4
 * left unspecified.
 *
 * `BindingConfig` (`models.ts:29-49`) carries `persona`, `modelAliases`,
 * `digestTargets`, `allowedSenders` and `maxTokens`. Returning the blob
 * verbatim would disclose an operator's prompt library and a list of third
 * parties' addresses to anything holding a read token. Returning nothing
 * makes `my_agents` unable to answer "will this thing SEND?", which is the
 * question a person most needs answered about an agent.
 *
 * So: derived facts, never raw values. Booleans and counts where the value
 * itself is sensitive; the literal only where it is an enum this file
 * defines.
 *
 * Exported for the drift check in `services/jmap/src/consoleContract.test.ts`:
 * the console's read interface returns this same summary and mirrors this
 * derivation, and the two surfaces must not tell an operator different things
 * about whether an agent SENDS.
 */
export function describeBinding(configJson: string) {
  let cfg: BindingConfig = {};
  try {
    cfg = JSON.parse(configJson || "{}") as BindingConfig;
  } catch {
    return { pipeline: null, replyMode: null, configUnparseable: true };
  }
  const senders = cfg.allowedSenders ?? [];
  return {
    pipeline: cfg.pipeline ?? "reply",
    // An enum this module owns — not free text from config.
    replyMode: cfg.replyMode === "send" ? "send" : "draft",
    hasPersona: typeof cfg.persona === "string" && cfg.persona.length > 0,
    // The COUNT, never the addresses: who is allowed to drive an agent is a
    // list of third parties.
    senderAllowlist: senders.length > 0 ? { active: true, count: senders.length } : { active: false },
    modelAliasCount: Object.keys(cfg.modelAliases ?? {}).length,
  };
}

function bindingWarnings(b: { enabled: number; trigger_on: string }, d: ReturnType<typeof describeBinding>): string[] {
  const out: string[] = [];
  if (b.enabled !== 1) out.push("disabled — it will not fire, and ingest creates no invocation for it");
  if (d.replyMode === "send") {
    out.push(
      "replyMode is SEND: this agent sends mail to the original sender itself. Nothing is " +
        "queued for you to approve.",
    );
  }
  if (d.senderAllowlist && d.senderAllowlist.active === false && d.replyMode === "send") {
    out.push(
      "no sender allowlist AND replyMode send: anyone who can get a human-looking message " +
        "into this mailbox can make this account send mail. That combination is the " +
        "exfiltration shape worth reviewing even though each half looks routine.",
    );
  }
  if (b.trigger_on !== "mailbox-delivery") {
    out.push(
      `trigger_on is "${b.trigger_on}", and mailbox delivery is the only trigger the system ` +
        "actually implements — so nothing fires this binding today.",
    );
  }
  return out;
}

interface BindingRow {
  id: string;
  name: string;
  trigger_on: string;
  sla_seconds: number | null;
  enabled: number;
  config_json: string;
}

/** Rule 3: enumerated columns. `config_json` is read but never returned raw. */
export async function listBindings(db: D1Database, accountId: string): Promise<BindingRow[]> {
  const { results } = await db.prepare(
    `SELECT id, name, trigger_on, sla_seconds, enabled, config_json
     FROM agent_bindings WHERE account_id = ? ORDER BY name`,
  )
    .bind(accountId)
    .all<BindingRow>();
  return results;
}

function renderBinding(b: BindingRow) {
  const config = describeBinding(b.config_json);
  return {
    bindingId: b.id,
    name: b.name,
    triggerOn: b.trigger_on,
    slaSeconds: b.sla_seconds,
    enabled: b.enabled === 1,
    config,
    warnings: bindingWarnings(b, config),
  };
}

// ---- invocations -----------------------------------------------------------

interface InvocationRow {
  id: string;
  binding_id: string;
  binding_name: string;
  status: string;
  email_id: string | null;
  result_json: string | null;
  note: string | null;
  created_at: number;
  claimed_at: number | null;
  done_at: number | null;
}

/**
 * Enumerated columns again, and note what is NOT here: `context_json`. It
 * holds the triggering envelope recipient, which is delivery metadata rather
 * than an answer to any question this surface asks. `result_json` IS included
 * — it is worker-authored ({draftEmailId, replyId, error, note, model}) and
 * `AgentInvocation/get` already returns it parsed to any read-scoped caller
 * (`agent.ts:70`), so this is not new disclosure.
 */
const INVOCATION_COLUMNS =
  "id, binding_id, binding_name, status, email_id, result_json, note, created_at, claimed_at, done_at";

export async function listInvocations(
  db: D1Database,
  accountId: string,
  filter: { bindingName?: string; emailId?: string; status?: string; limit: number },
): Promise<InvocationRow[]> {
  const where = ["account_id = ?"];
  const binds: unknown[] = [accountId];
  if (filter.bindingName) {
    where.push("binding_name = ?");
    binds.push(filter.bindingName);
  }
  if (filter.emailId) {
    where.push("email_id = ?");
    binds.push(filter.emailId);
  }
  if (filter.status) {
    where.push("status = ?");
    binds.push(filter.status);
  }
  const { results } = await db.prepare(
    `SELECT ${INVOCATION_COLUMNS} FROM agent_invocations
     WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(...binds, filter.limit)
    .all<InvocationRow>();
  return results;
}

function parseResult(json: string | null): unknown {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function renderInvocation(r: InvocationRow) {
  return {
    invocationId: r.id,
    bindingId: r.binding_id,
    bindingName: r.binding_name,
    status: r.status,
    emailId: r.email_id,
    // The runtime's own explanation. `finish()` copies `result.note` into this
    // column (`services/agent/src/index.ts:330-335`), which is what makes the
    // skip reasons below readable at all.
    note: r.note,
    result: parseResult(r.result_json),
    createdAt: new Date(r.created_at).toISOString(),
    claimedAt: r.claimed_at === null ? null : new Date(r.claimed_at).toISOString(),
    doneAt: r.done_at === null ? null : new Date(r.done_at).toISOString(),
  };
}

/**
 * *"Why did editor@ skip that email?"*, turned into a verdict per binding.
 *
 * This is the question the unit was least sure was answerable at all, and the
 * answer is: PARTLY, from state that already exists — no decision log needs
 * to be invented, so this stays a projection.
 *
 *   answerable — the cloud runtime records every skip it takes as a real row:
 *     `done("done", { note: "skipped: <sender> not in allowedSenders" })` and
 *     `note: "skipped: auto-generated sender"` (`services/agent/src/index.ts:167,172`),
 *     and `finish()` writes that note to `agent_invocations.note` (`:330-335`).
 *     Both the fact and the reason are on the row.
 *
 *   answerable — a binding that is disabled or not `mailbox-delivery` never
 *     produces an invocation at all, because ingest filters on exactly those
 *     two columns (`services/ingest/src/index.ts:167-172`). No row is not a
 *     mystery: the binding row says why.
 *
 *   NOT answerable — the homelab runtime drops an invocation whose
 *     `bindingName` does not match its local config with a bare
 *     `return false` (`packages/cli/src/agent.ts:156`), writing no note and
 *     leaving the row `pending`. And it applies no `allowedSenders` gate at
 *     all (`.feedback/fromClaude/agentic/017`), so its skips are invisible.
 *
 *   NOT answerable — nothing records a delivery that matched no binding. If
 *     the email arrived before the binding existed there is no evidence
 *     either way, and this says so instead of guessing.
 */
function verdict(binding: BindingRow, invs: InvocationRow[]): { outcome: string; because: string } {
  if (invs.length === 0) {
    if (binding.enabled !== 1) {
      return {
        outcome: "never-ran",
        because:
          "The binding is disabled, and ingest only creates invocations for enabled bindings, " +
          "so no work was ever queued for this message.",
      };
    }
    if (binding.trigger_on !== "mailbox-delivery") {
      return {
        outcome: "never-ran",
        because:
          `The binding's trigger is "${binding.trigger_on}", and ingest only creates ` +
          'invocations for "mailbox-delivery", so nothing queued this message.',
      };
    }
    return {
      outcome: "no-evidence",
      because:
        "No invocation row exists for this message and this binding. The binding is enabled " +
        "and fires on delivery, so the likeliest explanations are that the message predates " +
        "the binding, or that it was never delivered to this account. Nothing is recorded " +
        "either way — this is an absence of evidence, not evidence of a decision.",
    };
  }
  const latest = invs[0]!;
  if (latest.status === "pending" || latest.status === "running") {
    return {
      outcome: "not-skipped",
      because: `The invocation is still ${latest.status}; it has not finished, let alone skipped.`,
    };
  }
  if (latest.note?.startsWith("skipped:")) {
    return { outcome: "skipped", because: `The runtime recorded: "${latest.note}".` };
  }
  if (latest.status === "failed") {
    return {
      outcome: "failed",
      because: `It did not skip — it failed.${latest.note ? ` The runtime recorded: "${latest.note}".` : ""}`,
    };
  }
  return {
    outcome: "ran",
    because:
      "It did not skip: the invocation completed." +
      (latest.note ? ` The runtime recorded: "${latest.note}".` : ""),
  };
}

/**
 * What this surface structurally cannot tell you. Returned WITH every skip
 * answer rather than documented somewhere a model will not read, because a
 * confident wrong answer here is worse than an admission.
 */
const SKIP_LIMITATIONS = [
  "The homelab runtime (`bullmoose agent serve`) drops an invocation whose binding name does " +
    "not match its local config without writing a note, leaving the row pending — a skip it " +
    "takes leaves no trace here.",
  "The homelab runtime applies no allowedSenders filter at all, so the same message can be " +
    "skipped in the cloud and answered locally.",
  "Nothing records a delivery that matched no binding, so 'no invocation exists' can never be " +
    "distinguished from 'the message was never delivered'.",
];

// ---- the access log --------------------------------------------------------

interface AuditRow {
  id: number;
  grant_id: string;
  principal: string;
  method: string;
  at: number;
  grant_live: number;
  grant_revoked_at: number | null;
  grant_scopes: string | null;
}

/**
 * `grant_audit`, read for the first time by anything in this repo.
 *
 * Windowed on `(account_id, at)`, which is the only index the table has
 * (`control-plane.sql:117`); any other predicate is a scan.
 *
 * The LEFT JOIN is the point. `revokeGrant` is a hard `DELETE FROM grants`
 * (`provision/src/index.ts:603`) and `s03.A`'s tombstones do not exist, so
 * audit rows outlive the grant they name and their `grant_id` resolves to
 * nothing. Dropping those rows would hide exactly the access an operator most
 * wants to see; rendering a dangling id would be a puzzle. Annotate instead —
 * `s03.E/readme.md:29-31`: the gap between "who could" and "who did" is
 * itself the finding.
 */
export async function readAccessLog(
  db: D1Database,
  accountId: string,
  since: number,
  limit: number,
): Promise<AuditRow[]> {
  const { results } = await db.prepare(
    `SELECT ga.id, ga.grant_id, ga.principal, ga.method, ga.at,
            -- COUNT(*) alone counted the TOMBSTONE: since s03.A revocation is
            -- an UPDATE, not a DELETE, so the row survives and this was always
            -- >= 1. Every historical access rendered "live" and the
            -- underRevokedGrants summary was permanently 0.
            (SELECT COUNT(*) FROM grants g
              WHERE g.id = ga.grant_id AND g.revoked_at IS NULL) AS grant_live,
            (SELECT g.revoked_at FROM grants g WHERE g.id = ga.grant_id) AS grant_revoked_at,
            (SELECT g.scopes FROM grants g WHERE g.id = ga.grant_id) AS grant_scopes
     FROM grant_audit ga
     WHERE ga.account_id = ? AND ga.at >= ?
     ORDER BY ga.at DESC LIMIT ?`,
  )
    .bind(accountId, since, limit)
    .all<AuditRow>();
  return results;
}

/**
 * `grant_audit.method` has four shapes, all written by this repo:
 *   `mcp:<tool>`                  — `mcp.ts:350`
 *   `bureau:<verb>:<credRef>`     — `services/bureau/src/grants.ts` (Bureau T2)
 *   `<domain>:<scope>`            — `methods/common.ts:108` (requireAccount)
 *   `<domain>:<a>+<b>`            — `methods/common.ts:76` (requireAccountScopes)
 * The last is not in `015`'s bread-crumbs and would render as a scope named
 * "draft+delete" if parsed naively.
 *
 * The `bureau:` shape must be matched BEFORE the generic `<domain>:<scope>`
 * fallthrough, or a credential-use row renders as domain "bureau" with a scope
 * literally named "fetch:aws-mcp".
 */
function parseAuditMethod(method: string): Record<string, unknown> {
  if (method.startsWith("mcp:")) {
    return { surface: "mcp", tool: method.slice(4) };
  }
  if (method.startsWith("bureau:")) {
    // bureau:<verb>:<credRef> — credRef may itself contain no colon
    // (validated `^[a-z0-9][a-z0-9._-]{0,63}$`), so one split is safe.
    const rest = method.slice(7);
    const sep = rest.indexOf(":");
    return sep < 0
      ? { surface: "bureau", verb: rest }
      : { surface: "bureau", verb: rest.slice(0, sep), credRef: rest.slice(sep + 1) };
  }
  const colon = method.indexOf(":");
  if (colon < 0) return { surface: "unknown", raw: method };
  return {
    surface: "jmap",
    domain: method.slice(0, colon),
    scopes: method.slice(colon + 1).split("+"),
  };
}

function renderAudit(r: AuditRow) {
  return {
    at: new Date(r.at).toISOString(),
    principal: r.principal,
    ...parseAuditMethod(r.method),
    grantId: r.grant_id,
    grantStatus: r.grant_live > 0 ? "live" : r.grant_revoked_at !== null ? "revoked" : "deleted",
    ...(r.grant_live > 0
      ? {}
      : r.grant_revoked_at !== null
        ? {
            // s03.A turned revocation into a tombstone, which makes this case
            // BETTER than the note used to claim: the row survives, so both the
            // revocation time and the original scopes are recoverable. The old
            // text ("a hard DELETE with no tombstone, so the grant's original
            // scopes cannot be recovered") described the pre-s03.A world and
            // would have told an auditor to stop looking.
            revokedAt: new Date(r.grant_revoked_at).toISOString(),
            scopesAtAccess: r.grant_scopes === null ? null : (JSON.parse(r.grant_scopes) as string[]),
            note:
              "This grant was revoked. The access below happened while it was live — " +
              "revocation does not retroactively un-do it. Because revocation is a " +
              "tombstone rather than a delete, the grant's scopes are shown above as " +
              "they stood.",
          }
        : {
            note:
              "This grant row is gone entirely — not revoked, deleted. Revocation " +
              "leaves a tombstone, so a missing row means something bypassed the " +
              "revocation path. The access below happened while the grant was live, " +
              "but its original scopes cannot be recovered.",
          }),
  };
}

/**
 * What `grant_audit` does and does not record. Returned with every
 * `access_log` answer, because all four of these would otherwise be read into
 * the data by anyone treating it as an access log in the ordinary sense.
 */
const ACCESS_LOG_LIMITATIONS = [
  "Only DELEGATED access is recorded. A row is written when someone reaches this account " +
    "through a grant; the owner's own reads and writes are never logged. An empty result means " +
    "'nobody reached this account through a grant', not 'nothing happened'.",
  "Rows record ATTEMPTS, not outcomes. The audit write happens before the method or tool runs " +
    "and there is no status column, so a call that was then refused or errored looks identical " +
    "to one that succeeded.",
  "No row says WHAT was read. There is no object id, count, or collection on the row — only " +
    "the account, the acting principal, the method label and the time.",
  "The grant's scopes are not copied onto the row, so for a revoked grant there is no way to " +
    "recover what the access was permitted to do.",
];

// ---- tools -----------------------------------------------------------------
//
// Every tool declares scope `read`. That is not laziness: `mcpTools.test.ts`
// treats `scope !== "read"` as the definition of a write tool, and these
// write nothing. `domain` is `mail` because `MethodDomain` is a closed union
// of `mail | contacts | calendar` (`principal.ts:207`) and none of the three
// describes authorization state.
//
// `mail` is the honest choice of the three, and — contra `015`'s own reasoning
// — it puts no lie in the audit log: MCP writes `mcp:<toolName>` as the audit
// `method` (`mcp.ts:350`), never the domain. The domain is consumed only by
// `grantCoversDomain`, where it decides which grants could unlock the tool for
// a GRANT-REACHED caller — and Rule 1 refuses every one of those anyway for
// the tools that read other principals' rows. Widening `MethodDomain` for a
// label nothing records would be a change to a shared type for no behaviour.

const ACCOUNT_ARG = {
  accountId: {
    type: "string",
    description: "The bullmoose account id to answer about.",
  },
} as const;

const INTROSPECTION_TOOLS: ToolDef[] = [
  {
    name: "whoami",
    scope: "read",
    domain: "mail",
    // The discovery entry point, so it takes NO arguments (s02 T5). It used
    // to require an accountId "only to satisfy the MCP dispatcher's account
    // gate" — which meant the one tool that tells you your account ids could
    // not be called until you knew one. `accountless` is the dispatcher-side
    // half of that fix; the answer was always a projection of the principal,
    // never of the account that was being passed in.
    accountless: true,
    description:
      "Who this token is, what it can actually do, and every account it reaches — owned " +
      "accounts and grant-reached accounts listed separately. Scopes are reported as the " +
      "permissions they confer, not as the raw strings: a token scoped \"mail\" is reported " +
      "as read/annotate/draft/move/send/delete, because that is what it allows. Takes no " +
      "arguments. Start here — every other tool takes an accountId this one gives you, and " +
      "you may omit that argument when the answer below lists exactly one account.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    // A pure projection of the Principal `verifyBearer` already built
    // (`principal.ts:123-187`) — owned accounts from the accounts table,
    // grant-reached ones with their GrantRefs attached. No query at all.
    async run({ principal }) {
      const owned = principal.accounts.filter((a) => !a.granted);
      const reached = principal.accounts.filter((a) => a.granted);
      return {
        principal: principal.username,
        tokenScopes: principal.scopes,
        tokenAllows: effectiveScopes(principal.scopes),
        ownedAccounts: owned.map((a) => ({
          accountId: a.accountId,
          name: a.name,
          tenantId: a.tenantId,
        })),
        grantReachedAccounts: reached.map((a) => ({
          accountId: a.accountId,
          name: a.name,
          tenantId: a.tenantId,
          via: (a.granted ?? []).map((g: GrantRef) => ({
            grantId: g.grantId,
            scopes: g.scopes,
            // Effective rights on a grant-reached account are token ∩ grant.
            allows: effectiveScopes(g.scopes).filter((s) => hasScope(principal.scopes, s)),
            collection: g.collection,
            collectionId: g.collectionId,
          })),
        })),
        notes: [
          "Owned accounts are yours. Grant-reached accounts belong to someone else and you " +
            "reach them only through the grants listed under each one.",
          "On a grant-reached account your effective rights are token ∩ grant, which is what " +
            "`allows` shows — never the grant's scopes alone.",
          "Tools that report who ELSE can reach an account (who_can_access, my_agents, " +
            "access_log, invocation_history, explain_skip) work on OWNED accounts only.",
        ],
      };
    },
  },
  {
    name: "my_access",
    scope: "read",
    domain: "mail",
    description:
      "Every grant where YOU are the grantee — what you can reach, what it lets you do, and " +
      "when it expires. Self-description: always answerable, on any account you can reach. " +
      "Use who_can_access for the opposite direction.",
    inputSchema: {
      type: "object",
      properties: ACCOUNT_ARG,
      required: ["accountId"],
    },
    // Deliberately NOT gated on ownership. Every row is a grant made TO this
    // principal — Rule 2's "what can I reach", which is self-description and
    // discloses nothing about a third party's access to anything.
    async run({ env, principal }, args) {
      requireAccountId(args);
      const mine = ownedIds(principal);
      const rows = await grantsAsGrantee(env.DB, mine);
      return {
        principal: principal.username,
        granteeAccounts: mine,
        grants: rows.map((r) => renderGrant(r, "target")),
        notes: [
          "`scopes` is what the grant row stores; `allows` is what it actually permits. A " +
            'grant stored as ["mail"] permits read, annotate, draft, move, send and delete.',
          "Your effective rights are token ∩ grant: a grant allowing `send` does nothing if " +
            "your token lacks `send`. Run whoami to see the token side.",
          "Expired grants are listed with live=false; verifyBearer already excludes them from " +
            "the accounts you can actually reach.",
        ],
      };
    },
  },
  {
    name: "who_can_access",
    scope: "read",
    domain: "mail",
    description:
      'Who else can reach an account you OWN — "which agents can read my contacts?". Filter ' +
      "with domain (contacts | calendar | mail) and scope (read, send, delete, ...) to ask a " +
      "narrower question. Refused on an account you only reach through a grant: those rows " +
      "are about third parties, and a grant to read an account is not a grant to read its " +
      "access list.",
    inputSchema: {
      type: "object",
      properties: {
        ...ACCOUNT_ARG,
        domain: {
          type: "string",
          enum: ["mail", "contacts", "calendar"],
          description:
            'Only grants that unlock this domain. "contacts" excludes a Calendar-scoped grant ' +
            "and includes any whole-account grant.",
        },
        scope: {
          type: "string",
          description:
            'Only grants conferring this permission, e.g. "read", "send", "contacts". ' +
            'Expansion is applied, so ["mail"] matches scope="send".',
        },
      },
      required: ["accountId"],
    },
    async run({ env, principal }, args) {
      const accountId = requireAccountId(args);
      const access = ownedAccount(principal, accountId);
      const rows = await grantsAsTarget(env.DB, access.accountId);

      const domain = typeof args.domain === "string" ? (args.domain as MethodDomain) : undefined;
      const scope = typeof args.scope === "string" ? args.scope : undefined;
      // `matchingGrants` (principal.ts:217-224) IS the scope ∩ domain rule the
      // gate runs. Reusing it rather than re-deriving the predicate in SQL is
      // what keeps this answer equal to what the gate would decide.
      const filtered =
        domain || scope
          ? rows.filter((r) => {
              const ref: GrantRef = {
                grantId: r.id,
                scopes: JSON.parse(r.scopes) as string[],
                collection: r.collection,
                collectionId: r.collection_id,
              };
              return (
                matchingGrants({ ...access, granted: [ref] }, scope ?? "read", domain ?? "mail")
                  .length > 0
              );
            })
          : rows;

      // Connected OAuth clients reach this account too (s02 T4). They are not
      // grants — a client is not an account and has no row in `grants` — so
      // without this branch the answer would be complete-looking and wrong:
      // it would render as "nobody else", which is the one failure this tool
      // must not have. See oauth_consents in control-plane.sql.
      const clients = await connectedClients(env.DB, principal, accountId);

      return {
        accountId: access.accountId,
        filter: { domain: domain ?? null, scope: scope ?? null },
        grants: filtered.map((r) => renderGrant(r, "grantee")),
        connectedApps: clients,
        notes: [
          "These are the OTHER principals who can reach this account, and their addresses. " +
            "You are entitled to know who can read your mail; it is still a disclosure, which " +
            "is why this tool works on owned accounts only.",
          "`connectedApps` are third-party clients this account's owner authorized through " +
            "the consent screen (claude.ai, Claude Code). They act AS the owner, so they do " +
            "not appear as grants — but they can reach this account, and revoking one is a " +
            "separate action from revoking a grant.",
          "This is who COULD reach the account. For who actually did, use access_log — and " +
            "expect the two to differ.",
          "Agents that act on this account without a grant do not appear here; they are " +
            "bindings, not grantees. Use my_agents.",
        ],
      };
    },
  },
  {
    name: "my_agents",
    scope: "read",
    domain: "mail",
    description:
      "The agent bindings on an account you own: name, trigger, SLA, whether it is enabled, " +
      "and the safety-relevant shape of its config — whether it SENDS or only drafts, and " +
      "whether it has a sender allowlist. Personas, model routing and allowlisted addresses " +
      "are deliberately not returned. Owner only.",
    inputSchema: {
      type: "object",
      properties: ACCOUNT_ARG,
      required: ["accountId"],
    },
    async run({ env, principal }, args) {
      const accountId = requireAccountId(args);
      const access = ownedAccount(principal, accountId);
      const rows = await listBindings(env.DB, access.accountId);
      return {
        accountId: access.accountId,
        bindings: rows.map(renderBinding),
        notes: [
          "A binding is not a grant: it runs inside this account, so it does not appear in " +
            "who_can_access and its activity is not written to the access log.",
          "config is a derived summary, never the stored config. The persona text, the model " +
            "aliases and the allowlisted addresses are not returned by this surface.",
        ],
      };
    },
  },
  {
    name: "invocation_history",
    scope: "read",
    domain: "mail",
    description:
      "What the agents on an account you own actually did — one row per invocation, with the " +
      "runtime's own note and result. Filter by binding name, email id or status " +
      "(pending | running | done | failed). Owner only.",
    inputSchema: {
      type: "object",
      properties: {
        ...ACCOUNT_ARG,
        bindingName: { type: "string", description: 'e.g. "editor" — the binding\'s name.' },
        emailId: { type: "string", description: "Only invocations triggered by this message." },
        status: { type: "string", enum: ["pending", "running", "done", "failed"] },
        limit: { type: "number", description: "max rows (default 25, max 200)" },
      },
      required: ["accountId"],
    },
    // A direct query rather than AgentInvocation/query, which hard-caps at
    // LIMIT 64 and filters to exactly one status (`agent.ts:22-28`) — it
    // cannot express "all of them, newest first", which is what history means.
    async run({ env, principal }, args) {
      const accountId = requireAccountId(args);
      const access = ownedAccount(principal, accountId);
      const rows = await listInvocations(env.DB, access.accountId, {
        bindingName: typeof args.bindingName === "string" ? args.bindingName : undefined,
        emailId: typeof args.emailId === "string" ? args.emailId : undefined,
        status: typeof args.status === "string" ? args.status : undefined,
        limit: clamp(args.limit, 25, 1, 200),
      });
      return {
        accountId: access.accountId,
        invocations: rows.map(renderInvocation),
        notes: [
          "A row exists only where ingest created one: for an ENABLED binding with " +
            "trigger_on = 'mailbox-delivery'. A message that matched no binding leaves no row.",
          'A status of "done" with a note beginning "skipped:" means the runtime deliberately ' +
            "declined the message. Use explain_skip for the full account of one message.",
        ],
      };
    },
  },
  {
    name: "explain_skip",
    scope: "read",
    domain: "mail",
    description:
      'Why an agent did or did not act on one message — "why did editor@ skip that email?". ' +
      "Gives a verdict per binding: skipped (with the runtime's recorded reason), never-ran " +
      "(with the binding state that prevented it), still running, failed, or no-evidence. " +
      "Says plainly when the system recorded nothing, rather than guessing. Owner only.",
    inputSchema: {
      type: "object",
      properties: {
        ...ACCOUNT_ARG,
        emailId: { type: "string", description: "The message in question." },
        bindingName: {
          type: "string",
          description: 'Only this binding, e.g. "editor". Omit to cover every binding.',
        },
      },
      required: ["accountId", "emailId"],
    },
    async run({ env, principal }, args) {
      const accountId = requireAccountId(args);
      const access = ownedAccount(principal, accountId);
      const emailId = typeof args.emailId === "string" && args.emailId ? args.emailId : null;
      if (!emailId) throw new ToolError("emailId is required and must be a non-empty string.");
      const only = typeof args.bindingName === "string" ? args.bindingName : undefined;

      const bindings = (await listBindings(env.DB, access.accountId)).filter(
        (b) => !only || b.name === only,
      );
      const invocations = await listInvocations(env.DB, access.accountId, {
        emailId,
        limit: 200,
      });

      const perBinding = bindings.map((b) => {
        const mine = invocations.filter((i) => i.binding_id === b.id);
        return {
          binding: renderBinding(b),
          ...verdict(b, mine),
          invocations: mine.map(renderInvocation),
        };
      });

      // An invocation whose binding row has since been deleted still explains
      // a skip, and dropping it would silently lose the answer.
      const orphaned = invocations.filter((i) => !bindings.some((b) => b.id === i.binding_id));

      return {
        accountId: access.accountId,
        emailId,
        bindings: perBinding,
        ...(orphaned.length > 0
          ? {
              orphanedInvocations: {
                note:
                  "These invocations reference a binding that no longer exists. The work " +
                  "happened; the binding was deleted afterwards.",
                invocations: orphaned.map(renderInvocation),
              },
            }
          : {}),
        ...(bindings.length === 0
          ? {
              note: only
                ? `This account has no binding named "${only}". If it once did, it has been deleted — ` +
                  "binding deletion leaves no record."
                : "This account has no agent bindings at all, so nothing could have acted on " +
                  "the message.",
            }
          : {}),
        limitations: SKIP_LIMITATIONS,
      };
    },
  },
  {
    name: "access_log",
    scope: "read",
    domain: "mail",
    description:
      "Who reached an account you own through a GRANT, under what method, and when — read " +
      "from the grant_audit trail. Includes access made under grants that have since been " +
      "revoked, annotated as such rather than dropped. Owner only. Read the limitations it " +
      "returns before drawing a conclusion: this records delegated attempts, not everything " +
      "that happened.",
    inputSchema: {
      type: "object",
      properties: {
        ...ACCOUNT_ARG,
        days: { type: "number", description: "window (default 30, max 365)" },
        limit: { type: "number", description: "max rows (default 100, max 500)" },
      },
      required: ["accountId"],
    },
    async run({ env, principal }, args) {
      const accountId = requireAccountId(args);
      const access = ownedAccount(principal, accountId);
      const days = clamp(args.days, 30, 1, 365);
      const rows = await readAccessLog(
        env.DB,
        access.accountId,
        Date.now() - days * 86_400_000,
        clamp(args.limit, 100, 1, 500),
      );
      const revoked = rows.filter((r) => r.grant_live === 0).length;
      return {
        accountId: access.accountId,
        windowDays: days,
        access: rows.map(renderAudit),
        summary: {
          rows: rows.length,
          underRevokedGrants: revoked,
          principals: [...new Set(rows.map((r) => r.principal))],
        },
        limitations: ACCESS_LOG_LIMITATIONS,
      };
    },
  },
];

/** Registered into `TOOLS` by `mcp.ts`. */
export const INTROSPECT_TOOLS: ToolDef[] = INTROSPECTION_TOOLS;
