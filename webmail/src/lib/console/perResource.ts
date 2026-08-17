// T3 — the per-resource view. *"Who could have messed up VendorsBook?"*
//
// Backward-looking, after the fact: the forensic question a security person
// asks. `readme.md`: *"security tools organize per-resource"*, and the two views
// are different questions in different directions — neither substitutes for the
// other.
//
// ── The split, and why the GAP is the product ───────────────────────────────
//
// `readme.md`: *"Show them side by side — the gap between them is itself the
// finding. A wide `could` with a narrow `did` means over-permissioning; a `did`
// with no matching `could` means something is broken."*
//
// So `reconcile()` below does not return two lists. It returns one list of
// FINDINGS, each of which is a statement about the relationship between the two
// sources. A screen that renders "grants" above "audit rows" and lets the reader
// do the subtraction has shipped the raw material and kept the product.
//
// ── Why point-in-time is possible at all ────────────────────────────────────
//
// `s03.A` T2 made grant revocation a tombstone (`grants.revoked_at`) instead of
// a `DELETE`. That is the entire reason this view can be correct: the question
// "who could have, last Tuesday?" is unanswerable against a table that forgets.
// Every predicate below therefore compares against a supplied instant rather
// than reading a `live` flag — and it checks each recorded action against the
// authorization set AT THAT ACTION'S OWN TIMESTAMP, not at the window's edge,
// because "she had a grant then, though not now" is the normal case rather than
// an anomaly.

import { ACCESS_LOG_CAVEATS, NOT_CAPTURED, POINT_IN_TIME_NOTE, PROVENANCE_CAVEATS, emptyMeans } from "./caveats";
import { effectiveScopes } from "./scopes";
import type {
  ConsoleAuditRow,
  ConsoleBureauGrant,
  ConsoleGrant,
  ConsoleProvenance,
  ConsoleResource,
  PartyRef,
  ResourceDossier,
} from "./types";

/** Does this grant cover the resource at all, ignoring time? */
export function coversResource(grant: ConsoleGrant, resource: ConsoleResource): boolean {
  // A whole-account grant covers every collection its scopes allow — the
  // agent-delegation shape, and the one most often mistaken for narrow.
  if (grant.collection === null) return true;
  return grant.collection === resource.collection && grant.collectionId === resource.collectionId;
}

/** Was this grant in force at `at`? Tombstone first, then expiry, then birth. */
export function liveAt(grant: Pick<ConsoleGrant, "createdAt" | "expiresAt" | "revokedAt">, at: number): boolean {
  if (grant.createdAt > at) return false;
  if (grant.revokedAt !== null && grant.revokedAt <= at) return false;
  if (grant.expiresAt !== null && grant.expiresAt <= at) return false;
  return true;
}

export interface CouldEntry {
  grant: ConsoleGrant;
  /** Who held it — the grantee, resolved to an address where one is known. */
  party: PartyRef | null;
  allows: string[];
  /** Whether it is STILL in force now, as distinct from at the chosen instant. */
  stillLive: boolean;
  /** How it reached the resource. */
  reach: "whole-account" | "this-collection";
}

/**
 * **who could** — the authorization set covering `resource` at instant `at`,
 * reconstructed from tombstoned rows. `devPlan.md` T3's done-when: *"a
 * since-revoked grant still appears for the window in which it was live."*
 */
export function whoCould(
  dossier: Pick<ResourceDossier, "grants" | "parties" | "resource">,
  at: number,
  now = Date.now(),
): CouldEntry[] {
  const byAccount = new Map(dossier.parties.map((p) => [p.accountId, p]));
  return dossier.grants
    .filter((g) => coversResource(g, dossier.resource) && liveAt(g, at))
    .map((g) => ({
      grant: g,
      // The directory wins where it has one — a grant row may carry only an
      // account id, and "who could have" is unusable without an address.
      party: g.grantee ? (byAccount.get(g.grantee.accountId) ?? g.grantee) : null,
      allows: effectiveScopes(g.scopes),
      stillLive: liveAt(g, now),
      reach: g.collection === null ? ("whole-account" as const) : ("this-collection" as const),
    }))
    .sort((a, b) => a.grant.createdAt - b.grant.createdAt);
}

