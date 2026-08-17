import type { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { pickAccountId, requireSettings, type Settings } from "./db.js";
import { EXIT, emitIds, emitJson, emitNdjson, exitCodeForJmapType, fail, note, usage, type IoOpts } from "./io.js";
import { JmapClient } from "./jmap.js";
import { reconcileEmails } from "./sync.js";
import { resolveMailbox } from "./mailbox.js";

/**
 * bullmoose triage verbs (sVOL 019) — the write half of the mail surface the
 * CLI has always lacked. `s05` punted these by name ("worth its own slice",
 * `.plans/s05-cli-crud/readme.md:95-96`); this is that slice.
 *
 *   flag    <id…> --add <kw> [--remove <kw>]     Email/set update  keywords/*
 *   seen    <id…> [--unset]                        sugar over flag  keywords/$seen
 *   move    <id…> --role <r> | --mailbox <box>    Email/set update  mailboxIds (replace)
 *   label   <id…> --add <box> [--remove <box>]    Email/set update  mailboxIds (add/remove)
 *   archive <id…>                                  sugar: move --role archive
 *   junk    <id…>                                  sugar: move --role junk
 *   trash   <id…>                                  sugar: move --role trash
 *   rm      <id…> --force                          Email/set destroy  (HARD delete)
 *
 * Every verb is thin projection over `Email/set`
 * (`services/jmap/src/methods/email.ts`), and the whole point of the unit is
 * Unix composition — these are the payoff for sVOL `016`'s `--ids`:
 *
 *   bullmoose search "from:amazon" --ids | xargs bullmoose archive
 *   bullmoose search "unsubscribe"  --ids | xargs bullmoose trash --dry-run
 *
 * so a verb's stdout is the ids it acted on (`arch.md` §1.1), and ids arrive
 * either as positional arguments (the `xargs` shape) or on stdin.
 *
 * Two disciplines the unit turns on:
 *
 *  1. **Per-verb scope, flat-set** (`.feedback/fromClaude/common/027`).
 *     `Email/set` charges scopes from its arguments: a keywords-only patch is
 *     `annotate`, a mailboxIds patch is `move`, a destroy is `delete`. Because
 *     `hasScope` is a flat set, not the lattice the docs draw, `move` does NOT
 *     imply `annotate`. So each verb builds a SINGLE-operation patch — `flag`
 *     never touches mailboxIds, `move` never touches keywords — and a token
 *     scoped to exactly that verb gets a clean exit 4 rather than the server
 *     refusing one bundled half.
 *
 *  2. **Reconcile the local mirror after the write** (`019` "Reconcile…").
 *     `search`/`log`/`mailboxes` read the local SQLite mirror, written only by
 *     `sync`. A verb that writes over JMAP and returns leaves the mirror
 *     describing the old world, so every verb re-fetches the ids the server
 *     reported as changed — and ONLY those, and ONLY after the write returns.
 *     `--no-sync` opts out for a caller that batches and syncs once at the end.
 */

export interface TriageOpts extends IoOpts {
  account?: string;
  add?: string[];
  remove?: string[];
  role?: string;
  mailbox?: string;
  force?: boolean;
  unset?: boolean;
  noSync?: boolean;
}

/** System keyword long-hand, so `seen`/`unset` can build the right patch. */
const SEEN = "$seen";

const UPDATE_VERBS = new Set(["flag", "seen", "move", "label", "archive", "junk", "trash"]);

interface Outcome {
  verb: string;
  succeeded: string[];
  failed: Array<{ id: string; type: string; description?: string }>;
  newState: string | null;
}

export async function cmdTriage(
  db: DatabaseSync,
  verb: string,
  positionals: string[],
  opts: TriageOpts,
): Promise<void> {
  // `delete` is an alias for `rm`: both name the same hard destroy. `rm` is the
  // canonical spelling (`019` "the verbs"); `delete` is here because it is the
  // word a human reaches for and the pipelines in the unit brief use.
  if (verb === "delete") verb = "rm";

  const ids = collectIds(positionals);
  if (ids.length === 0) {
    usage(`bullmoose ${verb} <id…>   (ids as arguments, or piped on stdin)`);
  }

  const settings = requireSettings(db);
  const accountId = resolveAccount(db, settings, opts, ids[0]!);
  const client = new JmapClient(settings.base, settings.token);

  if (verb === "rm") {
    await runDestroy(db, client, accountId, ids, opts);
    return;
  }
  if (UPDATE_VERBS.has(verb)) {
    await runUpdate(db, client, accountId, verb, ids, opts);
    return;
  }
  usage(`unknown triage verb: ${verb}`);
}

// ─────────────────────────────── the update verbs ───────────────────────────

async function runUpdate(
  db: DatabaseSync,
  client: JmapClient,
  accountId: string,
  verb: string,
  ids: string[],
  opts: TriageOpts,
): Promise<void> {
  // Build the SINGLE-operation patch for this verb, plus a human/JSON label for
  // what it does, plus (for the mailbox verbs) a resolved destination for the
  // dry-run report and the empty-mailbox guard.
  let patch: Record<string, unknown>;
  const extra: Record<string, unknown> = {};
  let destDesc = "";
  // For `label --remove` we need each message's current mailboxIds to refuse a
  // remove that would leave it in no mailbox client-side. Collected here.
  let clientFailed: Outcome["failed"] = [];
  let workIds = ids;

  switch (verb) {
    case "flag": {
      patch = keywordPatch(opts.add ?? [], opts.remove ?? []);
      if (Object.keys(patch).length === 0) {
        usage("bullmoose flag <id…> --add <keyword> [--remove <keyword>]  (e.g. --add '$flagged')");
      }
      extra.keywords = patch;
      destDesc = ` (${describeKeywords(opts.add ?? [], opts.remove ?? [])})`;
      break;
    }
    case "seen": {
      // Sugar over flag: set $seen, or clear it with --unset.
      patch = opts.unset ? keywordPatch([], [SEEN]) : keywordPatch([SEEN], []);
      extra.keywords = patch;
      destDesc = opts.unset ? " (mark unread)" : " (mark read)";
      break;
    }
    case "move":
    case "archive":
    case "junk":
    case "trash": {
      const selector = moveSelector(verb, opts);
      const dest = await resolveDestMailbox(db, client, accountId, selector);
      // Full-property replacement: the message ends up in exactly this one
      // mailbox. A `mailboxIds`-only patch → the server charges `move` alone.
      patch = replacePatch(dest.id);
      extra.mailbox = dest.id;
      extra.mailboxName = dest.name;
      destDesc = ` → ${dest.name} (${dest.id})`;
      break;
    }
    case "label": {
      const adds = await resolveMany(db, client, accountId, opts.add ?? []);
      const removes = await resolveMany(db, client, accountId, opts.remove ?? []);
      if (adds.length === 0 && removes.length === 0) {
        usage("bullmoose label <id…> --add <mailbox> [--remove <mailbox>]");
      }
      // Per-key add/remove — NOT a full replace, so a labelled message stays in
      // its other mailboxes. Still a mailboxIds-only patch → charges `move`.
      patch = labelPatch(adds, removes);
      extra.add = adds;
      extra.remove = removes;
      destDesc = (adds.length ? ` +[${adds.join(", ")}]` : "") + (removes.length ? ` -[${removes.join(", ")}]` : "");
      // The empty-mailbox guard (`email.ts:403`): a remove that would leave a
      // message in zero mailboxes is an error, not an archive. Catch it here
      // naming `move`, rather than letting a bare `invalidProperties` surface.
      if (removes.length > 0) {
        const guarded = await guardEmptyRemove(client, accountId, ids, adds, removes);
        workIds = guarded.keep;
        clientFailed = guarded.rejected;
      }
      break;
    }
    default:
      usage(`unknown triage verb: ${verb}`);
      return;
  }

  if (opts.dryRun) {
    reportDryRun(opts, verb, ids, destDesc, extra);
    return;
  }

  const outcome: Outcome = { verb, succeeded: [], failed: [...clientFailed], newState: null };

  if (workIds.length > 0) {
    const update: Record<string, Record<string, unknown>> = {};
    for (const id of workIds) update[id] = patch;
    const res = await client.one("Email/set", {
      accountId,
      ...ifInState(opts),
      update,
    });
    outcome.succeeded = Object.keys((res.updated as Record<string, unknown>) ?? {});
    for (const [id, e] of Object.entries((res.notUpdated as Record<string, SetErr>) ?? {})) {
      outcome.failed.push({ id, type: e?.type ?? "unknown", description: e?.description });
    }
    outcome.newState = (res.newState as string | undefined) ?? null;
    // Reconcile ONLY the ids the server actually updated, and only now that the
    // write has returned (`019`: reconciling optimistically re-introduces the
    // divergence this prevents).
    if (!opts.noSync && outcome.succeeded.length > 0) {
      await reconcileEmails(db, client, accountId, { updated: outcome.succeeded });
    }
  }

  report(opts, outcome, extra);
}

// ─────────────────────────────────── rm ─────────────────────────────────────

async function runDestroy(
  db: DatabaseSync,
  client: JmapClient,
  accountId: string,
  ids: string[],
  opts: TriageOpts,
): Promise<void> {
  // The hard-delete gate. `store.destroyEmail` removes the rows and ORPHANS the
  // R2 blob — no tombstone, nothing recoverable (`019` "the verbs"). So refuse
  // unless the caller says --force (or is only rehearsing with --dry-run). The
  // gesture a human means by "delete this" is `bullmoose trash`.
  if (!opts.force && !opts.dryRun) {
    fail(
      "rm permanently destroys mail — there is no Trash and no undo. " +
        "Pass --force to confirm, --dry-run to rehearse, or use `bullmoose trash` to move to Trash.",
      EXIT.USAGE,
    );
  }

  if (opts.dryRun) {
    reportDryRun(opts, "rm", ids, " — PERMANENT, no undo", {});
    return;
  }

  const res = await client.one("Email/set", {
    accountId,
    ...ifInState(opts),
    destroy: ids,
  });
  const outcome: Outcome = {
    verb: "rm",
    succeeded: (res.destroyed as string[]) ?? [],
    failed: Object.entries((res.notDestroyed as Record<string, SetErr>) ?? {}).map(([id, e]) => ({
      id,
      type: e?.type ?? "unknown",
      description: e?.description,
    })),
    newState: (res.newState as string | undefined) ?? null,
  };
  if (!opts.noSync && outcome.succeeded.length > 0) {
    await reconcileEmails(db, client, accountId, { destroyed: outcome.succeeded });
  }
  report(opts, outcome, { destroyed: true });
}

// ─────────────────────────────── shared plumbing ────────────────────────────

interface SetErr {
  type: string;
  description?: string;
}

/**
 * Ids come as positional arguments (the `| xargs bullmoose archive` shape) or,
 * when there are none, on stdin (`--ids | bullmoose archive`). Explicit
 * arguments beat implicit stdin, the same rule `send`/`readInput` follow
 * (`arch.md` §1.4). Whitespace-separated, so a newline- or space-delimited id
 * stream both work.
 */
export function collectIds(positionals: string[]): string[] {
  if (positionals.length > 0) return positionals;
  if (process.stdin.isTTY) return [];
  const piped = readFileSync(0, "utf8");
  return piped.split(/\s+/).filter(Boolean);
}

function resolveAccount(db: DatabaseSync, settings: Settings, opts: TriageOpts, firstId: string): string {
  // An explicit --account wins and is checked for ambiguity. Otherwise resolve
  // the owning account of the first id from the local mirror (as `read` does),
  // falling back to the default — every id in one Email/set must share it.
  if (opts.account) return pickAccountId(settings, opts.account);
  const owner = db.prepare("SELECT account_id FROM emails WHERE id = ?").get(firstId) as
    | { account_id: string }
    | undefined;
  return owner?.account_id ?? settings.accountId;
}

function moveSelector(verb: string, opts: TriageOpts): string {
  if (verb === "archive") return "archive";
  if (verb === "junk") return "junk";
  if (verb === "trash") return "trash";
  // plain `move`
  if (opts.role && opts.mailbox) {
    usage("bullmoose move <id…> takes --role OR --mailbox, not both");
  }
  const selector = opts.role ?? opts.mailbox;
  if (!selector) usage("bullmoose move <id…> --role <role> | --mailbox <id-or-name>");
  return selector;
}

/**
 * A keywords-ONLY patch — no `mailboxIds` key ever. That is what makes `flag`
 * and `seen` charge `annotate` alone (`requiredScopesForEmailSet`,
 * `email.ts:241`): a token scoped to annotate can flag, without also needing
 * `move`. Exported so the scope discipline is asserted, not just asserted-about.
 */
export function keywordPatch(add: string[], remove: string[]): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const kw of add) {
    if (!kw) usage("--add needs a keyword, e.g. --add '$flagged'");
    patch[`keywords/${kw}`] = true;
  }
  for (const kw of remove) {
    if (!kw) usage("--remove needs a keyword");
    patch[`keywords/${kw}`] = null;
  }
  return patch;
}

