# @bullmoose/mime

Minimal RFC 5322 / MIME **builder** — the write side only (inbound
parsing is postal-mime's job). Used by the jmap worker (Email/set
drafts), the AccountDO (armed responses), and the agent worker
(replies, digests, forwards).

`buildMime(draft)` supports:

- text/plain, text/html, or multipart/alternative with both
- base64-encoded bodies (line-length safe for any content)
- To/Cc/Bcc, In-Reply-To + References threading headers
- RFC 2047 B-encoding for non-ASCII headers (`encodeHeaderValue`)
- `extraHeaders` passthrough — how agent mail carries
  `Auto-Submitted`, `X-Auto-Response-Suppress`, `X-Bullmoose-Model`,
  `X-Bullmoose-Invocation`
- **attachments** — `attachments: MimeAttachment[]`, each carrying
  resolved bytes. A part with a `cid` goes in a `multipart/related`
  beside the body (that is what resolves `cid:` refs from the HTML);
  everything else is a `multipart/mixed` sibling. Filenames use RFC
  2183 `filename="…"`, or RFC 2231 `filename*=utf-8''…` when non-ASCII.
  Empty levels collapse, so a draft with no attachments produces
  byte-identical output to before they existed (pinned by golden
  strings in `index.test.ts`).

`MimeAttachment` carries **bytes, not a blobId**, deliberately: resolving a
blobId is an authorization decision (whose blob is it?), and this package has
no store and no notion of an account. The caller fetches under its own account
scope — see `resolveAttachments` in `services/jmap/src/methods/email.ts`.

## The other builder

`packages/cli/src/mime.ts` is a second implementation with the same
nested-multipart structure — this one's node/multipart shape was lifted from
it, and for a given input the two now emit the same bytes. They are still
separate because this package `exports` raw `./src/index.ts` for wrangler's
bundler, and the CLI is plain compiled Node that cannot `import` a `.ts` file
at runtime. Unifying means giving `@bullmoose/mime` a build step and dual
`exports` (source for the three bundled workers, `dist/` for the CLI); the two
remaining behavioural differences are `extraHeaders` (here only) and `Buffer`
vs `btoa` base64 (there only).