/** Bureau grants in force at `at` — the credential-resource flavour of who-could. */
export function whoCouldUseCredential(
  grants: readonly ConsoleBureauGrant[],
  credRef: string,
  at: number,
): ConsoleBureauGrant[] {
  return grants.filter((g) => g.credRef === credRef && liveAt(g, at));
}

// ── who did ─────────────────────────────────────────────────────────────────

export type ActionSource = "grant-audit" | "provenance";

export interface DidEntry {
  source: ActionSource;
  /** Acting identity. `null` on a provenance row whose writer was not captured. */
  actor: string | null;
  at: number | null;
  /** Human label for what the row records. */
  what: string;
  /** The grant that authorized it, if one can be found for that instant. */
  authorizedBy: ConsoleGrant | null;
  /** Present on provenance rows: which binding/invocation, when captured. */
  binding?: string | null;
  invocation?: string | null;
  raw?: ConsoleAuditRow | ConsoleProvenance;
}

/** `grant_audit.method` — MIRROR of `introspectTools.parseAuditMethod`, all four shapes. */
export function parseAuditMethod(method: string): string {
  if (method.startsWith("mcp:")) return `MCP tool \`${method.slice(4)}\``;
  if (method.startsWith("bureau:")) {
    const rest = method.slice(7);
    const sep = rest.indexOf(":");
    // The `bureau:` shape MUST be matched before the generic `<domain>:<scope>`
    // fallthrough, or a credential use renders as a scope literally named
    // "fetch:aws-mcp".
    return sep < 0
      ? `Bureau verb \`${rest}\``
      : `Bureau \`${rest.slice(0, sep)}\` on credential \`${rest.slice(sep + 1)}\``;
  }
  const colon = method.indexOf(":");
  if (colon < 0) return method;
  // `<domain>:<a>+<b>` is a real shape (requireAccountScopes) and renders as a
  // scope named "draft+delete" if split naively.
  const scopes = method.slice(colon + 1).split("+");
  return `JMAP ${method.slice(0, colon)} (${scopes.join(" + ")})`;
}

/**
 * **who did** — `grant_audit` for delegated access, plus the `last_writer_*`
 * provenance on the records themselves for everything `grant_audit` structurally
 * misses (the owner's own writes, and an agent acting on its own account —
 * exactly the case `s03.A` exists for).
 */
export function whoDid(dossier: ResourceDossier): DidEntry[] {
  const audit: DidEntry[] = dossier.audit.map((row) => ({
    source: "grant-audit",
    actor: row.principal,
    at: row.at,
    what: parseAuditMethod(row.method),
    authorizedBy: authorizingGrant(dossier, row),
    raw: row,
  }));

  const writes: DidEntry[] = dossier.provenance.map((p) => ({
    source: "provenance",
    actor: p.lastWriterPrincipal,
    at: p.updatedAt,
    what: `last write to ${p.label}`,
    authorizedBy:
      p.lastWriterPrincipal === null || p.updatedAt === null
        ? null
        : (dossier.grants.find(
            (g) =>
              coversResource(g, dossier.resource) &&
              liveAt(g, p.updatedAt as number) &&
              g.grantee?.address === p.lastWriterPrincipal,
          ) ?? null),
    binding: p.lastWriterBinding,
    invocation: p.lastWriterInvocation,
    raw: p,
  }));

  return [...audit, ...writes].sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}

