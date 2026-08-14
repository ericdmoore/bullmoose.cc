import { MAIL_SCOPES, REALM_SCOPES, hasScope } from "@bullmoose/auth-core";
import {
  accountAccess,
  isAgentPrincipal,
  principalHasScope,
  type AccountAccess,
  type Principal,
} from "./auth";
import type { Env } from "./index";

/**
 * `/console/*` — the agent console's READ interface (s03.E's one ask).
 *
 * s03.E built the whole console against an interface it could only *request*:
 * `webmail/src/lib/console/ConsoleClient.ts` names four endpoints
 * (`CONSOLE_ENDPOINTS`) and, until they answer, the screen says which one is
 * missing. This file answers them. **The client is the contract** — every shape
 * below is `webmail/src/lib/console/types.ts` verbatim, mirrored here for the
 * same reason that file mirrors these tables: pulling browser code into a
 * worker bundle (or the reverse) is not on.
 *
 * ── Why THIS worker ────────────────────────────────────────────────────────
 *
 * The client resolves a read against `vault ?? site` (`origins.ts`
 * `resolveTarget`). `/vault/credentials` genuinely lives on the agent worker;
 * these four do not, and they must not:
 *
 *   • `services/agent` has no `routes` in its wrangler config and sends no CORS
 *     headers, so a browser cannot reach it cross-origin at all — the same
 *     reason `services/jmap` is deliberately same-origin with the app
 *     (`wrangler.jsonc`, `webmail/src/lib/app/sameOrigin.test.ts`).
 *   • This worker already holds the session the console runs on, the same D1
 *     both planes are applied to, and `authenticate` → scope → account
 *     resolution as one path.
 *
 * So `/console/*` is claimed on `app.bullmoose.cc` beside `/api/*` and
 * `/auth/*`, and `HttpConsoleClient` addresses console reads at the SITE origin
 * while credential traffic keeps going to the vault (`origins.ts` `readBase`).
 *
 * ── The disclosure boundary, unchanged ─────────────────────────────────────
 *
 * These routes return AUTHORIZATION STATE — who else can reach an account,
 * under what scope, what acted and when. `services/agent/src/introspectTools.ts`
 * settled the rules for that data and they are reproduced here, not relaxed:
 *
 *   Rule 1 — every returned row is justified by an account the caller OWNS.
 *     `AccountAccess.granted` is present *iff* access came through a grant, so
 *     `!access.granted` is an exact ownership test. A grant to read an account
 *     is not a grant to read its access list, and `authorizeAccount` would say
 *     `ok` for exactly that case — which is why it is not what gates here.
 *   Rule 3 — never `SELECT *` from a control-plane table. Every query below
 *     enumerates its columns; `tokens.secret_hash` and `agent_bindings.
 *     config_json` are read by nothing that returns them.
 *   Read-only — every route is GET and no statement here is a write. The one
 *     write the JMAP method path performs on a delegated read (`grant_audit`,
 *     `methods/common.ts`) has nothing to record for these: they are refused on
 *     any account the caller does not own, so no grant is ever exercised.
 *
 * ── The agent marker (s10) ─────────────────────────────────────────────────
 *
 * An agent-marked principal is REFUSED here, deliberately. The console is the
 * human session surface: `015` Rule 4 sent token inventory ("which tokens exist
 * and what are they scoped to") to s03.E precisely because it is not an agent's
 * tool loop's business, and this route serves it. An agent that wants to know
 * what it can do has `whoami` / `my_access` over MCP, ownership-gated and
 * token-blind. The marker grants nothing (`hasScope` ignores it) and survives a
 * self-service re-mint, so this narrowing cannot be shed by re-minting.
 */

// ---- the wire shapes (webmail/src/lib/console/types.ts) --------------------

interface PartyRef {
  accountId: string;
  name: string | null;
  address: string | null;
}

interface ConsoleGrant {
  grantId: string;
  grantee?: PartyRef;
  target?: PartyRef;
  scopes: string[];
  allows: string[];
  collection: string | null;
  collectionId: string | null;
  createdBy: string;
  /** epoch ms, NOT ISO — point-in-time reconstruction compares these. */
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
}

interface ConsoleBureauGrant {
  grantId: string;
  principalId: string;
  credRef: string;
  verb: string;
  createdBy: string;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
}

interface ConsoleBindingConfig {
  pipeline: string | null;
  replyMode: "send" | "draft" | null;
  hasPersona?: boolean;
  senderAllowlist?: { active: boolean; count?: number };
  modelAliasCount?: number;
  configUnparseable?: boolean;
}

interface ConsoleBinding {
  bindingId: string;
  name: string;
  triggerOn: string;
  slaSeconds: number | null;
  enabled: boolean;
  config: ConsoleBindingConfig;
  /** ⚠️ Deliberately absent — see `describeBindingConfig`. */
  credentialRefs?: string[];
}

