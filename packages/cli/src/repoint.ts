import type { DatabaseSync } from "node:sqlite";
import { isFileUrl, loadBootstrap, pickAccount, setConfig, type Settings } from "./db.js";
import { resolveJmapBase } from "./discover.js";
import { EXIT, emitJson, fail, note, notFound, out, usage, type IoOpts } from "./io.js";
import { JmapClient, type JmapError } from "./jmap.js";

/**
 * `bullmoose repoint [--base <url>]` — move this device's stored server URL
 * without re-authenticating.
 *
 * The gap it closes: `base` is written once, by `login` or `init`, and nothing
 * could write it again. When a deployment retires a hostname the stored value
 * is wrong forever, and the only repairs were re-running `init` with a token
 * the user may no longer hold a copy of, or opening ~/.bullmoose/mail.db with
 * sqlite3. That is the state PR #201's live smoke found: a config still naming
 * `bullmoose-jmap.eric-d-moore.workers.dev`, which now 404s on everything
 * including `/.well-known/jmap`.
 *
 * It keeps the token and the account and rewrites exactly one config row — and
 * it VALIDATES BEFORE WRITING, so a wrong URL leaves the old (even broken) base
 * in place rather than replacing one wrong answer with another.
 *
 * Not folded into `init`, which requires a token: needing the credential again
 * is precisely the thing that made this unrepairable, and a device whose server
 * moved has not lost its credential.
 */

export interface RepointOpts extends IoOpts {
  /** The new base, or a `file://` bootstrap bundle. Omitted → autodiscover. */
  base?: string;
}

export async function cmdRepoint(db: DatabaseSync, settings: Settings, opts: RepointOpts): Promise<void> {
  const base = await resolveTarget(settings, opts);

  if (base === settings.base) {
    note(`already pointed at ${base}`);
    if (opts.json) emitJson({ base, changed: false });
    return;
  }

  // Validate with the credential already held: a base that serves the session
  // resource but rejects this token is not a repoint, it is a new login, and
  // saying so beats storing it and failing on the next command.
  const session = await new JmapClient(base, settings.token).session().catch((err: unknown) => {
    const status = (err as JmapError).httpStatus;
    if (status === 401 || status === 403) {
      fail(
        `${base} is a JMAP server, but it rejected this device's token (HTTP ${status}).\n` +
          `Nothing was changed. A moved deployment keeps your token; a DIFFERENT one does not — ` +
          `if this is a new server, run: bullmoose login <your address> --base ${base}`,
        EXIT.AUTH,
      );
    }
    throw err;
  });

  if (!session.accounts[settings.accountId]) {
    notFound(
      `${base} does not serve account ${settings.accountId} ` +
        `(it has: ${Object.keys(session.accounts).join(", ") || "none"}).\n` +
        `Nothing was changed — run \`bullmoose login ${session.username}\` if this is a different deployment.`,
    );
  }
  const accounts = Object.entries(session.accounts).map(([id, a]) => ({
    accountId: id,
    name: (a as { name?: string }).name,
  }));

  const previous = settings.base;
  setConfig(db, "base", base);
  setConfig(db, "accounts", JSON.stringify(accounts));
  if (opts.json) {
    emitJson({ base, previousBase: previous, changed: true, accountId: settings.accountId, accounts });
    return;
  }
  out(`repointed: ${previous} -> ${base}`);
  note(`token and account kept (${session.username} / ${settings.accountId})`);
}

/**
 * Where to point. A `file://` base is an operator's bootstrap bundle, exactly as
 * `init` reads it. No base at all asks the network the same question `login`
 * asks — which is the whole point of the bare form: `login`'s answer TODAY,
 * applied to the config `login` wrote months ago.
 */
async function resolveTarget(settings: Settings, opts: RepointOpts): Promise<string> {
  if (isFileUrl(opts.base)) {
    const boot = loadBootstrap(opts.base);
    const fromFile = boot.base ?? boot.url;
    if (!fromFile) usage(`bootstrap bundle names no base: ${opts.base}`);
    return fromFile;
  }
  if (opts.base) return opts.base;

  // The stored address is the input, so a device configured from a bundle that
  // carried no address is told to name the URL rather than handed a DNS error
  // about the empty string.
  const address = pickAccount(settings).address ?? settings.accounts.find((a) => a.address)?.address;
  if (!address) usage("bullmoose repoint --base <url>  (no stored address to autodiscover from)");
  const found = await resolveJmapBase(address);
  note(
    `discovered ${found.base} (via ${found.via})` +
      (found.redirectedFrom ? ` — ${found.redirectedFrom} redirected the session resource here` : ""),
  );
  return found.base;
}
