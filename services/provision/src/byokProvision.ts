/**
 * **The BYOK core** — seal, grant, attach, detach, revoke, and the status
 * projection that says whether any of it will actually work (s26 T4).
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
 *
 * #203 shipped the whole BYOK path and one door onto it: `POST /provider-keys`
 * on the operator plane, behind `ADMIN_TOKEN`. Bringing your own key was
 * therefore something Eric did for you with a `curl`. The session-reachable
 * door (`services/jmap/src/methods/providerCredential.ts`) is the fix, and the
 * moment there are two doors the interesting question is whether there are two
 * IMPLEMENTATIONS. There must not be: "which credentials may this binding
 * spend" is a security decision, and a second copy of it is a second copy that
 * can drift — the Bureau's check 2 (`bindingNamesCredential`) reads whatever
 * these functions wrote, so a writer that disagrees with the other writer is a
 * binding that silently cannot spend, or worse, one that silently can.
 *
 * So this module owns the three steps, and BOTH doors are thin adapters over
 * it. It is deliberately free of any `Env`: it takes a `D1Database` and — for
 * the seal — a `BureauHop`, because it is imported by two workers whose `Env`
 * types have nothing else in common. That is also why it imports nothing from
 * `index.ts`: a bare `import` of this module from `services/jmap` must not drag
 * the whole provisioning worker into the JMAP bundle. (Same shape and same
 * reason as `services/jmap/src/methods/actionProposal.ts` reaching into
 * `services/agent/src/watchCompose`.)
 *
 * ── THE INVARIANT, IN THE ONE PLACE IT COULD BE BROKEN ─────────────────────
 *
 * ⚠️ **The provider key is write-only.** It appears in exactly one parameter,
 * `sealProviderKey`'s `secret`, and travels exactly one hop: into the BUREAU
 * binding, where `VAULT_MASTER_KEY` lives and this worker's does not. It is
 * never returned, never stored here, never logged, never interpolated into an
 * error message and never truncated into one — a prefix of an API key is still
 * a piece of an API key, and it is exactly the piece an attacker uses to
 * confirm they have the right one. Nothing in this file reads `secret` except
 * to put it in the seal request body. Every function below that could carry it
 * outward takes it as a separate argument for that reason: if it is not in the
 * options object, it cannot end up in a response by a spread.
 *
 * ── WHAT "THREE STEPS" MEANS, AND WHY ALL THREE ────────────────────────────
 *
 *   1. **seal** — the plaintext crosses the BUREAU binding once and becomes
 *      ciphertext under a key this worker has never held (s04 T3a);
 *   2. **grant** — `(principal, credRef, fetch)`, because minting a credential
 *      authorizes nobody (bureau.md §5.1). A sealed-but-ungranted key is a key
 *      that silently does nothing;
 *   3. **attach** — `config_json.providerCredentials[provider] = credRef` on
 *      the account's bindings, which is what makes the Bureau's own check
 *      ("does this binding NAME this credential?") pass.
 *
 * Miss any one and the result is a configuration that looks live and is not —
 * which is the exact failure mode `models.ts` refuses to paper over, and the
 * reason `byokStatus` below exists as a first-class read.
 */

/** The two bindings a seal needs. Structural, so either worker's `Env` fits. */
export interface BureauHop {
  BUREAU?: Fetcher;
  INTERNAL_TOKEN?: string;
}

/**
 * Hosts that authenticate with a bearer, and can therefore carry a tenant's
 * own key. `workers-ai` runs on the platform's account binding and `mock` runs
 * nowhere — neither has a key to bring, so neither is offered one.
 */
export const BYOK_PROVIDERS: Record<string, { defaultAllow?: string }> = {
  openrouter: { defaultAllow: "https://openrouter.ai" },
  gateway: {},
};

/** Injection recipe when the caller names none. Header-only (invariant 8). */
export const DEFAULT_HEADER_RECIPE = "Authorization: Bearer {}";