interface ConsoleCredential {
  name: string;
  kind: string;
  allow: string | null;
  header: string | null;
  scope: string;
  enforcement: string;
  createdAt: number;
  updatedAt: number;
  meta: Record<string, unknown>;
}

interface ConsoleInvocation {
  invocationId: string;
  bindingId: string;
  bindingName: string;
  status: string;
  emailId: string | null;
  note: string | null;
  createdAt: number;
  doneAt: number | null;
}

interface ConsoleAuditRow {
  id: number;
  at: number;
  principal: string;
  method: string;
  grantId: string;
  accountId: string;
}

interface ConsoleProvenance {
  realm: string;
  recordId: string;
  label: string;
  lastWriterPrincipal: string | null;
  lastWriterBinding: string | null;
  lastWriterInvocation: string | null;
  updatedAt: number | null;
}

interface ConsoleResource {
  collection: string;
  collectionId: string;
  name: string;
  accountId: string;
}

interface ConsoleSpend {
  currency: string;
  totalCents: number;
  rows: number;
  since: number | null;
}

interface AgentSummary {
  accountId: string;
  principalId: string;
  principal: string;
  displayName: string | null;
  bindingCount: number;
  enabledBindingCount: number;
}

interface AgentDossier {
  accountId: string;
  principalId: string;
  principal: string;
  tokenScopes: string[];
  bindings: ConsoleBinding[];
  credentials: ConsoleCredential[];
  bureauGrants: ConsoleBureauGrant[];
  grantsHeld: ConsoleGrant[];
  grantsGiven: ConsoleGrant[];
  invocations: ConsoleInvocation[];
  spend: ConsoleSpend | null;
}

interface ResourceDossier {
  resource: ConsoleResource;
  grants: ConsoleGrant[];
  bureauGrants: ConsoleBureauGrant[];
  audit: ConsoleAuditRow[];
  provenance: ConsoleProvenance[];
  parties: PartyRef[];
}

// ---- limits ---------------------------------------------------------------

const INVOCATION_LIMIT = 25;
const AUDIT_LIMIT = 500;
const PROVENANCE_LIMIT = 200;
const RESOURCE_LIMIT = 500;
const DEFAULT_WINDOW_MS = 90 * 86_400_000;
const MAX_WINDOW_MS = 365 * 86_400_000;

/** The four collections a resource dossier can be built for. Closed set: an
 *  unknown collection is `notFound`, never a table name off the wire. */
const COLLECTIONS = ["AddressBook", "Calendar", "Mailbox", "FileNode"] as const;
type Collection = (typeof COLLECTIONS)[number];

const isCollection = (v: string): v is Collection =>
  (COLLECTIONS as readonly string[]).includes(v);

// ---- effective permissions ------------------------------------------------

/** Concrete permissions — `mail` excluded, because expanding it is the point. */
const CONCRETE_SCOPES: readonly string[] = [...MAIL_SCOPES, ...REALM_SCOPES, "admin"];

/**
 * What a scope list ACTUALLY allows, derived by asking `hasScope` — the same
 * function every gate in the tree calls, so the console's answer cannot drift
 * from the gate that enforces it. Identical derivation to
 * `introspectTools.effectiveScopes`; the console expands again client-side and
 * the two must agree (`consoleContract.test.ts` asserts they do).
 */
function effectiveScopes(granted: string[]): string[] {
  return CONCRETE_SCOPES.filter((s) => hasScope(granted, s));
}

// ---- the gate -------------------------------------------------------------

type Refusal = { status: number; error: string };

const isRefusal = (v: unknown): v is Refusal =>
  typeof v === "object" && v !== null && "status" in v && "error" in v;

/**
 * Rule 1 as one function: the access, but only when the caller OWNS the
 * account. An account the token cannot reach at all is `notFound` (the same
 * answer `requireAccount` gives, and the same one another tenant's id gets);
 * an account reached through a GRANT is refused with the reason, because these
 * routes report who ELSE can reach it.
 */
function ownedAccount(principal: Principal, accountId: string): AccountAccess | Refusal {
  const access = accountAccess(principal, accountId);
  if (!access) return { status: 404, error: "not found" };
  if (access.granted) {
    return {
      status: 403,
      error:
        `you reach ${accountId} through a grant, not ownership, and the console reports who ` +
        "ELSE can reach it — rows about third parties who never granted you anything. Ask the " +
        "account's owner to open their own console.",
    };
  }
  return access;
}

const ownedIds = (principal: Principal): string[] =>
  principal.accounts.filter((a) => !a.granted).map((a) => a.accountId);

const marks = (xs: readonly unknown[]): string => xs.map(() => "?").join(",");

// ---- entry point ----------------------------------------------------------

