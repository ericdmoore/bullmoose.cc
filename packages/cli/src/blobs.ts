import type { DatabaseSync } from "node:sqlite";
import { requireSettings, selectAccounts, type Settings } from "./db.js";
import { JmapClient, type BlobEntry, type ShareEntry } from "./jmap.js";

/**
 * `bullmoose blobs` and `bullmoose share` — the human half of sVOL `010`.
 *
 *   blobs list                 what R2 actually holds for this account
 *   blobs rm    <blobId>       explicit delete; refused if mail or a share needs it
 *   share list                 every link the server has a record of
 *   share revoke <shareId>     the kill switch
 *
 * `share revoke` is the point of the whole unit and the reason it grades
 * human-verifiable: open a link in a browser, revoke it here, reload, get a
 * refusal. No engineer required for any step.
 *
 * `admin.ts`'s designed-not-built list carried `○ share list | revoke expiring
 * links (needs the shares table)`. There is no shares table — the records live
 * in KV, for the reasons in `services/jmap/src/shares.ts` — so these are their
 * own top-level verbs against the mail account's own token rather than
 * `admin` subcommands against operator credentials. Revoking your own link
 * should not need the provision worker's admin token.
 */

export interface BlobOpts {
  account?: string;
  json: boolean;
}

export async function cmdBlobs(
  db: DatabaseSync,
  positionals: string[],
  opts: BlobOpts,
): Promise<void> {
  const [sub, arg] = positionals;
  const settings = requireSettings(db);
  const accountId = pickAccount(settings, opts.account);
  const client = new JmapClient(settings.base, settings.token);

  switch (sub) {
    case "list": {
      const res = await client.listBlobs(accountId);
      if (opts.json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      console.log(renderBlobs(res.blobs));
      console.log(`\n  ${res.blobs.length} object(s), ${formatSize(res.totalSize)} total`);
      if (res.cursor) console.log("  (more — listing is paginated)");
      return;
    }
    case "rm": {
      if (!arg) usage("blobs rm <blobId> [--account <sel>]");
      const res = await client.deleteBlob(accountId, arg);
      if (opts.json) console.log(JSON.stringify(res, null, 2));
      else console.log(`deleted ${arg}`);
      return;
    }
    default:
      console.error(`unknown blobs subcommand: ${sub ?? "(none)"} (list|rm)`);
      process.exit(1);
  }
}

export async function cmdShare(
  db: DatabaseSync,
  positionals: string[],
  opts: BlobOpts,
): Promise<void> {
  const [sub, arg] = positionals;
  const settings = requireSettings(db);
  const accountId = pickAccount(settings, opts.account);
  const client = new JmapClient(settings.base, settings.token);

  switch (sub) {
    case "list": {
      const res = await client.listShares(accountId);
      if (opts.json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      console.log(renderShares(res.shares));
      const live = res.shares.filter((s) => s.live).length;
      console.log(`\n  ${live} live, ${res.shares.length - live} revoked or expired`);
      return;
    }
    case "revoke": {
      if (!arg) usage("share revoke <shareId> [--account <sel>]");
      const res = await client.revokeShare(accountId, arg);
      if (opts.json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      console.log(res.alreadyRevoked ? `${arg} was already revoked` : `revoked ${arg}`);
      // Say the eventual-consistency cost out loud. The records live in KV, so
      // a revoke can take up to ~60s to reach every edge; a human who reloads
      // instantly and still sees the file must know that is expected and
      // temporary, not that the revoke failed.
      console.log("  " + res.note);
      return;
    }
    default:
      console.error(`unknown share subcommand: ${sub ?? "(none)"} (list|revoke)`);
      process.exit(1);
  }
}

// ---- rendering (pure; this is what the tests hold) ----------------------

/**
 * `bullmoose blobs list` output.
 *
 * Sorted largest-first: the question this command exists to answer is "what is
 * R2 billing me for", and that is the top of the list.
 */
export function renderBlobs(blobs: BlobEntry[]): string {
  if (blobs.length === 0) return "  (no blobs)";
  return [...blobs]
    .sort((a, b) => b.size - a.size)
    .map(
      (b) =>
        `  ${b.blobId}  ${formatSize(b.size).padStart(9)}  ${b.uploaded.slice(0, 10)}`,
    )
    .join("\n");
}

/**
 * `bullmoose share list` output.
 *
 * Live links first, and the state word comes before the id: someone running
 * this after a leak is scanning for what is still exposed, not reading ids.
 */
export function renderShares(shares: ShareEntry[]): string {
  if (shares.length === 0) return "  (no share links)";
  const rank = (s: ShareEntry) => (s.live ? 0 : 1);
  return [...shares]
    .sort((a, b) => rank(a) - rank(b) || b.createdAt.localeCompare(a.createdAt))
    .map((s) => {
      const state = s.live ? "live   " : s.revokedAt ? "revoked" : "expired";
      return `  ${state}  ${s.shareId}  ${s.name}  expires ${s.expiresAt.slice(0, 10)}`;
    })
    .join("\n");
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

function usage(line: string): never {
  console.error(`usage: bullmoose ${line}`);
  process.exit(1);
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
