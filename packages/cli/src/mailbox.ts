import type { DatabaseSync } from "node:sqlite";
import { requireSettings, selectAccounts, type Settings } from "./db.js";
import { JmapClient } from "./jmap.js";
import { refreshMailboxes, type MirroredMailbox } from "./sync.js";

/**
 * bullmoose mailbox — the write half of the folder surface (sVOL 004):
 *   mailbox create <name> [--parent <id-or-name>] [--sort <n>]
 *   mailbox rename <id-or-name> <new-name>
 *   mailbox move   <id-or-name> --parent <id-or-name|->
 *   mailbox rm     <id-or-name> [--force]
 *
 * `bullmoose mailboxes` (plural) stays as it was: a read of the LOCAL
 * SQLite mirror. These verbs go over JMAP, so every one of them refreshes
 * the mirror on the way out — otherwise a create would not show up until
 * the next `bullmoose sync` and the two commands would disagree about what
 * folders exist, which reads as a bug no matter how well documented.
 */

export interface MailboxOpts {
  account?: string;
  parent?: string;
  sort?: string;
  force?: boolean;
  json: boolean;
}

interface JmapMailbox {
  id: string;
  name: string;
  parentId: string | null;
  role: string | null;
  sortOrder: number;
}

export async function cmdMailbox(
  db: DatabaseSync,
  positionals: string[],
  opts: MailboxOpts,
): Promise<void> {
  const [sub, arg, arg2] = positionals;
  const settings = requireSettings(db);
  const accountId = pickAccount(settings, opts.account);
  const client = new JmapClient(settings.base, settings.token);

  switch (sub) {
    case "create": {
      if (!arg) usage("mailbox create <name> [--parent <id-or-name>] [--sort <n>]");
      const boxes = await listMailboxes(client, accountId);
      const spec: Record<string, unknown> = { name: arg };
      if (opts.parent !== undefined) spec.parentId = resolveMailbox(boxes, opts.parent).id;
      if (opts.sort !== undefined) spec.sortOrder = parseSort(opts.sort);
      const res = await setMailbox(client, accountId, { create: { c1: spec } });
      const made = (res.created as Record<string, { id: string }>).c1;
      if (!made) fail("create", (res.notCreated as Record<string, unknown>).c1);
      await report(db, client, accountId, opts, { action: "created", id: made.id, name: arg });
      return;
    }
    case "rename": {
      if (!arg || !arg2) usage("mailbox rename <id-or-name> <new-name>");
      const boxes = await listMailboxes(client, accountId);
      const target = resolveMailbox(boxes, arg);
      const res = await setMailbox(client, accountId, {
        update: { [target.id]: { name: arg2 } },
      });
      if (!(target.id in (res.updated as Record<string, unknown>))) {
        fail("rename", (res.notUpdated as Record<string, unknown>)[target.id]);
      }
      await report(db, client, accountId, opts, { action: "renamed", id: target.id, name: arg2 });
      return;
    }
    case "move": {
      if (!arg || opts.parent === undefined) usage("mailbox move <id-or-name> --parent <id-or-name|->");
      const boxes = await listMailboxes(client, accountId);
      const target = resolveMailbox(boxes, arg);
      // "-" is the only way to say "top level" on a command line: an empty
      // --parent is indistinguishable from a missing one.
      const parentId = opts.parent === "-" ? null : resolveMailbox(boxes, opts.parent!).id;
      const res = await setMailbox(client, accountId, {
        update: { [target.id]: { parentId } },
      });
      if (!(target.id in (res.updated as Record<string, unknown>))) {
        fail("move", (res.notUpdated as Record<string, unknown>)[target.id]);
      }
      await report(db, client, accountId, opts, {
        action: "moved",
        id: target.id,
        name: target.name,
      });
      return;
    }
    case "rm": {
      if (!arg) usage("mailbox rm <id-or-name> [--force]");
      const boxes = await listMailboxes(client, accountId);
      const target = resolveMailbox(boxes, arg);
      const res = await setMailbox(client, accountId, {
        destroy: [target.id],
        // --force is onDestroyRemoveEmails: without it a folder holding
        // mail is refused, which is the RFC 8621 default and the right one.
        ...(opts.force ? { onDestroyRemoveEmails: true } : {}),
      });
      if (!(res.destroyed as string[]).includes(target.id)) {
        fail("rm", (res.notDestroyed as Record<string, unknown>)[target.id]);
      }
      await report(db, client, accountId, opts, {
        action: "destroyed",
        id: target.id,
        name: target.name,
      });
      return;
    }
    default:
      console.error(`unknown mailbox subcommand: ${sub ?? "(none)"} (create|rename|move|rm)`);
      process.exit(1);
  }
}