function authorizingGrant(dossier: ResourceDossier, row: ConsoleAuditRow): ConsoleGrant | null {
  // `grant_id = 'none'` is written by the Bureau when NOTHING authorized the
  // attempt — a refusal. Every other writer names a real grant, so a reader
  // joining to `grants` will not resolve these rows. That is by design, and
  // inventing a grant for one would be a lie in the forensic record.
  if (row.grantId === "none") return null;
  const named = dossier.grants.find((g) => g.grantId === row.grantId);
  if (named && liveAt(named, row.at)) return named;
  return named ?? null;
}

// ── the gap ─────────────────────────────────────────────────────────────────

export type FindingKind =
  /** Held authorization over the window and no recorded use. */
  | "over-permissioned"
  /** Acted with nothing in the grant table covering it. The alarming one. */
  | "unexplained"
  /** Acted, and a grant covering that instant explains it. */
  | "explained"
  /** A write happened and the writer was not captured (common/033). */
  | "not-captured"
  /** An attempt the Bureau refused — recorded precisely because it was refused. */
  | "refused-attempt";

export interface Finding {
  kind: FindingKind;
  actor: string | null;
  headline: string;
  detail: string;
  entries: DidEntry[];
  could: CouldEntry[];
}

/**
 * The product of this screen: one list of statements about the relationship
 * between the two sources, rather than two tables and an exercise for the
 * reader.
 */
export function reconcile(dossier: ResourceDossier, at: number, did: DidEntry[], could: CouldEntry[]): Finding[] {
  const findings: Finding[] = [];
  const actedActors = new Set(did.map((d) => d.actor).filter((a): a is string => a !== null));

  // 1. Held authorization, no recorded use.
  for (const c of could) {
    const address = c.party?.address ?? c.party?.accountId ?? null;
    if (address !== null && actedActors.has(address)) continue;
    findings.push({
      kind: "over-permissioned",
      actor: address,
      headline: `${address ?? c.grant.grantId} could have, and nothing recorded that they did`,
      detail:
        `Grant ${c.grant.grantId} was in force at the chosen instant and confers ` +
        `${c.allows.join(", ")} over this resource (${c.reach}). No row in the delegated-access ` +
        "log and no writer stamp names them. Read that as over-permissioning to review, NOT as " +
        "proof of inaction: this log only records delegated access, and it records attempts " +
        "rather than outcomes.",
      entries: [],
      could: [c],
    });
  }

  // 2. Acted with nothing covering it — and the refusals, which look identical
  //    in the table and mean the opposite.
  for (const d of did) {
    if (d.actor === null) {
      findings.push({
        kind: "not-captured",
        actor: null,
        headline: "A write happened and the writer was not captured",
        detail:
          `${d.what} has no \`last_writer_principal\`. ${NOT_CAPTURED}. This is a recording gap, ` +
          "not an anonymous actor — CardDAV/CalDAV writes and part of the agent-MCP path do not " +
          "go through the provenance stamp (common/033).",
        entries: [d],
        could: [],
      });
      continue;
    }
    const isRefusal = d.source === "grant-audit" && (d.raw as ConsoleAuditRow | undefined)?.grantId === "none";
    if (isRefusal) {
      findings.push({
        kind: "refused-attempt",
        actor: d.actor,
        headline: `${d.actor} attempted ${d.what} with nothing authorizing it`,
        detail:
          "The Bureau writes an audit row for every ATTEMPTED use, allowed or refused, and " +
          "records `grant_id = 'none'` when nothing authorized it. This row is a refusal — an " +
          "agent probing for a credential it was never granted, which is the one case a " +
          "write-only-on-success log would silently drop.",
        entries: [d],
        could: [],
      });
      continue;
    }
    if (d.authorizedBy === null) {
      findings.push({
        kind: "unexplained",
        actor: d.actor,
        headline: `${d.actor} acted, and no grant in the table explains it`,
        detail:
          `${d.what} at ${d.at === null ? "an unrecorded time" : new Date(d.at).toISOString()} ` +
          "has no covering grant. Three explanations, in decreasing order of likelihood: the " +
          "actor is the account's OWNER (owners need no grant and are never written to the " +
          "delegated-access log at all); the grant was hard-deleted before tombstones existed " +
          "(s03.A), so it is unrecoverable; or something is genuinely broken. The first is " +
          "usually the answer and the third is the one worth ruling out.",
        entries: [d],
        could: [],
      });
      continue;
    }
    findings.push({
      kind: "explained",
      actor: d.actor,
      headline: `${d.actor} acted under grant ${d.authorizedBy.grantId}`,
      detail:
        `${d.what}. The grant was in force at that instant` +
        (d.authorizedBy.revokedAt !== null
          ? `, and has since been revoked (${new Date(d.authorizedBy.revokedAt).toISOString()}) — ` +
            "it still appears here because revocation is a tombstone, not a delete."
          : ".") +
        (d.binding ? ` Binding: \`${d.binding}\`.` : "") +
        (d.invocation ? ` Invocation: \`${d.invocation}\`.` : ""),
      entries: [d],
      could: [],
    });
  }

  void at;
  return findings;
}