/**
 * A whole-property `mailboxIds` replacement — the message ends up in EXACTLY
 * this mailbox. `mailboxIds`-only, so `move`/`archive`/`junk`/`trash` charge
 * `move` alone. This is the set-REPLACE that `move` means, as opposed to
 * `label`'s per-key add.
 */
export function replacePatch(mailboxId: string): Record<string, unknown> {
  return { mailboxIds: { [mailboxId]: true } };
}

/**
 * A per-key `mailboxIds` add/remove — the message KEEPS its other mailboxes.
 * Still `mailboxIds`-only, so `label` charges `move` and never `annotate`.
 */
export function labelPatch(adds: string[], removes: string[]): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const id of adds) patch[`mailboxIds/${id}`] = true;
  for (const id of removes) patch[`mailboxIds/${id}`] = null;
  return patch;
}

/**
 * Would applying these adds/removes leave the message in NO mailbox? The rule
 * `applyEmailPatch` enforces server-side (`email.ts:403`); computed here so
 * `label --remove` can refuse client-side, naming `move`.
 */
export function wouldEmpty(current: string[], adds: string[], removes: string[]): boolean {
  const set = new Set(current);
  for (const a of adds) set.add(a);
  for (const r of removes) set.delete(r);
  return set.size === 0;
}

