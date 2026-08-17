import {
  authorizeAccount,
  isAgentPrincipal,
  principalHasScope,
  verifyBearer,
  type MethodDomain,
  type Principal,
} from "@bullmoose/auth-core/principal";
import {
  principalForInvocation,
  resolveInvocationToken,
  type InvocationIdentity,
} from "@bullmoose/auth-core/invocation";
import {
  describeDenial,
  effectiveNodeAuthority,
  mayUse,
  type NodeAuthority,
} from "@bullmoose/scheduling";
import { EMAIL_TOOLS } from "./emailTools.js";
import { INTROSPECT_TOOLS } from "./introspectTools.js";
import { ToolError } from "./jmapBridge.js";
import { initializeResult, isLegacyMethod } from "./mcpLegacy.js";
import { REVOKE_APP_TOOL } from "./oauthBridge.js";
import { NOUN_TOOLS } from "./mcpNouns.js";
import type { Env } from "./models.js";

/**
 * bullmoose's own MCP server. Two kinds of tool live here, and the
 * difference between them is the most important thing on this page.
 *
 *  1. **Analytics** (devPlan-handoff Phase 3) — bounded, parameterized
 *     read-only queries over the message log and spend ledger, so an
 *     analyst-style agent gets useful tools with zero external
 *     credentials. No free-form SQL crosses this boundary. These read
 *     `env.DB` directly, which is correct for aggregates over rows
 *     nobody else is watching.
 *
 *  2. **Nouns** (sVOL `013`) — Calendar and Contacts CRUD. These are
 *     WRITES, and they do NOT touch D1. Every one of them dispatches
 *     into the JMAP method layer through `jmapBridge.ts`, because the
 *     write choreography — ctag bump, AccountDO changelog commit, new
 *     state string — lives in the methods and nowhere else. A write that
 *     skips it lands the row, reads back fine on a direct `/get`, and is
 *     invisible to CalDAV, to `Foo/changes` and to the CLI mirror. See
 *     `jmapBridge.ts` and `_context.md` §3 before adding a third kind.
 *
 * This surface was read-only until `013`; it is not any more. `ToolDef`
 * declares scope and domain per tool and `handleToolCall` gates on them,
 * so a read tool and a delete tool are no longer authorized alike.
 *
 * Transport: stateless MCP (2026-07-28 / SEP-2575). One JSON-RPC request
 * per POST, one response — no session, no `initialize`, no `ping`. Each
 * request carries its own protocol version (an HTTP header mirrored in
 * `_meta`) and its own identity: a bearer token resolved to a principal,
 * with every tool call authorized against the TARGET account (token ∩
 * grant) and audited — never a self-asserted accountId.
 *
 * ## The third credential, and the gap it closes (s17)
 *
 * This surface used to gate on the BEARER'S PRINCIPAL and nothing else, which
 * meant a delegated invocation's authority envelope — the `{tools,
 * credentials, budgetMicros}` a Job's chain narrowed down to it — had no
 * consumer here at all: MCP could not map a bearer to one invocation, so there
 * was nothing to intersect with. A `bmi_` per-invocation token
 * (`@bullmoose/auth-core/invocation`) names the invocation, and this file is
 * its first consumer.
 *
 * Two rules, and neither is optional:
 *
 *  1. The envelope is **ANDed after** the standing check, never substituted
 *     for it. `authorizeAccount` still decides which account and which scope;
 *     `mayUse` can then only take things away. See `envelopeAllows`.
 *  2. It is re-derived **live**, per request, from rows the holder cannot
 *     write. Nothing is read off the token row but the invocation's id, so
 *     narrowing a binding mid-flight bites a token that is already open.
 *
 * A `bmi_` token reaches exactly one account and carries a fixed, deliberately
 * coarse standing scope set (`INVOCATION_STANDING_SCOPES` — no vault, no
 * admin, no send). The narrowing is the envelope, not the scopes.
 *
 * And one MANDATORY rule, which is what makes the two above enforcement rather
 * than etiquette: an `agent`-MARKED bearer may not reach `tools/list` or
 * `tools/call` at all without an invocation token (see `TOOL_SURFACE_METHODS`
 * and the gate before the dispatch switch). Until that rule existed the
 * mechanism was voluntary — the harness holds a device token by architectural
 * necessity (`packages/cli/src/agent.ts`), so presenting the narrow credential
 * was a choice it made about itself. Unmarked principals are untouched.
 *
 * ⚠️ **WHERE THIS STOPS, NAMED SO IT IS A BOUNDARY AND NOT AN OVERSIGHT.** An
 * invocation with no `job_id` is not a delegation: `effectiveNodeAuthority`
 * answers `{tools: null, …}` for it — the DefaultCase `data-plane.sql` states
 * as "NULL = no envelope = an ordinary invocation" — and `mayUse` then admits
 * every tool. So for an ORDINARY mail-triggered invocation this gate narrows
 * the account (one, never the principal's whole reach), the realm (no vault),
 * the verbs (no send, no admin) and the LIFETIME (the token dies with the
 * work), and it does NOT narrow the tool set. Only a Job node carries an
 * envelope for the tool axis to bite.
 *
 * Making the binding's `config_json.jobs.tools` bound every invocation of that
 * binding — not only its Job nodes — would close that, and it is one
 * `intersectAuthority` away. It is deliberately NOT done here, because
 * `bindingCeiling` is documented as the top of a JOB's chain and a second
 * reading of `config_json.jobs` invented at a consumer is exactly the drift
 * that module exists to prevent. It is a decision about what that key MEANS,
 * and it belongs with whoever owns the key.
 * `invocationToken.test.ts` asserts this boundary rather than leaving it to
 * be discovered.
 *
 * As of s02 T1 this route is PUBLIC: the `x-internal-token` network ACL came
 * off /mcp (it stays on /drain and /internal/*), because a third-party client
 * cannot hold a secret only we have. The bearer was always the identity —
 * the wrapper's removal takes away a second lock on the same door, not the
 * lock itself. The unauthenticated case is answered by index.ts with a 401
 * carrying `WWW-Authenticate: resource_metadata=…` rather than by the bare
 * JSON-RPC error below, so a client learns where to authenticate.
 * See .plans/s01-stateless-MCP/ and .plans/s02-mcp-facade/.
 */