export async function handleConsole(
  request: Request,
  url: URL,
  env: Env,
  principal: Principal,
): Promise<Response> {
  // Read-only, in the dispatcher rather than per route: there is no console
  // write surface, and a POST that fell through to a GET handler would be one.
  if (request.method !== "GET") return json({ error: "method not allowed" }, 405);

  // `read` is the floor for the whole family. Every realm scope and every mail
  // write verb satisfies it (auth-core common/027), so a `mail` login token
  // passes; a token scoped to nothing does not.
  if (!principalHasScope(principal, "read")) {
    return json({ error: 'token lacks the "read" scope' }, 403);
  }
  // The agent marker (s10). See the header: token inventory is a human-session
  // question and an agent has its own, narrower introspection surface.
  if (isAgentPrincipal(principal)) {
    return json(
      {
        error:
          "the console is a human session surface and this token is agent-marked. Use the " +
          "whoami / my_access introspection tools, which answer what YOU can do without " +
          "enumerating tokens or credentials.",
      },
      403,
    );
  }

  const seg = url.pathname.split("/").filter((s) => s.length > 0).map(decodeURIComponent);
  // /console/agents
  if (seg.length === 2 && seg[1] === "agents") {
    return listAgents(env, principal);
  }
  // /console/agents/{accountId}
  if (seg.length === 3 && seg[1] === "agents") {
    return agentDossier(env, principal, seg[2] as string);
  }
  // /console/accounts/{accountId}/resources
  if (seg.length === 4 && seg[1] === "accounts" && seg[3] === "resources") {
    return listResources(env, principal, seg[2] as string);
  }
  // /console/resources/{collection}/{collectionId}?accountId&at&since
  if (seg.length === 4 && seg[1] === "resources") {
    return resourceDossier(env, principal, url, seg[2] as string, seg[3] as string);
  }
  return json({ error: "not found" }, 404);
}

// ---- GET /console/agents --------------------------------------------------

/**
 * The agent picker: accounts the caller OWNS that carry at least one agent
 * binding. An agent IS a binding — an owned account with none is not one, and
 * listing it would put a row in the picker whose dossier is empty by
 * construction.
 */
async function listAgents(env: Env, principal: Principal): Promise<Response> {
  const owned = ownedIds(principal);
  if (owned.length === 0) return json({ agents: [] });

  const { results } = await env.DB.prepare(
    `SELECT a.id AS account_id, a.principal_id, p.login_email, a.display_name,
            COUNT(b.id) AS binding_count,
            SUM(CASE WHEN b.enabled = 1 THEN 1 ELSE 0 END) AS enabled_count
       FROM accounts a
       JOIN principals p ON p.id = a.principal_id
       JOIN agent_bindings b ON b.account_id = a.id
      WHERE a.id IN (${marks(owned)}) AND a.deleted_at IS NULL
      GROUP BY a.id, a.principal_id, p.login_email, a.display_name
      ORDER BY p.login_email, a.id`,
  )
    .bind(...owned)
    .all<{
      account_id: string;
      principal_id: string;
      login_email: string;
      display_name: string | null;
      binding_count: number;
      enabled_count: number;
    }>();

  const agents: AgentSummary[] = results.map((r) => ({
    accountId: r.account_id,
    principalId: r.principal_id,
    principal: r.login_email,
    displayName: r.display_name,
    bindingCount: r.binding_count,
    enabledBindingCount: r.enabled_count ?? 0,
  }));
  return json({ agents });
}

// ---- GET /console/agents/{accountId} --------------------------------------

async function agentDossier(
  env: Env,
  principal: Principal,
  accountId: string,
): Promise<Response> {
  const access = ownedAccount(principal, accountId);
  if (isRefusal(access)) return json({ error: access.error }, access.status);

  const owner = await env.DB.prepare(
    `SELECT a.principal_id, p.login_email
       FROM accounts a JOIN principals p ON p.id = a.principal_id
      WHERE a.id = ? AND a.deleted_at IS NULL`,
  )
    .bind(access.accountId)
    .first<{ principal_id: string; login_email: string }>();
  // Reachable with the local-dev bootstrap principal, whose account is
  // synthetic and has no row: honest 404 rather than a dossier of nulls.
  if (!owner) return json({ error: "not found" }, 404);

  // Credential REFERENCES are the vault's data and `/vault/credentials` gates
  // them on the `vault` scope. Serving the same rows under `read` would be a
  // scope downgrade with a different door on it, so the gate travels with the
  // data. Absent the scope these are EMPTY, which the shape cannot distinguish
  // from "none exist" — see the deploy note in the report.
  const mayReadVault = hasScope(principal.scopes, "vault");

  const [tokenScopes, bindings, credentials, bureauGrants, grantsHeld, grantsGiven, invocations, spend] =
    await Promise.all([
      readTokenScopes(env, owner.principal_id),
      readBindings(env, access.accountId),
      mayReadVault ? readCredentials(env, owner.principal_id) : Promise.resolve([]),
      mayReadVault ? readBureauGrants(env, owner.principal_id) : Promise.resolve([]),
      readGrants(env, "grantee", access.accountId),
      readGrants(env, "target", access.accountId),
      readInvocations(env, access.accountId),
      readSpend(env, access.accountId),
    ]);

  const dossier: AgentDossier = {
    accountId: access.accountId,
    principalId: owner.principal_id,
    principal: owner.login_email,
    tokenScopes,
    bindings,
    credentials,
    bureauGrants,
    grantsHeld,
    grantsGiven,
    invocations,
    spend,
  };
  return json(dossier);
}

