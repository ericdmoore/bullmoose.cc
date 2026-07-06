import type { DatabaseSync } from "node:sqlite";
import { getConfig, setConfig } from "./db.js";

/**
 * `bullmoose admin <noun> <verb>` — operator surface, wrapping the
 * provision worker's admin API (separate credentials from the mail
 * account: adminUrl/adminToken vs base/token).
 *
 * Noun taxonomy (implemented ✓ / designed ○):
 *   ✓ tenant       create | list
 *   ✓ domain       add | status | list          (drives CF DNS + SES wiring)
 *   ✓ account      create | list                (mailbox provisioning)
 *   ○ route        aliases / forwards / catch-all management
 *   ○ identity     extra from-addresses per account
 *   ○ policy       tenant-scoped delivery policies (§17: quarantine/DLP/retention)
 *   ○ share        list | revoke expiring links  (needs the shares table)
 *   ○ suppression  list | add | remove           (outbound suppression list)
 *   ○ token        app passwords / scoped agent tokens (needs auth service)
 *   ○ agent        register agents, grants, bindings (agent-integration.md §2)
 */

export interface AdminOpts {
  url?: string;
  token?: string;
  tenant?: string;
  name?: string;
  json: boolean;
}

export async function cmdAdmin(
  db: DatabaseSync,
  args: string[],
  opts: AdminOpts,
): Promise<void> {
  const [noun, verb, arg] = args;

  if (noun === "init") {
    if (!opts.url || !opts.token) fail("admin init requires --url and --token");
    setConfig(db, "adminUrl", opts.url);
    setConfig(db, "adminToken", opts.token);
    console.log(`admin configured: ${opts.url}`);
    return;
  }

  const api = adminApi(db);

  switch (`${noun} ${verb}`) {
    case "tenant create": {
      if (!arg) fail("usage: admin tenant create <tenantId> --name <name>");
      const res = await api("POST", "/tenants", { tenantId: arg, name: opts.name ?? arg });
      out(res, opts, () => console.log(`tenant ${arg} created`));
      return;
    }
    case "tenant list": {
      const res = (await api("GET", "/tenants")) as { tenants: Array<Record<string, unknown>> };
      out(res, opts, () => {
        for (const t of res.tenants) console.log(`${t.id}  ${t.status}  ${t.name}`);
        if (res.tenants.length === 0) console.log("(no tenants)");
      });
      return;
    }
    case "domain add": {
      if (!arg || !opts.tenant) fail("usage: admin domain add <domain> --tenant <tenantId>");
      const res = (await api("POST", "/domains", { tenantId: opts.tenant, domain: arg })) as {
        ok: boolean;
        steps: Array<{ step: string; ok: boolean; detail?: string }>;
      };
      out(res, opts, () => {
        for (const s of res.steps) {
          console.log(`${s.ok ? "✓" : "✗"} ${s.step}${s.detail ? `  (${s.detail})` : ""}`);
        }
        console.log(res.ok ? `${arg} wired — poll: admin domain status ${arg}` : "some steps failed — re-run after fixing");
      });
      return;
    }
    case "domain status": {
      if (!arg) fail("usage: admin domain status <domain>");
      const res = (await api("GET", `/domains/${arg}`)) as Record<string, unknown>;
      out(res, opts, () =>
        console.log(
          `${arg}: ${res.status} (sending verified: ${res.verifiedForSending}, dkim: ${res.dkimStatus})`,
        ),
      );
      return;
    }
    case "domain list": {
      const res = (await api("GET", "/domains")) as { domains: Array<Record<string, unknown>> };
      out(res, opts, () => {
        for (const d of res.domains) console.log(`${d.domain}  ${d.status}  tenant=${d.tenant_id}`);
        if (res.domains.length === 0) console.log("(no domains)");
      });
      return;
    }
    case "account create": {
      // arg is local@domain
      const [localpart, domain] = (arg ?? "").split("@");
      if (!localpart || !domain || !opts.tenant) {
        fail("usage: admin account create <local@domain> --tenant <tenantId> [--name <display>]");
      }
      const res = (await api("POST", "/accounts", {
        tenantId: opts.tenant,
        domain,
        localpart,
        displayName: opts.name ?? localpart,
      })) as { accountId: string; address: string };
      out(res, opts, () => console.log(`account ${res.accountId} created for ${res.address}`));
      return;
    }
    case "account list": {
      const qs = opts.tenant ? `?tenant=${encodeURIComponent(opts.tenant)}` : "";
      const res = (await api("GET", `/accounts${qs}`)) as {
        accounts: Array<Record<string, unknown>>;
      };
      out(res, opts, () => {
        for (const a of res.accounts) {
          console.log(`${a.id}  ${a.addresses ?? "(no identity)"}  "${a.display_name}"  shard=${a.shard}`);
        }
        if (res.accounts.length === 0) console.log("(no accounts)");
      });
      return;
    }
    default:
      fail(
        `unknown admin command: ${[noun, verb].filter(Boolean).join(" ") || "(none)"}\n` +
          `implemented: init | tenant create/list | domain add/status/list | account create/list\n` +
          `designed (not yet built): route, identity, policy, share, suppression, token, agent`,
      );
  }
}

function adminApi(db: DatabaseSync) {
  const url = getConfig(db, "adminUrl");
  const token = getConfig(db, "adminToken");
  if (!url || !token) {
    fail("admin not configured — run: bullmoose admin init --url <provision-url> --token <admin-token>");
  }
  return async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) fail(`admin API ${method} ${path} → HTTP ${res.status}: ${await res.text()}`);
    return res.json();
  };
}

function out(res: unknown, opts: AdminOpts, human: () => void): void {
  if (opts.json) console.log(JSON.stringify(res, null, 2));
  else human();
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}