const PROTOCOL_VERSION = "2026-07-28";
const SUPPORTED_VERSIONS = [PROTOCOL_VERSION];
/** Clients may cache tools/list this long (MCP.2 list cache hint). */
const TOOLS_LIST_TTL_MS = 5 * 60_000;
const UNSUPPORTED_PROTOCOL_VERSION = -32022;
/** SEP-2575 assigns these two; we used to answer with the generic JSON-RPC
 *  codes, which a client cannot tell apart from a malformed request (s02 T2). */
const HEADER_MISMATCH = -32020;
const MISSING_CLIENT_CAPABILITY = -32021;
const PROTO_META = "io.modelcontextprotocol/protocolVersion";
const CAPS_META = "io.modelcontextprotocol/clientCapabilities";

/**
 * THE TOOL SURFACE — what mandatory rule 1 (s17 (d)) gates, and nothing more.
 *
 * Visibility and dispatch, together: hiding a tool an agent may then call would
 * be a UI, and refusing a call to a tool the same token was just shown would be
 * a lie. Everything else `handleMcp` answers is handshake or negotiation and
 * discloses no account data.
 */
const TOOL_SURFACE_METHODS = new Set(["tools/list", "tools/call"]);

/**
 * Shared by `server/discover` (modern) and `initialize` (legacy) — one
 * identity for the server rather than two that can drift.
 *
 * The name is an identifier clients pin config to, and it is the one
 * "mailstore-analytics" spelling that four plan docs, the route
 * (/mcp/analytics) and mcp-auth.md all share — so it stays, now historical
 * rather than descriptive. The version moves instead.
 */
const SERVER_INFO = { name: "bullmoose-mailstore-analytics", version: "1.1.0" };

const INSTRUCTIONS =
  "bullmoose: read-only analytics over the message log and spend ledger, plus full " +
  "calendar and contacts CRUD. Tools act on one account; call whoami first to learn " +
  "which accounts this token reaches, and omit accountId when it reaches exactly one. " +
  "Each tool is authorized separately — a token may be able to read a calendar and not " +
  "write it. Creating, changing and deleting events and cards are real, immediate, " +
  "un-undoable writes that the human's calendar and contacts apps will sync; confirm " +
  "destructive ones first. List calendars and address books before guessing an id.";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

/**
 * What a tool is handed. `principal` is here because the noun tools call
 * the JMAP method layer, which runs its own `requireAccount` gate and
 * therefore needs the identity, not just the bindings — the analytics
 * tools destructure `{ env }` and ignore it.
 */
