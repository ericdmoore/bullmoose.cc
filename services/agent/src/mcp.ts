import {
  authorizeAccount,
  principalHasScope,
  verifyBearer,
  type MethodDomain,
  type Principal,
} from "@bullmoose/auth-core/principal";
import { EMAIL_TOOLS } from "./emailTools.js";
import { INTROSPECT_TOOLS } from "./introspectTools.js";
import { ToolError } from "./jmapBridge.js";
import { initializeResult, isLegacyMethod } from "./mcpLegacy.js";
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
function defaultAccountId(principal: Principal): { ok: true; accountId: string } | { ok: false; detail: string } {
  // Owned only, and there is no fallback to grant-reached accounts on
  // purpose. It would be unreachable anyway — `principal.ts:149` resolves
  // grants only when the principal owns at least one account, because a
  // grantee IS an account — so a principal with no owned accounts has no
  // accounts at all. Writing the fallback would be dead code that reads
  // like a policy.
  const owned = principal.accounts.filter((a) => !a.granted);
  if (owned.length === 1) return { ok: true, accountId: owned[0]!.accountId };
  if (owned.length === 0) {
    return { ok: false, detail: "this token owns no account; pass accountId explicitly (see whoami)" };
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
    description:
      "Spend grouped by vendor, optionally within one month (YYYY-MM). Top N by total.",
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
      const month = typeof args.month === "string" && /^\d{4}-\d{2}$/.test(args.month) ? args.month : null;
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
export async function handleMcp(request: Request, env: Env, authenticated?: Principal): Promise<Response> {
  if (request.method !== "POST") {
    return json({ error: "MCP: POST JSON-RPC only" }, 405);
  }

  // Identity first: MCP.2 has no session to authenticate once, so every
  // request carries its own bearer. Resolve it to a principal up front.
  let principal = authenticated ?? null;
  if (!principal) {
    const authz = request.headers.get("Authorization") ?? "";
    const raw = authz.startsWith("Bearer ") ? authz.slice(7) : null;
    principal = raw ? await verifyBearer(env.DB, raw) : null;
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
      initializeResult((msg.params as { protocolVersion?: unknown } | undefined)?.protocolVersion, SERVER_INFO, INSTRUCTIONS),
    );
  }

  // Per-request protocol negotiation (SEP-2575): the header MUST be present
  // and MUST equal the _meta value; an unknown version returns a typed error
  // carrying the supported set.
  const headerVersion = request.headers.get("MCP-Protocol-Version");
  // A legacy client that got through `initialize` keeps calling tools without
  // the modern per-request envelope. Recognize it by the ABSENCE of both
  // modern signals and serve it on the legacy lane rather than failing it
  // with a conformance error it cannot act on.
  const legacyLane = !headerVersion && meta[PROTO_META] === undefined;
  if (!legacyLane) {
    if (!headerVersion || headerVersion !== meta[PROTO_META]) {
      // -32020 HeaderMismatch, not -32600. The spec assigns this code and a
      // client keys its retry on it; a generic "invalid request" is
      // indistinguishable from a malformed body.
      return rpcError(msg.id, HEADER_MISMATCH, "MCP-Protocol-Version header must equal _meta protocolVersion", 400);
    }
    if (!SUPPORTED_VERSIONS.includes(headerVersion)) {
      return rpcError(msg.id, UNSUPPORTED_PROTOCOL_VERSION, `unsupported protocol version: ${headerVersion}`, 400, {
        supported: SUPPORTED_VERSIONS,
        requested: headerVersion,
      });
    }
    if (typeof meta[CAPS_META] !== "object" || meta[CAPS_META] === null) {
      // -32021 MissingRequiredClientCapability, not -32602.
      return rpcError(msg.id, MISSING_CLIENT_CAPABILITY, "_meta clientCapabilities is required per request", 400);
    }
    // `Mcp-Method` is REQUIRED on the modern lane and must agree with the
    // body. It exists so an intermediary can route without parsing JSON —
    // which only works if the two cannot disagree.
    const methodHeader = request.headers.get("Mcp-Method");
    if (methodHeader && methodHeader !== msg.method) {
      return rpcError(msg.id, HEADER_MISMATCH, "Mcp-Method header does not match the request method", 400);
    }
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
        tools: TOOLS.map(({ name, description, inputSchema, scope, domain, accountless }) => ({
          name,
          description,
          inputSchema,
          scope,
          domain,
          // Absent rather than false for the 28 account-scoped tools, so the
          // flag reads as the exception it is.
          ...(accountless ? { accountless: true } : {}),
        })),
        ttlMs: TOOLS_LIST_TTL_MS,
        cacheScope: "session",
      });
    case "tools/call":
      return handleToolCall(msg, request, env, principal);
    default:
      return rpcError(msg.id, -32601, `method not found: ${msg.method}`, 404);
  }
}

async function handleToolCall(
  msg: JsonRpcRequest,
  request: Request,
  env: Env,
  principal: Principal,
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
  // applies; the token ∩ grant intersection does not.
  if (tool.accountless) {
    if (!principalHasScope(principal, tool.scope)) {
      return rpcError(msg.id, -32004, `token lacks the "${tool.scope}" scope`, 403);
    }
    return runTool(tool, msg, env, principal, args);
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
  if (decision.auditGrant) {
    await env.DB.prepare(
      `INSERT INTO grant_audit (grant_id, principal, account_id, method, at)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(decision.auditGrant.grantId, principal.username, accountId, `mcp:${tool.name}`, Date.now())
      .run();
  }

  return runTool(tool, msg, env, principal, args);
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
): Promise<Response> {
  try {
    const result = await tool.run({ env, principal }, args);
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