/**
 * The scopes any live bearer token of this principal carries, unioned.
 *
 * `015` Rule 4 refused token enumeration to an agent's tool loop and named this
 * surface as where it belongs, so this is the one place it happens. The union
 * is deliberate and it OVERSTATES any single token: for a governance screen the
 * dangerous direction is understating — "can Allen send?" answered *no* about
 * an identity that can — so the answer is the upper bound of what anything
 * holding this principal's credentials may do, and `answerCan` intersects it
 * with the grant, never widens past it.
 *
 * The agent MARKER rides along in the raw list (it is a stored scope) and drops
 * out of `allows` on its own, because `hasScope` confers nothing for it.
 */
async function readTokenScopes(env: Env, principalId: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT scopes FROM tokens
      WHERE principal_id = ? AND kind = 'bearer'
        AND (expires_at IS NULL OR expires_at > ?)`,
  )
    .bind(principalId, Date.now())
    .all<{ scopes: string }>();
  const out = new Set<string>();
  for (const r of results) {
    for (const s of parseJsonArray(r.scopes)) out.add(s);
  }
  return [...out].sort();
}

async function readBindings(env: Env, accountId: string): Promise<ConsoleBinding[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, name, trigger_on, sla_seconds, enabled, config_json
       FROM agent_bindings WHERE account_id = ? ORDER BY name`,
  )
    .bind(accountId)
    .all<{
      id: string;
      name: string;
      trigger_on: string;
      sla_seconds: number | null;
      enabled: number;
      config_json: string;
    }>();
  return results.map((b) => ({
    bindingId: b.id,
    name: b.name,
    triggerOn: b.trigger_on,
    slaSeconds: b.sla_seconds,
    enabled: b.enabled === 1,
    config: describeBindingConfig(b.config_json),
    // `credentialRefs` is deliberately ABSENT, not `[]`: nothing stores which
    // credentials a binding's MCP servers reference (`BindingConfig` has no
    // such field and no table joins one), and `[]` would assert "none" where
    // the truth is "not recorded". The client already reads it as optional.
  }));
}

/**
 * Derived facts about a binding's config, never the config. MIRROR of
 * `services/agent/src/introspectTools.ts` `describeBinding` — the persona text,
 * the model aliases and the allowlisted addresses are third parties' data and a
 * summary is what both surfaces return. `consoleContract.test.ts` drives the
 * real one and asserts these agree, so the mirror cannot rot quietly.
 */
export function describeBindingConfig(configJson: string): ConsoleBindingConfig {
  let cfg: Record<string, unknown>;
  try {
    cfg = (JSON.parse(configJson || "{}") ?? {}) as Record<string, unknown>;
  } catch {
    return { pipeline: null, replyMode: null, configUnparseable: true };
  }
  const senders = (cfg.allowedSenders ?? []) as string[];
  return {
    pipeline: (cfg.pipeline as string | undefined) ?? "reply",
    replyMode: cfg.replyMode === "send" ? "send" : "draft",
    hasPersona: typeof cfg.persona === "string" && cfg.persona.length > 0,
    senderAllowlist:
      senders.length > 0 ? { active: true, count: senders.length } : { active: false },
    modelAliasCount: Object.keys((cfg.modelAliases ?? {}) as Record<string, unknown>).length,
  };
}

/**
 * The vault's public view — names, kinds and the bureau.md §5 mint-time
 * contract. There is no value field here and there cannot be one: `enc_json` is
 * not in the SELECT, and this worker holds no key that could open it.
 *
 * Diverges from `vault.ts` `credentialView` in exactly one place: a row minted
 * before the contract existed gets `enforcement: "broad"` rather than `null`,
 * because `broad` IS that file's stated honest default ("assume the weakest
 * until an operator records otherwise") and the client types the field
 * non-nullable.
 */