/** The verb, fixed. A model call is a proxied HTTP request; the Class B verbs
 *  are signing oracles an API-key credential has no business answering
 *  (bureau.md §4.1), and nothing here should be able to grant one. */
export const BYOK_VERB = "fetch";

/** Kinds `fetch` is legal for (bureau.md §4.1) — mirrored here so the status
 *  read can predict the Bureau's own gate rather than guess at it. */
const FETCH_KINDS = new Set(["api-key", "oauth-refresh", "aws-sigv4"]);

// ── validation ────────────────────────────────────────────────────────────

/** `vault_credentials.name` shape — the public handle, stable across rotate. */
export function isCredRef(raw: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(raw);
}

/**
 * Normalize a destination-allowlist entry to a canonical origin (bureau.md §6),
 * or null. Deliberately the same normalization the vault's mint path performs
 * (`services/agent/src/vault.ts`) — the Bureau RE-PARSES the stored string on
 * every use and matches scheme+host+port structurally, so the value of
 * canonicalizing here is that whoever reads the row sees what the enforcement
 * point will see.
 */
export function normalizeAllow(raw: string): string | null {
  const val = raw.trim().toLowerCase();
  if (!val) return null;
  const wild = /^(?:(https?):\/\/)?(\*\.[a-z0-9.-]+)$/.exec(val);
  if (wild) return `${wild[1] ?? "https"}://${wild[2]}`;
  try {
    const u = new URL(val.includes("://") ? val : `https://${val}`);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (!u.hostname || u.hostname.includes("*")) return null;
    if (u.username || u.password) return null;
    return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ""}`;
  } catch {
    return null;
  }
}

/** `"Header-Name: …{}…"` — a field name, a colon, and the slot the credential
 *  lands in. This shape can only produce a HEADER (invariant 8): there is no
 *  branch anywhere that puts a credential in a URL. */
export function normalizeHeaderRecipe(raw: string): string | null {
  const val = raw.trim();
  if (!val.includes("{}")) return null;
  if (!/^[!#$%&'*+.^_`|~0-9a-z-]+:\s*\S/i.test(val)) return null;
  return val;
}

/** config_json, parsed junk-tolerantly: operator-written TEXT must degrade to
 *  "nothing declared", never throw. A private copy rather than an import so
 *  this module keeps its no-dependencies property (see the header). */
