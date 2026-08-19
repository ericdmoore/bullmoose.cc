import type { Invocation } from "../jmap/types";
import type { JmapClient } from "../jmap/JmapClient";
import { describeRefusal } from "../mail/triage";
import { parseNote, type Note } from "./types";

/**
 * The `/notes` realm's fetch and verbs (s18 N1).
 *
 * ONE ACCOUNT, deliberately — and this is the first place the Note/Annotation
 * split changes the code rather than the prose. `lib/annotations/api.ts` fans
 * out across every reachable account, because a claim about your mail can be
 * made in an agent's account you supervise. A NOTE cannot: it is a document
 * you authored in your own account, and there is no path by which someone
 * else's account holds one of yours (s18 N3, the sharing half, is not built).
 * Fanning out would therefore query accounts that can never have an answer.
 *
 * The write scope is `draft` — the repo's existing capability for authoring
 * mutable content you have not disclosed to anyone. See the header of
 * `services/jmap/src/methods/note.ts` for why that and not a `notes` realm
 * scope; the refusal text below names it, so a session that lacks it is told
 * which permission is missing rather than shown a dead button.
 */

const WRITE_SCOPES = ["draft"];

export interface NotesResult {
  notes: Note[];
  /** A sentence a person can act on, or null. The realm renders it as an
   *  error banner — unlike a home glance, a Notes page that silently shows
   *  nothing is indistinguishable from a person who has written nothing. */
  failure: string | null;
}

/**
 * Load this account's notes: `Note/query` → `Note/get` back-referencing it, in
 * ONE POST (the `loadThread` discipline). `text` runs the server's own LIKE
 * scan; omit it and the query is the whole collection, newest edit first.
 */
export async function loadNotes(client: JmapClient, accountId: string, text?: string): Promise<NotesResult> {
  const filter = text && text.trim() !== "" ? { text: text.trim() } : undefined;
  const calls: Invocation[] = [
    ["Note/query", { accountId, ...(filter ? { filter } : {}) }, "q0"],
    ["Note/get", { accountId, "#ids": { resultOf: "q0", name: "Note/query", path: "/ids" } }, "g0"],
  ];
  const responses = await client.request(calls);
  const get = responses.find((r) => r[2] === "g0");
  const query = responses.find((r) => r[2] === "q0");

  if (!get || get[0] === "error") {
    const failed = query && query[0] === "error" ? query : get;
    const detail = (failed?.[1] ?? {}) as { type?: string; description?: string };
    // `unknownMethod` is its own answer: the server is older than this realm.
    if (detail.type === "unknownMethod") {
      return { notes: [], failure: "This server does not implement Note methods yet." };
    }
    return {
      notes: [],
      failure: describeRefusal(detail, ["read"]).message,
    };
  }

  const args = get[1] as Record<string, unknown>;
  const list = Array.isArray(args.list) ? (args.list as Record<string, unknown>[]) : [];
  const notes: Note[] = [];
  for (const raw of list) {
    const n = parseNote(raw, accountId);
    if (n) notes.push(n);
  }
  return { notes, failure: null };
}

export type WriteResult =
  | { ok: true; id: string }
  | {
      ok: false;
      message: string;
      /** True when the session lacks `draft` — the caller greys the verbs
       *  rather than inviting the same refusal again. */
      forbidden: boolean;
    };

/** Create a note. The server stamps the id, the owner and revision 1 — the
 *  three fields a federated note would be identified by (s18 N3 seam), and
 *  none of them is a client's to choose. */
export async function createNote(
  client: JmapClient,
  accountId: string,
  draft: { title: string; body: string },
): Promise<WriteResult> {
  const [response] = await client.request([["Note/set", { accountId, create: { n0: draft } }, "s0"]]);
  return oneWrite(response, (result) => {
    const made = (result.created as Record<string, { id?: string }> | undefined)?.n0;
    if (made?.id) return { ok: true, id: made.id };
    return refusalFrom((result.notCreated as Record<string, SetErr> | undefined)?.n0);
  });
}

/** Save an edit. `revision` is bumped server-side; the client never sends one,
 *  so two tabs cannot argue about a number neither of them owns. */
export async function updateNote(
  client: JmapClient,
  accountId: string,
  id: string,
  patch: { title?: string; body?: string },
): Promise<WriteResult> {
  const [response] = await client.request([["Note/set", { accountId, update: { [id]: patch } }, "s0"]]);
  return oneWrite(response, (result) => {
    if ((result.updated as Record<string, unknown> | undefined) && id in (result.updated as object)) {
      return { ok: true, id };
    }
    return refusalFrom((result.notUpdated as Record<string, SetErr> | undefined)?.[id]);
  });
}

/** Delete a note. There is no tombstone and no undo: nothing off-instance can
 *  hold a reference to it, because nothing federates (s18 N3). */
export async function destroyNote(client: JmapClient, accountId: string, id: string): Promise<WriteResult> {
  const [response] = await client.request([["Note/set", { accountId, destroy: [id] }, "s0"]]);
  return oneWrite(response, (result) => {
    const gone = Array.isArray(result.destroyed) ? (result.destroyed as string[]) : [];
    if (gone.includes(id)) return { ok: true, id };
    return refusalFrom((result.notDestroyed as Record<string, SetErr> | undefined)?.[id]);
  });
}

interface SetErr {
  type?: string;
  description?: string;
}

/** The shared shell of every one-object `Note/set`: method error → a sentence
 *  naming the missing scope; otherwise hand the result to the caller. */
function oneWrite(
  response: readonly [string, unknown, string] | undefined,
  read: (result: Record<string, unknown>) => WriteResult,
): WriteResult {
  if (!response) return { ok: false, message: "no response from the server", forbidden: false };
  if (response[0] === "error") {
    const detail = response[1] as SetErr;
    const refusal = describeRefusal(detail, WRITE_SCOPES);
    return { ok: false, message: refusal.message, forbidden: refusal.type === "forbidden" };
  }
  return read(response[1] as Record<string, unknown>);
}

/** A per-object SetError, rendered verbatim. The server's refusals are written
 *  to be read by a person — notably the one that names the OTHER entity ("an
 *  anchored, classed claim is an Annotation") — so re-wording them here would
 *  throw away the only place that distinction is explained at the point of
 *  the mistake. */
function refusalFrom(err: SetErr | undefined): WriteResult {
  return {
    ok: false,
    message: err?.description ?? `The server refused: ${err?.type ?? "unknown"}.`,
    forbidden: false,
  };
}
