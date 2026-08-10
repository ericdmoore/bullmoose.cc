// The agent console's wire shapes (s03.E).
//
// These MIRROR what already exists server-side. The console is the VISUAL FACE
// of sVOL `015`'s introspection surface, not a second implementation, so every
// shape below is the JSON one of these already produces:
//
//   ConsoleGrant       ← services/agent/src/introspectTools.ts  renderGrant()
//   ConsoleBinding     ←                                        renderBinding()
//   ConsoleInvocation  ←                                        renderInvocation()
//   ConsoleAuditRow    ←                                        renderAudit()
//   ConsoleCredential  ← services/agent/src/vault.ts            credentialView()
//   ConsoleBureauGrant ← control-plane.sql `bureau_grants` (bureau.md §5.1)
//
// Mirrored rather than imported, for the same reason `lib/jmap/types.ts`
// mirrors `@bullmoose/jmap-core`: those modules are Cloudflare Worker code
// (D1, service bindings, the vault master key's absence) and pulling one into a
// browser bundle would drag the worker in with it. Worse, this checkout's
// `node_modules` is empty — a bare `@bullmoose/*` specifier resolves UPWARD to
// the parent checkout, i.e. a different branch's source (see the warning in
// `vitest.config.ts`). Astro's build would silently bundle the wrong tree.
//
// The mirror is held honest by tests, not by discipline:
//   • `scopes.test.ts`  drives the REAL `hasScope` from `@bullmoose/auth-core`
//     (test-only, through the vitest alias) and asserts our expansion agrees
//     with the gate for every scope list.
//   • `caveats.test.ts` reads `introspectTools.ts` off disk and asserts the
//     caveat sentences we render are the ones it returns.
//
// ── Two shapes that deliberately DIVERGE from `015`, because it is stale ──
//
// `015` was written before `s03.A` landed grant tombstones. It says so in its
// own comment: *"revokeGrant is a hard DELETE FROM grants and s03.A's tombstones
// do not exist"*. They exist now (`grants.revoked_at`, `provision:1594`), which
// makes two of its derivations wrong rather than merely dated:
//
//   1. `renderGrant().live` is computed from `expires_at` alone, so a REVOKED
//      grant renders `live: true`.
//   2. `readAccessLog()` decides `grant_live` with
//      `SELECT COUNT(*) FROM grants WHERE id = ?` — which now counts the
//      tombstoned row, so access under a since-revoked grant renders as
//      `grantStatus: "live"`.
//
// So `ConsoleGrant` carries `revokedAt` and the console derives liveness from
// the tombstone. Reported upstream rather than patched here (`services/agent`
// is not this slice's to edit).

/** The other party on a grant — never more than name + address. */
export interface PartyRef {
  accountId: string;
  name: string | null;
  address: string | null;
}

/**
 * One account→account grant. `scopes` is what the row stores; `allows` is what
 * it actually permits — the distinction `readme.md` §Non-obvious 1 exists for.
 * Both are on the wire so the UI can show the raw list *as* the thing that
 * understates the truth, beside the expansion.
 */
export interface ConsoleGrant {
  grantId: string;
  /** Present when this grant is rendered from the target's side ("who can reach me"). */
  grantee?: PartyRef;
  /** Present when rendered from the grantee's side ("what can I reach"). */
  target?: PartyRef;
  scopes: string[];
  allows: string[];
  collection: string | null;
  collectionId: string | null;
  createdBy: string;
  /** epoch ms. Kept numeric, not ISO: point-in-time reconstruction compares these. */
  createdAt: number;
  expiresAt: number | null;
  /** s03.A tombstone. `null` = never revoked. Absent from `015`; see the header. */
  revokedAt: number | null;
}

/**
 * A Bureau grant — `(principal, credRef, verb)`, bureau.md §5.1. Capability-
 * shaped, never access-shaped: *"p_allen may use `sign_sigv4` with `aws-mcp`"*,
 * not *"p_allen may read aws-mcp"*.
 */
export interface ConsoleBureauGrant {
  grantId: string;
  principalId: string;
  /** The public handle — `vault_credentials.name`, stable across a rotate. */
  credRef: string;
  verb: "fetch" | "oauth_token" | "sign_sigv4" | "hmac_sha256";
  createdBy: string;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
}

/** Which rung of bureau.md §5.2's ladder enforces the provider-side narrowing. */
export type Enforcement = "federated" | "narrow" | "broad";

export type CredentialKind = "api-key" | "oauth-refresh" | "aws-sigv4" | "hmac-key";