export interface ToolContext {
  env: Env;
  principal: Principal;
  /**
   * The caller's own `bm_` credential, present ONLY when that is how they
   * authenticated (s02 T4 revocation). It exists for exactly one consumer:
   * `revoke_app`, whose backing route on the AS authenticates the presented
   * bearer itself rather than trusting a relayed identity — so the tool must
   * forward the human's actual credential, and cannot for an OAuth caller
   * (deliberately: a connected app must not manage the app roster).
   *
   * Absent for OAuth-authenticated requests. Do not grow new consumers
   * without the same argument this one has.
   */
  rawBearer?: string;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * What this tool needs, declared per tool rather than assumed per request.
   *
   * `handleToolCall` used to hardcode `("read", "mail")` for EVERY tool, which
   * was harmless while the surface was four read-only analytics tools but is
   * not a gate — a write tool added under it would be authorized as a read on
   * mail.
   *
   * Mirror the live JMAP convention exactly (services/jmap/src/methods/):
   *
   *   mail       reads `("read", "mail")`, writes the specific verb for the
   *              operation (annotate/draft/move/delete — an independent flat
   *              set, common/027; any write also implies read)
   *   calendar   reads `("read", "calendar")`, writes `("calendar", "calendar")`
   *   contacts   reads `("read", "contacts")`, writes `("contacts", "contacts")`
   *
   * Calendar and contacts do NOT use the mail verbs — one scope named after
   * the domain covers create, update and delete. Do not invent a mapping.
   */
  scope: string;
  domain: MethodDomain;
  /**
   * This tool acts on the PRINCIPAL, not on an account, so the account gate
   * does not apply to it (s02 T5). Only `whoami` sets it, and the reason is
   * discovery: a third-party client has no way to learn a bullmoose account
   * id — they are `t_<tenant>__a_<uuid>`, they appear in no discovery
   * document, and requiring one here made the tool that answers "what
   * accounts do I have" unanswerable without already knowing the answer.
   *
   * An accountless tool is still scope-gated (`principalHasScope`); what it
   * skips is the per-account token ∩ grant check, which has nothing to
   * intersect. Do not set it on a tool that reads or writes account data —
   * that would be an unauthorized read wearing a discovery costume.
   */
  accountless?: true;
  run: (ctx: ToolContext, args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Which account a call means when it does not say (s02 T5).
 *
 * Resolution is SERVER-SIDE and never trusts a client-supplied id — that
 * rejection still stands below. Owned accounts win over grant-reached ones:
 * defaulting into someone else's account because you happen to hold a grant
 * on it is a surprise, and surprises about which mailbox you just wrote to
 * are the expensive kind. When the answer is ambiguous the error NAMES the
 * candidates, so the next call succeeds instead of the model guessing.
 */
function defaultAccountId(
  principal: Principal,
): { ok: true; accountId: string } | { ok: false; detail: string } {
  // Owned only, and there is no fallback to grant-reached accounts on
  // purpose. It would be unreachable anyway — `principal.ts:149` resolves
  // grants only when the principal owns at least one account, because a
  // grantee IS an account — so a principal with no owned accounts has no
  // accounts at all. Writing the fallback would be dead code that reads
  // like a policy.
  const owned = principal.accounts.filter((a) => !a.granted);
  if (owned.length === 1) return { ok: true, accountId: owned[0]!.accountId };
  if (owned.length === 0) {
    return {
      ok: false,
      detail: "this token owns no account; pass accountId explicitly (see whoami)",
    };
  }
  const names = owned.map((a) => `${a.accountId} (${a.name})`).join(", ");
  return {
    ok: false,
    detail:
      `accountId is required: this token owns ${owned.length} accounts — pass one of ${names}. ` +
      "Call whoami for the full picture.",
  };
}

const clampInt = (v: unknown, def: number, min: number, max: number): number => {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : def;
  return Math.min(Math.max(n, min), max);
};

const requireAccountId = (args: Record<string, unknown>): string => {
  if (typeof args.accountId !== "string" || args.accountId.length === 0) {
    throw new Error("accountId is required");
  }
  return args.accountId;
};

/**
 * Read-only aggregates over rows this worker owns. Raw SQL is the right
 * shape here and the wrong shape for anything that writes — see the module
 * docstring.
 */
const ANALYTICS_TOOLS: ToolDef[] = [
  {
    name: "spend_by_month",
    scope: "read",
    domain: "mail",
    description:
      "Monthly spend totals from the receipt ledger (spend_facts): period, currency, total, transaction count.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string", description: "bullmoose account id" },
        months: { type: "number", description: "how many recent months (default 6, max 24)" },
      },
      required: ["accountId"],
    },
    async run({ env }, args) {
      const months = clampInt(args.months, 6, 1, 24);
      const { results } = await env.DB.prepare(
        `SELECT period_month, currency, SUM(amount_cents) AS total_cents, COUNT(*) AS txns
         FROM spend_facts WHERE account_id = ?
         GROUP BY period_month, currency
         ORDER BY period_month DESC LIMIT ?`,
      )
        .bind(requireAccountId(args), months)
        .all();
      return results;
    },
  },
  {
    name: "spend_by_vendor",
    scope: "read",
    domain: "mail",
    description: "Spend grouped by vendor, optionally within one month (YYYY-MM). Top N by total.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string" },
        month: { type: "string", description: "YYYY-MM; omit for all time" },
        top: { type: "number", description: "max vendors (default 10, max 50)" },
      },
      required: ["accountId"],
    },
    async run({ env }, args) {
      const top = clampInt(args.top, 10, 1, 50);
      const month =
        typeof args.month === "string" && /^\d{4}-\d{2}$/.test(args.month) ? args.month : null;
      const { results } = await env.DB.prepare(
        `SELECT vendor, currency, SUM(amount_cents) AS total_cents, COUNT(*) AS txns
         FROM spend_facts WHERE account_id = ? ${month ? "AND period_month = ?" : ""}
         GROUP BY vendor, currency
         ORDER BY total_cents DESC LIMIT ?`,
      )
        .bind(...(month ? [requireAccountId(args), month, top] : [requireAccountId(args), top]))
        .all();
      return results;
    },
  },
  {
    name: "top_senders",
    scope: "read",
    domain: "mail",
    description: "Most frequent senders over a recent window of days.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string" },
        days: { type: "number", description: "window (default 30, max 365)" },
        limit: { type: "number", description: "max senders (default 10, max 50)" },
      },
      required: ["accountId"],
    },
    async run({ env }, args) {
      const days = clampInt(args.days, 30, 1, 365);
      const limit = clampInt(args.limit, 10, 1, 50);
      const since = Date.now() - days * 86_400_000;
      const { results } = await env.DB.prepare(
        `SELECT COALESCE(json_extract(from_json, '$[0].email'), '(unknown)') AS sender,
                COUNT(*) AS messages
         FROM emails WHERE account_id = ? AND received_at >= ?
         GROUP BY sender ORDER BY messages DESC LIMIT ?`,
      )
        .bind(requireAccountId(args), since, limit)
        .all();
      return results;
    },
  },
  {
    name: "message_volume",
    scope: "read",
    domain: "mail",
    description: "Messages received per day over a recent window.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string" },
        days: { type: "number", description: "window (default 14, max 90)" },
      },
      required: ["accountId"],
    },
    async run({ env }, args) {
      const days = clampInt(args.days, 14, 1, 90);
      const since = Date.now() - days * 86_400_000;
      const { results } = await env.DB.prepare(
        `SELECT date(received_at / 1000, 'unixepoch') AS day, COUNT(*) AS messages
         FROM emails WHERE account_id = ? AND received_at >= ?
         GROUP BY day ORDER BY day`,
      )
        .bind(requireAccountId(args), since)
        .all();
      return results;
    },
  },
];