function describeKeywords(add: string[], remove: string[]): string {
  const bits = [...add.map((k) => `+${k}`), ...remove.map((k) => `-${k}`)];
  return bits.join(" ");
}

interface Box {
  id: string;
  name: string;
  role: string | null;
}

async function accountMailboxes(db: DatabaseSync, client: JmapClient, accountId: string): Promise<Box[]> {
  // Local mirror first (`019` bread-crumbs); fall back to a live Mailbox/get
  // when the mirror is empty — e.g. before the first `sync`.
  const rows = db
    .prepare("SELECT id, name, role FROM mailboxes WHERE account_id = ?")
    .all(accountId) as unknown as Box[];
  if (rows.length > 0) return rows;
  const res = await client.one("Mailbox/get", { accountId, ids: null });
  return ((res.list as Box[]) ?? []).map((m) => ({ id: m.id, name: m.name, role: m.role }));
}

async function resolveDestMailbox(
  db: DatabaseSync,
  client: JmapClient,
  accountId: string,
  selector: string,
): Promise<Box> {
  return resolveMailbox(await accountMailboxes(db, client, accountId), selector);
}

async function resolveMany(
  db: DatabaseSync,
  client: JmapClient,
  accountId: string,
  selectors: string[],
): Promise<string[]> {
  if (selectors.length === 0) return [];
  const boxes = await accountMailboxes(db, client, accountId);
  return selectors.map((s) => resolveMailbox(boxes, s).id);
}

