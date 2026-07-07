# @bullmoose/jmap-core

The protocol layer: RFC 8620 request plumbing shared by every worker
that speaks JMAP.

- **types** — `JmapRequest`, method call/response tuples, `StateChange`
- **dispatch** — batched `methodCalls` execution with back-reference
  resolution (`#ids` → `{resultOf, name, path}`, RFC 8620 §3.7)
- **errors** — request-level problems and per-method `MethodError`s
  (`unknownMethod`, `invalidArguments`, `cannotCalculateChanges`,
  `blobNotFound`, …)
- **capabilities** — capability URNs and their session objects:
  `core`, `mail`, `submission`, `websocket`, `vacationresponse`, plus
  the vendor extension `urn:bullmoose:params:jmap:agent` (AgentInvocation)

No storage, no HTTP server, no Cloudflare types — pure protocol. The
jmap worker (`services/jmap`) wires these to real method handlers; see
`docs/architecture/serverless-jmap.md` for the full design.