/**
 * The whole surface. Exported so tests can assert every tool declares its
 * own gate, and so the read/write split is one list rather than a claim in
 * a comment.
 */
export const TOOLS: ToolDef[] = [
  ...ANALYTICS_TOOLS,
  ...NOUN_TOOLS,
  ...EMAIL_TOOLS,
  ...INTROSPECT_TOOLS,
  // AS interaction, not introspection — lives in oauthBridge (s02 T4).
  REVOKE_APP_TOOL,
];

/**
 * @param authenticated - A principal the CALLER already resolved (s02 T4).
 *   Supplied when an OAuth access token authenticated the request: the
 *   provider validated the token against its own store and handed back the
 *   encrypted `props`, which the route turned into a principal. Absent for a
 *   `bm_` bearer, which is resolved here as it always was.
 *
 *   Two credential systems, ONE authorization path: whichever way the
 *   principal arrived, everything below — `authorizeAccount`, the per-tool
 *   scope/domain gate, `grant_audit` — is identical and unaware of which
 *   credential was used. That is the property that makes adopting an AS
 *   cheap, and it is worth protecting: a future third credential type should
 *   also land here as a `Principal` and nowhere else.
 */
export async function handleMcp(
  request: Request,
  env: Env,
  authenticated?: Principal,
): Promise<Response> {
  if (request.method !== "POST") {
    return json({ error: "MCP: POST JSON-RPC only" }, 405);
  }

  // Identity first: MCP.2 has no session to authenticate once, so every
  // request carries its own bearer. Resolve it to a principal up front.
  let principal = authenticated ?? null;
  // Kept only when the caller authenticated with their own bm_ credential —
  // see ToolContext.rawBearer for the single consumer and the rule.
  let rawBearer: string | undefined;
  // s17 — the THIRD credential this surface accepts, and the first one that
  // names something narrower than a principal. Tried only after `verifyBearer`
  // has already said no, which costs nothing: `parseToken` and
  // `parseInvocationToken` are disjoint, so exactly one of them can match and
  // the loser returns before touching D1.
  let invocation: InvocationIdentity | null = null;
  if (!principal) {
    const authz = request.headers.get("Authorization") ?? "";
    const raw = authz.startsWith("Bearer ") ? authz.slice(7) : null;
    principal = raw ? await verifyBearer(env.DB, raw) : null;
    if (principal && raw) rawBearer = raw;
    if (!principal && raw) {
      invocation = await resolveInvocationToken(env.DB, raw);
      // The invocation's own principal, reaching EXACTLY its own account. Note
      // `rawBearer` stays undefined: `revoke_app` forwards the human's real
      // credential to the AS, and an invocation is not a human.
      principal = invocation ? await principalForInvocation(env.DB, invocation) : null;
      if (!principal) invocation = null;
    }
  }
  if (!principal) return rpcError(null, -32001, "unauthorized", 401);

  let msg: JsonRpcRequest;
  try {
    msg = (await request.json()) as JsonRpcRequest;
  } catch {
    return rpcError(null, -32700, "parse error", 400);
  }
  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return rpcError(msg.id ?? null, -32600, "invalid request", 400);
  }

  // Notifications carry no id and expect an empty 202 — no version gate.
  // This already covers the legacy lane's `notifications/initialized`.
  if (msg.id === undefined || msg.method.startsWith("notifications/")) {
    return new Response(null, { status: 202 });
  }

  // ---- era selection (s02 T2) -------------------------------------------
  //
  // Which era a request belongs to is decided by HOW THE CLIENT OPENS, not by
  // a config flag: an `initialize` request selects legacy semantics, and a
  // request carrying modern per-request `_meta` is served statelessly. A
  // 2025-era client sends neither the MCP-Protocol-Version header nor
  // `clientCapabilities` on each request, so those two requirements — which
  // are correct and mandatory on the modern lane — must not apply here.
  //
  // No session is created and none is looked up. `Mcp-Session-Id` on the way
  // in is ignored, and never minted or echoed on the way out.
  const meta = (msg.params?._meta ?? {}) as Record<string, unknown>;
  if (isLegacyMethod(msg.method)) {
    if (msg.method === "ping") return rpcResult(msg.id, {});
    return rpcResult(
      msg.id,
      initializeResult(
        (msg.params as { protocolVersion?: unknown } | undefined)?.protocolVersion,
        SERVER_INFO,
        INSTRUCTIONS,
      ),
    );
  }

  // Per-request protocol negotiation (SEP-2575): the header MUST be present
  // and MUST equal the _meta value; an unknown version returns a typed error
  // carrying the supported set.
  const headerVersion = request.headers.get("MCP-Protocol-Version");
  // Era selection, corrected by the FIRST REAL CLIENT (2026-08-14): the
  // discriminator is the `_meta` mirror ALONE, never the header. The first
  // cut required the header to be absent too — wrong, because the 2025
  // streamable-HTTP spec ALSO mandates `MCP-Protocol-Version` on every
  // post-initialize request. So the real Claude client authenticated fine
  // and then died on tools/list with our own -32020: it sent
  // `MCP-Protocol-Version: 2025-06-18` and (correctly, for its era) no
  // `_meta.protocolVersion`, and we read "header without mirror" as a
  // malformed MODERN request instead of a normal LEGACY one. The harness
  // never caught it because its fake legacy client omitted the header —
  // T7's own rationale ("a self-written client shares your assumptions"),
  // demonstrated. What each era actually sends:
  //
  //           header   _meta mirror
  //   2025:   yes      no            ← the case the first cut refused
  //   2026:   yes      yes (equal)
  //
  // On the legacy lane the header is informational and unvalidated: the
  // client echoes whatever `initialize` negotiated, and refusing an
  // unexpected value would only manufacture a second version of this bug.
  const legacyLane = meta[PROTO_META] === undefined;
  if (!legacyLane) {
    if (!headerVersion || headerVersion !== meta[PROTO_META]) {
      // -32020 HeaderMismatch, not -32600. The spec assigns this code and a
      // client keys its retry on it; a generic "invalid request" is
      // indistinguishable from a malformed body.
      return rpcError(
        msg.id,
        HEADER_MISMATCH,
        "MCP-Protocol-Version header must equal _meta protocolVersion",
        400,
      );
    }
    if (!SUPPORTED_VERSIONS.includes(headerVersion)) {
      return rpcError(
        msg.id,
        UNSUPPORTED_PROTOCOL_VERSION,
        `unsupported protocol version: ${headerVersion}`,
        400,
        {
          supported: SUPPORTED_VERSIONS,
          requested: headerVersion,
        },
      );
    }
    if (typeof meta[CAPS_META] !== "object" || meta[CAPS_META] === null) {
      // -32021 MissingRequiredClientCapability, not -32602.
      return rpcError(
        msg.id,
        MISSING_CLIENT_CAPABILITY,
        "_meta clientCapabilities is required per request",
        400,
      );
    }
    // `Mcp-Method` is REQUIRED on the modern lane and must agree with the
    // body. It exists so an intermediary can route without parsing JSON —
    // which only works if the two cannot disagree.
    const methodHeader = request.headers.get("Mcp-Method");
    if (methodHeader && methodHeader !== msg.method) {
      return rpcError(
        msg.id,
        HEADER_MISMATCH,
        "Mcp-Method header does not match the request method",
        400,
      );
    }
  }

  // ---- MANDATORY RULE 1 (s17 (d)) ---------------------------------------
  //
  // AN `agent`-MARKED BEARER MAY NOT USE THE TOOL SURFACE EXCEPT THROUGH AN
  // INVOCATION TOKEN.
  //
  // This is the line that turns everything above from etiquette into
  // enforcement. Without it the mechanism is VOLUNTARY: the harness holds both
  // credentials — a device token and, after a claim, an invocation token — so
  // narrowing is whichever one it happens to present, and a compromised model
  // that can reach the harness's device token is back to the full surface with
  // no envelope at all.
  //
  // `isAgentPrincipal` is the whole test, and it is the right test because the
  // marker is STICKY: `authRoutes.ts` re-adds `agent` to any re-minted scope
  // set, so an agent cannot mint itself an unmarked child token and shed this.
  // `invocationToken.test.ts` re-asserts that rather than trusting the comment.
  //
  // ⚠️ UNMARKED PRINCIPALS ARE COMPLETELY UNTOUCHED — humans, third-party MCP
  // clients, claude.ai, an OAuth-authenticated connected app. This surface is
  // public (s02 T1) and its primary non-agent consumer authenticates with an
  // ordinary token that has never seen an invocation. The predicate is
  // "is this bearer marked as an agent", never "is there an invocation".
  //
  // Scoped to the TOOL surface, not the whole endpoint: `initialize`,
  // `notifications/*` and `server/discover` are the handshake, and refusing
  // there would leave a client unable to learn why it was refused while
  // protecting nothing — discovery names the server, and the tools it lists are
  // filtered by `visibleTools` for an invocation and gated per call regardless.
  if (TOOL_SURFACE_METHODS.has(msg.method) && isAgentPrincipal(principal) && !invocation) {
    return rpcError(
      msg.id,
      -32004,
      "an agent-marked token may not use the tool surface directly — present the " +
        "invocationToken minted by this invocation's claim (AgentInvocation/set, " +
        "updated[id].invocationToken) as the bearer instead",
      403,
    );
  }

  // ---- the envelope (s17) -----------------------------------------------
  //
  // Resolved ONCE per request, and LIVE: `effectiveNodeAuthority` re-derives
  // `binding ∩ env(root) ∩ … ∩ env(this node)` from the rows every time, so an
  // operator narrowing `config_json.jobs` — or an ancestor's binding being
  // disabled — bites a token that is already open. Nothing is read from the
  // token row but the invocation's identity.
  //
  // ⚠️ `!resolved.ok` is a DENIAL, never "no envelope". A corrupt, absent,
  // grafted or cyclic chain means the bound is UNKNOWN, and an unknown bound is
  // not a permissive one. Reading this as "nothing to enforce" is precisely the
  // mistake that would make the gate decorative, so it refuses the whole
  // request rather than each tool.
  let envelope: { invocationId: string; effective: NodeAuthority } | null = null;
  if (invocation) {
    const resolved = await effectiveNodeAuthority(env, invocation.accountId, invocation.node);
    if (!resolved.ok) {
      return rpcError(msg.id, -32004, `invocation authority unresolvable: ${resolved.note}`, 403);
    }
    envelope = { invocationId: invocation.invocationId, effective: resolved.effective };
  }

  switch (msg.method) {
    case "server/discover":
      return rpcResult(msg.id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    case "tools/list":
      return rpcResult(msg.id, {
        // `scope` and `domain` are PUBLISHED, not stripped (s02 T6).
        //
        // The primary consumer of this surface is bullmoose's own agents
        // finding facts across each other — and an agent that cannot see what
        // a tool requires can only discover it by calling and eating a -32004.
        // That is a wasted turn per tool per agent, on the hot path of exactly
        // the thing this surface is for. Publishing the requirement lets a
        // caller pre-filter to the tools its token can actually use.
        //
        // This leaks nothing: the gate is enforced per call regardless, and
        // "this tool needs the calendar scope" is not a secret — it is the
        // same sentence the refusal would have said, delivered before the
        // round trip instead of after it.
        //
        // s17: an INVOCATION token sees a narrower list. Visibility and
        // dispatch are gated by the same two predicates in the same order —
        // the standing scope check, then the envelope — so a tool that is
        // listed is a tool that would run, and a tool that is hidden would
        // have been refused. `tools/call` re-runs both; this is not the gate,
        // it is the gate told early.
        tools: visibleTools(principal, envelope).map(
          ({ name, description, inputSchema, scope, domain, accountless }) => ({
            name,
            description,
            inputSchema,
            scope,
            domain,
            // Absent rather than false for the 28 account-scoped tools, so the
            // flag reads as the exception it is.
            ...(accountless ? { accountless: true } : {}),
          }),
        ),
        ttlMs: TOOLS_LIST_TTL_MS,
        cacheScope: "session",
      });
    case "tools/call":
      return handleToolCall(msg, request, env, principal, rawBearer, envelope);
    default:
      return rpcError(msg.id, -32601, `method not found: ${msg.method}`, 404);
  }
}

