import {
  authorizeAccount,
  verifyBearer,
  type MethodDomain,
  type Principal,
} from "@bullmoose/auth-core/principal";
import { INTROSPECT_TOOLS } from "./introspectTools.js";
import { ToolError } from "./jmapBridge.js";
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
 * grant) and audited — never a self-asserted accountId. The platform
 * `x-internal-token` remains as a coarse network ACL on the route (see
 * index.ts); the bearer is the identity. See .plans/s01-stateless-MCP/.
 */

const PROTOCOL_VERSION = "2026-07-28";
const SUPPORTED_VERSIONS = [PROTOCOL_VERSION];
/** Clients may cache tools/list this long (MCP.2 list cache hint). */
const TOOLS_LIST_TTL_MS = 5 * 60_000;
const UNSUPPORTED_PROTOCOL_VERSION = -32022;
const PROTO_META = "io.modelcontextprotocol/protocolVersion";
const CAPS_META = "io.modelcontextprotocol/clientCapabilities";

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
   *   mail       reads `("read", "mail")`, writes the lattice verb
   *              (`read < annotate < draft < move < send < delete`)
   *   calendar   reads `("read", "calendar")`, writes `("calendar", "calendar")`
   *   contacts   reads `("read", "contacts")`, writes `("contacts", "contacts")`
   *
   * Calendar and contacts do NOT use the mail lattice — one scope named after
   * the domain covers create, update and delete. Do not invent a mapping.
   */
  scope: string;
  domain: MethodDomain;
  run: (ctx: ToolContext, args: Record<string, unknown>) => Promise<unknown>;
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
export const TOOLS: ToolDef[] = [...ANALYTICS_TOOLS, ...NOUN_TOOLS, ...INTROSPECT_TOOLS];

export async function handleMcp(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return json({ error: "MCP: POST JSON-RPC only" }, 405);
  }

  // Identity first: MCP.2 has no session to authenticate once, so every
  // request carries its own bearer. Resolve it to a principal up front.
  const authz = request.headers.get("Authorization") ?? "";
  const raw = authz.startsWith("Bearer ") ? authz.slice(7) : null;
  const principal = raw ? await verifyBearer(env.DB, raw) : null;
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
  if (msg.id === undefined || msg.method.startsWith("notifications/")) {
    return new Response(null, { status: 202 });
  }

  // Per-request protocol negotiation (SEP-2575): the header MUST be present
  // and MUST equal the _meta value; an unknown version returns a typed error
  // carrying the supported set. No `initialize`, no `ping`.
  const meta = (msg.params?._meta ?? {}) as Record<string, unknown>;
  const headerVersion = request.headers.get("MCP-Protocol-Version");
  if (!headerVersion || headerVersion !== meta[PROTO_META]) {
    return rpcError(
      msg.id,
      -32600,
      "MCP-Protocol-Version header is required and must equal _meta protocolVersion",
      400,
    );
  }
  if (!SUPPORTED_VERSIONS.includes(headerVersion)) {
    return rpcError(msg.id, UNSUPPORTED_PROTOCOL_VERSION, `unsupported protocol version: ${headerVersion}`, 400, {
      supported: SUPPORTED_VERSIONS,
      requested: headerVersion,
    });
  }
  if (typeof meta[CAPS_META] !== "object" || meta[CAPS_META] === null) {
    return rpcError(msg.id, -32602, "_meta clientCapabilities is required per request", 400);
  }

  switch (msg.method) {
    case "server/discover":
      return rpcResult(msg.id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        // The name is an identifier clients pin config to, and it is the
        // one "mailstore-analytics" spelling that four plan docs, the route
        // (/mcp/analytics) and mcp-auth.md all share — so it stays, now
        // historical rather than descriptive. The version moves instead.
        serverInfo: { name: "bullmoose-mailstore-analytics", version: "1.1.0" },
        instructions:
          "bullmoose: read-only analytics over the message log and spend ledger, plus full " +
          "calendar and contacts CRUD. Every tool takes the accountId it should act on, and " +
          "each is authorized separately — a token may be able to read a calendar and not " +
          "write it. Creating, changing and deleting events and cards are real, immediate, " +
          "un-undoable writes that the human's calendar and contacts apps will sync; confirm " +
          "destructive ones first. List calendars and address books before guessing an id.",
      });
    case "tools/list":
      return rpcResult(msg.id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
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

  const args = params.arguments ?? {};
  const accountId = args.accountId;
  if (typeof accountId !== "string" || accountId.length === 0) {
    return rpcError(msg.id, -32602, "accountId is required", 400);
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

  try {
    const result = await tool.run({ env, principal }, args);
    return rpcResult(msg.id, {
      content: [{ type: "text", text: JSON.stringify(result, null, 1) }],
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
