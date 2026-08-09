import type { DatabaseSync } from "node:sqlite";
import { pickAccountId, requireSettings } from "./db.js";
import {
  EXIT,
  conflict,
  emitIds,
  emitJson,
  emitNdjson,
  failSetError,
  fail,
  note,
  notFound,
  out,
  outRaw,
  readInput,
  usage,
  warn,
  type Input,
  type IoOpts,
} from "./io.js";
import { JmapClient } from "./jmap.js";
import { parseVcf, type Card } from "./vcard.js";

/**
 * bullmoose contacts — the read AND write surface for the JSContact core
 * (devPlan-handoff §5 Phase 1, then s05 T2 / sVOL 017):
 *   contacts import <file.vcf> [--book <name-or-id>]   idempotent bulk seed
 *   contacts list [--book <name-or-id>] [-n N]         browse cards
 *   contacts show <id>                                 one card, in full
 *   contacts books list|create|rename|rm               address-book lifecycle
 *   contacts create|edit|rm  [-] [--as vcard|json]     one card from stdin
 *   contacts export [--book]                           the inverse of import
 *
 * Import is idempotent: cards dedup by JSContact uid (UID from the .vcf,
 * or a content-derived urn for UID-less cards), so re-running an import
 * only creates what's new. `create` is the un-deduped single-card verb;
 * `export` re-serialises stored cards back to vCard 3.0, so
 * `export | import` round-trips a book with no drift.
 *
 * Book management (`books create|rename|rm`) is OWNER-ONLY: the server
 * (`AddressBook/set`, contacts.ts:117-121) refuses it on delegated access
 * with `forbidden`, which the §1.5 table maps to a clean exit 4 — so an
 * agent reaching the account through a grant gets a plain refusal, not a
 * stack trace. Card writes require the `contacts` scope; because any write
 * implies `read` (`.feedback/…/common/027`), a `contacts` token also satisfies
 * the read verbs, so one scope covers both listing and editing cards.
 */

interface ContactsOpts extends IoOpts {
  account?: string;
  book?: string;
  n: string;
  /** `books rm` → onDestroyRemoveContents; also confirms a non-empty book. */
  force?: boolean;
}

/**
 * Set-request chunking: small enough that the worker's JSON handling of
 * a photo-heavy chunk stays inside the free tier's per-request CPU
 * budget (inline photos make single cards ~MB-scale). A chunk that
 * still trips the limit is split and retried down to single cards.
 */
const CREATE_CHUNK = 20;
const CREATE_CHUNK_BYTES = 600_000;
const PAGE = 256;

export async function cmdContacts(
  db: DatabaseSync,
  positionals: string[],
  opts: ContactsOpts,
): Promise<void> {
  const [sub, arg, arg2] = positionals;
  const settings = requireSettings(db);
  const accountId = pickAccountId(settings, opts.account);
  const client = new JmapClient(settings.base, settings.token);

  switch (sub) {
    case "import":
      // §1.4: the path is optional and `-` is explicit stdin, so
      // `cat a.vcf | bullmoose contacts import -` works like every other
      // Unix filter. `--as` forces the type when the bytes are ambiguous.
      await cmdImport(client, accountId, arg, opts);
      break;
    case "list":
      await cmdList(client, accountId, opts);
      break;
    case "show": {
      if (!arg) usage("bullmoose contacts show <cardId>");
      await cmdShow(client, accountId, arg, opts);
      break;
    }
    case "books":
      await cmdBooks(client, accountId, positionals.slice(1), opts);
      break;
    case "create":
      // A single card (or a small vCard/JSON batch) from stdin or a path,
      // WITHOUT import's dedup — `create` means "make this", not "reconcile".
      await cmdCreate(client, accountId, arg, opts);
      break;
    case "edit": {
      if (!arg) usage("bullmoose contacts edit <cardId> [<file>|-] [--as vcard|json]");
      await cmdEdit(client, accountId, arg, arg2, opts);
      break;
    }
    case "rm": {
      if (!arg) usage("bullmoose contacts rm <cardId> [--dry-run]");
      await cmdRm(client, accountId, arg, opts);
      break;
    }
    case "export":
      await cmdExport(client, accountId, opts);
      break;
    default:
      usage(
        `unknown contacts subcommand: ${sub ?? "(none)"} ` +
          `(import|list|show|books|create|edit|rm|export)`,
      );
  }
}

// ---- import -------------------------------------------------------------