async function setMailbox(
  client: JmapClient,
  accountId: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return client.one("Mailbox/set", { accountId, ...args });
}

async function listMailboxes(client: JmapClient, accountId: string): Promise<JmapMailbox[]> {
  const res = await client.one("Mailbox/get", { accountId, ids: null });
  return (res.list as JmapMailbox[]) ?? [];
}

/**
 * Accept an id, a role, or a name — a human types "Receipts", not
 * "mb_9f3c…". Exact id wins, then exact role, then case-insensitive name;
 * an ambiguous name is an error rather than a coin flip.
 */
export function resolveMailbox<T extends { id: string; name: string; role: string | null }>(
  boxes: T[],
  selector: string,
): T {
  const byId = boxes.find((m) => m.id === selector);
  if (byId) return byId;
  const byRole = boxes.find((m) => m.role === selector.toLowerCase());
  if (byRole) return byRole;
  const byName = boxes.filter((m) => m.name.toLowerCase() === selector.toLowerCase());
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) {
    console.error(
      `"${selector}" matches ${byName.length} mailboxes; use an id: ` +
        byName.map((m) => m.id).join(", "),
    );
    process.exit(1);
  }
  console.error(`no such mailbox: ${selector}`);
  process.exit(1);
}

export function parseSort(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    console.error(`--sort must be a non-negative integer, got "${raw}"`);
    process.exit(1);
  }
  return n;
}

/** A per-object SetError is the normal failure here, not an exception. */
function fail(verb: string, err: unknown): never {
  const e = (err ?? {}) as { type?: string; description?: string };
  console.error(`${verb} failed: ${e.type ?? "unknown"}${e.description ? ` — ${e.description}` : ""}`);
  process.exit(1);
}

function usage(line: string): never {
  console.error(`usage: bullmoose ${line}`);
  process.exit(1);
}

async function report(
  db: DatabaseSync,
  client: JmapClient,
  accountId: string,
  opts: MailboxOpts,
  what: { action: string; id: string; name: string },
): Promise<void> {
  const { mailboxes: boxes } = await refreshMailboxes(db, client, accountId);
  if (opts.json) {
    console.log(JSON.stringify({ ...what, mailboxes: boxes }, null, 2));
    return;
  }
  console.log(`${what.action} ${what.name} (${what.id})`);
  console.log(renderTree(boxes));
}

/** The point of the whole unit: a human can see the hierarchy they made. */
export function renderTree(boxes: MirroredMailbox[]): string {
  const lines: string[] = [];
  const children = (parentId: string | null) =>
    boxes
      .filter((m) => m.parentId === parentId)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  const walk = (parentId: string | null, indent: string) => {
    for (const m of children(parentId)) {
      lines.push(`${indent}${m.name}${m.role ? `  [${m.role}]` : ""}`);
      walk(m.id, `${indent}  `);
    }
  };
  walk(null, "  ");
  return lines.join("\n");
}

function pickAccount(settings: Settings, selector?: string): string {
  if (!selector) return settings.accountId;
  const matches = selectAccounts(settings, selector);
  if (matches.length !== 1) {
    console.error(
      `--account "${selector}" matches ${matches.length} accounts; pick one of: ` +
        matches.map((a) => a.address ?? a.accountId).join(", "),
    );
    process.exit(1);
  }
  return matches[0]!.accountId;
}