/**
 * `applyEmailPatch` refuses to leave a message in zero mailboxes
 * (`email.ts:403-405`). For `label --remove`, fetch each id's current
 * membership and reject — client-side, naming `move` — any whose set would go
 * empty. The rest go through; partial failure is honest (`019` done-when #8).
 */
async function guardEmptyRemove(
  client: JmapClient,
  accountId: string,
  ids: string[],
  adds: string[],
  removes: string[],
): Promise<{ keep: string[]; rejected: Outcome["failed"] }> {
  const res = await client.one("Email/get", {
    accountId,
    ids,
    properties: ["id", "mailboxIds"],
  });
  const rows = new Map(
    (res.list as Array<{ id: string; mailboxIds: Record<string, boolean> }>).map((e) => [
      e.id,
      new Set(Object.keys(e.mailboxIds ?? {})),
    ]),
  );
  const keep: string[] = [];
  const rejected: Outcome["failed"] = [];
  for (const id of ids) {
    const set = rows.get(id);
    if (!set) {
      // Unknown id: let the server report it as notFound in the write below.
      keep.push(id);
      continue;
    }
    if (wouldEmpty([...set], adds, removes)) {
      rejected.push({
        id,
        type: "invalidProperties",
        description: "remove would leave it in no mailbox — use `move` to relocate instead",
      });
    } else {
      keep.push(id);
    }
  }
  return { keep, rejected };
}

