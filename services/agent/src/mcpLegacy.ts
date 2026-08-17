/**
 * The 2025-era `initialize` adapter (s02 T2) — a hedge with a delete
 * condition, deliberately not a second protocol implementation.
 *
 * ## Why this exists
 *
 * `mcp.ts` implements stateless MCP (2026-07-28 / SEP-2575) and advertises
 * only that version. Anthropic's connector documentation lists the auth
 * specs its clients support as 2025-03-26, 2025-06-18 and 2025-11-25 —
 * 2026-07-28 is not among them, and clients still identify themselves in the
 * `initialize` handshake. So without this file, claude.ai / Claude Desktop /
 * Claude Code cannot complete a handshake with this server at all: their
 * first request is `initialize`, which falls to `default` → `-32601`.
 *
 * The spec explicitly blesses serving both: *"A dual-era server MAY serve
 * both eras concurrently on the same endpoint or process."*
 *
 * ## What makes it cheap
 *
 * The two eras differ in almost nothing that costs us anything, because the
 * expensive parts of the old era are exactly the parts 2026-07-28 removed —
 * and this file implements NONE of them:
 *
 *   HTTP+SSE, `Mcp-Session-Id`, resumability, `Last-Event-ID` → REFUSED.
 *
 * The server is stateless either way, which is why `initialize` can be a
 * canned object rather than a session constructor. GET/DELETE on the
 * endpoint stay 405 (index.ts); a session id on a request is ignored rather
 * than echoed; we never mint one.
 *
 * ## Delete condition
 *
 * When a Claude client completes `server/discover` against this server
 * WITHOUT first sending `initialize`, delete this file and the one dispatch
 * branch that calls it. If it ever starts leaking conditionals into
 * `handleMcp`'s modern path, it was built wrong.
 */

/** What a 2025-era client negotiates. We advertise the newest legacy version
 *  we can honestly serve; the shape of our tool surface is identical across
 *  the 2025 revisions. */
export const LEGACY_PROTOCOL_VERSION = "2025-11-25";

/** Every 2025 revision Claude products are documented to speak. A client
 *  asking for one of these gets it echoed back; anything else is answered
 *  with our preferred version, which is what the spec prescribes for an
 *  unknown request. */
export const LEGACY_SUPPORTED = ["2025-03-26", "2025-06-18", "2025-11-25"] as const;

export interface LegacyServerInfo {
  name: string;
  version: string;
}

/**
 * The `initialize` result. No session is created, nothing is stored, and the
 * response is a pure function of the request — which is the whole reason the
 * legacy lane costs us an adapter instead of a second server.
 */
export function initializeResult(
  requestedVersion: unknown,
  serverInfo: LegacyServerInfo,
  instructions: string,
): Record<string, unknown> {
  const asked = typeof requestedVersion === "string" ? requestedVersion : null;
  const protocolVersion =
    asked && (LEGACY_SUPPORTED as readonly string[]).includes(asked)
      ? asked
      : LEGACY_PROTOCOL_VERSION;
  return {
    protocolVersion,
    // Tools only. We deliberately advertise no `resources`, no `prompts`, no
    // `sampling`, no `roots`: Claude does not support the latter two, and the
    // former two do not exist on this server. Advertising a capability we do
    // not implement is how a client ends up calling a method we answer with
    // -32601 in the middle of a user's turn.
    capabilities: { tools: {} },
    serverInfo,
    instructions,
  };
}

/** Is this the request that selects legacy semantics? */
export function isLegacyHandshake(method: string): boolean {
  return method === "initialize";
}

/**
 * Methods the legacy lane must answer that the modern lane does not have.
 * `ping` is three lines and its absence breaks keepalive; `initialized` is
 * already a notification and handled as a 202 upstream.
 */
export function isLegacyMethod(method: string): boolean {
  return method === "initialize" || method === "ping";
}
