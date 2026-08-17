// Keyboard-first triage — archive / flag / move / delete via `Email/set`.
//
// Every action is a PatchObject, and every batch is one `Email/set` call, so
// triaging a selection of thirty messages is one round trip.
//
// Per-operation scopes exist server-side (`requiredScopesForEmailSet` in
// `services/jmap/src/methods/email.ts`): a token scoped to `annotate` may flip
// keywords but not move mail, and one scoped to `draft` may not delete the
// inbox. When such a token drives the UI, `Email/set` comes back as a
// method-level `forbidden` error. `describeRefusal` turns that into a sentence
// naming the missing verb instead of a generic failure toast.

import type { JmapClient } from "../jmap/JmapClient";
import { KEYWORD, type Email } from "./types";

/** An RFC 8620 PatchObject for `Email/set update`. */
export type EmailPatch = Record<string, boolean | null | Record<string, boolean>>;

export function seenPatch(seen: boolean): EmailPatch {
  return { [`keywords/${KEYWORD.seen}`]: seen ? true : null };
}

export function flaggedPatch(flagged: boolean): EmailPatch {
  return { [`keywords/${KEYWORD.flagged}`]: flagged ? true : null };
}

export function answeredPatch(): EmailPatch {
  return { [`keywords/${KEYWORD.answered}`]: true };
}

/**
 * Move: add the destination, remove every mailbox the message is currently in.
 *
 * Server-enforced invariant worth knowing before composing a patch by hand —
 * `applyEmailPatch` refuses a message that would end up in NO mailbox
 * ("an email must belong to at least one mailbox"), so the add and the removes
 * have to travel in the same patch. They do here.
 */
export function movePatch(email: Pick<Email, "mailboxIds">, toMailboxId: string): EmailPatch {
  const patch: EmailPatch = { [`mailboxIds/${toMailboxId}`]: true };
  for (const [id, present] of Object.entries(email.mailboxIds ?? {})) {
    if (present && id !== toMailboxId) patch[`mailboxIds/${id}`] = null;
  }
  return patch;
}

/** Archive = move out of the Inbox, keeping any other filing. */
export function archivePatch(email: Pick<Email, "mailboxIds">, inboxId: string, archiveId: string): EmailPatch {
  // If Archive and Inbox are the same mailbox there is nothing to do; emitting
  // `{id: true, id: null}` would leave the message homeless.
  if (inboxId === archiveId) return {};
  return { [`mailboxIds/${archiveId}`]: true, [`mailboxIds/${inboxId}`]: null };
}

/** Trash is a MOVE, not a destroy — `Email/set destroy` is unrecoverable. */
export function trashPatch(email: Pick<Email, "mailboxIds">, trashId: string): EmailPatch {
  return movePatch(email, trashId);
}

// ── scopes ────────────────────────────────────────────────────────────────

/**
 * Mirror of the server's `requiredScopesForEmailSet` for the UPDATE half —
 * enough to grey out an action a token cannot perform, instead of offering it
 * and collecting a refusal.
 *
 * ⚠️ A MIRROR, not the source of truth. The server decides; this only predicts.
 * `services/jmap/src/methods/email.ts` is authoritative, and it is Worker source
 * that cannot be imported into a browser bundle (see `../jmap/types.ts` for the
 * same trade-off). If the server's mapping changes, change this too — the
 * failure mode is a UI that offers an action the server then refuses, which is
 * ugly but not unsafe.
 */
export function scopesForPatch(patch: EmailPatch): string[] {
  const keys = Object.keys(patch);
  const need = new Set<string>();
  const isMailboxKey = (k: string): boolean => k === "mailboxIds" || k.startsWith("mailboxIds/");
  if (keys.some(isMailboxKey)) need.add("move");
  if (keys.length === 0 || keys.some((k) => !isMailboxKey(k))) need.add("annotate");
  return [...need];
}

export function scopesForPatches(patches: Record<string, EmailPatch>): string[] {
  const need = new Set<string>();
  for (const patch of Object.values(patches)) for (const s of scopesForPatch(patch)) need.add(s);
  return [...need];
}

// ── applying ──────────────────────────────────────────────────────────────

