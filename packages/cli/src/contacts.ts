import type { DatabaseSync } from "node:sqlite";
import { pickAccountId, requireSettings } from "./db.js";
import {
  EXIT,
  emitIds,
  emitJson,
  emitNdjson,
  failSetError,
  fail,
  note,
  notFound,
  out,
  readInput,
  usage,
  warn,
  type IoOpts,
} from "./io.js";
import { JmapClient } from "./jmap.js";
import { parseVcf, type Card } from "./vcard.js";

/**
 * bullmoose contacts — the convergence/bootstrap surface for the
 * JSContact core (devPlan-handoff §5 Phase 1):
 *   contacts import <file.vcf> [--book <name-or-id>]   seed the destination
 *   contacts list [--book <name-or-id>] [-n N]         verify what's there
 *   contacts show <id>                                 one card, in full
 *
 * Import is idempotent: cards dedup by JSContact uid (UID from the .vcf,
 * or a content-derived urn for UID-less cards), so re-running an import
 * only creates what's new.
 */

interface ContactsOpts extends IoOpts {
  account?: string;
  book?: string;
  n: string;
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
  const [sub, arg] = positionals;
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
    default:
      usage(`unknown contacts subcommand: ${sub ?? "(none)"} (import|list|show)`);
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
  for (const c of await listAllCards(client, accountId, ["id", "uid"])) {
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
  properties: string[],
): Promise<Card[]> {
  const ids: string[] = [];
  let position = 0;
  for (;;) {
    const q = await client.one(
      "ContactCard/query",
      { accountId, position, limit: PAGE },
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
      { accountId, ids: ids.slice(i, i + PAGE), properties },
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
