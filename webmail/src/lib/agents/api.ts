// s26 T2 — every JMAP call the agent surfaces make, in one module (the
// lib/approvals/api.ts split, applied again): the injected `JmapClient` is
// composed, never a second client. `capabilityForMethod` already routes
// `AgentBinding/*` under `urn:bullmoose:params:jmap:agent`, so `using[]` is
// right without this module knowing about capabilities at all.
//
// ONE door, TWO consumers: the dossier's kill-switch control (AgentsApp) and
// the Settings → Agents roster toggle both call `setBindingEnabled` — same
// method, same scope wall (`send` — the server documents the why), same audit
// row. The UI flips optimistically and reconciles against the /set response:
// `updated[id].enabled` is the server's word, and there is no /changes for
// AgentBinding (it is not a synced collection), so the response IS the
// reconcile.

import type { JmapClient } from "../jmap/JmapClient";
import type { AgentDossier } from "../console/types";

export type ToggleOutcome = { ok: true; enabled: boolean } | { ok: false; message: string };

/**
 * Flip the 008 kill switch on one binding. Mirrors `approvals/api.ts decide`:
 * a method-level refusal (the scope wall, accountNotFound) throws inside the
 * client and comes back as `{ ok: false }` with the server's sentence — the
 * capability-wall refusal is worth showing verbatim, not paraphrasing softer.
 */
export async function setBindingEnabled(
  client: JmapClient,
  accountId: string,
  bindingId: string,
  enabled: boolean,
): Promise<ToggleOutcome> {
  let result: Record<string, unknown>;
  try {
    result = await client.requestOne("AgentBinding/set", {
      accountId,
      update: { [bindingId]: { enabled } },
    });
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }

  const updated = result.updated as Record<string, { enabled?: unknown }> | undefined;
  const confirmed = updated?.[bindingId];
  if (confirmed) {
    // The server-set property is the reconcile: trust IT, not the ask.
    return { ok: true, enabled: confirmed.enabled === true };
  }
  const notUpdated = (result.notUpdated as Record<string, { type?: string; description?: string }>)?.[bindingId];
  return {
    ok: false,
    message: notUpdated?.description ?? notUpdated?.type ?? "the server did not accept the change",
  };
}

/**
 * The optimistic half, pure: the dossier record with ONE binding's `enabled`
 * replaced. Untouched inputs are returned by reference (no clone of dossiers
 * that did not change), and an accountId/bindingId that is not in the map is
 * a no-op — reverting after a refused call composes as a second application
 * with the prior value.
 */
export function applyBindingEnabled(
  dossiers: Readonly<Record<string, AgentDossier>>,
  accountId: string,
  bindingId: string,
  enabled: boolean,
): Record<string, AgentDossier> {
  const dossier = dossiers[accountId];
  if (!dossier || !dossier.bindings.some((b) => b.bindingId === bindingId)) return { ...dossiers };
  return {
    ...dossiers,
    [accountId]: {
      ...dossier,
      bindings: dossier.bindings.map((b) => (b.bindingId === bindingId ? { ...b, enabled } : b)),
    },
  };
}
