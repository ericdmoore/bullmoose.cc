/**
 * Human- and model-readable documentation for the authorization server (s02).
 *
 * Served as markdown at `/` and `/docs` on `auth.bullmoose.cc`. Same reasoning
 * as the MCP surface's docs: co-located with the behaviour it describes, so it
 * ships in the same upload and cannot drift.
 *
 * The root previously returned the 15-byte string `bullmoose-oauth`. `/health`
 * keeps it for anything watching.
 */

export const AUTH_DOCS = `# bullmoose authorization server

Issues OAuth 2.1 access tokens for the bullmoose MCP surface, and is where a
human signs in.

    issuer     https://auth.bullmoose.cc
    metadata   https://auth.bullmoose.cc/.well-known/oauth-authorization-server
    resource   https://mcp.bullmoose.cc/mcp

## The flow

Standard OAuth 2.1 authorization code with PKCE:

    GET  /authorize   consent screen; the human signs in and approves
    POST /token       code -> access token (+ refresh)
    POST /register    dynamic client registration (see below)

**PKCE is required and only S256 is accepted.** The \`plain\` method is
rejected. Authorization requests without a code challenge are refused at the
consent screen rather than at the token exchange, so the failure arrives
before a human has approved anything.

**Send the \`resource\` parameter.** Tokens are audience-bound to
\`https://mcp.bullmoose.cc/mcp\`, and the resource server refuses a token
minted for anything else. Omitting it inherits that resource rather than
leaving the token unbound.

## Identifying your client

**Client ID Metadata Documents are preferred.** Use an \`https\` URL that
serves your client metadata as your \`client_id\`; no registration step is
needed and you get a stable identity across connections.

**Dynamic client registration** is supported as a fallback for clients that
cannot do the above. It works, but it registers a fresh client on every
connection, so prefer the metadata document where you have the choice.

### Redirect URIs

Registered for first-party Claude clients:

    https://claude.ai/api/mcp/auth_callback
    http://localhost/callback
    http://127.0.0.1/callback

Matching is exact, with one deliberate exception: on loopback the **port is
ignored**, because a local client binds an ephemeral port that cannot be
registered in advance (RFC 8252 §7.3). The relaxation is the port and nothing
else — scheme, host and path must still match exactly, \`localhost\` and
\`127.0.0.1\` are not interchangeable, and a query string on the redirect is
refused.

## Scopes

Requested with the \`scope\` parameter, space-separated. What each one lets a
connected app do:

    read       read your mail, contacts, calendar and files
    annotate   mark mail read, flagged or categorized
    draft      write drafts in your mailbox (it cannot send them)
    move       file mail into other mailboxes
    delete     delete mail
    contacts   read and change your contacts
    calendar   read and change your calendar, including creating and
               deleting events
    files      read and change your files, including uploading and
               deleting them
    mail       the bundle: read + annotate + draft + move + delete

Three things a connected app can **never** be granted, whatever it asks for:

    send    there is no send tool; an app that can read your mail and send
            from your address is a one-hop exfiltration path
    vault   the credential store — not something to hand over through a
            consent screen
    admin   control-plane only

The consent screen states what each requested scope *does*, in prose, computed
from the same rule the server enforces — so the explanation cannot drift from
what is actually allowed.

## Signing in

The consent screen takes your bullmoose address and password. **The password
never reaches this server.** Your browser derives a login key from it locally
(600,000 rounds of PBKDF2-SHA256, salted with your address) and sends only
that; the server compares a single hash of it. The raw password is cleared
from the form before submission, so it is never in a request body, a proxy
cache, or a log.

Repeated failures are rate-limited per address and per source address, and the
answer is identical for an unknown address and a wrong password.

## Tokens

    access token    1 hour
    refresh token   rotated on use

A refresh that fails returns \`invalid_grant\`. Access tokens are audience-
bound; presenting one to a resource it was not minted for is refused.

## What you granted, later — and how to take it back

Every consent is recorded and visible to the account owner: which client, what
it may do, where its codes were delivered, and when you connected it. Revoking
one is independent of every other client and of any account sharing you have
set up.

To disconnect an app, POST to \`/revoke\` with your own device token:

    curl -X POST https://auth.bullmoose.cc/revoke \\
      -H 'authorization: Bearer bm_…' \\
      -H 'content-type: application/json' \\
      -d '{"clientId":"<the client id shown in your connected-apps list>"}'

The app's access and refresh tokens die immediately — not at their natural
expiry — and it can only return by going through consent again. Your device
token is required deliberately: a connected app cannot manage the roster of
connected apps, itself included. An app that wants to revoke only its own
token uses standard OAuth token revocation instead.

## The webmail session exchange (first-party only)

\`POST /webmail/session\` with an access token as the bearer returns a
bullmoose \`bm_\` session token — how signing in at \`app.bullmoose.cc\`
becomes a mailbox session. It answers **only** for tokens granted to the
webmail's own client id; every other connected app receives 403 and keeps
exactly the OAuth token it consented to. The minted session appears in your
token listings as \`webmail session\`, expires after 30 days, and is revoked
like any device token.

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
