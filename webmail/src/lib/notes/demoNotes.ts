// The demo backend for `/notes?demo=1` (s18 N1) — `Note/query|get|set` over an
// in-memory array, attached through `FakeJmapClient.setHandler` so parallel
// section work never edits one shared fake (the `demoActivity.ts` pattern).
//
// It mirrors the SERVER's semantics, refusals included, because the refusals
// are where the Note/Annotation distinction is taught at the point of the
// mistake: an `anchor`, `class`, `confidence` or `status` on a note create is
// refused here exactly as `services/jmap/src/methods/note.ts` refuses it. A
// demo that quietly accepted them would let a UI ship against a shape the real
// server does not have.
//
// Loaded on demand by the island, so the fixtures never reach a live bundle.

import type { FakeJmapClient, MethodHandler } from "../jmap/FakeJmapClient";

const ACCOUNT = "acct-fake";
const OWNER = "fake@bullmoose.test";
const ANNOTATION_ONLY = ["anchor", "class", "confidence", "status", "rationale"];

export interface DemoNoteRow extends Record<string, unknown> {
  id: string;
  owner: string;
  title: string;
  body: string;
  revision: number;
  lastWriter: string | null;
  lastWriterBinding: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface NotesDemoBackend {
  /** Mutated by `Note/set` — assert against this instead of a database. */
  notes: DemoNoteRow[];
}

export interface NotesDemoOptions {
  now?: number;
}

/** Three notes a person would plausibly have written — none of them a claim
 *  about a message, which is the point: an agent's observations about your
 *  mail are annotations and render in the margin, not here. */
export function demoNotes(now: number): DemoNoteRow[] {
  const day = 24 * 3600_000;
  const row = (over: Partial<DemoNoteRow> & { id: string; title: string; body: string }): DemoNoteRow => ({
    owner: OWNER,
    revision: 1,
    lastWriter: OWNER,
    lastWriterBinding: null,
    createdAt: now - 7 * day,
    updatedAt: now - 7 * day,
    ...over,
  });
  return [
    row({
      id: "nt-boards",
      title: "Board order — open questions",
      body: "Sergio quoted $750 for the walnut. Still need:\n\n- the load calc for the long span\n- whether the finish is included\n- a delivery date that survives the holiday week",
      revision: 4,
      updatedAt: now - 2 * 3600_000,
    }),
    row({
      id: "nt-shop",
      title: "Shop layout",
      body: "Bench against the north wall so the planer gets the window. Dust collection needs a 6in run before it branches.",
      revision: 2,
      updatedAt: now - 2 * day,
    }),
    row({
      id: "nt-untitled",
      title: "",
      body: "Ask about the hinge pattern before ordering.\nBrass, 3in, five per door.",
      updatedAt: now - 5 * day,
    }),
  ];
}

export function installNotesDemo(client: FakeJmapClient, opts: NotesDemoOptions = {}): NotesDemoBackend {
  const now = opts.now ?? Date.now();
  const notes = demoNotes(now);

  const byRecent = (a: DemoNoteRow, b: DemoNoteRow) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id);

  const query: MethodHandler = (args) => {
    const filter = (args.filter as { text?: string } | null | undefined) ?? null;
    const text = typeof filter?.text === "string" ? filter.text.trim().toLowerCase() : "";
    const rows = notes
      .filter((n) => !text || n.title.toLowerCase().includes(text) || n.body.toLowerCase().includes(text))
      .sort(byRecent);
    return { accountId: ACCOUNT, queryState: "0", ids: rows.slice(0, 256).map((n) => n.id) };
  };

  const get: MethodHandler = (args) => {
    const ids = args.ids as string[] | null | undefined;
    const rows = ids == null ? [...notes].sort(byRecent).slice(0, 256) : notes.filter((n) => ids.includes(n.id));
    return {
      accountId: ACCOUNT,
      state: "0",
      list: rows,
      notFound: (ids ?? []).filter((id) => !notes.some((n) => n.id === id)),
    };
  };

  const set: MethodHandler = (args) => {
    const created: Record<string, Record<string, unknown>> = {};
    const notCreated: Record<string, { type: string; description: string }> = {};
    const updated: Record<string, null> = {};
    const notUpdated: Record<string, { type: string; description: string }> = {};
    const destroyed: string[] = [];
    const notDestroyed: Record<string, { type: string; description: string }> = {};
    const at = Date.now();

    for (const [cid, spec] of Object.entries((args.create as Record<string, Record<string, unknown>>) ?? {})) {
      const wrong = ANNOTATION_ONLY.filter((k) => spec[k] !== undefined);
      if (wrong.length > 0) {
        notCreated[cid] = {
          type: "invalidProperties",
          description:
            `a Note has no ${wrong.join("/")} — it is a document you author, not a claim about a message. ` +
            "An anchored, classed claim is an Annotation: use Annotation/set.",
        };
        continue;
      }
      const title = typeof spec.title === "string" ? spec.title : "";
      const body = typeof spec.body === "string" ? spec.body : "";
      if (title === "" && body === "") {
        notCreated[cid] = { type: "invalidProperties", description: "a note needs a title or a body" };
        continue;
      }
      const id = `nt-demo-${notes.length + 1}`;
      notes.push({
        id,
        owner: OWNER,
        title,
        body,
        revision: 1,
        lastWriter: OWNER,
        lastWriterBinding: null,
        createdAt: at,
        updatedAt: at,
      });
      created[cid] = { id, owner: OWNER, revision: 1, createdAt: at, updatedAt: at };
    }

    for (const [id, patch] of Object.entries((args.update as Record<string, Record<string, unknown>>) ?? {})) {
      const row = notes.find((n) => n.id === id);
      if (!row) {
        notUpdated[id] = { type: "notFound", description: "no note with that id" };
        continue;
      }
      const wrong = Object.keys(patch).filter((k) => k !== "title" && k !== "body");
      if (wrong.length > 0) {
        notUpdated[id] = {
          type: "invalidProperties",
          description: ANNOTATION_ONLY.some((k) => wrong.includes(k))
            ? `a Note has no ${wrong.join("/")} — that is an Annotation's shape (Annotation/set), and an Annotation's claim is corrected by moving its status, never by editing a note.`
            : `only title and body may be written; refused ${wrong.join(", ")}`,
        };
        continue;
      }
      if (typeof patch.title === "string") row.title = patch.title;
      if (typeof patch.body === "string") row.body = patch.body;
      if (row.title === "" && row.body === "") {
        notUpdated[id] = { type: "invalidProperties", description: "a note needs a title or a body" };
        continue;
      }
      row.revision += 1;
      row.updatedAt = at;
      updated[id] = null;
    }

    for (const id of Array.isArray(args.destroy) ? (args.destroy as string[]) : []) {
      const i = notes.findIndex((n) => n.id === id);
      if (i < 0) {
        notDestroyed[id] = { type: "notFound", description: "no note with that id" };
        continue;
      }
      notes.splice(i, 1);
      destroyed.push(id);
    }

    return {
      accountId: ACCOUNT,
      oldState: "0",
      newState: "0",
      created,
      notCreated,
      updated,
      notUpdated,
      destroyed,
      notDestroyed,
    };
  };

  client.setHandler("Note/query", query);
  client.setHandler("Note/get", get);
  client.setHandler("Note/set", set);
  return { notes };
}
