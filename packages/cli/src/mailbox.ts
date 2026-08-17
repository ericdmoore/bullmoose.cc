import type { DatabaseSync } from "node:sqlite";
import { pickAccountId, requireSettings } from "./db.js";
import { EXIT, emitIds, emitJson, fail, failSetError, note, notFound, out, usage, type IoOpts } from "./io.js";
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

export interface MailboxOpts extends IoOpts {
  account?: string;
  parent?: string;
  sort?: string;
  force?: boolean;
}

interface JmapMailbox {
  id: string;
  name: string;
  parentId: string | null;
  role: string | null;
  sortOrder: number;
}

export async function cmdMailbox(db: DatabaseSync, positionals: string[], opts: MailboxOpts): Promise<void> {
  const [sub, arg, arg2] = positionals;
  const settings = requireSettings(db);
  const accountId = pickAccountId(settings, opts.account);
  const client = new JmapClient(settings.base, settings.token);

  switch (sub) {
    case "create": {
      if (!arg) usage("bullmoose mailbox create <name> [--parent <id-or-name>] [--sort <n>]");
      const boxes = await listMailboxes(client, accountId);
      const spec: Record<string, unknown> = { name: arg };
      if (opts.parent !== undefined) spec.parentId = resolveMailbox(boxes, opts.parent).id;
      if (opts.sort !== undefined) spec.sortOrder = parseSort(opts.sort);
      if (dryRun(opts, "create", arg)) return;
      const res = await setMailbox(client, accountId, opts, { create: { c1: spec } });
      const made = (res.created as Record<string, { id: string }>).c1;
      if (!made) failSetError("create", (res.notCreated as Record<string, unknown>).c1);
      await report(db, client, accountId, opts, res, { action: "created", id: made.id, name: arg });
      return;
    }
    case "rename": {
      if (!arg || !arg2) usage("bullmoose mailbox rename <id-or-name> <new-name>");
      const boxes = await listMailboxes(client, accountId);
      const target = resolveMailbox(boxes, arg);
      if (dryRun(opts, "rename", `${target.name} → ${arg2}`)) return;
      const res = await setMailbox(client, accountId, opts, {
        update: { [target.id]: { name: arg2 } },
      });
      if (!(target.id in (res.updated as Record<string, unknown>))) {
        failSetError("rename", (res.notUpdated as Record<string, unknown>)[target.id]);
      }
      await report(db, client, accountId, opts, res, {
        action: "renamed",
        id: target.id,
        name: arg2,
      });
      return;
    }
    case "move": {
      if (!arg || opts.parent === undefined) {
        usage("bullmoose mailbox move <id-or-name> --parent <id-or-name|->");
      }
      const boxes = await listMailboxes(client, accountId);
      const target = resolveMailbox(boxes, arg);
      // "-" is the only way to say "top level" on a command line: an empty
      // --parent is indistinguishable from a missing one.
      const parentId = opts.parent === "-" ? null : resolveMailbox(boxes, opts.parent!).id;
      if (dryRun(opts, "move", `${target.name} → parent ${parentId ?? "(top level)"}`)) return;
      const res = await setMailbox(client, accountId, opts, {
        update: { [target.id]: { parentId } },
      });
      if (!(target.id in (res.updated as Record<string, unknown>))) {
        failSetError("move", (res.notUpdated as Record<string, unknown>)[target.id]);
      }
      await report(db, client, accountId, opts, res, {
        action: "moved",
        id: target.id,
        name: target.name,
      });
      return;
    }
    case "rm": {
      if (!arg) usage("bullmoose mailbox rm <id-or-name> [--force] [--dry-run]");
      const boxes = await listMailboxes(client, accountId);
      const target = resolveMailbox(boxes, arg);
      // The destructive verb, so this is the one --dry-run exists for: the
      // selector is resolved for real (an unknown folder still exits 3) and
      // then nothing is written.
      if (dryRun(opts, "rm", `${target.name} (${target.id})${opts.force ? " and its mail" : ""}`)) {
        return;
      }
      const res = await setMailbox(client, accountId, opts, {
        destroy: [target.id],
        // --force is onDestroyRemoveEmails: without it a folder holding
        // mail is refused, which is the RFC 8621 default and the right one.
        ...(opts.force ? { onDestroyRemoveEmails: true } : {}),
      });
      if (!(res.destroyed as string[]).includes(target.id)) {
        failSetError("rm", (res.notDestroyed as Record<string, unknown>)[target.id]);
      }
      await report(db, client, accountId, opts, res, {
        action: "destroyed",
        id: target.id,
        name: target.name,
      });
      return;
    }
    default:
      usage(`unknown mailbox subcommand: ${sub ?? "(none)"} (create|rename|move|rm)`);
  }
}

/**
 * `--dry-run` (arch.md §1.7, invariant 4). Returns true when the caller must
 * stop. Everything before the call is a READ, so the report names the resolved
 * target rather than the string that was typed — a dry run that did not resolve
 * would not be evidence of anything.
 */
function dryRun(opts: MailboxOpts, verb: string, what: string): boolean {
  if (!opts.dryRun) return false;
  note(`dry run: would ${verb} ${what}; nothing was written`);
  if (opts.json) emitJson({ dryRun: true, action: verb, target: what });
  return true;
}

async function setMailbox(
  client: JmapClient,
  accountId: string,
  opts: MailboxOpts,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // §1.7: --if-state becomes JMAP's ifInState. The server compares it to the
  // account's current Mailbox state and answers a mismatch with a method-level
  // `stateMismatch` — which JmapClient.one rethrows with `jmapType` set, so it
  // reaches exit 5 through the ordinary error path with nothing written.
  return client.one("Mailbox/set", {
    accountId,
    ...(opts.ifState ? { ifInState: opts.ifState } : {}),
    ...args,
  });
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
    usage(`"${selector}" matches ${byName.length} mailboxes; use an id: ` + byName.map((m) => m.id).join(", "));
  }
  notFound(`no such mailbox: ${selector}`);
}

export function parseSort(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    fail(`--sort must be a non-negative integer, got "${raw}"`, EXIT.USAGE);
  }
  return n;
}

async function report(
  db: DatabaseSync,
  client: JmapClient,
  accountId: string,
  opts: MailboxOpts,
  res: Record<string, unknown>,
  what: { action: string; id: string; name: string },
): Promise<void> {
  const { mailboxes: boxes } = await refreshMailboxes(db, client, accountId);
  // The state the write LANDED on. Without it `--if-state` is half a feature:
  // a script has to be able to read the new state to pass it to the next write.
  const state = (res.newState as string | undefined) ?? null;
  if (opts.ids) {
    emitIds([what.id]);
    return;
  }
  if (opts.json) {
    emitJson({ ...what, state, mailboxes: boxes });
    return;
  }
  out(`${what.action} ${what.name} (${what.id})`);
  if (state) note(`state ${state}  (pass to --if-state on the next write)`);
  // The tree is decoration: useful to a human, noise in a pipeline.
  note(renderTree(boxes));
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
