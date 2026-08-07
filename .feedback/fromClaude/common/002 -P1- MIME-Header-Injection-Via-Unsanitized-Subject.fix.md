# FIX — 002 -P1- MIME header injection via unsanitized subject

## Proposal

**Strip CR/LF at every point a value becomes a header line**, not at the call sites.

```ts
// packages/mime/src/index.ts
const stripCrLf = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

export function encodeHeaderValue(v: string): string {
  const clean = stripCrLf(v);
  return isAscii(clean) ? clean : bEncode(clean);   // existing RFC 2047 path
}
```

Apply the same to:
- `formatAddress` (`:101-109`) — strip from both display name and `email`
- `extraHeaders` (`:46`) — strip each entry, and reject any that lacks a `:` (a malformed entry is a
  bug, not a header)

Replace rather than reject: a subject containing a newline is far more likely to be sloppy input
than an attack, and dropping the message is worse UX than folding the line.

## Why sanitize in the builder, not the callers

`buildMime` is the chokepoint every send path crosses. Sanitizing at `account-do:181` would fix the
one known reachable path and leave the next one open. This is the repo's own stated principle from
`mcp-auth.md` §8 — *enforce by wiring, not rule*.

## Bread-crumbs

- **Second copy:** `packages/cli/src/mime.ts:166`. Ideally the CLI imports `@bullmoose/mime` instead
  of carrying its own — check why it diverged first; the CLI runs on Node and the package targets
  Workers, which may be the reason. If they can't merge, fix both and leave a comment linking them.
- **Test:** feed `buildMime` a subject of `"hi\r\nBcc: evil@example.com"` and assert the output has
  exactly one `Bcc:`-shaped line (i.e. none). Add an RFC 2047 case too — decode-then-inject is the
  actual attack path, so test the *decoded* value reaching the builder.
- **Reachable path to regression-test:** `packages/account-do/src/index.ts:181` with a responder
  enabled — that is the one confirmed untrusted → header route.

## Docs to update

`packages/mime/README.md:13` — state the invariant explicitly: *header values are CR/LF-stripped
before encoding; callers may pass untrusted text.* That line is what tells the next person they
don't need to sanitize upstream.
