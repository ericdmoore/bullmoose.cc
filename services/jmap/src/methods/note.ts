import { commitChanges, type ChangeEntry } from "@bullmoose/account-do";
import type { MethodRegistry } from "@bullmoose/jmap-core";
import { accountState, requireAccount, type RequestContext, type SetError } from "./common";

/**
 * Note (urn:bullmoose:params:jmap:agent) — the human-authored noun (s18 N1).
 *
 * ── A Note is NOT an Annotation, and this file is where that stops blurring ─
 *
 * s18's devPlan resolves it explicitly ("The decision: two entities",
 * 2026-08-17, Eric): a **Note is a document YOU AUTHOR**; an **Annotation is a
 * claim about your mail you ADJUDICATE**. The first cut of the plan tried to
 * make one table with nullable columns carry both, which is the readme's own
 * "a draft is just a note that's never sent" shortcut one level up. The verbs
 * are the tell:
 *
 *      Note                          Annotation (annotation.ts)
 *      ────────────────────────      ──────────────────────────────────
 *      write / edit / delete         confirm / correct / dismiss
 *      stands alone — NO anchor      ALWAYS anchored {realm, objectId}
 *      no class, no confidence       a class, a confidence, a status
 *      authored by a human           extracted by an agent (or filed)
 *      edited forever                immutable claim; you move its status
 *
 * So `Note/set` **refuses `anchor`, `class`, `confidence` and `status` BY
 * NAME** rather than ignoring them (see `ANNOTATION_ONLY` below). A client
 * that tries to anchor a note gets a sentence telling it which entity it
 * actually wants. That refusal is the distinction made executable, so the next
 * reader cannot "helpfully" merge the two.
 *
 * It is also **not a never-sent draft** (readme §1). Modelling it as one leaks
 * notes into Apple Mail's Drafts and wants an invented mailbox role — the
 * `quarantine`-role mistake s12 spent a day undoing. A Note never appears in a
 * mailbox and has no `Email` anything.
 *
 * ── FUTURE(s18 N2/N3) — the federation seam, and what is NOT here ──────────
 *
 * The plan's whole arc is *"a private document that federates."* **v1
 * federates nothing.** No mention is parsed, no mail is sent, no note is
 * shared, and no note is reachable by anyone but its own account. What v1 DOES
 * build is the identity a federated note would need, because retrofitting
 * identity onto rows that already exist is the expensive half:
 *
 *   • `id` — `nt_<uuid>`, stable and never reused. Paired with the owner's
 *     domain it is the `X-Bullmoose-Mention: <note-ref>` a remote instance
 *     would dereference (readme §3).
 *   • `owner` — the authoring principal's login, written once at create and
 *     never rewritten. Federation's authentication is DKIM on the owner's
 *     domain (readme §3), so "who authored this" must be a property of the
 *     row, not of whoever last touched it.
 *   • `revision` — monotonic, bumped on every content write. A far end that
 *     was shown rev 2 can be told it is now rev 5; the append-only comment
 *     thread N3 describes hangs off this, and last-writer-wins (s18 "out of
 *     scope": no CRDT) is only honest if the version is visible.
 *
 * What federating would still require, none of it started: a write-time
 * `@name@domain` parser storing STRUCTURED mentions (never re-scraped at fire
 * time) and `mention` as the fifth `trigger_on` (N2); outbound mention-
 * stamping plus the reply-above-the-line trimmer (N3); the §4 consent moment —
 * quoting a private body into outbound mail IS the disclosure, stated before
 * send and un-revocable; and an agent mentioning an external address hitting
 * the s10 T1 governing book as egress. Those columns are deliberately ABSENT
 * from the table rather than present-and-unused: a `mentions_json` that
 * nothing writes is a claim that mentions work.
 *
 * ── Scope, and why this one ────────────────────────────────────────────────
 *
 * Reads gate on `read`; writes gate on **`draft`**. `draft` is the repo's
 * existing capability for *authoring mutable content you have not disclosed to
 * anyone* — which is precisely a Note's write. This is a CAPABILITY choice and
 * emphatically not the storage mistake above: nothing here touches `emails`,
 * and no note is a draft.
 *
 * The semantically ideal answer is a dedicated `notes` realm scope beside
 * `contacts`/`calendar`/`files`. It is not taken here for two reasons, both
 * concrete: (1) `DEFAULT_LOGIN_SCOPES` is `["mail"]`, so every token already
 * minted would silently NOT have it and the realm would be unreachable for
 * every existing session — the opposite of "session-reachable with the user's
 * own token"; (2) the vocabulary is mirrored in four lists in
 * `packages/auth-core/src/index.ts` plus a CLI drift guard that parses those
 * literals out of the source, so widening it is its own unit of work with its
 * own review. FUTURE(s18): when notes grow sharing, they earn the realm scope,
 * and the migration is additive (`hasScope` would let `notes` satisfy `read`).
 *
 * ── What is not here ───────────────────────────────────────────────────────
 *
 * No `Note/changes`. `proxyChanges`'s union does not carry `Note`, and adding
 * a method nothing consumes is the mistake `"Thread"` already demonstrates in
 * that union (sVOL 027: a collection sat there for months with no producer).
 * Writes DO `commitChanges` on a `Note` collection, and that is not
 * speculative: it is what moves the account state string every `/get` and
 * `/query` returns, so a client caching on state sees its own write. Wiring
 * `/changes` is a one-line addition to the union the day a consumer exists.
 *
 * ── Ownership ──────────────────────────────────────────────────────────────
 *
 * Every statement is scoped `WHERE account_id = ?`. Another account's note is
 * therefore indistinguishable from a nonexistent one — it lands in `notFound`
 * / `notUpdated` / `notDestroyed` with the same wording an unknown id gets,
 * and its content never crosses the boundary. `note.test.ts` drives that from
 * the outside rather than trusting the SQL to stay that way.
 */

