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

Not yet supported: attachment parts (drafts with uploads referencing
blobs) — the CLI has its own richer nested-multipart builder
(`packages/cli/src/mime.ts`, CID inlining + binary attachments) that
should eventually fold back in here.
