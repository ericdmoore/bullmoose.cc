// What the forensic view structurally cannot tell you.
//
// These are not footnotes. `grant_audit` looks like an access log and is not
// one, and a console that renders it as a table of "what happened" will mislead
// every person who reads it — confidently, and in the direction that matters.
// sVOL `015` reached the same conclusion for the conversational surface and
// returns these WITH every answer rather than documenting them somewhere a
// model will not read (`introspectTools.ts:663`). The console does the same:
// `perResource.ts` attaches them to the view model, so a renderer cannot
// produce a who-did panel without them.
//
// The four `grant_audit` caveats are MIRRORED VERBATIM from
// `services/agent/src/introspectTools.ts` ACCESS_LOG_LIMITATIONS, and
// `caveats.test.ts` reads that file off disk to prove it — if `015` rewords a
// caveat, this file's test fails rather than the two surfaces drifting into
// telling users different things about the same table.

/**
 * `grant_audit`, honestly described. Rendered beside every who-did panel.
 *
 * The first one is the one that bites hardest and is the reason `emptyMeans`
 * exists below: an empty table is the normal case for a well-run account, and
 * it means *"nobody reached this account through a grant"*, never *"nothing
 * happened"*.
 */
export const ACCESS_LOG_CAVEATS: readonly string[] = [
  "Only DELEGATED access is recorded. A row is written when someone reaches this account " +
    "through a grant; the owner's own reads and writes are never logged. An empty result means " +
    "'nobody reached this account through a grant', not 'nothing happened'.",
  "Rows record ATTEMPTS, not outcomes. The audit write happens before the method or tool runs " +
    "and there is no status column, so a call that was then refused or errored looks identical " +
    "to one that succeeded.",
  "No row says WHAT was read. There is no object id, count, or collection on the row — only " +
    "the account, the acting principal, the method label and the time.",
  "The grant's scopes are not copied onto the row, so for a revoked grant there is no way to " +
    "recover what the access was permitted to do.",
];

/** Short labels for the same four, for a caveat badge attached to a row. */
export const ACCESS_LOG_CAVEAT_LABELS: readonly string[] = [
  "delegated access only",
  "attempts, not outcomes",
  "no record of what was read",
  "revoked grants lose their scopes",
];

/**
 * The provenance columns' own gap (`common/033`). `s03.A` added
 * `last_writer_{principal,binding,invocation}` to all 7 realms and stamped them
 * in the shared mailstore write path — but two authenticated write paths do not
 * go through that stamp.
 *
 * The consequence for this screen is precise and worth stating in exactly these
 * words: **a blank `last_writer` means "not captured", not "nobody".** Rendering
 * a blank cell as an empty string invites the opposite reading.
 */
export const PROVENANCE_CAVEATS: readonly string[] = [
  "A blank writer means NOT CAPTURED, not 'nobody'. CardDAV/CalDAV writes " +
    "(services/anglebrackets) replicate the mailstore choreography instead of calling the " +
    "method layer, so a contact edited from Apple Contacts lands with no writer recorded — " +
    "even though the DAV principal is fully authenticated (common/033 §1).",
  "Agent writes over MCP record the PRINCIPAL but not the binding or invocation: the agent " +
    "worker's in-process bridge builds its request context without the active invocation, so " +
    "'which agent invocation touched this?' — the case provenance was built for — is the case " +
    "it currently cannot answer (common/033 §2).",
];

/** The single sentence a blank provenance cell must carry. */
export const NOT_CAPTURED = "not captured — see the provenance gap below";

/**
 * What an EMPTY who-did panel means. Rendered in place of the table, never as
 * an absence: a screen that shows nothing where a person expected an audit
 * trail has told them "nothing happened", which is the one thing this data
 * cannot say.
 */
export const emptyMeans =
  "No delegated access was recorded in this window. That is not the same as " +
  "'nothing happened': the owner's own reads and writes are never written to this table, and " +
  "neither is anything an agent did on its own account. Read this as 'no grantee showed up', " +
  "and use the writer column beside it for everything else.";

/**
 * Why a who-could set can be reconstructed at all, and the one thing it still
 * cannot recover. Rendered on the who-could panel.
 */
export const POINT_IN_TIME_NOTE =
  "Reconstructed from grant tombstones (s03.A): revoking a grant sets `revoked_at` instead of " +
  "deleting the row, so a since-revoked grant still appears for the window in which it was " +
  "live. Grants hard-deleted before tombstones existed are unrecoverable and cannot appear " +
  "here at all.";

/** Reserved for the skip/verdict panel — MIRROR of `introspectTools` SKIP_LIMITATIONS. */
export const SKIP_CAVEATS: readonly string[] = [
  "The homelab runtime (`bullmoose agent serve`) drops an invocation whose binding name does " +
    "not match its local config without writing a note, leaving the row pending — a skip it " +
    "takes leaves no trace here.",
  "The homelab runtime applies no allowedSenders filter at all, so the same message can be " +
    "skipped in the cloud and answered locally.",
  "Nothing records a delivery that matched no binding, so 'no invocation exists' can never be " +
    "distinguished from 'the message was never delivered'.",
];