async function readCredentials(env: Env, principalId: string): Promise<ConsoleCredential[]> {
  const { results } = await env.DB.prepare(
    `SELECT name, kind, meta_json, created_at, updated_at
       FROM vault_credentials WHERE principal_id = ? ORDER BY name`,
  )
    .bind(principalId)
    .all<{
      name: string;
      kind: string;
      meta_json: string;
      created_at: number;
      updated_at: number;
    }>();
  return results.map((r) => {
    let meta: Record<string, unknown> = {};
    try {
      meta = (JSON.parse(r.meta_json || "{}") ?? {}) as Record<string, unknown>;
    } catch {
      meta = {};
    }
    const userMeta = { ...meta };
    for (const k of ["allow", "header", "scope", "enforcement"]) delete userMeta[k];
    return {
      name: r.name,
      kind: r.kind,
      allow: (meta.allow as string | undefined) ?? null,
      header: (meta.header as string | undefined) ?? null,
      scope: (meta.scope as string | undefined) ?? "actor",
      enforcement: (meta.enforcement as string | undefined) ?? "broad",
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      meta: userMeta,
    };
  });
}

/** Bureau grants, tombstones INCLUDED — the console renders a revocation as a
 *  state, and dropping the row would erase the fact that one happened. */
async function readBureauGrants(env: Env, principalId: string): Promise<ConsoleBureauGrant[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, principal_id, cred_name, verb, created_by, created_at, expires_at, revoked_at
       FROM bureau_grants WHERE principal_id = ? ORDER BY cred_name, verb`,
  )
    .bind(principalId)
    .all<{
      id: string;
      principal_id: string;
      cred_name: string;
      verb: string;
      created_by: string;
      created_at: number;
      expires_at: number | null;
      revoked_at: number | null;
    }>();
  return results.map((r) => ({
    grantId: r.id,
    principalId: r.principal_id,
    credRef: r.cred_name,
    verb: r.verb,
    createdBy: r.created_by,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
  }));
}

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
  grantee_name: string | null;
  grantee_email: string | null;
  target_name: string | null;
  target_email: string | null;
}

/** Rule 3: enumerated columns, plus the two parties resolved to name+address. */
const GRANT_SELECT =
  `SELECT g.id, g.grantee_account_id, g.target_account_id, g.scopes, g.collection,
          g.collection_id, g.created_by, g.created_at, g.expires_at, g.revoked_at,
          (SELECT a.display_name FROM accounts a WHERE a.id = g.grantee_account_id) AS grantee_name,
          (SELECT i.email FROM identities i WHERE i.account_id = g.grantee_account_id LIMIT 1) AS grantee_email,
          (SELECT a.display_name FROM accounts a WHERE a.id = g.target_account_id) AS target_name,
          (SELECT i.email FROM identities i WHERE i.account_id = g.target_account_id LIMIT 1) AS target_email
     FROM grants g`;

/**
 * Both parties ride on every grant. The SAME row renders from opposite
 * directions in the two views — per-agent asks "what does this reach?" (the
 * target), forensic asks "who reached this?" (the grantee) — and a one-sided
 * row makes whichever view it was not shaped for render "another account".
 */
function renderGrant(r: GrantRow): ConsoleGrant {
  const scopes = parseJsonArray(r.scopes);
  return {
    grantId: r.id,
    grantee: {
      accountId: r.grantee_account_id,
      name: r.grantee_name,
      address: r.grantee_email,
    },
    target: {
      accountId: r.target_account_id,
      name: r.target_name,
      address: r.target_email,
    },
    scopes,
    // `scopes` is what the row stores; `allows` is what it does. A grant stored
    // as ["mail"] permits send and delete without naming either.
    allows: effectiveScopes(scopes),
    collection: r.collection,
    collectionId: r.collection_id,
    createdBy: r.created_by,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
  };
}

/**
 * `grantee` — what this account can reach; `target` — what was given away on
 * it. Both filter `revoked_at IS NULL`, matching `015`'s two queries: the
 * per-agent view answers "what is live", and the point-in-time reconstruction
 * that NEEDS tombstones is the resource dossier's job (`readResourceGrants`).
 */
async function readGrants(
  env: Env,
  side: "grantee" | "target",
  accountId: string,
): Promise<ConsoleGrant[]> {
  const column = side === "grantee" ? "grantee_account_id" : "target_account_id";
  const { results } = await env.DB.prepare(
    `${GRANT_SELECT}
      WHERE g.${column} = ? AND g.revoked_at IS NULL
      ORDER BY g.created_at DESC`,
  )
    .bind(accountId)
    .all<GrantRow>();
  return results.map(renderGrant);
}

async function readInvocations(env: Env, accountId: string): Promise<ConsoleInvocation[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, binding_id, binding_name, status, email_id, note, created_at, done_at
       FROM agent_invocations WHERE account_id = ?
      ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(accountId, INVOCATION_LIMIT)
    .all<{
      id: string;
      binding_id: string;
      binding_name: string;
      status: string;
      email_id: string | null;
      note: string | null;
      created_at: number;
      done_at: number | null;
    }>();
  // `context_json` and `result_json` are deliberately not selected: the first
  // carries the triggering envelope recipient, and neither is on the wire shape.
  return results.map((r) => ({
    invocationId: r.id,
    bindingId: r.binding_id,
    bindingName: r.binding_name,
    status: r.status,
    emailId: r.email_id,
    note: r.note,
    createdAt: r.created_at,
    doneAt: r.done_at,
  }));
}

/**
 * What this account's agents have COST — `agent_invocations.cost_micros` (s07
 * T5), frozen at capture, in micro-USD.
 *
 * NULL is not zero and is not counted: the schema is explicit that NULL means
 * undetermined (unpriceable model, no reported usage, pre-migration row) and 0
 * means genuinely free. So a deployment where nothing was priced returns `null`
 * — "not recorded" — rather than a flattering $0.00.
 */
async function readSpend(env: Env, accountId: string): Promise<ConsoleSpend | null> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n, SUM(cost_micros) AS micros, MIN(created_at) AS since
       FROM agent_invocations WHERE account_id = ? AND cost_micros IS NOT NULL`,
  )
    .bind(accountId)
    .first<{ n: number; micros: number | null; since: number | null }>();
  if (!row || row.n === 0) return null;
  return {
    currency: "USD",
    totalCents: Math.round((row.micros ?? 0) / 10_000),
    rows: row.n,
    since: row.since,
  };
}