function ifInState(opts: TriageOpts): Record<string, string> {
  return opts.ifState ? { ifInState: opts.ifState } : {};
}

function reportDryRun(
  opts: TriageOpts,
  verb: string,
  ids: string[],
  destDesc: string,
  extra: Record<string, unknown>,
): void {
  note(`dry run: would ${verb} ${ids.length} message(s)${destDesc}; nothing was written`);
  if (opts.json) emitJson({ dryRun: true, action: verb, ids, ...extra });
}

/**
 * stdout is the ids the verb acted on, so verbs chain
 * (`bullmoose archive $(…) | xargs bullmoose flag --add '$seen'`, `arch.md`
 * §1.1). Failures go to stderr and a non-zero exit — but the successes are NOT
 * swallowed: an archive of 40 ids where 1 does not exist still prints the 39 it
 * moved and reports the 1 (`019` done-when #7).
 */
function report(opts: TriageOpts, outcome: Outcome, extra: Record<string, unknown>): void {
  for (const f of outcome.failed) {
    note(`${outcome.verb}: ${f.id} failed: ${f.type}${f.description ? ` — ${f.description}` : ""}`);
  }

  if (opts.json) {
    emitNdjson(
      outcome.succeeded.map((id) => ({
        id,
        action: outcome.verb,
        ...extra,
        state: outcome.newState,
      })),
    );
  } else {
    // Default AND --ids: bare ids, one per line. A triage verb's result IS its
    // ids, so there is no separate human list.
    emitIds(outcome.succeeded);
  }

  const total = outcome.succeeded.length + outcome.failed.length;
  note(`${outcome.verb}: ${outcome.succeeded.length}/${total} ok`);
  if (outcome.newState) note(`state ${outcome.newState}  (pass to --if-state on the next write)`);

  if (outcome.failed.length > 0) {
    // Non-zero if ANY id failed (`019` done-when #7). Take the code from the
    // first failure's type — notFound → 3, forbidden → 4 — so a single-cause
    // batch reports its true cause.
    fail(`${outcome.verb}: ${outcome.failed.length} of ${total} failed`, exitCodeForJmapType(outcome.failed[0]!.type));
  }
}