// ── the assembled view ──────────────────────────────────────────────────────

export interface ResourceView {
  resource: ConsoleResource;
  /** The instant the authorization set is reconstructed at. */
  at: number;
  since: number;
  could: CouldEntry[];
  did: DidEntry[];
  findings: Finding[];
  /** The one-line summary of the gap — the thing to read first. */
  gapSummary: string;
  /** Rendered on the who-did panel. Not optional; see `caveats.ts`. */
  accessLogCaveats: readonly string[];
  provenanceCaveats: readonly string[];
  pointInTimeNote: string;
  /** Shown INSTEAD of an empty table, never alongside nothing. */
  emptyMeans: string | null;
}

export function buildResourceView(
  dossier: ResourceDossier,
  window: { at: number; since: number },
  now = Date.now(),
): ResourceView {
  const could = whoCould(dossier, window.at, now);
  const did = whoDid(dossier);
  const findings = reconcile(dossier, window.at, did, could);

  const unexplained = findings.filter((f) => f.kind === "unexplained").length;
  const refused = findings.filter((f) => f.kind === "refused-attempt").length;
  const over = findings.filter((f) => f.kind === "over-permissioned").length;
  const uncaptured = findings.filter((f) => f.kind === "not-captured").length;

  return {
    resource: dossier.resource,
    at: window.at,
    since: window.since,
    could,
    did,
    findings,
    gapSummary: gapSummary({
      could: could.length,
      did: did.length,
      over,
      unexplained,
      refused,
      uncaptured,
    }),
    accessLogCaveats: ACCESS_LOG_CAVEATS,
    provenanceCaveats: PROVENANCE_CAVEATS,
    pointInTimeNote: POINT_IN_TIME_NOTE,
    emptyMeans: dossier.audit.length === 0 ? emptyMeans : null,
  };
}

function gapSummary(n: {
  could: number;
  did: number;
  over: number;
  unexplained: number;
  refused: number;
  uncaptured: number;
}): string {
  const parts: string[] = [`${n.could} could have; ${n.did} recorded ${n.did === 1 ? "action" : "actions"}.`];
  if (n.unexplained > 0) {
    parts.push(
      `${n.unexplained} acted with no covering grant — the gap that means something is broken, ` +
        "or that the actor is the owner (who needs no grant and is never logged).",
    );
  }
  if (n.refused > 0) {
    parts.push(`${n.refused} refused ${n.refused === 1 ? "attempt" : "attempts"} with nothing authorizing them.`);
  }
  if (n.over > 0) {
    parts.push(
      `${n.over} held authorization with nothing recorded — over-permissioning to review, not ` + "proof of inaction.",
    );
  }
  if (n.uncaptured > 0) {
    parts.push(`${n.uncaptured} ${n.uncaptured === 1 ? "write" : "writes"} with no writer captured (common/033).`);
  }
  if (parts.length === 1) parts.push("Every recorded action is explained by a grant in force at the time.");
  return parts.join(" ");
}