// ---- GET /console/accounts/{accountId}/resources --------------------------

/**
 * What the forensic view can be pointed at from this account: its own
 * collections, plus the collections of any OTHER OWNED account a live grant
 * from here reaches (the shape the demo fixture has — an agent account whose
 * grant covers the operator's address book).
 *
 * Restricted to owned accounts on both ends, and not for tidiness: the
 * dossier behind every one of these rows is owner-only (Rule 1), so offering a
 * resource on a grant-reached account would put a row in the picker that 403s
 * when clicked.
 */
async function listResources(
  env: Env,
  principal: Principal,
  accountId: string,
): Promise<Response> {
  const access = ownedAccount(principal, accountId);
  if (isRefusal(access)) return json({ error: access.error }, access.status);

  const owned = new Set(ownedIds(principal));
  const reachable = new Set<string>([access.accountId]);
  const { results: targets } = await env.DB.prepare(
    `SELECT DISTINCT target_account_id FROM grants
      WHERE grantee_account_id = ? AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > ?)`,
  )
    .bind(access.accountId, Date.now())
    .all<{ target_account_id: string }>();
  for (const t of targets) if (owned.has(t.target_account_id)) reachable.add(t.target_account_id);

  const ids = [...reachable];
  const { results } = await env.DB.prepare(
    `SELECT 'AddressBook' AS collection, id AS collection_id, name, account_id
       FROM address_books WHERE account_id IN (${marks(ids)})
     UNION ALL
     SELECT 'Calendar', id, name, account_id
       FROM calendars WHERE account_id IN (${marks(ids)})
     UNION ALL
     SELECT 'Mailbox', id, name, account_id
       FROM mailboxes WHERE account_id IN (${marks(ids)})
     UNION ALL
     SELECT 'FileNode', id, name, account_id
       FROM file_nodes WHERE account_id IN (${marks(ids)}) AND node_type = 'directory'
     ORDER BY account_id, collection, name
     LIMIT ?`,
  )
    .bind(...ids, ...ids, ...ids, ...ids, RESOURCE_LIMIT)
    .all<{ collection: string; collection_id: string; name: string; account_id: string }>();

  const resources: ConsoleResource[] = results.map((r) => ({
    collection: r.collection,
    collectionId: r.collection_id,
    name: r.name,
    accountId: r.account_id,
  }));
  return json({ resources });
}

// ---- GET /console/resources/{collection}/{collectionId} -------------------

/**
 * who-could + who-did for one resource. `at` is the instant the authorization
 * set is reconstructed at and `since` bounds the trail; the client sends both.
 *
 * The grant set comes back WHOLE — tombstones included — because reconstructing
 * "who could have, last Tuesday" is the console's job and it cannot do it
 * against rows the server already filtered by liveness. That is the entire
 * reason s03.A made revocation a tombstone.
 */