interface NoteRow {
  id: string;
  account_id: string;
  owner: string;
  title: string;
  body: string;
  revision: number;
  last_writer_principal: string | null;
  last_writer_binding: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * The Annotation's own columns, refused here by name. See the header: a client
 * reaching for one of these wants the other entity, and saying so is cheaper
 * for everyone than a note that silently drops its anchor.
 */
const ANNOTATION_ONLY = ["anchor", "class", "confidence", "status", "rationale"];

/** Server-set on create; a client that sends one is guessing at our ids. */
const SERVER_SET = ["id", "owner", "revision", "createdAt", "updatedAt"];

/** The only two properties a client may write. Everything else is refused. */
const WRITABLE = new Set(["title", "body"]);

/** Inline body ceiling (s18 Decision 4: "a note that needs R2 is a document,
 *  and /files already is one"). Generous enough for prose, small enough that
 *  a note never becomes a blob store by accident. */
const MAX_BODY = 64_000;
const MAX_TITLE = 500;

/** How many rows an un-`ids`'d `Note/get` will hand back. See the `/get`
 *  comment: notes are UNBOUNDED, so this is a convenience cap, not a promise
 *  of completeness — `Note/query` is the enumeration door. */
const GET_CAP = 256;

function toJmap(r: NoteRow): Record<string, unknown> {
  return {
    id: r.id,
    owner: r.owner,
    title: r.title,
    body: r.body,
    revision: r.revision,
    lastWriter: r.last_writer_principal,
    lastWriterBinding: r.last_writer_binding,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function registerNoteMethods(registry: MethodRegistry<RequestContext>): void {
  registry.register("Note/get", async (args, ctx) => {
    const access = await requireAccount(ctx, args, "read");
    const ids = args.ids === null || args.ids === undefined ? undefined : (args.ids as string[]);
    let rows: NoteRow[];
    if (ids === undefined) {
      // RFC 8620 reads `ids: null` as "everything". Notes are an UNBOUNDED
      // collection — a person writes them forever — so answering literally
      // would grow without limit. Capped and newest-edited-first, with
      // `Note/query` as the real enumeration door (the reasoning #206 wrote
      // down one entity over: a bounded roster needs no `/query` and gets its
      // whole self from `/get`; an unbounded collection is the other case, and
      // this is that case).
      rows = (
        await ctx.env.DB.prepare(
          `SELECT * FROM notes WHERE account_id = ? ORDER BY updated_at DESC, id DESC LIMIT ${GET_CAP}`,
        )
          .bind(access.accountId)
          .all<NoteRow>()
      ).results;
    } else if (ids.length === 0) {
      rows = [];
    } else {
      const marks = ids.map(() => "?").join(",");
      rows = (
        await ctx.env.DB.prepare(`SELECT * FROM notes WHERE account_id = ? AND id IN (${marks})`)
          .bind(access.accountId, ...ids)
          .all<NoteRow>()
      ).results;
    }
    const found = new Set(rows.map((r) => r.id));
    return {
      accountId: access.accountId,
      state: await accountState(ctx, access.accountId),
      list: rows.map(toJmap),
      // Another account's id lands here, wearing exactly the same clothes as
      // an id that never existed. That is the whole ownership story.
      notFound: (ids ?? []).filter((id) => !found.has(id)),
    };
  });

  registry.register("Note/query", async (args, ctx) => {
    const access = await requireAccount(ctx, args, "read");
    const filter = (args.filter as { text?: string } | null | undefined) ?? null;
    const where = ["account_id = ?"];
    const binds: unknown[] = [access.accountId];
    if (typeof filter?.text === "string" && filter.text.trim() !== "") {
      // A LIKE scan, and the surface says so rather than implying an index
      // (`lib/notes/scope.ts`). Notes have no FTS table; giving them one is
      // real work and pretending otherwise is how `/search` learned to lie.
      // `escapeLike` keeps a literal % or _ from widening the match.
      where.push("(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')");
      const needle = `%${escapeLike(filter.text.trim())}%`;
      binds.push(needle, needle);
    }
    const rows = (
      await ctx.env.DB.prepare(
        `SELECT id FROM notes WHERE ${where.join(" AND ")} ORDER BY updated_at DESC, id DESC LIMIT ${GET_CAP}`,
      )
        .bind(...binds)
        .all<{ id: string }>()
    ).results;
    return {
      accountId: access.accountId,
      queryState: await accountState(ctx, access.accountId),
      ids: rows.map((r) => r.id),
    };
  });

  registry.register("Note/set", async (args, ctx) => {
    // `draft` — the capability to author mutable content you have not
    // disclosed. See the header for why this and not a `notes` realm scope.
    const access = await requireAccount(ctx, args, "draft");
    const principal = ctx.principal.username;
    const binding = ctx.agent?.binding ?? null;

    const created: Record<string, Record<string, unknown>> = {};
    const notCreated: Record<string, SetError> = {};
    const updated: Record<string, null> = {};
    const notUpdated: Record<string, SetError> = {};
    const destroyed: string[] = [];
    const notDestroyed: Record<string, SetError> = {};
    const entry: ChangeEntry = { collection: "Note", created: [], updated: [], destroyed: [] };
    const now = Date.now();

    // ---- create ----
    const createSpec = (args.create as Record<string, Record<string, unknown>> | undefined) ?? {};
    for (const [cid, spec] of Object.entries(createSpec)) {
      const wrong = ANNOTATION_ONLY.filter((k) => spec[k] !== undefined);
      if (wrong.length > 0) {
        notCreated[cid] = {
          type: "invalidProperties",
          description:
            `a Note has no ${wrong.join("/")} — it is a document you author, not a claim about a message. ` +
            "An anchored, classed claim is an Annotation: use Annotation/set.",
          properties: wrong,
        };
        continue;
      }
      const forbidden = SERVER_SET.filter((k) => spec[k] !== undefined);
      if (forbidden.length > 0) {
        notCreated[cid] = {
          type: "invalidProperties",
          description: `${forbidden.join(", ")} ${forbidden.length > 1 ? "are" : "is"} set by the server`,
        };
        continue;
      }
      const title = text(spec.title);
      const body = text(spec.body);
      if (title === null || body === null) {
        notCreated[cid] = { type: "invalidProperties", description: "title and body must be strings" };
        continue;
      }
      if (title === "" && body === "") {
        notCreated[cid] = { type: "invalidProperties", description: "a note needs a title or a body" };
        continue;
      }
      const tooBig = sizeRefusal(title, body);
      if (tooBig) {
        notCreated[cid] = tooBig;
        continue;
      }
      const id = `nt_${crypto.randomUUID()}`;
      await ctx.env.DB.prepare(
        `INSERT INTO notes
           (id, account_id, owner, title, body, revision,
            last_writer_principal, last_writer_binding, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      )
        // `owner` is the AUTHOR and is written exactly once. Even when an agent
        // binding drives the write, the owner is the principal it acts as — a
        // note belongs to a person, and federation authenticates that person's
        // domain. The binding is recorded beside it, never instead of it.
        .bind(id, access.accountId, principal, title, body, principal, binding, now, now)
        .run();
      created[cid] = { id, owner: principal, revision: 1, createdAt: now, updatedAt: now };
      entry.created.push(id);
    }

    // ---- update ----
    const updateSpec = (args.update as Record<string, Record<string, unknown>> | undefined) ?? {};
    for (const [id, patch] of Object.entries(updateSpec)) {
      const keys = Object.keys(patch);
      const wrong = keys.filter((k) => ANNOTATION_ONLY.includes(k));
      if (wrong.length > 0) {
        notUpdated[id] = {
          type: "invalidProperties",
          description:
            `a Note has no ${wrong.join("/")} — that is an Annotation's shape (Annotation/set), ` +
            "and an Annotation's claim is corrected by moving its status, never by editing a note.",
        };
        continue;
      }
      const unknown = keys.filter((k) => !WRITABLE.has(k));
      if (unknown.length > 0) {
        notUpdated[id] = {
          type: "invalidProperties",
          description: `only title and body may be written; refused ${unknown.join(", ")}`,
        };
        continue;
      }
      if (keys.length === 0) {
        notUpdated[id] = { type: "invalidProperties", description: "nothing to write" };
        continue;
      }
      const row = await ctx.env.DB.prepare(`SELECT * FROM notes WHERE account_id = ? AND id = ?`)
        .bind(access.accountId, id)
        .first<NoteRow>();
      if (!row) {
        // Same sentence a genuinely unknown id gets — an account boundary must
        // not be readable through the shape of a refusal.
        notUpdated[id] = { type: "notFound", description: "no note with that id" };
        continue;
      }
      const title = "title" in patch ? text(patch.title) : row.title;
      const body = "body" in patch ? text(patch.body) : row.body;
      if (title === null || body === null) {
        notUpdated[id] = { type: "invalidProperties", description: "title and body must be strings" };
        continue;
      }
      if (title === "" && body === "") {
        notUpdated[id] = { type: "invalidProperties", description: "a note needs a title or a body" };
        continue;
      }
      const tooBig = sizeRefusal(title, body);
      if (tooBig) {
        notUpdated[id] = tooBig;
        continue;
      }
      // Last-writer-wins, and `revision` is what makes that honest: s18 puts
      // CRDT/rich-text merge explicitly out of scope, so the version a client
      // (or one day a far end) was shown is a number it can compare, not a
      // guess. `owner` is untouched — editing a note never re-authors it.
      await ctx.env.DB.prepare(
        `UPDATE notes
            SET title = ?, body = ?, revision = revision + 1,
                last_writer_principal = ?, last_writer_binding = ?, updated_at = ?
          WHERE account_id = ? AND id = ?`,
      )
        .bind(title, body, principal, binding, now, access.accountId, id)
        .run();
      updated[id] = null;
      entry.updated.push(id);
    }

    // ---- destroy ----
    const destroySpec = Array.isArray(args.destroy) ? (args.destroy as string[]) : [];
    for (const id of destroySpec) {
      // A note is YOURS, so deleting it is a verb you have (unlike an
      // Annotation, whose claim is a record and closes forward instead).
      // There is no tombstone: nothing federates yet, so nothing off-instance
      // can hold a reference this would have to answer for. FUTURE(s18 N3):
      // once a note has been mentioned outward, destroy stops being local.
      const res = await ctx.env.DB.prepare(`DELETE FROM notes WHERE account_id = ? AND id = ?`)
        .bind(access.accountId, id)
        .run();
      if ((res.meta?.changes ?? 0) === 0) {
        notDestroyed[id] = { type: "notFound", description: "no note with that id" };
        continue;
      }
      destroyed.push(id);
      entry.destroyed.push(id);
    }

    const oldState = await accountState(ctx, access.accountId);
    if (entry.created.length + entry.updated.length + entry.destroyed.length > 0) {
      await commitChanges(ctx.env.ACCOUNT_DO, access.accountId, [entry]);
    }
    return {
      accountId: access.accountId,
      oldState,
      newState: await accountState(ctx, access.accountId),
      created,
      notCreated,
      updated,
      notUpdated,
      destroyed,
      notDestroyed,
    };
  });
}

/** A string property, trimmed of nothing but validated as a string. `undefined`
 *  reads as absent (→ ""); a non-string is a refusal, signalled as null. */
function text(v: unknown): string | null {
  if (v === undefined || v === null) return "";
  return typeof v === "string" ? v : null;
}

function sizeRefusal(title: string, body: string): SetError | null {
  if (title.length > MAX_TITLE) {
    return { type: "invalidProperties", description: `title is longer than ${MAX_TITLE} characters` };
  }
  if (body.length > MAX_BODY) {
    return {
      type: "tooLarge",
      description: `body is longer than ${MAX_BODY} characters — a note that big is a document, and /files is where documents live`,
    };
  }
  return null;
}

/** Escape LIKE's own wildcards so a search for "50%" is not a search for
 *  everything. Paired with `ESCAPE '\'` in the statement. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}
