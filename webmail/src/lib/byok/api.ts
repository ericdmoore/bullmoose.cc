// s26 T4 — every JMAP call the BYOK surfaces make, in one module (the
// `lib/agents/api.ts` split, applied again): the injected `JmapClient` is
// composed, never a second client, and `capabilityForMethod` routes
// `ProviderCredential/*` under the agent capability so `using[]` is right
// without this module knowing capabilities exist.
//
// ⚠️ THE KEY PASSES THROUGH AND IS NOT KEPT. `sealKey` takes the plaintext as
// its own parameter, puts it in exactly one request body, and returns an
// outcome that cannot carry it — `SealOutcome` has no field it could ride in,
// and the server's response has none either. Nothing here stores it in a
// module-level variable, a closure, a retry buffer or a logged error. The
// callers hold it in component state only until the request resolves and clear
// it on success. A rejected request throws inside `JmapClient` and comes back
// as a message the server wrote, never as a message this module composed from
// the arguments.
//
// ONE door, TWO consumers, same as the kill switch: Settings → Agents owns the
// key (add / rotate / revoke — it outlives every agent) and the dossier owns
// the binding's use of it (detach). Both call the methods below.

import type { JmapClient } from "../jmap/JmapClient";
import type { ByokStatus } from "./status";

export type ByokOutcome<T> = { ok: true; value: T } | { ok: false; message: string };

/** The status read — `read` scope, owner-only, and it never carries a key. */
export async function readByokStatus(client: JmapClient, accountId: string): Promise<ByokOutcome<ByokStatus>> {
  return call(client, "ProviderCredential/get", { accountId }, (r) => r as unknown as ByokStatus);
}

export interface SealResult {
  credRef: string;
  provider: string;
  allow: string;
  created: boolean;
  rotated: boolean;
  bindings: Array<{ id: string; name: string }>;
  note?: string;
}

/**
 * Seal (or rotate) the tenant's provider key.
 *
 * `key` is a positional argument rather than a field of an options object,
 * deliberately: an options object is the thing a future refactor spreads into a
 * log line or an error payload. Kept separate, there is no spread that can
 * carry it anywhere.
 *
 * Rotation is the same call — the server decides `created` vs `rotated` from
 * whether the handle already exists — which is what makes rotating something a
 * person will actually do rather than a second flow to find.
 */
export async function sealKey(
  client: JmapClient,
  accountId: string,
  opts: { provider: string; bindingId?: string; expiresDays?: number },
  key: string,
): Promise<ByokOutcome<SealResult>> {
  return call(
    client,
    "ProviderCredential/set",
    {
      accountId,
      seal: {
        provider: opts.provider,
        ...(opts.bindingId ? { bindingId: opts.bindingId } : {}),
        ...(opts.expiresDays ? { expiresDays: opts.expiresDays } : {}),
        key,
      },
    },
    (r) => r as unknown as SealResult,
  );
}

export interface MutationResult {
  detached: Array<{ id: string; name: string; provider: string; credRef: string }>;
  /** Always false. On the wire so the client cannot drift from the server's
   *  meaning of these verbs — see the method's own header. */
  credentialDeleted: boolean;
  grantRevoked: boolean;
  /** The recomputed status, so the caller reconciles from the server's word
   *  (ProviderCredential is not a synced collection — there is no /changes). */
  refs: ByokStatus["refs"];
  credentials: ByokStatus["credentials"];
  platformKeyBindings: ByokStatus["platformKeyBindings"];
}

/** Stop ONE agent using the key. The credential and the permission survive;
 *  that agent goes back to the platform's key. */
export async function detachFromBinding(
  client: JmapClient,
  accountId: string,
  bindingId: string,
  provider?: string,
): Promise<ByokOutcome<MutationResult>> {
  return call(
    client,
    "ProviderCredential/set",
    { accountId, detach: { bindingId, ...(provider ? { provider } : {}) } },
    (r) => r as unknown as MutationResult,
  );
}

/** Stop the key being spendable at all: the permission is tombstoned and every
 *  agent is detached. The sealed value is NOT deleted (destroying it is a
 *  separate, irreversible act on the vault's own door), and the surface says so
 *  rather than letting "revoke" be read as "erase". */
export async function revokeKey(
  client: JmapClient,
  accountId: string,
  credRef: string,
): Promise<ByokOutcome<MutationResult>> {
  return call(
    client,
    "ProviderCredential/set",
    { accountId, revoke: { credRef } },
    (r) => r as unknown as MutationResult,
  );
}

/**
 * One shape for every call: a method-level refusal (the scope wall, the agent
 * refusal, accountNotFound) throws inside the client and comes back as
 * `{ ok: false }` carrying **the server's own sentence, verbatim**. Those
 * refusals are the most educational text on the page — *"this session does not
 * carry the vault scope"* teaches where the boundary is, and a softened
 * paraphrase would teach nothing.
 */
async function call<T>(
  client: JmapClient,
  method: string,
  args: Record<string, unknown>,
  shape: (raw: Record<string, unknown>) => T,
): Promise<ByokOutcome<T>> {
  try {
    return { ok: true, value: shape(await client.requestOne(method, args)) };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
