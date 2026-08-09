import type { DatabaseSync } from "node:sqlite";
import { pickAccount, requireSettings } from "./db.js";
import {
  emitIds,
  emitJson,
  emitNdjson,
  failSetError,
  note,
  out,
  usage,
  type IoOpts,
} from "./io.js";
import { JmapClient } from "./jmap.js";

/**
 * `bullmoose agent invoke|invocations|rm` — the on-demand AgentInvocation
 * trigger (sVOL 007). The human-visible surface that earns the unit its I3:
 * `serve` runs the queue; these three drive it from the outside.
 *
 *   invoke <binding> --email <id>   queue a pending invocation for a binding on
 *                                   an existing message. Routed through
 *                                   `AgentInvocation/set` create, which refuses
 *                                   a DISABLED binding (008 kill switch) — you
 *                                   cannot fire an agent whose off switch is
 *                                   pulled. The drain (this account's
 *                                   `agent serve`, or the cloud runtime on its
 *                                   cron) picks the row up over the changelog.
 *   invocations [<status>]          list the queue (default: pending).
 *   rm <invId>                      purge one invocation (a running one is
 *                                   refused server-side).
 *
 * This runs on the account's OWN mail bearer token (base/token), NOT the
 * operator ADMIN_TOKEN: creating an invocation is a per-principal action behind
 * the `draft` scope, distinct from `admin agent bind|disable|unbind` (008),
 * which is control-plane. `config.yml` files both under the `Agents` noun; the
 * lanes are auth-model, not name.
 */

export interface AgentInvokeOpts extends IoOpts {
  account?: string;
  /** invoke: the message the agent acts on (required). */
  email?: string;
  /** invoke: a human note stored in the invocation context. */
  note?: string;
}

export async function cmdAgentInvoke(
  db: DatabaseSync,
  args: string[],
  opts: AgentInvokeOpts,
): Promise<void> {
  const [verb, arg] = args;
  const settings = requireSettings(db);
  const client = new JmapClient(settings.base, settings.token);
  const account = pickAccount(settings, opts.account);

  switch (verb) {
    case "invoke": {
      if (!arg) {
        usage("bullmoose agent invoke <binding> --email <emailId> [--note <text>]");
      }
      if (!opts.email) usage("agent invoke requires --email <emailId>");
      if (opts.dryRun) {
        note(`dry run: would invoke ${arg} on ${opts.email}; nothing was queued`);
        if (opts.json) emitJson({ dryRun: true, binding: arg, emailId: opts.email });
        return;
      }
      const res = await client.one("AgentInvocation/set", {
        accountId: account.accountId,
        create: {
          c: {
            bindingName: arg,
            emailId: opts.email,
            ...(opts.note ? { note: opts.note } : {}),
          },
        },
      });
      const inv = (res.created as Record<string, Record<string, unknown>>).c;
      if (!inv) {
        // A disabled binding, a nonexistent binding, and a bad emailId each
        // arrive here with a distinct SetError type → distinct exit code.
        failSetError(`invoke ${arg}`, (res.notCreated as Record<string, unknown>).c);
      }
      if (opts.json) {
        emitJson({
          id: inv.id,
          binding: arg,
          emailId: opts.email,
          status: inv.status,
          state: res.newState ?? null,
        });
      } else {
        out(`queued ${String(inv.id)} on ${arg} for ${opts.email} (status: ${String(inv.status)})`);
        note("a runtime claims it over the changelog: `bullmoose agent serve`, or the cloud cron.");
      }
      return;
    }

    case "invocations": {
      // `--status` is already a boolean flag (watch); the filter is a
      // positional here to avoid the collision. Default: pending.
      const status = arg ?? "pending";
      const q = await client.one("AgentInvocation/query", {
        accountId: account.accountId,
        status,
      });
      const ids = q.ids as string[];
      if (opts.ids) {
        emitIds(ids);
        return;
      }
      if (ids.length === 0) {
        note(`(no ${status} invocations)`);
        return;
      }
      const got = await client.one("AgentInvocation/get", {
        accountId: account.accountId,
        ids,
      });
      const list = got.list as Array<Record<string, unknown>>;
      if (opts.json) {
        emitNdjson(list);
        return;
      }
      for (const inv of list) {
        out(
          `${String(inv.id)}  ${String(inv.status).padEnd(7)}  ${String(inv.bindingName)}  ` +
            `${inv.emailId ?? "-"}  ${String(inv.createdAt)}`,
        );
      }
      return;
    }

    case "rm": {
      if (!arg) usage("bullmoose agent rm <invId>");
      if (opts.dryRun) {
        note(`dry run: would remove invocation ${arg}; nothing was written`);
        if (opts.json) emitJson({ dryRun: true, id: arg });
        return;
      }
      const res = await client.one("AgentInvocation/set", {
        accountId: account.accountId,
        destroy: [arg],
      });
      if ((res.destroyed as string[]).includes(arg)) {
        if (opts.json) emitJson({ id: arg, destroyed: true, state: res.newState ?? null });
        else out(`removed ${arg}`);
        return;
      }
      failSetError(`rm ${arg}`, (res.notDestroyed as Record<string, unknown>)[arg]);
      return;
    }

    default:
      usage("bullmoose agent invoke <binding> --email <id> | invocations [<status>] | rm <invId>");
  }
}