/**
 * THE ENVELOPE, ANDed — never substituted for the standing check (s17).
 *
 * `mayUse` is a DENIAL function. `effective.tools === null` means "no level of
 * this chain declared the tools axis", which is the DefaultCase the Job columns
 * were built with — it is NOT a grant, and a caller that read it as one would
 * hand an unfaceted invocation the whole surface. So this only ever narrows
 * what the standing check already allowed, and every caller runs the standing
 * check first.
 *
 * `envelope === null` means the caller is an ORDINARY bearer, which is a
 * different thing again from `effective.tools === null`: there is no invocation
 * in play, so there is no delegation to enforce and the surface behaves exactly
 * as it did before s17. The two nulls are deliberately different types so they
 * cannot be confused at a call site.
 */
function envelopeAllows(
  envelope: { invocationId: string; effective: NodeAuthority } | null,
  toolName: string,
): { ok: true } | { ok: false; detail: string } {
  if (!envelope) return { ok: true };
  const verdict = mayUse(envelope.effective, { kind: "tool", name: toolName });
  if (verdict.ok) return { ok: true };
  return {
    ok: false,
    detail: `invocation ${envelope.invocationId}: ${describeDenial(verdict.denial)}`,
  };
}

/** What `tools/list` shows: standing scope ∧ envelope, in that order. */
function visibleTools(
  principal: Principal,
  envelope: { invocationId: string; effective: NodeAuthority } | null,
): ToolDef[] {
  if (!envelope) return TOOLS;
  return TOOLS.filter(
    (t) => principalHasScope(principal, t.scope) && envelopeAllows(envelope, t.name).ok,
  );
}

