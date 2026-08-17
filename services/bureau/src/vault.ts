import { openSecret, sealSecret, vaultAad, type SealedSecret } from "@bullmoose/auth-core";
import type { Env } from "./models.js";

/**
 * The half of the credential vault that touches VAULT_MASTER_KEY.
 *
 * This file is the other side of the T3a split. `services/agent/src/vault.ts`
 * kept the metadata/reference layer — names, kinds, `meta_json`, the mint-time
 * contract validation, the `creds` HTTP surface. Everything that needs the
 * master key came HERE: `sealSecret`, `openSecret`, `vaultAad`, and — the part
 * that is easy to miss — **seal-on-mint**, because leaving the mint path in the
 * agent worker would have left the key there too.
 *
 * The consequence is a property you can grep for: `enc_json` is written and read
 * ONLY in this file, in this worker. The agent worker can list credentials,
 * rename nothing, and unseal nothing.
 *
 * Internal surface (x-internal-token, over the BUREAU service binding):
 *   POST /internal/bureau/seal    {mode:'mint', principalId, name, kind, meta, secret}
 *                                 {mode:'rotate', principalId, name, secret}
 *   POST /internal/bureau/verify  {principalEmail, name} → {ok}
 *
 * The agent hands over a plaintext secret exactly once, at mint/rotate, on the
 * way IN. Nothing ever travels back out: the seal path returns an
 * acknowledgement, the verify path returns a boolean, and the use path
 * (grants.ts) returns a result. That is bureau.md §1's contract — a NAME goes
 * in, a RESULT comes back — and invariant 1 holds because no route here can
 * return a value even if a caller asked for one.
 */

/** Mint: seal the secret and write the whole row. The credential's contract
 *  (kind, meta_json) was validated by the agent's metadata layer and is passed
 *  through verbatim — this worker owns the ciphertext, not the policy. */
export async function sealAndStore(
  env: Env,
  principalId: string,
  name: string,
  kind: string,
  metaJson: string,
  secret: string,
): Promise<void> {
  const sealed = await sealSecret(env.VAULT_MASTER_KEY, secret, vaultAad(principalId, name));
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO vault_credentials (id, principal_id, name, kind, enc_json, meta_json,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (principal_id, name) DO UPDATE SET
       kind = excluded.kind, enc_json = excluded.enc_json,
       meta_json = excluded.meta_json, updated_at = excluded.updated_at`,
  )
    .bind(`vc_${crypto.randomUUID()}`, principalId, name, kind, JSON.stringify(sealed), metaJson, now, now)
    .run();
}

/**
 * Rotate: re-seal a NEW secret under the SAME name, so the AAD, kind, allowlist
 * and every other mint-time field are unchanged and nothing downstream
 * re-attaches (bureau.md §5). Only `enc_json` + `updated_at` move — deliberately
 * NOT `meta_json`, which is the agent's to own.
 */
export async function reseal(env: Env, principalId: string, name: string, secret: string): Promise<boolean> {
  const existing = await env.DB.prepare(`SELECT id FROM vault_credentials WHERE principal_id = ? AND name = ?`)
    .bind(principalId, name)
    .first<{ id: string }>();
  if (!existing) return false;
  const sealed = await sealSecret(env.VAULT_MASTER_KEY, secret, vaultAad(principalId, name));
  await env.DB.prepare(
    `UPDATE vault_credentials SET enc_json = ?, updated_at = ?
     WHERE principal_id = ? AND name = ?`,
  )
    .bind(JSON.stringify(sealed), Date.now(), principalId, name)
    .run();
  return true;
}

/**
 * Decrypt-and-discard health check: proves a row is present AND openable under
 * the current master key, returning just a boolean. The plaintext never leaves
 * this function — it is not returned, not logged, not put in an error message.
 */
export async function verifyOpenable(
  env: Env,
  principalEmail: string,
  name: string,
): Promise<{ ok: boolean; reason?: string }> {
  const row = await env.DB.prepare(
    `SELECT v.enc_json, v.principal_id FROM vault_credentials v
     JOIN principals p ON p.id = v.principal_id
     WHERE p.login_email = ? AND v.name = ?`,
  )
    .bind(principalEmail.toLowerCase(), name)
    .first<{ enc_json: string; principal_id: string }>();
  if (!row) return { ok: false, reason: "not found" };
  try {
    await openSecret(env.VAULT_MASTER_KEY, JSON.parse(row.enc_json) as SealedSecret, vaultAad(row.principal_id, name));
    return { ok: true };
  } catch {
    return { ok: false, reason: "cannot decrypt" };
  }
}

/**
 * Unseal for the Bureau's own verb runtime. The ONE function in the codebase
 * that yields a credential value, and it is not reachable over any route: T3's
 * `fetch` and T5's Class B verbs will call it in-process, inject the value into
 * an outbound request, and return only the result.
 *
 * Deliberately not exported from `index.ts` and never wired to a handler. If a
 * future route returns what this returns, invariant 1 is broken.
 */
export async function openCredential(
  env: Env,
  principalId: string,
  name: string,
): Promise<{ kind: string; secret: string; meta: Record<string, unknown> } | null> {
  const row = await env.DB.prepare(
    `SELECT kind, enc_json, meta_json FROM vault_credentials
     WHERE principal_id = ? AND name = ?`,
  )
    .bind(principalId, name)
    .first<{ kind: string; enc_json: string; meta_json: string }>();
  if (!row) return null;
  const secret = await openSecret(
    env.VAULT_MASTER_KEY,
    JSON.parse(row.enc_json) as SealedSecret,
    vaultAad(principalId, name),
  );
  return { kind: row.kind, secret, meta: JSON.parse(row.meta_json) as Record<string, unknown> };
}

/** Metadata-only lookup: kind + the §5 contract, no ciphertext. What the verb
 *  runtime gates on BEFORE it unseals anything (kind→verb typing, §4.1). */
export async function credentialContract(
  env: Env,
  principalId: string,
  name: string,
): Promise<{ kind: string; meta: Record<string, unknown> } | null> {
  const row = await env.DB.prepare(`SELECT kind, meta_json FROM vault_credentials WHERE principal_id = ? AND name = ?`)
    .bind(principalId, name)
    .first<{ kind: string; meta_json: string }>();
  if (!row) return null;
  return { kind: row.kind, meta: JSON.parse(row.meta_json) as Record<string, unknown> };
}