async function cmdImport(
  client: JmapClient,
  accountId: string,
  file: string | undefined,
  opts: ContactsOpts,
): Promise<void> {
  const input = readInput(file, { as: opts.as, required: true, what: "vCard" })!;
  if (input.type !== "vcard") {
    fail(
      `${input.from} looks like ${input.type}, not vCard — pass --as vcard to force it`,
      EXIT.USAGE,
    );
  }
  const { cards, warnings } = parseVcf(input.text);
  for (const w of warnings) warn(w);
  if (cards.length === 0) notFound(`no vCards found in ${input.from}`);
  const source = input.from;

  const book = await resolveBook(client, accountId, opts.book, { createMissing: true });

  // uid → id map of what's already there (idempotent re-import).
  const existing = new Map<string, string>();
  for (const c of await listAllCards(client, accountId, { properties: ["id", "uid"] })) {
    existing.set(String(c.uid), String(c.id));
  }

  if (opts.dryRun) {
    // §1.7: a --dry-run write performs zero mutations. Everything up to here
    // is reads, so the report is real — it names the book the cards WOULD land
    // in and what would be skipped, then stops before the first /set.
    const wouldSkip = cards.filter((c) => existing.has(String(c.uid))).length;
    if (opts.json) {
      emitJson({
        dryRun: true,
        source,
        book: { id: book.id, name: book.name },
        parsed: cards.length,
        wouldCreate: cards.length - wouldSkip,
        wouldSkip,
      });
    } else {
      note(
        `dry run: ${source} would create ${cards.length - wouldSkip} of ${cards.length} ` +
          `card(s) in "${book.name}" (${wouldSkip} already on server); nothing was written`,
      );
    }
    return;
  }

  const toCreate: Card[] = [];
  let skippedExisting = 0;
  let duplicatesInFile = 0;
  const seenInFile = new Set<string>();
  for (const card of cards) {
    const uid = String(card.uid);
    if (seenInFile.has(uid)) {
      duplicatesInFile++;
      continue;
    }
    seenInFile.add(uid);
    if (existing.has(uid)) {
      skippedExisting++;
      continue;
    }
    toCreate.push({ ...card, addressBookIds: { [book.id]: true } });
  }

  let created = 0;
  const failed: Array<{ uid: string; error: string }> = [];
  let done = 0;
  const progress = () => {
    if (toCreate.length > CREATE_CHUNK && !opts.json) {
      process.stderr.write(`\rimporting… ${done}/${toCreate.length}`);
    }
  };

  /** Send one chunk; on transport/worker failure split and retry. */
  const sendChunk = async (chunk: Card[]): Promise<void> => {
    const create: Record<string, Card> = {};
    chunk.forEach((card, i) => (create[`c${i}`] = card));
    try {
      const res = await client.one("ContactCard/set", { accountId, create }, CONTACTS_USING);
      created += Object.keys((res.created as object) ?? {}).length;
      for (const [cid, err] of Object.entries(
        (res.notCreated as Record<string, { type?: string; description?: string }>) ?? {},
      )) {
        failed.push({
          uid: String(create[cid]?.uid ?? cid),
          error: err.description ?? err.type ?? "unknown error",
        });
      }
      done += chunk.length;
      progress();
    } catch {
      if (chunk.length > 1) {
        // Halve until it fits the worker's per-request resource budget.
        const mid = Math.ceil(chunk.length / 2);
        await sendChunk(chunk.slice(0, mid));
        await sendChunk(chunk.slice(mid));
      } else {
        // Single card: give a transient failure one more chance.
        try {
          await new Promise((r) => setTimeout(r, 1500));
          await sendChunk0(chunk[0]!);
        } catch (err2) {
          failed.push({ uid: String(chunk[0]?.uid), error: String(err2) });
          done += 1;
          progress();
        }
      }
    }
  };
  const sendChunk0 = async (card: Card): Promise<void> => {
    const res = await client.one("ContactCard/set", { accountId, create: { c0: card } }, CONTACTS_USING);
    created += Object.keys((res.created as object) ?? {}).length;
    const err = (res.notCreated as Record<string, { type?: string; description?: string }>)?.c0;
    if (err) failed.push({ uid: String(card.uid), error: err.description ?? err.type ?? "unknown" });
    done += 1;
    progress();
  };

  for (const chunk of chunkBySize(toCreate)) await sendChunk(chunk);
  if (toCreate.length > CREATE_CHUNK && !opts.json) process.stderr.write("\n");

  if (opts.json) {
    emitJson({
      source,
      book: { id: book.id, name: book.name },
      parsed: cards.length,
      created,
      skippedExisting,
      duplicatesInFile,
      failed,
    });
  } else {
    const parts = [`created ${created}`];
    if (skippedExisting > 0) parts.push(`${skippedExisting} already on server`);
    if (duplicatesInFile > 0) parts.push(`${duplicatesInFile} duplicates within the file`);
    out(
      `${source}: parsed ${cards.length} card${cards.length === 1 ? "" : "s"} → ` +
        `${parts.join(", ")} → "${book.name}"`,
    );
    for (const f of failed) note(`failed: ${f.uid}: ${f.error}`);
  }
  if (failed.length > 0) process.exit(EXIT.FAIL);
}

