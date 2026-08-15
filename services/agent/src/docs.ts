/**
 * Human- and model-readable documentation for the MCP surface (s02).
 *
 * Served as markdown at `/` and `/docs` on `mcp.bullmoose.cc`, and pointed to
 * by the PRM's `resource_documentation`. Three reasons it lives HERE, in the
 * worker, rather than on the marketing site:
 *
 *  1. It cannot drift to a different deploy cadence. This string ships in the
 *     same upload as the behaviour it describes.
 *  2. It is reachable at the moment it is needed — someone reading a 401 from
 *     this host is one URL away, and that URL is in the 401.
 *  3. Its readers are split between humans and models, and markdown-as-text
 *     is the one format that serves both without a renderer.
 *
 * The root used to return the 15-byte string `bullmoose-agent`, which is a
 * fine health check and useless to anyone who pasted the hostname into a
 * browser. `/health` keeps that string for anything watching it.
 */

export const MCP_DOCS = `# bullmoose MCP

The Model Context Protocol surface for a bullmoose mailbox: read your mail,
contacts and calendar, and create/change/delete calendar events and contact
cards — from any MCP client.

    endpoint   https://mcp.bullmoose.cc/mcp
    transport  JSON-RPC over HTTP POST, one request per POST
    docs       https://mcp.bullmoose.cc/docs

## Connecting

Point your client at the endpoint above. It will get a 401 carrying a
\`WWW-Authenticate\` header that names our discovery document, and everything
else follows from there:

    401  WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp"
     ->  GET that document        (resource + authorization server)
     ->  GET the AS metadata      (https://auth.bullmoose.cc)
     ->  OAuth 2.1 + PKCE S256    (see https://auth.bullmoose.cc/docs)
     ->  Bearer <token> on every request

If you hold a bullmoose device token (\`bm_…\`), you can skip OAuth entirely and
send it as the bearer. Both credential types authenticate the same way and are
authorized identically once resolved.

## Protocol versions

Two eras are served on the same endpoint.

**2026-07-28 (stateless MCP)** is the primary lane. Every request carries its
own protocol version — an \`MCP-Protocol-Version\` header mirrored in
\`params._meta\` — and its own identity. There is no session and no
\`initialize\`.

**2025-11-25 and earlier** are served through a compatibility lane for clients
that open with \`initialize\`, which includes Claude products as they ship
today. \`ping\` is answered; \`notifications/initialized\` returns 202. No
session is created: an \`Mcp-Session-Id\` you send is ignored, and one is never
minted or echoed back.

HTTP+SSE is not implemented and will not be. \`GET\` and \`DELETE\` on the
endpoint return 405.

## Accounts

Every tool acts on one account, but you rarely need to name it.

- **Omit \`accountId\`** and it resolves to your single owned account.
- Own several, and the error names them, so the next call can succeed.
- **\`whoami\` takes no arguments at all.** It is the discovery entry point:
  call it first to learn your accounts, what your token can do, and which
  accounts you reach through a grant rather than ownership.

A client-supplied account id is never trusted — it is checked against what
your credential actually reaches, and refused with \`-32004\` if it does not.

## Tools

\`tools/list\` publishes each tool's \`scope\` and \`domain\` alongside its
schema, so you can filter to what your token can actually use instead of
discovering it by getting refused. The requirement published is the one
enforced.

**There is no send tool, and that is deliberate.** This surface can draft mail
but cannot send it. A connected client that can read your mail and send from
your address is a one-hop exfiltration path, so the capability is absent
rather than merely gated.

Large results are truncated at 100,000 characters with an explicit marker
saying how much was omitted. Truncated output is **not** valid JSON — do not
parse it; narrow the request and call again.

## Errors

    -32001  unauthorized — no credential, or it did not resolve
    -32004  forbidden — your credential does not reach that account, or
            lacks the scope the tool requires (the message says which)
    -32020  header mismatch — MCP-Protocol-Version disagrees with _meta,
            or Mcp-Method disagrees with the body
    -32021  _meta clientCapabilities missing (modern lane only)
    -32022  unsupported protocol version (the supported set is in \`data\`)

## Privacy

Every tool call is authorized against the target account and audited when it
is reached through a grant. Ask \`who_can_access\` who else can reach an
account you own — including connected OAuth clients — and \`access_log\` for
who actually did. \`revoke_app\` disconnects a connected client on the spot,
killing its tokens immediately; it works only when you authenticated with
your own device token, because a connected app may not manage the roster of
connected apps.

## Example

    curl -X POST https://mcp.bullmoose.cc/mcp \\
      -H 'authorization: Bearer bm_…' \\
      -H 'content-type: application/json' \\
      -H 'MCP-Protocol-Version: 2026-07-28' \\
      --data '{
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {
          "name": "whoami", "arguments": {},
          "_meta": {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {}
          }
        }
      }'

bullmoose is self-hosted mail for people and agents. https://bullmoose.cc
`;

/** Markdown, as text. Cached, because it changes only when the worker does. */
export function docsResponse(body: string): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