async function handleToolCall(
  msg: JsonRpcRequest,
  request: Request,
  env: Env,
  principal: Principal,
  rawBearer?: string,
  envelope: { invocationId: string; effective: NodeAuthority } | null = null,
): Promise<Response> {
  const params = (msg.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
  // The routable Mcp-Name header, when present, must agree with the body.
  const nameHeader = request.headers.get("Mcp-Name");
  if (nameHeader && nameHeader !== params.name) {
    return rpcError(msg.id, -32602, "Mcp-Name header does not match params.name", 400);
  }
  const tool = TOOLS.find((t) => t.name === params.name);
  if (!tool) return rpcError(msg.id, -32602, `unknown tool: ${String(params.name)}`, 400);

  let args = params.arguments ?? {};

  // A principal-scoped tool (whoami) has no account to gate on. Scope still
  // applies; the token ∩ grant intersection does not. The envelope applies to
  // this branch too — an accountless tool is still a TOOL, and a delegation
  // that did not carry it does not acquire it by the tool being about the
  // principal.
  if (tool.accountless) {
    if (!principalHasScope(principal, tool.scope)) {
      return rpcError(msg.id, -32004, `token lacks the "${tool.scope}" scope`, 403);
    }
    const allowed = envelopeAllows(envelope, tool.name);
    if (!allowed.ok) return rpcError(msg.id, -32004, allowed.detail, 403);
    return runTool(tool, msg, env, principal, args, rawBearer);
  }

  // Omitted accountId resolves server-side (s02 T5); a supplied one is used
  // as given and still faces the gate below. `null`/`""` are omissions, not
  // ids — a client that sends one gets the naming error, not "not found".
  let accountId: string;
  if (args.accountId === undefined || args.accountId === null || args.accountId === "") {
    const resolved = defaultAccountId(principal);
    if (!resolved.ok) return rpcError(msg.id, -32602, resolved.detail, 400);
    accountId = resolved.accountId;
    args = { ...args, accountId };
  } else if (typeof args.accountId !== "string") {
    return rpcError(msg.id, -32602, "accountId must be a string", 400);
  } else {
    accountId = args.accountId;
  }

  // §6 gate: authorize the TARGET account (token ∩ grant), never a self-
  // asserted id, and audit any grant-reached read.
  const decision = authorizeAccount(principal, accountId, tool.scope, tool.domain);
  if (!decision.ok) {
    const detail = decision.reason === "accountNotFound" ? "account not found" : decision.detail;
    return rpcError(msg.id, -32004, detail, 403);
  }
  // …AND THEN the envelope (s17). Strictly after: `authorizeAccount` is the
  // standing check the delegation narrows, and the order is the invariant —
  // an envelope consulted INSTEAD of the standing check would let an
  // invocation reach an account or a scope its principal never held.
  const allowed = envelopeAllows(envelope, tool.name);
  if (!allowed.ok) return rpcError(msg.id, -32004, allowed.detail, 403);
  if (decision.auditGrant) {
    await env.DB.prepare(
      `INSERT INTO grant_audit (grant_id, principal, account_id, method, at)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(
        decision.auditGrant.grantId,
        principal.username,
        accountId,
        `mcp:${tool.name}`,
        Date.now(),
      )
      .run();
  }

  return runTool(tool, msg, env, principal, args, rawBearer);
}

/**
 * Tool results are capped, and the cap ANNOUNCES itself (s02 T6).
 *
 * Client limits are real — roughly 150,000 characters for claude.ai and
 * Desktop, ~25,000 tokens for Code — and `email_get_body` on a large message
 * clears them easily. What matters is not the truncation but the honesty of
 * it: a result cut by the transport ends mid-JSON, so the caller sees
 * malformed output and cannot tell whether the tool failed, the data is
 * corrupt, or there is simply more. An agent doing fact-finding then draws a
 * conclusion from a fragment it believes is complete, which is worse than
 * getting nothing.
 *
 * So: cut on our terms, leave valid text, and say plainly what happened and
 * how much is missing. The marker is prose because its reader is a model.
 */
const RESULT_CHAR_CAP = 100_000;

export function capResult(text: string): string {
  if (text.length <= RESULT_CHAR_CAP) return text;
  const omitted = text.length - RESULT_CHAR_CAP;
  return (
    text.slice(0, RESULT_CHAR_CAP) +
    `\n\n[truncated by bullmoose: ${omitted.toLocaleString("en-US")} of ` +
    `${text.length.toLocaleString("en-US")} characters omitted. This output is INCOMPLETE and is ` +
    `no longer valid JSON — do not parse it, and do not conclude anything from what is missing. ` +
    `Narrow the request (fewer items, a smaller range, or a more specific id) and call again.]`
  );
}

/** Dispatch past the gate. Both the account path and the accountless one land
 *  here, so a tool cannot acquire a second error convention by which route it
 *  was reached. */
async function runTool(
  tool: ToolDef,
  msg: JsonRpcRequest,
  env: Env,
  principal: Principal,
  args: Record<string, unknown>,
  rawBearer?: string,
): Promise<Response> {
  try {
    const result = await tool.run({ env, principal, rawBearer }, args);
    return rpcResult(msg.id, {
      content: [{ type: "text", text: capResult(JSON.stringify(result, null, 1)) }],
    });
  } catch (err) {
    // A ToolError is a refusal the agent can act on — a sentence saying what
    // was rejected, why, and what to do instead, plus the structured JMAP
    // SetError for anything reading programmatically. Everything else is a
    // bug and is stringified as before.
    const text =
      err instanceof ToolError
        ? err.data === undefined
          ? err.message
          : `${err.message}\n${JSON.stringify(err.data, null, 1)}`
        : String(err);
    return rpcResult(msg.id, { content: [{ type: "text", text }], isError: true });
  }
}

function rpcResult(id: number | string | null | undefined, result: unknown): Response {
  return json({ jsonrpc: "2.0", id: id ?? null, result });
}

function rpcError(
  id: number | string | null | undefined,
  code: number,
  message: string,
  status = 200,
  data?: unknown,
): Response {
  const error: { code: number; message: string; data?: unknown } = { code, message };
  if (data !== undefined) error.data = data;
  return json({ jsonrpc: "2.0", id: id ?? null, error }, status);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