function parseConfig(configJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(configJson || "{}") as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// ── 1: seal ───────────────────────────────────────────────────────────────

export interface SealContract {
  principalId: string;
  credRef: string;
  /** Normalized origin (bureau.md §6). Never optional here: a credential with
   *  no allowlist is refused at use time (invariant 5), so a door that omitted
   *  one would mint a key that cannot be spent. */
  allow: string;
  /** Normalized injection recipe. */
  header: string;
}

export type SealOutcome = { ok: true } | { ok: false; status: number; error: string };

/**
 * The seal hop, and the ONLY function that touches the plaintext.
 *
 * `mode: "mint"` upserts, so a re-run rewrites ciphertext AND contract
 * together: both doors compute the whole contract every time, and a rotate-only
 * path would leave an allowlist behind that no longer matches what was asked
 * for. (The narrower key-only rotate is the tenant's own
 * `POST /vault/credentials/{name}/rotate`, on their own bearer.)
 *
 * The failure branch reports the Bureau's STATUS and nothing else — not the
 * Bureau's response body, which the caller has no reason to trust and this
 * function has no reason to relay. Fail closed and write nothing else: a grant
 * or an attachment pointing at a credential that was never sealed is a config
 * that looks live and is not.
 */
export async function sealProviderKey(hop: BureauHop, contract: SealContract, secret: string): Promise<SealOutcome> {
  if (!hop.BUREAU || !hop.INTERNAL_TOKEN) {
    return { ok: false, status: 501, error: "BYOK is not configured on this deployment (no BUREAU binding)" };
  }
  const res = await hop.BUREAU.fetch("https://bureau.internal/internal/bureau/seal", {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-token": hop.INTERNAL_TOKEN },
    body: JSON.stringify({
      mode: "mint",
      principalId: contract.principalId,
      name: contract.credRef,
      kind: "api-key",
      metaJson: JSON.stringify({
        allow: contract.allow,
        header: contract.header,
        scope: "actor",
        enforcement: "federated",
      }),
      // ⚠️ The one place the plaintext appears. It goes IN and nothing but an
      // acknowledgement comes back — there is no route on the Bureau that
      // returns a secret (bureau.md invariant 1).
      secret,
    }),
  });
  // Deliberately NOT `${await res.text()}`: relaying an upstream body is how a
  // secret ends up in a log by accident.
  return res.ok ? { ok: true } : { ok: false, status: 502, error: `bureau refused the seal (${res.status})` };
}

/** Does this principal already hold this handle? Decides created-vs-rotated,
 *  and is the only thing either door needs to know about the vault row. */
export async function credentialExists(db: D1Database, principalId: string, credRef: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT id FROM vault_credentials WHERE principal_id = ? AND name = ?`)
    .bind(principalId, credRef)
    .first<{ id: string }>();
  return !!row;
}

// ── 2: grant ──────────────────────────────────────────────────────────────

/**
 * `(principal, credRef, "fetch")`, upserted — one statement, one place, so the
 * operator door and the session door cannot drift on the reinstate semantics
 * (a tombstone must not make a capability ungrantable forever).
 *
 * `actor` is WHO: `"admin"` from the operator plane, the acting login email
 * from a session. It lands in both `bureau_grants.created_by` and the
 * `grant_lifecycle` row, so "who gave this agent permission to spend the
 * tenant's key" is answerable from the chain rather than from memory.
 */
export async function grantFetchOnCredential(
  db: D1Database,
  principalId: string,
  credRef: string,
  opts: { actor: string; expiresDays?: number | undefined; now?: number } = { actor: "admin" },
): Promise<string> {
  const id = `bg_${crypto.randomUUID()}`;
  const now = opts.now ?? Date.now();
  const expiresAt = opts.expiresDays ? now + opts.expiresDays * 86_400_000 : null;
  await db
    .prepare(
      `INSERT INTO bureau_grants (id, principal_id, cred_name, verb, created_by,
         created_at, expires_at, revoked_at)
       VALUES (?, ?, ?, '${BYOK_VERB}', ?, ?, ?, NULL)
       ON CONFLICT (principal_id, cred_name, verb) DO UPDATE SET
         revoked_at = NULL, created_at = excluded.created_at,
         created_by = excluded.created_by, expires_at = excluded.expires_at`,
    )
    .bind(id, principalId, credRef, opts.actor, now, expiresAt)
    .run();
  const row = await db
    .prepare(`SELECT id FROM bureau_grants WHERE principal_id = ? AND cred_name = ? AND verb = '${BYOK_VERB}'`)
    .bind(principalId, credRef)
    .first<{ id: string }>();
  const grantId = row?.id ?? id;
  await logGrantLifecycle(db, grantId, "created", now, opts.actor);
  return grantId;
}

/**
 * Tombstone the `fetch` grant — the s03.A contract, not a DELETE. The
 * credential and its history survive and the next call stops resolving, which
 * is what makes "stop spending this key" reversible without re-sealing it.
 *
 * Returns the grant id when something was live to revoke, null when there was
 * nothing (already revoked, or never granted) — idempotent by construction, so
 * a double-click writes one lifecycle row rather than two.
 */
export async function revokeFetchGrant(
  db: D1Database,
  principalId: string,
  credRef: string,
  actor: string,
  now = Date.now(),
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT id FROM bureau_grants
        WHERE principal_id = ? AND cred_name = ? AND verb = '${BYOK_VERB}' AND revoked_at IS NULL`,
    )
    .bind(principalId, credRef)
    .first<{ id: string }>();
  if (!row) return null;
  await db.prepare(`UPDATE bureau_grants SET revoked_at = ? WHERE id = ?`).bind(now, row.id).run();
  await logGrantLifecycle(db, row.id, "revoked", now, actor);
  return row.id;
}