/**
 * A credential REFERENCE. There is no value field and there never will be one:
 * bureau.md invariant 1, and the vault has no read path that could return one
 * (`enc_json` is written and read in exactly one worker, and it is not the one
 * this talks to).
 */
export interface ConsoleCredential {
  name: string;
  kind: CredentialKind;
  /** Destination binding (§6) — normalized origin, or `*.host`. `null` = unbound. */
  allow: string | null;
  /** Injection recipe, "Header-Name: …{}…". Header-only (invariant 8). */
  header: string | null;
  scope: string;
  enforcement: Enforcement;
  createdAt: number;
  updatedAt: number;
  /** Non-reserved user metadata (provider, client_id, token_url…). Never secret. */
  meta: Record<string, unknown>;
}

/** The derived, safety-relevant shape of a binding's config — never the config. */
export interface ConsoleBindingConfig {
  pipeline: string | null;
  replyMode: "send" | "draft" | null;
  hasPersona?: boolean;
  senderAllowlist?: { active: boolean; count?: number };
  modelAliasCount?: number;
  configUnparseable?: boolean;
}

export interface ConsoleBinding {
  bindingId: string;
  name: string;
  triggerOn: string;
  slaSeconds: number | null;
  enabled: boolean;
  config: ConsoleBindingConfig;
  /** Credential handles this binding's MCP servers reference. Values never. */
  credentialRefs?: string[];
}

export interface ConsoleInvocation {
  invocationId: string;
  bindingId: string;
  bindingName: string;
  status: "pending" | "running" | "done" | "failed";
  emailId: string | null;
  note: string | null;
  createdAt: number;
  doneAt: number | null;
}

/** `grant_audit.method` has four shapes; `parseAuditMethod` mirrors all four. */
export type AuditSurface =
  | { surface: "mcp"; tool: string }
  | { surface: "bureau"; verb: string; credRef?: string }
  | { surface: "jmap"; domain: string; scopes: string[] }
  | { surface: "unknown"; raw: string };

/**
 * One `grant_audit` row — an ATTEMPT, not an outcome. There is no status
 * column, so a refused call is indistinguishable from a successful one; see
 * `caveats.ts`, which the UI is required to render beside every one of these.
 */
export interface ConsoleAuditRow {
  id: number;
  at: number;
  principal: string;
  /** Raw `method` as stored, so the UI can always fall back to the literal. */
  method: string;
  /** `"none"` when a Bureau refusal wrote a row with nothing authorizing it. */
  grantId: string;
  accountId: string;
}

/**
 * The `last_writer_*` trio (s03.A T1) on one record, in one of the 7 realms.
 *
 * ⚠️ All three may be NULL and NULL does not mean "nobody" — see
 * `PROVENANCE_CAVEATS` in `caveats.ts`. `common/033`: DAV writes and agent-MCP
 * writes currently bypass the stamp.
 */
export interface ConsoleProvenance {
  realm: string;
  recordId: string;
  label: string;
  lastWriterPrincipal: string | null;
  lastWriterBinding: string | null;
  lastWriterInvocation: string | null;
  updatedAt: number | null;
}

/** A resource the forensic view can be pointed at. */
export interface ConsoleResource {
  /** e.g. "AddressBook", "Calendar", "Mailbox", "FileNode". */
  collection: string;
  collectionId: string;
  name: string;
  accountId: string;
}

export interface ConsoleSpend {
  currency: string;
  totalCents: number;
  rows: number;
  since: number | null;
}

/** Everything the per-agent view needs, in one payload. */
export interface AgentDossier {
  accountId: string;
  principalId: string;
  principal: string;
  /** The token's own scopes — effective rights are token ∩ grant. */
  tokenScopes: string[];
  bindings: ConsoleBinding[];
  credentials: ConsoleCredential[];
  bureauGrants: ConsoleBureauGrant[];
  /** Grants where this principal is the GRANTEE — what it can reach. */
  grantsHeld: ConsoleGrant[];
  /** Grants this principal made to others. */
  grantsGiven: ConsoleGrant[];
  invocations: ConsoleInvocation[];
  spend: ConsoleSpend | null;
}

/** Everything the per-resource view needs, in one payload. */
export interface ResourceDossier {
  resource: ConsoleResource;
  /** Every grant that ever covered this resource, tombstones included. */
  grants: ConsoleGrant[];
  /** Bureau grants, when the resource is a credential. */
  bureauGrants: ConsoleBureauGrant[];
  /** `grant_audit` rows for the window. */
  audit: ConsoleAuditRow[];
  /** `last_writer_*` on the records inside the resource. */
  provenance: ConsoleProvenance[];
  /** Directory of accountId → address, for rendering audit principals. */
  parties: PartyRef[];
}