async function resourceDossier(
  env: Env,
  principal: Principal,
  url: URL,
  collection: string,
  collectionId: string,
): Promise<Response> {
  const accountId = url.searchParams.get("accountId");
  if (!accountId) return json({ error: "accountId is required" }, 400);
  if (!isCollection(collection)) return json({ error: "not found" }, 404);

  const access = ownedAccount(principal, accountId);
  if (isRefusal(access)) return json({ error: access.error }, access.status);

  const window = parseWindow(url);
  if (isRefusal(window)) return json({ error: window.error }, window.status);

  const found = await readResource(env, access.accountId, collection, collectionId);
  // Another account's collection id resolves to nothing HERE, because every
  // query is bound to the authorized account — not filtered afterwards.
  if (!found) return json({ error: "not found" }, 404);

  const [grants, audit, provenance] = await Promise.all([
    readResourceGrants(env, access.accountId, collection, collectionId),
    readAudit(env, access.accountId, window.since, window.at),
    readProvenance(env, access.accountId, collection, collectionId),
  ]);

  const dossier: ResourceDossier = {
    resource: found,
    grants,
    // Bureau grants are (principal, credential, verb) and no credential is a
    // resource this picker can name, so there is never a row to put here. Empty
    // is the honest answer, not a placeholder — see the report's gap list.
    bureauGrants: [],
    audit,
    provenance,
    parties: partiesOf(grants),
  };
  return json(dossier);
}