export interface TriageRefusal {
  type: string;
  description?: string;
  /** The verbs this call needed, per the client-side mirror. */
  requiredScopes: string[];
  message: string;
}

export interface TriageResult {
  /** Email ids the server confirmed. */
  updated: string[];
  /** Per-id failures — `Email/set` reports these individually in `notUpdated`. */
  notUpdated: Array<{ id: string; type: string; description?: string }>;
  /** Set when the WHOLE call was refused (scope, state mismatch). */
  refusal?: TriageRefusal;
  newState?: string;
}

/**
 * Apply patches to many emails in ONE `Email/set`.
 *
 * Two failure shapes, kept distinct because they mean different things:
 * a method-level error refused the whole call (usually scope), while
 * `notUpdated` means the call ran and some ids did not apply (already moved,
 * deleted underneath). Collapsing them into one "failed" would hide a
 * permissions problem behind what looks like a race.
 */
export async function applyTriage(
  client: JmapClient,
  accountId: string,
  patches: Record<string, EmailPatch>,
  opts: { ifInState?: string } = {},
): Promise<TriageResult> {
  const ids = Object.keys(patches);
  if (ids.length === 0) return { updated: [], notUpdated: [] };

  const args: Record<string, unknown> = { accountId, update: patches };
  if (opts.ifInState) args.ifInState = opts.ifInState;

  const [response] = await client.request([["Email/set", args, "t0"]]);
  if (!response) return { updated: [], notUpdated: [] };

  if (response[0] === "error") {
    const detail = response[1] as { type?: string; description?: string };
    return {
      updated: [],
      notUpdated: [],
      refusal: describeRefusal(detail, scopesForPatches(patches)),
    };
  }

  const result = response[1] as {
    updated?: Record<string, unknown>;
    notUpdated?: Record<string, { type?: string; description?: string }>;
    newState?: string;
  };
  return {
    updated: Object.keys(result.updated ?? {}),
    notUpdated: Object.entries(result.notUpdated ?? {}).map(([id, err]) => ({
      id,
      type: err?.type ?? "unknown",
      ...(err?.description ? { description: err.description } : {}),
    })),
    ...(result.newState ? { newState: result.newState } : {}),
  };
}

/**
 * Permanently destroy. Separate from `applyTriage` because it needs the
 * `delete` scope and because it is not undoable — `Email/set destroy` removes
 * the row, it does not move it to Trash. `trashPatch` is what a delete KEY
 * should call.
 */
export async function destroyEmails(client: JmapClient, accountId: string, ids: string[]): Promise<TriageResult> {
  if (ids.length === 0) return { updated: [], notUpdated: [] };
  const [response] = await client.request([["Email/set", { accountId, destroy: ids }, "d0"]]);
  if (!response) return { updated: [], notUpdated: [] };
  if (response[0] === "error") {
    return {
      updated: [],
      notUpdated: [],
      refusal: describeRefusal(response[1] as { type?: string }, ["delete"]),
    };
  }
  const result = response[1] as {
    destroyed?: string[];
    notDestroyed?: Record<string, { type?: string; description?: string }>;
    newState?: string;
  };
  return {
    updated: result.destroyed ?? [],
    notUpdated: Object.entries(result.notDestroyed ?? {}).map(([id, err]) => ({
      id,
      type: err?.type ?? "unknown",
      ...(err?.description ? { description: err.description } : {}),
    })),
    ...(result.newState ? { newState: result.newState } : {}),
  };
}

/** Turn a method-level error into something a person can act on. */
export function describeRefusal(
  detail: { type?: string; description?: string },
  requiredScopes: string[],
): TriageRefusal {
  const type = detail.type ?? "error";
  const verbs = requiredScopes.join(" + ");
  const message =
    type === "forbidden"
      ? `This session is not allowed to do that. The action needs the “${verbs}” ${
          requiredScopes.length > 1 ? "permissions" : "permission"
        }; the token in use does not have ${requiredScopes.length > 1 ? "them" : "it"}.`
      : type === "stateMismatch"
        ? "The mailbox changed while you were working. Refresh and try again."
        : detail.description || `The server refused: ${type}.`;
  return {
    type,
    ...(detail.description ? { description: detail.description } : {}),
    requiredScopes,
    message,
  };
}
