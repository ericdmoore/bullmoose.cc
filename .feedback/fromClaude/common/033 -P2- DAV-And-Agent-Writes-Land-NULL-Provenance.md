# 033 -P2- CardDAV/CalDAV and agent-path writes bypass the provenance stamp

**Subsystem:** common · **Severity:** MEDIUM (forensic blind spots) · **Fix class:** CHANGE-CODE

`s03.A` added `last_writer_{principal,binding,invocation}` to all 7 realms, stamped in the
shared `Mailstore` write path via `provenanceValues()`/`appendProvenance()`. Two authenticated
write paths do not go through that stamp, so they record **NULL provenance** — exactly where a
forensic query would look first.

## 1. DAV writes (`services/anglebrackets/src/dav.ts`)
CardDAV/CalDAV writes construct `new Mailstore(env.DB, env.BLOBS)` and **replicate** the
choreography rather than calling the JMAP method layer (anglebrackets binds only `ACCOUNT_DO`
cross-script). So a contact edited from Apple Contacts, or an event from Apple Calendar, lands
with no writer recorded — even though the DAV principal is a fully authenticated user. The
mechanism supports it: build a `WriteProvenance` from the DAV principal and pass it to the
insert/update calls. This is the clearest follow-up from `s03.A`.

## 2. Agent MCP path records principal but not binding/invocation
`services/agent`'s in-process `jmapBridge.callJmap` builds `RequestContext` without
`ctx.agent`, so a noun write an agent makes over MCP stamps the **principal** but leaves
`last_writer_binding`/`last_writer_invocation` NULL. That's the exact case provenance was
built for — "which agent invocation touched this?" Wire `handleToolCall`/`callJmap` to set
`ctx.agent` from the active invocation.

## Why P2
Provenance's whole point (`s03.A` readme) is that `grant_audit` misses owner-context and
agent-scrambled-owner-data writes. These two gaps re-open a chunk of that: DAV is a common
human write path, and the agent path is *the* motivating case. Not urgent (the columns exist
and most writes populate them), but the coverage hole is precisely the interesting quadrant.

## Related
- `.plans/s03.A-foundations` — shipped the columns; scoped itself to the mailstore path + `storeFor`.
- `.plans/s03.E-console` — the forensic "who could / who did" view reads these columns; NULLs there are silent gaps.