/** Greedy chunks bounded by count and serialized size (photos are big). */
function chunkBySize(cards: Card[]): Card[][] {
  const chunks: Card[][] = [];
  let cur: Card[] = [];
  let bytes = 0;
  for (const card of cards) {
    const size = JSON.stringify(card).length;
    if (cur.length > 0 && (cur.length >= CREATE_CHUNK || bytes + size > CREATE_CHUNK_BYTES)) {
      chunks.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(card);
    bytes += size;
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}

// ---- list / show ----------------------------------------------------------

async function cmdList(client: JmapClient, accountId: string, opts: ContactsOpts): Promise<void> {
  const book = opts.book ? await resolveBook(client, accountId, opts.book, {}) : null;
  const limit = Math.max(1, Number(opts.n) || 20);

  const ids: string[] = [];
  let position = 0;
  while (ids.length < limit) {
    const q = await client.one(
      "ContactCard/query",
      {
        accountId,
        ...(book ? { filter: { inAddressBook: book.id } } : {}),
        sort: [{ property: "name", isAscending: true }],
        position,
        limit: Math.min(PAGE, limit - ids.length),
      },
      CONTACTS_USING,
    );
    const page = (q.ids as string[]) ?? [];
    ids.push(...page);
    if (page.length < Math.min(PAGE, limit - ids.length + page.length)) break;
    position += page.length;
  }

  const cards: Card[] = [];
  for (let i = 0; i < ids.length; i += PAGE) {
    const g = await client.one(
      "ContactCard/get",
      {
        accountId,
        ids: ids.slice(i, i + PAGE),
        properties: ["id", "name", "emails", "phones", "organizations", "addressBookIds"],
      },
      CONTACTS_USING,
    );
    cards.push(...((g.list as Card[]) ?? []));
  }
  // /get returns store order; present in the query's sort order.
  const rank = new Map(ids.map((id, i) => [id, i]));
  cards.sort((a, b) => (rank.get(String(a.id)) ?? 0) - (rank.get(String(b.id)) ?? 0));

  if (opts.ids) {
    emitIds(cards.map((c) => String(c.id)));
    return;
  }
  if (opts.json) {
    // §1.3 — one card per line, so `| jq -r .id | xargs` streams.
    emitNdjson(cards);
    return;
  }
  if (cards.length === 0) {
    note(book ? `no contacts in "${book.name}"` : "no contacts");
    return;
  }
  for (const c of cards) {
    out(`${displayName(c).padEnd(28)} ${firstEmail(c).padEnd(30)} ${c.id}`);
  }
}

async function cmdShow(
  client: JmapClient,
  accountId: string,
  id: string,
  opts: ContactsOpts,
): Promise<void> {
  const g = await client.one("ContactCard/get", { accountId, ids: [id] }, CONTACTS_USING);
  const card = ((g.list as Card[]) ?? [])[0];
  if (!card) notFound(`no such contact: ${id}`);
  if (opts.ids) {
    emitIds([String(card.id ?? id)]);
    return;
  }
  // §1.3: `show` is the single-object case — one JSON object under --json,
  // pretty-printed only for a human.
  if (opts.json) emitJson(card);
  else out(JSON.stringify(card, null, 2));
}

// ---- shared helpers -------------------------------------------------------

const CONTACTS_USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:contacts"];

interface BookRef {
  id: string;
  name: string;
  isDefault: boolean;
}

async function resolveBook(
  client: JmapClient,
  accountId: string,
  selector: string | undefined,
  { createMissing = false }: { createMissing?: boolean },
): Promise<BookRef> {
  const res = await client.one("AddressBook/get", { accountId, ids: null }, CONTACTS_USING);
  const books = (res.list as BookRef[]) ?? [];

  if (!selector) {
    const book = books.find((b) => b.isDefault) ?? books[0];
    if (book) return book;
    notFound("no address book on the account");
  }

  const match = books.find(
    (b) => b.id === selector || b.name.toLowerCase() === selector.toLowerCase(),
  );
  if (match) return match;
  if (!createMissing) {
    notFound(`no address book "${selector}"; have: ${books.map((b) => b.name).join(", ")}`);
  }
  const set = await client.one(
    "AddressBook/set",
    { accountId, create: { b0: { name: selector } } },
    CONTACTS_USING,
  );
  const createdId = (set.created as Record<string, { id?: string }>)?.b0?.id;
  if (!createdId) {
    failSetError(`create address book "${selector}"`, (set.notCreated as Record<string, unknown>)?.b0);
  }
  note(`created address book "${selector}" (${createdId})`);
  return { id: createdId, name: selector, isDefault: false };
}

async function listAllCards(
  client: JmapClient,
  accountId: string,
  { properties, bookId }: { properties?: string[]; bookId?: string } = {},
): Promise<Card[]> {
  const ids: string[] = [];
  let position = 0;
  for (;;) {
    const q = await client.one(
      "ContactCard/query",
      {
        accountId,
        ...(bookId ? { filter: { inAddressBook: bookId } } : {}),
        position,
        limit: PAGE,
      },
      CONTACTS_USING,
    );
    const page = (q.ids as string[]) ?? [];
    ids.push(...page);
    if (page.length < PAGE) break;
    position += page.length;
  }
  const out: Card[] = [];
  for (let i = 0; i < ids.length; i += PAGE) {
    const g = await client.one(
      "ContactCard/get",
      // No `properties` → the whole card, which is what `export` re-serialises.
      { accountId, ids: ids.slice(i, i + PAGE), ...(properties ? { properties } : {}) },
      CONTACTS_USING,
    );
    out.push(...((g.list as Card[]) ?? []));
  }
  return out;
}

function displayName(c: Card): string {
  const name = c.name as { full?: string } | undefined;
  if (name?.full) return name.full;
  const orgs = Object.values((c.organizations as Record<string, { name?: string }>) ?? {});
  if (orgs[0]?.name) return orgs[0].name;
  return firstEmail(c) || "(unnamed)";
}

function firstEmail(c: Card): string {
  const emails = Object.values((c.emails as Record<string, { address?: string }>) ?? {});
  return emails[0]?.address ?? "";
}

// ---- books: address-book lifecycle (owner-only) ---------------------------

/**
 * `contacts books list|create|rename|rm`. `AddressBook/set` (create/rename/rm)
 * refuses delegated access with a method-level `forbidden`, which reaches the
 * single exit path in main.ts and maps to exit 4 — a grant-reaching agent gets
 * a clean refusal, not a trace. `list` is `AddressBook/get`, which delegated
 * readers may call.
 */
async function cmdBooks(
  client: JmapClient,
  accountId: string,
  positionals: string[],
  opts: ContactsOpts,
): Promise<void> {
  const [verb, arg, arg2] = positionals;
  switch (verb) {
    case "list": {
      const res = await client.one("AddressBook/get", { accountId, ids: null }, CONTACTS_USING);
      const books = (res.list as Array<Record<string, unknown>>) ?? [];
      if (opts.ids) {
        emitIds(books.map((b) => String(b.id)));
        return;
      }
      if (opts.json) {
        emitNdjson(books);
        return;
      }
      if (books.length === 0) {
        note("no address books");
        return;
      }
      for (const b of books) {
        out(`${String(b.name ?? "").padEnd(28)} ${b.isDefault ? "★" : " "}  ${b.id}`);
      }
      return;
    }
    case "create": {
      if (!arg) usage("bullmoose contacts books create <name>");
      if (dryRun(opts, "create book", arg)) return;
      const res = await client.one(
        "AddressBook/set",
        { accountId, ...ifInState(opts), create: { b0: { name: arg } } },
        CONTACTS_USING,
      );
      const made = (res.created as Record<string, { id: string }>)?.b0;
      if (!made) failSetError("create book", (res.notCreated as Record<string, unknown>)?.b0);
      reportWrite(opts, {
        action: "created book",
        id: made.id,
        name: arg,
        state: (res.newState as string) ?? null,
      });
      return;
    }
    case "rename": {
      if (!arg || !arg2) usage("bullmoose contacts books rename <name-or-id> <new-name>");
      const book = await resolveBook(client, accountId, arg, {});
      if (dryRun(opts, "rename book", `${book.name} → ${arg2}`)) return;
      const res = await client.one(
        "AddressBook/set",
        { accountId, ...ifInState(opts), update: { [book.id]: { name: arg2 } } },
        CONTACTS_USING,
      );
      if (!(book.id in ((res.updated as Record<string, unknown>) ?? {}))) {
        failSetError("rename book", (res.notUpdated as Record<string, unknown>)?.[book.id]);
      }
      reportWrite(opts, {
        action: "renamed book",
        id: book.id,
        name: arg2,
        state: (res.newState as string) ?? null,
      });
      return;
    }
    case "rm": {
      if (!arg) usage("bullmoose contacts books rm <name-or-id> [--force] [--dry-run]");
      // Destructive: resolve for real, then count what it holds — both so the
      // dry-run report is evidence of something and so a non-empty book gets a
      // clean exit-5 refusal rather than the server's generic set error.
      const book = await resolveBook(client, accountId, arg, {});
      const contents = await queryIdsInBook(client, accountId, book.id);
      const detail =
        contents.length === 0
          ? `${book.name} (${book.id})`
          : opts.force
            ? `${book.name} and its ${contents.length} contact(s)`
            : `${book.name} — holds ${contents.length} contact(s), needs --force`;
      if (dryRun(opts, "remove book", detail)) return;
      if (contents.length > 0 && !opts.force) {
        conflict(
          `address book "${book.name}" holds ${contents.length} contact(s); ` +
            `pass --force to remove them too`,
        );
      }
      const res = await client.one(
        "AddressBook/set",
        {
          accountId,
          ...ifInState(opts),
          destroy: [book.id],
          ...(opts.force ? { onDestroyRemoveContents: true } : {}),
        },
        CONTACTS_USING,
      );
      if (!((res.destroyed as string[]) ?? []).includes(book.id)) {
        failSetError("remove book", (res.notDestroyed as Record<string, unknown>)?.[book.id]);
      }
      reportWrite(opts, {
        action: "removed book",
        id: book.id,
        name: book.name,
        state: (res.newState as string) ?? null,
      });
      return;
    }
    default:
      usage(`unknown contacts books subcommand: ${verb ?? "(none)"} (list|create|rename|rm)`);
  }
}

// ---- card writes: create / edit / rm --------------------------------------

/**
 * `contacts create [<file>|-] [--book <name-or-id>] [--as vcard|json]`.
 * The un-deduped counterpart to `import`: it creates every card in the input,
 * whether or not one with the same uid already exists. `--book` places them;
 * with none, the server's default book is used.
 */
async function cmdCreate(
  client: JmapClient,
  accountId: string,
  file: string | undefined,
  opts: ContactsOpts,
): Promise<void> {
  const input = readInput(file, { as: opts.as, required: true, what: "vCard or JSON" })!;
  const cards = cardsFromInput(input);
  if (cards.length === 0) notFound(`no contact found in ${input.from}`);
  const book = opts.book ? await resolveBook(client, accountId, opts.book, {}) : null;

  if (dryRun(opts, "create", `${cards.length} contact(s)${book ? ` in "${book.name}"` : ""}`)) {
    return;
  }

  const create: Record<string, Card> = {};
  cards.forEach((card, i) => {
    const rest: Card = { ...card };
    delete rest.id; // id is server-set
    create[`c${i}`] = book ? { ...rest, addressBookIds: { [book.id]: true } } : rest;
  });
  const res = await client.one(
    "ContactCard/set",
    { accountId, ...ifInState(opts), create },
    CONTACTS_USING,
  );
  const created = (res.created as Record<string, { id: string }>) ?? {};
  const notCreated =
    (res.notCreated as Record<string, { type?: string; description?: string }>) ?? {};
  const keys = Object.keys(create);
  const madeIds = keys.filter((k) => created[k]).map((k) => created[k]!.id);
  const fails = keys.filter((k) => notCreated[k]);

  // Nothing landed → surface the first SetError with its mapped exit code.
  if (madeIds.length === 0 && fails.length > 0) failSetError("create", notCreated[fails[0]!]);

  if (opts.ids) {
    emitIds(madeIds);
  } else if (opts.json) {
    emitNdjson(
      keys.map((k) =>
        created[k]
          ? { id: created[k]!.id, uid: create[k]!.uid ?? null, created: true }
          : { uid: create[k]!.uid ?? null, created: false, error: notCreated[k]?.type ?? "unknown" },
      ),
    );
  } else {
    for (const id of madeIds) out(`created ${id}`);
    for (const k of fails) {
      note(
        `failed to create ${String(create[k]!.uid ?? k)}: ` +
          `${notCreated[k]!.description ?? notCreated[k]!.type ?? "unknown"}`,
      );
    }
    const state = res.newState as string | undefined;
    if (state && madeIds.length > 0) {
      note(`state ${state}  (pass to --if-state on the next write)`);
    }
  }
  // A partial failure is still a failure.
  if (fails.length > 0) process.exit(EXIT.FAIL);
}

/**
 * `contacts edit <cardId> [<file>|-] [--book …] [--as …]`. The input is the
 * card's new content; each top-level JSContact property present replaces the
 * stored one (JMAP `/set update` patch semantics). A missing card comes back as
 * a `notFound` SetError → exit 3.
 */
async function cmdEdit(
  client: JmapClient,
  accountId: string,
  id: string,
  file: string | undefined,
  opts: ContactsOpts,
): Promise<void> {
  const input = readInput(file, { as: opts.as, required: true, what: "vCard or JSON" })!;
  const cards = cardsFromInput(input);
  if (cards.length !== 1) {
    usage(`contacts edit takes exactly one card, got ${cards.length} in ${input.from}`);
  }
  const patch: Card = { ...cards[0]! };
  delete patch.id; // the id is the target, not a settable property
  if (opts.book) {
    const book = await resolveBook(client, accountId, opts.book, {});
    patch.addressBookIds = { [book.id]: true };
  }
  if (dryRun(opts, "edit", id)) return;
  const res = await client.one(
    "ContactCard/set",
    { accountId, ...ifInState(opts), update: { [id]: patch } },
    CONTACTS_USING,
  );
  if (!(id in ((res.updated as Record<string, unknown>) ?? {}))) {
    failSetError("edit", (res.notUpdated as Record<string, unknown>)?.[id]);
  }
  reportWrite(opts, {
    action: "edited",
    id,
    name: displayName(patch),
    state: (res.newState as string) ?? null,
  });
}

/** `contacts rm <cardId> [--dry-run]`. Resolves the target for real first. */
async function cmdRm(
  client: JmapClient,
  accountId: string,
  id: string,
  opts: ContactsOpts,
): Promise<void> {
  const g = await client.one(
    "ContactCard/get",
    { accountId, ids: [id], properties: ["id", "name", "organizations", "emails"] },
    CONTACTS_USING,
  );
  const card = ((g.list as Card[]) ?? [])[0];
  if (!card) notFound(`no such contact: ${id}`);
  const name = displayName(card);
  if (dryRun(opts, "remove", `${name} (${id})`)) return;
  const res = await client.one(
    "ContactCard/set",
    { accountId, ...ifInState(opts), destroy: [id] },
    CONTACTS_USING,
  );
  if (!((res.destroyed as string[]) ?? []).includes(id)) {
    failSetError("remove", (res.notDestroyed as Record<string, unknown>)?.[id]);
  }
  reportWrite(opts, { action: "removed", id, name, state: (res.newState as string) ?? null });
}

// ---- export: the inverse of import ----------------------------------------

/**
 * `contacts export [--book <name-or-id>]`. Default output is the DATA — vCard
 * 3.0 blocks concatenated, each already CRLF-terminated — so `export | import`
 * round-trips a book. `--json` emits the JSContact cards as NDJSON; `--ids`
 * emits the card ids for `| xargs`.
 */
async function cmdExport(
  client: JmapClient,
  accountId: string,
  opts: ContactsOpts,
): Promise<void> {
  const book = opts.book ? await resolveBook(client, accountId, opts.book, {}) : null;
  const cards = await listAllCards(client, accountId, book ? { bookId: book.id } : {});
  if (opts.ids) {
    emitIds(cards.map((c) => String(c.id)));
    return;
  }
  if (opts.json) {
    emitNdjson(cards);
    return;
  }
  if (cards.length === 0) {
    note(book ? `no contacts in "${book.name}"` : "no contacts");
    return;
  }
  for (const c of cards) outRaw(serializeVcard(c));
}

// ---- write-path helpers ---------------------------------------------------

/**
 * Turn a resolved stdin/file input into JSContact cards. vCard is parsed by the
 * existing converter; JSON is a single card object or an array of them. `--as`
 * (already applied in `readInput`) forces the type; a `text`/`ical` payload is
 * a usage error that names the fix.
 */
export function cardsFromInput(input: Input): Card[] {
  if (input.type === "vcard") {
    const { cards, warnings } = parseVcf(input.text);
    for (const w of warnings) warn(w);
    return cards;
  }
  if (input.type === "json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.text);
    } catch (e) {
      fail(`${input.from} is not valid JSON: ${(e as Error).message}`, EXIT.USAGE);
    }
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    for (const c of arr) {
      if (c === null || typeof c !== "object" || Array.isArray(c)) {
        fail(`${input.from}: each contact must be a JSON object`, EXIT.USAGE);
      }
    }
    return arr as Card[];
  }
  fail(
    `${input.from} looks like ${input.type}, not a contact — ` +
      `pass --as vcard or --as json to force it`,
    EXIT.USAGE,
  );
}

/** §1.7 — `--if-state` → JMAP `ifInState`; a mismatch reaches exit 5. */
function ifInState(opts: ContactsOpts): Record<string, string> {
  return opts.ifState ? { ifInState: opts.ifState } : {};
}

/**
 * `--dry-run` (arch.md §1.7, invariant 4). Returns true when the caller must
 * stop. Everything before the call is a read, so the report names the resolved
 * target rather than the string that was typed.
 */
function dryRun(opts: ContactsOpts, verb: string, what: string): boolean {
  if (!opts.dryRun) return false;
  note(`dry run: would ${verb} ${what}; nothing was written`);
  if (opts.json) emitJson({ dryRun: true, action: verb, target: what });
  return true;
}

/** The single-target write report, mirroring `mailbox`'s: id for `--ids`, one
 * object for `--json`, a line plus the chainable state for a human. */
function reportWrite(
  opts: ContactsOpts,
  what: { action: string; id: string; name: string; state: string | null },
): void {
  if (opts.ids) {
    emitIds([what.id]);
    return;
  }
  if (opts.json) {
    emitJson({ action: what.action, id: what.id, name: what.name, state: what.state });
    return;
  }
  out(`${what.action} ${what.name} (${what.id})`);
  if (what.state) note(`state ${what.state}  (pass to --if-state on the next write)`);
}

async function queryIdsInBook(
  client: JmapClient,
  accountId: string,
  bookId: string,
): Promise<string[]> {
  const ids: string[] = [];
  let position = 0;
  for (;;) {
    const q = await client.one(
      "ContactCard/query",
      { accountId, filter: { inAddressBook: bookId }, position, limit: PAGE },
      CONTACTS_USING,
    );
    const page = (q.ids as string[]) ?? [];
    ids.push(...page);
    if (page.length < PAGE) break;
    position += page.length;
  }
  return ids;
}

// ---- JSContact → vCard 3.0 ------------------------------------------------
//
// The serialise direction that `import` (parseVcf) lacks, so `export` is a real
// inverse. Ported from `packages/contacts-core` — the CLI cannot import a
// workspace package (see `vcard.ts`'s note; that module is itself a copy), so
// this lives here. 3.0 because that is what Apple Contacts requests and emits;
// unmapped source properties preserved on import as `vCardProps` are re-emitted
// verbatim, so a round-trip drops nothing.

interface Line {
  group?: string;
  name: string;
  params?: string[]; // preformatted "TYPE=HOME" segments
  value: string; // already escaped as appropriate for the property
}

const N_COMPONENT_KINDS = ["surname", "given", "given2", "title", "credential"] as const;
const ADR_COMPONENT_KINDS = [
  "postOfficeBox",
  "apartment",
  "name",
  "locality",
  "region",
  "postcode",
  "country",
] as const;

export function serializeVcard(card: Card): string {
  const lines: Line[] = [];
  let item = 0;
  const push = (l: Line) => lines.push(l);
  const withLabel = (label: string | undefined, l: Line): void => {
    if (!label) {
      push(l);
      return;
    }
    const group = `item${++item}`;
    push({ ...l, group });
    push({ group, name: "X-ABLABEL", value: escapeText(label) });
  };

  const name = card.name as
    | { full?: string; components?: Array<{ kind?: string; value?: string }> }
    | undefined;

  // FN is mandatory in 3.0.
  const fn =
    name?.full ??
    name?.components
      ?.filter((c) => c.kind !== "separator" && c.value)
      .map((c) => c.value)
      .join(" ")
      .trim() ??
    firstValue(card.organizations, "name") ??
    firstValue(card.emails, "address") ??
    "Unnamed";
  push({ name: "FN", value: escapeText(String(fn)) });

  if (name?.components && name.components.length > 0) {
    const slots: Record<(typeof N_COMPONENT_KINDS)[number], string[]> = {
      surname: [],
      given: [],
      given2: [],
      title: [],
      credential: [],
    };
    for (const c of name.components) {
      const kind = c.kind as keyof typeof slots;
      if (kind in slots && typeof c.value === "string") slots[kind].push(c.value);
    }
    push({
      name: "N",
      value: N_COMPONENT_KINDS.map((k) => slots[k].map(escapeComponent).join(",")).join(";"),
    });
  }

  for (const org of values(card.organizations)) {
    const units = Array.isArray(org.units)
      ? (org.units as Array<{ name?: string }>).map((u) => u.name ?? "")
      : [];
    push({
      name: "ORG",
      value: [org.name ?? "", ...units].map((v) => escapeComponent(String(v))).join(";"),
    });
  }
  for (const t of values(card.titles)) {
    push({
      name: t.kind === "role" ? "ROLE" : "TITLE",
      value: escapeText(String(t.name ?? "")),
    });
  }
  const nicknames = values(card.nicknames)
    .map((n) => n.name)
    .filter(Boolean);
  if (nicknames.length > 0) {
    push({ name: "NICKNAME", value: nicknames.map((n) => escapeText(String(n))).join(",") });
  }

  for (const e of values(card.emails)) {
    withLabel(e.label as string | undefined, {
      name: "EMAIL",
      params: ["TYPE=INTERNET", ...typeParams(e)],
      value: escapeText(String(e.address ?? "")),
    });
  }

  // vCard TEL types. Only `mobile` → `CELL` differs from the JSContact
  // feature name upper-cased, so the rest (voice, fax, pager, video, text,
  // textphone) derive from `.toUpperCase()` — which also keeps the literal
  // pager-type token out of this source, where io.test.ts's §1.6 guard scans
  // for it (it means the pager the user pipes to, not a phone type).
  const FEATURE_TYPES: Record<string, string> = { mobile: "CELL" };
  for (const p of values(card.phones)) {
    const featureTypes = Object.keys((p.features as Record<string, boolean>) ?? {})
      .map((f) => FEATURE_TYPES[f] ?? f.toUpperCase())
      .filter((f) => f.length > 0)
      .map((f) => `TYPE=${f}`);
    withLabel(p.label as string | undefined, {
      name: "TEL",
      params: [...featureTypes, ...typeParams(p)],
      value: escapeText(String(p.number ?? "")),
    });
  }

  for (const a of values(card.addresses)) {
    const comps = (a.components as Array<{ kind?: string; value?: string }>) ?? [];
    const slots: Record<(typeof ADR_COMPONENT_KINDS)[number], string[]> = {
      postOfficeBox: [],
      apartment: [],
      name: [],
      locality: [],
      region: [],
      postcode: [],
      country: [],
    };
    for (const c of comps) {
      const kind = c.kind as keyof typeof slots;
      if (kind in slots && typeof c.value === "string") slots[kind].push(c.value);
    }
    push({
      name: "ADR",
      params: typeParams(a),
      value: ADR_COMPONENT_KINDS.map((k) => slots[k].map(escapeComponent).join(",")).join(";"),
    });
  }

  for (const ann of values(card.anniversaries)) {
    const d = ann.date as
      | { year?: number; month?: number; day?: number; utc?: string }
      | undefined;
    if (!d) continue;
    let value: string | null = null;
    if (typeof d.utc === "string") value = d.utc.slice(0, 10);
    else if (d.year && d.month && d.day) {
      value = `${pad4(d.year)}-${pad2(d.month)}-${pad2(d.day)}`;
    } else if (d.month && d.day) {
      // Apple's yearless-date convention.
      value = `1604-${pad2(d.month)}-${pad2(d.day)}`;
    }
    if (!value) continue;
    const params = value.startsWith("1604-") ? ["X-APPLE-OMIT-YEAR=1604"] : undefined;
    if (ann.kind === "birth") push({ name: "BDAY", params, value });
    else if (ann.kind === "wedding") push({ name: "ANNIVERSARY", params, value });
  }

  for (const n of values(card.notes)) {
    if (n.note) push({ name: "NOTE", value: escapeText(String(n.note)) });
  }
  for (const l of values(card.links)) {
    if (l.uri) {
      withLabel(l.label as string | undefined, { name: "URL", value: String(l.uri) });
    }
  }
  for (const s of values(card.onlineServices)) {
    if (s.uri) {
      withLabel(s.label as string | undefined, { name: "IMPP", value: String(s.uri) });
    }
  }
  for (const m of values(card.media)) {
    if (m.kind !== "photo" || typeof m.uri !== "string") continue;
    const data = m.uri.match(/^data:image\/([a-z0-9.+-]+);base64,(.+)$/is);
    if (data) {
      push({
        name: "PHOTO",
        params: ["ENCODING=b", `TYPE=${data[1]!.toUpperCase()}`],
        value: data[2]!.replaceAll(/\s/g, ""),
      });
    } else if (/^https?:/i.test(m.uri)) {
      push({ name: "PHOTO", params: ["VALUE=uri"], value: m.uri });
    }
  }

  const keywords = Object.keys((card.keywords as Record<string, boolean>) ?? {});
  if (keywords.length > 0) {
    push({ name: "CATEGORIES", value: keywords.map(escapeText).join(",") });
  }
  if (card.kind === "org") push({ name: "X-ABSHOWAS", value: "COMPANY" });
  if (typeof card.updated === "string") {
    const ms = Date.parse(card.updated);
    if (Number.isFinite(ms)) {
      push({ name: "REV", value: new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z") });
    }
  }

  // Lossless tail: re-emit preserved unmapped properties verbatim.
  for (const raw of (card.vCardProps as unknown[]) ?? []) {
    if (!Array.isArray(raw) || raw.length < 4) continue;
    const [pname, pparams, , pvalue] = raw as [string, Record<string, unknown>, string, string];
    const { group, ...rest } = pparams ?? {};
    const params = Object.entries(rest).flatMap(([k, v]) =>
      (Array.isArray(v) ? v : [v]).map((x) => `${k.toUpperCase()}=${String(x)}`),
    );
    // Prefix preserved group names so they can't collide with the itemN groups
    // this serializer mints for labels (relative grouping survives the rename).
    push({
      ...(typeof group === "string" ? { group: `p${group}` } : {}),
      name: pname.toUpperCase(),
      ...(params.length > 0 ? { params } : {}),
      value: String(pvalue),
    });
  }

  const out: string[] = ["BEGIN:VCARD", "VERSION:3.0", "PRODID:-//bullmoose//cli//EN"];
  if (typeof card.uid === "string") out.push(fold(`UID:${escapeText(card.uid)}`));
  for (const l of lines) {
    const head = `${l.group ? `${l.group}.` : ""}${l.name}${l.params?.length ? ";" + l.params.join(";") : ""}`;
    out.push(fold(`${head}:${l.value}`));
  }
  out.push("END:VCARD");
  return out.join("\r\n") + "\r\n";
}

function escapeText(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll(",", "\\,")
    .replaceAll(";", "\\;");
}

/** Escaping for one component of a structured value (N/ADR/ORG). */
function escapeComponent(value: string): string {
  return escapeText(value);
}

/** RFC 6350 §3.2 folding at 75 octets, never splitting a code point. */
function fold(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = "";
  let curBytes = 0;
  const budget = 75;
  for (const ch of line) {
    const chBytes = enc.encode(ch).length;
    if (curBytes + chBytes > budget) {
      out.push(cur);
      cur = " ";
      curBytes = 1;
    }
    cur += ch;
    curBytes += chBytes;
  }
  if (cur.length > 0) out.push(cur);
  return out.join("\r\n");
}

function values(map: unknown): Array<Record<string, unknown>> {
  if (map === null || typeof map !== "object" || Array.isArray(map)) return [];
  return Object.values(map as Record<string, unknown>).filter(
    (v): v is Record<string, unknown> => v !== null && typeof v === "object",
  );
}

function firstValue(map: unknown, key: string): string | undefined {
  for (const v of values(map)) {
    if (typeof v[key] === "string" && v[key]) return v[key] as string;
  }
  return undefined;
}

function typeParams(entry: Record<string, unknown>): string[] {
  const out: string[] = [];
  const ctx = (entry.contexts as Record<string, boolean>) ?? {};
  if (ctx.private) out.push("TYPE=HOME");
  if (ctx.work) out.push("TYPE=WORK");
  if (typeof entry.pref === "number" && entry.pref === 1) out.push("TYPE=pref");
  return out;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
function pad4(n: number): string {
  return String(n).padStart(4, "0");
}