/** The `grant_lifecycle` writer for this module's two grant transitions. The
 *  admin plane has no authorizing proposal, and neither does a human acting on
 *  their own account, so `via_proposal_id` is NULL from both doors — the column
 *  is the contract a future approval flow fills. */
async function logGrantLifecycle(
  db: D1Database,
  grantId: string,
  event: "created" | "revoked",
  at: number,
  actor: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO grant_lifecycle (grant_id, event, at, actor, via_proposal_id)
       VALUES (?, ?, ?, ?, NULL)`,
    )
    .bind(grantId, event, at, actor)
    .run();
}

// ── 3: attach / detach ────────────────────────────────────────────────────

export interface TouchedBinding {
  id: string;
  name: string;
}

/**
 * Write `providerCredentials[provider] = credRef` onto the account's bindings.
 *
 * Which bindings, when none is named: every binding on the account that already
 * has a route to that provider, plus any that already named a credential for it
 * (a re-run must find its own previous work). A binding with no `openrouter`
 * candidate has nothing to authenticate, so attaching there would be noise in a
 * config a human has to read.
 *
 * Binding-WIDE rather than per candidate: `providerCredentials` covers every
 * present and future route to that host, so adding a second OpenRouter model to
 * the menu later cannot accidentally fall back to the platform key.
 *
 * Each real change appends a `binding_lifecycle` row — the same chain the kill
 * switch writes, with the same `actor` convention. A no-op (the ref is already
 * what it would be set to) writes NOTHING: a chain that records non-events is
 * a chain nobody can read (provision's own rule, s10 T4).
 */
export async function attachCredentialToBindings(
  db: D1Database,
  accountId: string,
  provider: string,
  credRef: string,
  opts: { actor: string; bindingName?: string | undefined; bindingId?: string | undefined; now?: number } = {
    actor: "admin",
  },
): Promise<TouchedBinding[]> {
  const now = opts.now ?? Date.now();
  const { results } = await db
    .prepare(`SELECT id, name, config_json FROM agent_bindings WHERE account_id = ? ORDER BY name`)
    .bind(accountId)
    .all<{ id: string; name: string; config_json: string }>();

  const attached: TouchedBinding[] = [];
  for (const binding of results) {
    const config = parseConfig(binding.config_json);
    if (opts.bindingId) {
      if (binding.id !== opts.bindingId) continue;
    } else if (opts.bindingName) {
      if (binding.name !== opts.bindingName) continue;
    } else if (!routesToProvider(config, provider)) {
      continue;
    }
    const existing = asRecord(config.providerCredentials);
    const prior = existing?.[provider];
    const providerCredentials: Record<string, unknown> = { ...(existing ?? {}) };
    providerCredentials[provider] = credRef;
    config.providerCredentials = providerCredentials;
    await db
      .prepare(`UPDATE agent_bindings SET config_json = ? WHERE account_id = ? AND id = ?`)
      .bind(JSON.stringify(config), accountId, binding.id)
      .run();
    attached.push({ id: binding.id, name: binding.name });
    if (prior !== credRef) {
      await logBindingCredential(db, accountId, binding.id, "attached", provider, prior, credRef, opts.actor, now);
    }
  }
  return attached;
}

/**
 * The inverse: drop `providerCredentials[provider]` from one binding, or from
 * every binding on the account.
 *
 * **Detach is not delete, and the difference is exact.** Nothing here touches
 * `vault_credentials`. A hard delete of a credential does exist — `DELETE
 * /vault/credentials/{name}` on the agent worker's vault surface — and it is
 * somebody else's verb on somebody else's door; no path through this module
 * reaches it. What detach removes is the binding's REFERENCE, which is
 * the Bureau's check 2. The consequence for that binding is precise and is the
 * whole reason the verb is separate from `revoke`: with nobody naming a
 * credential, `models.ts` step 3 applies and the binding goes back to the
 * PLATFORM key — it starts working again, on our key, with our guardrails.
 * That is the correct behaviour for "this agent should stop using my key" and
 * the wrong one for "my key should stop being spendable"; `revokeFetchGrant` is
 * the second sentence.
 */
export async function detachCredentialFromBindings(
  db: D1Database,
  accountId: string,
  opts: { actor: string; provider?: string | undefined; bindingId?: string | undefined; now?: number } = {
    actor: "admin",
  },
): Promise<Array<TouchedBinding & { provider: string; credRef: string }>> {
  const now = opts.now ?? Date.now();
  const { results } = await db
    .prepare(`SELECT id, name, config_json FROM agent_bindings WHERE account_id = ? ORDER BY name`)
    .bind(accountId)
    .all<{ id: string; name: string; config_json: string }>();

  const detached: Array<TouchedBinding & { provider: string; credRef: string }> = [];
  for (const binding of results) {
    if (opts.bindingId && binding.id !== opts.bindingId) continue;
    const config = parseConfig(binding.config_json);
    const existing = asRecord(config.providerCredentials);
    if (!existing) continue;
    const providerCredentials: Record<string, unknown> = { ...existing };
    let changed = false;
    for (const [provider, ref] of Object.entries(existing)) {
      if (opts.provider && provider !== opts.provider) continue;
      if (typeof ref !== "string") continue;
      delete providerCredentials[provider];
      detached.push({ id: binding.id, name: binding.name, provider, credRef: ref });
      await logBindingCredential(db, accountId, binding.id, "detached", provider, ref, null, opts.actor, now);
      changed = true;
    }
    if (!changed) continue;
    // An empty map is REMOVED rather than left as `{}`: `bindingNamesCredential`
    // reads an absent key and an empty object identically, and a config a human
    // reads should not carry the ghost of a setting that is gone.
    if (Object.keys(providerCredentials).length === 0) delete config.providerCredentials;
    else config.providerCredentials = providerCredentials;
    await db
      .prepare(`UPDATE agent_bindings SET config_json = ? WHERE account_id = ? AND id = ?`)
      .bind(JSON.stringify(config), accountId, binding.id)
      .run();
  }
  return detached;
}

/**
 * The audit row for an attach or a detach.
 *
 * `binding_lifecycle` rather than a new table: this IS a change to the
 * binding's config, it is exactly the shape the kill switch already writes
 * (`account_id`, `binding_id`, event, old→new, actor), and this repo has no
 * migration framework, so a new table is a hand-run schema event on every
 * deployment (tools/README.md). The event names are namespaced so the chain
 * reads as prose: `provider-credential-attached` / `-detached`.
 *
 * ⚠️ `old_value`/`new_value` carry the credential HANDLE — `"openrouter"` —
 * and never the key or any part of it. The handle is a public name: it is
 * already in `config_json`, in `bureau_grants.cred_name` and on the wire of
 * every Bureau call. There is no branch here that can see a secret; the seal
 * hop is the only thing in this module that ever holds one.
 */
async function logBindingCredential(
  db: D1Database,
  accountId: string,
  bindingId: string,
  event: "attached" | "detached",
  provider: string,
  oldRef: unknown,
  newRef: string | null,
  actor: string,
  at: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO binding_lifecycle
         (account_id, binding_id, event, old_value, new_value, actor, via_proposal_id, at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
    )
    .bind(
      accountId,
      bindingId,
      `provider-credential-${event}`,
      typeof oldRef === "string" ? `${provider}=${oldRef}` : null,
      newRef === null ? null : `${provider}=${newRef}`,
      actor,
      at,
    )
    .run();
}

/** Does this binding's model menu (or an existing attachment) reach this host? */
export function routesToProvider(config: Record<string, unknown>, provider: string): boolean {
  const existing = asRecord(config.providerCredentials);
  if (existing && existing[provider] !== undefined) return true;
  const aliases = asRecord(config.modelAliases);
  if (!aliases) return false;
  for (const menu of Object.values(aliases)) {
    if (!Array.isArray(menu)) continue;
    for (const candidate of menu) {
      const c = asRecord(candidate);
      if (c && c.provider === provider) return true;
    }
  }
  return false;
}

// ── the status projection ─────────────────────────────────────────────────

/**
 * Why this is a first-class read and not a nice-to-have.
 *
 * The single most important property of #203 is that a binding whose named
 * credential does not resolve **refuses rather than spending the platform key**
 * (`models.ts`, THE RESOLUTION ORDER). That is the right behaviour and it has
 * one bad property: from the outside it is indistinguishable from an agent that
 * is merely quiet. The whole feature exists so that a tenant's provider-side
 * guardrails ride their key; a misconfiguration that silently looks fine is
 * precisely the failure this design refuses to have. So the surface needs a
 * status that says *"this agent will refuse, and here is which of the three
 * steps is missing"*, computed from the same rows the Bureau's own door reads.
 *
 * These checks MIRROR `services/bureau/src/byok.ts` in its own order, so a
 * green status here means that door would say yes. It is a prediction, not an
 * authorization: nothing below grants anything, and the Bureau re-checks every
 * one of them on every call.
 */
export type ByokRefStatus =
  | "live"
  | "no-credential"
  | "no-grant"
  | "grant-revoked"
  | "grant-expired"
  | "wrong-kind"
  | "no-destination";

/** One `(binding, provider) → credRef` reference, and whether it will work. */
export interface ByokBindingRef {
  bindingId: string;
  bindingName: string;
  /** The 008 kill switch. A disabled binding refuses BEFORE any of this. */
  enabled: boolean;
  /** The host key in `providerCredentials` — "openrouter", "gateway". */
  provider: string;
  credRef: string;
  status: ByokRefStatus;
}

/**
 * One credential this account's agents reference or could spend.
 *
 * ⚠️ There is no value field and there never will be one (bureau.md invariant
 * 1). `header` and the rest of `meta_json` are deliberately absent too: the
 * injection recipe is the vault's own read surface's business
 * (`GET /vault/credentials`, gated on the `vault` scope), and nothing on a
 * status page needs it. `allow` IS here, because "where may my key be spent"
 * is the security-relevant fact of this entire feature and withholding it from
 * the account's owner would make the surface dishonest.
 */
export interface ByokCredential {
  credRef: string;
  kind: string;
  /** Destination origin (bureau.md §6). null = unbound, which is REFUSED at
   *  use time (invariant 5) — a fail-closed state, not a permissive one. */
  allow: string | null;
  /** The BYOK host this handle serves, when a binding names it for one. */
  provider: string | null;
  /** `created_at` — when this handle was first sealed. */
  sealedAt: number;
  /** `updated_at` — when its ciphertext was last rewritten. Equal to
   *  `sealedAt` until the first rotation. */
  rotatedAt: number;
  grant: {
    grantId: string;
    live: boolean;
    createdAt: number;
    expiresAt: number | null;
    revokedAt: number | null;
  } | null;
}

export interface ByokStatus {
  credentials: ByokCredential[];
  refs: ByokBindingRef[];
  /** Bindings on this account that route to a BYOK-capable host and name NO
   *  credential — i.e. the ones running on the PLATFORM key today, which is
   *  the honest answer to "what happens if I add nothing". */
  platformKeyBindings: Array<TouchedBinding & { provider: string }>;
}

/**
 * The whole BYOK picture for one account, from four tables and no guesses.
 *
 * Scoped two ways at once, and both matter: bindings come from `account_id`,
 * credentials and grants from that account's OWN `principal_id`. There is no
 * argument a caller can make that reaches another tenant's row — the same
 * boundary `byok.ts` check 3 enforces at use time, restated as a read.
 *
 * Credentials are NOT enumerated from the vault. The list is the union of
 * (a) handles this account's bindings actually name and (b) handles carrying a
 * live-or-tombstoned `fetch` grant, which is what makes a sealed-and-granted
 * key that nothing references VISIBLE rather than an invisible live capability.
 * A credential minted for something else entirely — an MCP server's API key —
 * has neither property and never appears here, so this cannot be used as a
 * back door onto `GET /vault/credentials`.
 */
export async function byokStatus(
  db: D1Database,
  accountId: string,
  principalId: string,
  now = Date.now(),
): Promise<ByokStatus> {
  const [bindings, grants] = await Promise.all([
    db
      .prepare(`SELECT id, name, enabled, config_json FROM agent_bindings WHERE account_id = ? ORDER BY name`)
      .bind(accountId)
      .all<{ id: string; name: string; enabled: number; config_json: string }>(),
    db
      .prepare(
        `SELECT id, cred_name, created_at, expires_at, revoked_at FROM bureau_grants
          WHERE principal_id = ? AND verb = '${BYOK_VERB}' ORDER BY cred_name`,
      )
      .bind(principalId)
      .all<{
        id: string;
        cred_name: string;
        created_at: number;
        expires_at: number | null;
        revoked_at: number | null;
      }>(),
  ]);

  const grantByRef = new Map(grants.results.map((g) => [g.cred_name, g]));

  const refs: ByokBindingRef[] = [];
  const platformKeyBindings: Array<TouchedBinding & { provider: string }> = [];
  const wanted = new Set<string>(grants.results.map((g) => g.cred_name));
  const providerOf = new Map<string, string>();

  for (const binding of bindings.results) {
    const config = parseConfig(binding.config_json);
    const named = asRecord(config.providerCredentials) ?? {};
    for (const [provider, ref] of Object.entries(named)) {
      if (typeof ref !== "string") continue;
      wanted.add(ref);
      providerOf.set(ref, provider);
      refs.push({
        bindingId: binding.id,
        bindingName: binding.name,
        enabled: binding.enabled === 1,
        provider,
        credRef: ref,
        status: "no-credential", // resolved below, once the rows are read
      });
    }
    // "Which agents are on the platform key" is the empty state's honest
    // content, so it is computed rather than implied by an absence.
    for (const provider of Object.keys(BYOK_PROVIDERS)) {
      if (named[provider] === undefined && routesToProvider(config, provider)) {
        platformKeyBindings.push({ id: binding.id, name: binding.name, provider });
      }
    }
  }

  const credentials: ByokCredential[] = [];
  const statusByRef = new Map<string, ByokRefStatus>();
  for (const credRef of [...wanted].sort()) {
    const row = await db
      .prepare(
        `SELECT kind, meta_json, created_at, updated_at FROM vault_credentials
          WHERE principal_id = ? AND name = ?`,
      )
      .bind(principalId, credRef)
      .first<{ kind: string; meta_json: string; created_at: number; updated_at: number }>();
    const grant = grantByRef.get(credRef);
    const grantLive = !!grant && grant.revoked_at === null && (grant.expires_at === null || grant.expires_at > now);

    if (!row) {
      statusByRef.set(credRef, "no-credential");
      // No vault row means nothing to describe: a handle a binding names and
      // the vault does not have is a REF with a status, not a credential.
      continue;
    }
    const meta = parseConfig(row.meta_json);
    const allow = typeof meta.allow === "string" && meta.allow ? meta.allow : null;
    statusByRef.set(
      credRef,
      !grant
        ? "no-grant"
        : grant.revoked_at !== null
          ? "grant-revoked"
          : !grantLive
            ? "grant-expired"
            : !FETCH_KINDS.has(row.kind)
              ? "wrong-kind"
              : allow === null
                ? "no-destination"
                : "live",
    );
    credentials.push({
      credRef,
      kind: row.kind,
      allow,
      provider: providerOf.get(credRef) ?? null,
      sealedAt: row.created_at,
      rotatedAt: row.updated_at,
      grant: grant
        ? {
            grantId: grant.id,
            live: grantLive,
            createdAt: grant.created_at,
            expiresAt: grant.expires_at,
            revokedAt: grant.revoked_at,
          }
        : null,
    });
  }

  for (const ref of refs) ref.status = statusByRef.get(ref.credRef) ?? "no-credential";
  return { credentials, refs, platformKeyBindings };
}