function parseWindow(url: URL): { at: number; since: number } | Refusal {
  const raw = (k: string): number | null => {
    const v = url.searchParams.get(k);
    if (v === null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  };
  const atRaw = raw("at");
  const sinceRaw = raw("since");
  if (Number.isNaN(atRaw) || Number.isNaN(sinceRaw)) {
    return { status: 400, error: "at and since must be epoch milliseconds" };
  }
  const at = atRaw ?? Date.now();
  // Clamped, not rejected: a window is a read cost, and the client's default is
  // 90 days. `since > at` would be an empty trail rendered as "nothing
  // happened", which is exactly the confident-wrong-answer this screen bans.
  const since = Math.min(sinceRaw ?? at - DEFAULT_WINDOW_MS, at);
  return { at, since: Math.max(since, at - MAX_WINDOW_MS) };
}

/** Does this collection exist ON THIS ACCOUNT? The account id is bound into
 *  every branch, so a cross-account id is `notFound` rather than filtered. */
async function readResource(
  env: Env,
  accountId: string,
  collection: Collection,
  collectionId: string,
): Promise<ConsoleResource | null> {
  const table = {
    AddressBook: "address_books",
    Calendar: "calendars",
    Mailbox: "mailboxes",
    FileNode: "file_nodes",
  }[collection];
  const row = await env.DB.prepare(
    `SELECT name FROM ${table} WHERE account_id = ? AND id = ?`,
  )
    .bind(accountId, collectionId)
    .first<{ name: string }>();
  if (!row) return null;
  return { collection, collectionId, name: row.name, accountId };
}

/**
 * Every grant that ever covered this resource — a whole-account grant covers
 * every collection its scopes allow, and a collection-scoped one covers its
 * own. Tombstoned and expired rows are INCLUDED: a grant revoked four days ago
 * must still appear in the who-could set for an instant six days ago.
 */
async function readResourceGrants(
  env: Env,
  accountId: string,
  collection: Collection,
  collectionId: string,
): Promise<ConsoleGrant[]> {
  const { results } = await env.DB.prepare(
    `${GRANT_SELECT}
      WHERE g.target_account_id = ?
        AND (g.collection IS NULL OR (g.collection = ? AND g.collection_id = ?))
      ORDER BY g.created_at DESC`,
  )
    .bind(accountId, collection, collectionId)
    .all<GrantRow>();
  return results.map(renderGrant);
}

/**
 * `grant_audit` for the window, windowed on `(account_id, at)` — the only index
 * the table has.
 *
 * NOT narrowed to the resource, and it cannot be: the table records the
 * account, the acting principal, the method label and the time, and no object
 * id at all. `caveats.ts` renders that limitation beside every one of these
 * rows, which is the honest resolution — dropping rows we cannot attribute to
 * the resource would hide exactly the access an operator is looking for.
 */
async function readAudit(
  env: Env,
  accountId: string,
  since: number,
  at: number,
): Promise<ConsoleAuditRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, grant_id, principal, account_id, method, at
       FROM grant_audit
      WHERE account_id = ? AND at >= ? AND at <= ?
      ORDER BY at DESC LIMIT ?`,
  )
    .bind(accountId, since, at, AUDIT_LIMIT)
    .all<{
      id: number;
      grant_id: string;
      principal: string;
      account_id: string;
      method: string;
      at: number;
    }>();
  return results.map((r) => ({
    id: r.id,
    at: r.at,
    principal: r.principal,
    method: r.method,
    grantId: r.grant_id,
    accountId: r.account_id,
  }));
}

/**
 * The `last_writer_*` trio (s03.A T1) on the collection itself and on the
 * records inside it.
 *
 * All three may be NULL and NULL does not mean "nobody" — `common/033`: DAV
 * writes and part of the agent-MCP path bypass the stamp. The console renders
 * that as a `not-captured` finding, which is why the rows are returned with
 * their nulls intact rather than dropped.
 */
async function readProvenance(
  env: Env,
  accountId: string,
  collection: Collection,
  collectionId: string,
): Promise<ConsoleProvenance[]> {
  const P = "last_writer_principal, last_writer_binding, last_writer_invocation";
  const out: ConsoleProvenance[] = [];

  const push = (
    realm: string,
    r: {
      id: string;
      label: string | null;
      updated_at: number | null;
      last_writer_principal: string | null;
      last_writer_binding: string | null;
      last_writer_invocation: string | null;
    },
  ) => {
    out.push({
      realm,
      recordId: r.id,
      label: r.label ?? r.id,
      lastWriterPrincipal: r.last_writer_principal,
      lastWriterBinding: r.last_writer_binding,
      lastWriterInvocation: r.last_writer_invocation,
      updatedAt: r.updated_at,
    });
  };

  if (collection === "AddressBook") {
    const book = await env.DB.prepare(
      `SELECT id, name AS label, updated_at, ${P} FROM address_books
        WHERE account_id = ? AND id = ?`,
    )
      .bind(accountId, collectionId)
      .first<Parameters<typeof push>[1]>();
    if (book) push("address_books", book);
    const { results } = await env.DB.prepare(
      `SELECT id, COALESCE(name_full, uid) AS label, updated_at, ${P} FROM contact_cards
        WHERE account_id = ? AND address_book_id = ?
        ORDER BY updated_at DESC LIMIT ?`,
    )
      .bind(accountId, collectionId, PROVENANCE_LIMIT)
      .all<Parameters<typeof push>[1]>();
    for (const r of results) push("contact_cards", r);
    return out;
  }

  if (collection === "Calendar") {
    const cal = await env.DB.prepare(
      `SELECT id, name AS label, updated_at, ${P} FROM calendars
        WHERE account_id = ? AND id = ?`,
    )
      .bind(accountId, collectionId)
      .first<Parameters<typeof push>[1]>();
    if (cal) push("calendars", cal);
    const { results } = await env.DB.prepare(
      `SELECT id, COALESCE(title, uid) AS label, updated_at, ${P} FROM calendar_events
        WHERE account_id = ? AND calendar_id = ?
        ORDER BY updated_at DESC LIMIT ?`,
    )
      .bind(accountId, collectionId, PROVENANCE_LIMIT)
      .all<Parameters<typeof push>[1]>();
    for (const r of results) push("calendar_events", r);
    return out;
  }

  if (collection === "Mailbox") {
    // `mailboxes` carries no updated stamp, and `emails` carries only
    // `received_at`. Both are reported as the row's time rather than invented:
    // `updatedAt` is nullable on the wire precisely for the first case.
    const mb = await env.DB.prepare(
      `SELECT id, name AS label, NULL AS updated_at, ${P} FROM mailboxes
        WHERE account_id = ? AND id = ?`,
    )
      .bind(accountId, collectionId)
      .first<Parameters<typeof push>[1]>();
    if (mb) push("mailboxes", mb);
    const { results } = await env.DB.prepare(
      `SELECT e.id, e.subject AS label, e.received_at AS updated_at,
              e.last_writer_principal, e.last_writer_binding, e.last_writer_invocation
         FROM emails e
         JOIN email_mailboxes em ON em.account_id = e.account_id AND em.email_id = e.id
        WHERE e.account_id = ? AND em.mailbox_id = ?
        ORDER BY e.received_at DESC LIMIT ?`,
    )
      .bind(accountId, collectionId, PROVENANCE_LIMIT)
      .all<Parameters<typeof push>[1]>();
    for (const r of results) push("emails", r);
    return out;
  }

  const dir = await env.DB.prepare(
    `SELECT id, name AS label, changed AS updated_at, ${P} FROM file_nodes
      WHERE account_id = ? AND id = ?`,
  )
    .bind(accountId, collectionId)
    .first<Parameters<typeof push>[1]>();
  if (dir) push("file_nodes", dir);
  const { results } = await env.DB.prepare(
    `SELECT id, name AS label, changed AS updated_at, ${P} FROM file_nodes
      WHERE account_id = ? AND parent_id = ?
      ORDER BY changed DESC LIMIT ?`,
  )
    .bind(accountId, collectionId, PROVENANCE_LIMIT)
    .all<Parameters<typeof push>[1]>();
  for (const r of results) push("file_nodes", r);
  return out;
}

/** accountId → address, so the forensic view can render an audit principal as
 *  a person rather than an id. Built from the grants already on the wire — no
 *  second disclosure, and nothing about an account with no grant here. */
function partiesOf(grants: ConsoleGrant[]): PartyRef[] {
  const byId = new Map<string, PartyRef>();
  for (const g of grants) {
    for (const p of [g.grantee, g.target]) {
      if (p && !byId.has(p.accountId)) byId.set(p.accountId, p);
    }
  }
  return [...byId.values()];
}

// ---- helpers --------------------------------------------------------------

function parseJsonArray(raw: string): string[] {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
