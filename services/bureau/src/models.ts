/**
 * The Bureau's environment — deliberately tiny.
 *
 * Compare `services/agent/src/models.ts`: that worker has R2, KV, a Durable
 * Object namespace, Workers AI, a submit binding and an AI gateway. This one has
 * a database and a key. Every binding absent here is a capability the Bureau
 * cannot be tricked into exercising, and the short list is itself part of the
 * design (bureau.md §2 — the rejected `exec(code)` shape failed because it had
 * no closed set of things it could do).
 */
export interface Env {
  /** Control plane: vault_credentials, bureau_grants, and `verifyBearer`'s
   *  tokens⋈principals⋈grants resolution. */
  DB: D1Database;
  /**
   * The credential-vault master secret. Bound to THIS worker and no other —
   * that is the whole point of the service existing (arch.md OQ1). Not optional:
   * a Bureau without the key is not a degraded Bureau, it is a misconfiguration,
   * and it should fail at the first call rather than silently 501 forever.
   */
  VAULT_MASTER_KEY: string;
  /** Shared with `services/agent`; gates the /internal/* seal + health paths. */
  INTERNAL_TOKEN: string;
}
