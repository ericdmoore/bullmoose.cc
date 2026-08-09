import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { getConfig, isFileUrl, loadBootstrap, setConfig } from "./db.js";
import {
  emitIds,
  emitJson,
  emitNdjson,
  exitCodeForHttpStatus,
  fail,
  note,
  out,
  usage,
  type IoOpts,
} from "./io.js";
import { TOKEN_SCOPES, parseScopeFlag } from "./scopes.js";
import { deriveLoginKey, promptHidden } from "./tokens.js";

/**
 * `bullmoose admin <noun> <verb>` — operator surface, wrapping the
 * provision worker's admin API (separate credentials from the mail
 * account: adminUrl/adminToken vs base/token).
 *
 * Noun taxonomy: IMPLEMENTED and DESIGNED below are the single source of
 * truth, used both to dispatch and to render the unknown-command message.
 * The header list used to be hand-written prose and drifted — it called
 * `agent`, `token` and `grant` unbuilt while all three were live, so a typo in
 * `admin grant create` was answered with "grants do not exist"
 * (`.feedback/fromClaude/cli/010` item 1). `admin.test.ts` now diffs
 * IMPLEMENTED against the `case` labels in this file, so it cannot drift again.
 *
 * `share` is BUILT, but as `bullmoose share list|revoke` — not here. sVOL 010
 * put the share records in KV (see services/jmap/src/shares.ts for why), so
 * there is no table and no operator credential involved: revoking a link you
 * minted runs on your own mail token against the jmap worker.
 */

/** Every implemented `admin` command, as `"<noun> <verb>"`. */
export const IMPLEMENTED = [
  "init",
  "password",
  "tenant create",
  "tenant list",
  "tenant rename",
  "tenant delete",
  "domain add",
  "domain status",
  "domain list",
  "domain suspend",
  "domain resume",
  "domain delete",
  "account create",
  "account list",
  "account rename",
  "account delete",
  "agent bind",
  "agent list",
  "agent disable",
  "agent enable",
  "agent unbind",
  "grant create",
  "grant list",
  "grant revoke",
  "token create",
  "token list",
  "token revoke",
] as const;

/**
 * Verbs that cannot be undone by another verb here, and therefore refuse to
 * run without `--yes`.
 *
 * Deliberately NOT an interactive prompt, which the unit file suggested: every
 * other destructive verb on this surface (`grant revoke`, `token revoke`,
 * `mailbox rm`) runs straight through, prompting breaks under `ssh host
 * 'bullmoose …'` and in CI, and the I/O contract has no interactive posture to
 * build on. `--dry-run` is the preview; `--yes` is the confirmation.
 *
 * The reversible verbs — `agent disable|enable`, `domain suspend|resume`, both
 * renames — deliberately do NOT need it. Making the kill switch harder to pull
 * than it has to be defeats the point of having one.
 */
const IRREVERSIBLE = new Set(["tenant delete", "domain delete", "account delete", "agent unbind"]);

/** Designed, not built. Anything here must NOT appear in IMPLEMENTED. */
export const DESIGNED = ["route", "identity", "policy", "suppression"] as const;

export interface AdminOpts extends IoOpts {
  url?: string;
  token?: string;
  tenant?: string;
  name?: string;
  password?: string;
  scopes?: string;
  principal?: string;
  sla?: string;
  /** agent bind: comma-separated allowed sender addresses. */
  allow?: string;
  /** agent bind: "send" | "draft" (cloud runtime default: draft). */
  replyMode?: string;
  /** agent bind: JSON file with persona/modelAliases/defaultModel/maxTokens. */
  config?: string;
  /** grant create: restrict to one address book (AddressBook collection). */
  book?: string;
  /** grant create: expiry in days. */
  expires?: string;
  /** agent disable|enable|unbind: the binding's account, if its id is ambiguous. */
  account?: string;
  /** Required by the irreversible verbs; see IRREVERSIBLE. */
  yes?: boolean;
  /** account list: show tombstoned accounts too. */
  includeDeleted?: boolean;
}

export async function cmdAdmin(
  db: DatabaseSync,
  args: string[],
  opts: AdminOpts,
): Promise<void> {
  const [noun, verb, arg] = args;

  if (noun === "init") {
    // --url also accepts file:///bundle.json ({url, token}); flags win.
    let url = opts.url;
    let token = opts.token;
    if (isFileUrl(url)) {
      const boot = loadBootstrap(url);
      url = boot.url ?? boot.base;
      token = opts.token ?? boot.token;
    }
    if (!url || !token) usage("bullmoose admin init --url <provision-url> --token <admin-token>");
    setConfig(db, "adminUrl", url);
    setConfig(db, "adminToken", token);
    if (opts.json) emitJson({ adminUrl: url });
    else out(`admin configured: ${url}`);
    return;
  }

  const api = adminApi(db);
  requireConfirmation(`${noun} ${verb}`, opts);

  switch (`${noun} ${verb}`) {
    case "tenant create": {
      if (!arg) usage("bullmoose admin tenant create <tenantId> --name <name>");
      const res = await api("POST", "/tenants", { tenantId: arg, name: opts.name ?? arg });
      report(res, opts, () => out(`tenant ${arg} created`));
      return;
    }
    case "tenant list": {
      const res = (await api("GET", "/tenants")) as { tenants: Array<Record<string, unknown>> };
      collection(res.tenants, opts, "id", () => {
        for (const t of res.tenants) out(`${t.id}  ${t.status}  ${t.name}`);
        if (res.tenants.length === 0) note("(no tenants)");
      });
      return;
    }
    case "tenant rename": {
      if (!arg || !opts.name) usage("bullmoose admin tenant rename <tenantId> --name <new name>");
      const res = await api("PATCH", `/tenants/${encodeURIComponent(arg)}`, { name: opts.name });
      report(res, opts, () => out(`tenant ${arg} renamed to "${opts.name}"`));
      return;
    }
    case "tenant delete": {
      if (!arg) usage("bullmoose admin tenant delete <tenantId> --yes");
      if (dryRun(opts, `delete tenant ${arg}`)) return;
      const res = (await api("DELETE", `/tenants/${encodeURIComponent(arg)}`)) as {
        deleted: boolean;
      };
      report(res, opts, () => out(`tenant ${arg} deleted`));
      return;
    }
    case "domain add": {
      if (!arg || !opts.tenant) usage("bullmoose admin domain add <domain> --tenant <tenantId>");
      const res = (await api("POST", "/domains", { tenantId: opts.tenant, domain: arg })) as {
        ok: boolean;
        steps: Array<{ step: string; ok: boolean; detail?: string }>;
      };
      report(res, opts, () => {
        printSteps(res.steps);
        note(res.ok ? `${arg} wired — poll: admin domain status ${arg}` : "some steps failed — re-run after fixing");
      });
      return;
    }
    case "domain status": {
      if (!arg) usage("bullmoose admin domain status <domain>");
      const res = (await api("GET", `/domains/${arg}`)) as Record<string, unknown>;
      report(res, opts, () =>
        out(
          `${arg}: ${res.status} (sending verified: ${res.verifiedForSending}, dkim: ${res.dkimStatus})`,
        ),
      );
      return;
    }
    case "domain list": {
      const res = (await api("GET", "/domains")) as { domains: Array<Record<string, unknown>> };
      collection(res.domains, opts, "domain", () => {
        for (const d of res.domains) out(`${d.domain}  ${d.status}  tenant=${d.tenant_id}`);
        if (res.domains.length === 0) note("(no domains)");
      });
      return;
    }
    case "domain suspend":
    case "domain resume": {
      const status = verb === "suspend" ? "suspended" : "active";
      if (!arg) usage(`bullmoose admin domain ${verb} <domain>`);
      if (dryRun(opts, `set ${arg} to ${status}`)) return;
      const res = (await api("PATCH", `/domains/${encodeURIComponent(arg)}`, { status })) as {
        previousStatus: string;
        steps: Array<{ step: string; ok: boolean; detail?: string }>;
      };
      report(res, opts, () => {
        printSteps(res.steps);
        note(
          status === "suspended"
            ? `${arg} suspended — mail to it now bounces 550 5.1.1; undo with: admin domain resume ${arg}`
            : `${arg} active again`,
        );
      });
      return;
    }
    case "domain delete": {
      if (!arg) usage("bullmoose admin domain delete <domain> --yes");
      if (dryRun(opts, `delete domain ${arg}`)) return;
      const res = (await api("DELETE", `/domains/${encodeURIComponent(arg)}`)) as {
        ok: boolean;
        steps: Array<{ step: string; ok: boolean; detail?: string }>;
      };
      report(res, opts, () => {
        printSteps(res.steps);
        note(
          res.ok
            ? `${arg} deleted`
            : `${arg} deleted from bullmoose, but some external teardown failed — see the ✗ steps above`,
        );
      });
      return;
    }
    case "account create": {
      // arg is local@domain
      const [localpart, domain] = (arg ?? "").split("@");
      if (!localpart || !domain || !opts.tenant) {
        usage("bullmoose admin account create <local@domain> --tenant <tenantId> [--name <display>]");
      }
      const res = (await api("POST", "/accounts", {
        tenantId: opts.tenant,
        domain,
        localpart,
        displayName: opts.name ?? localpart,
        ...(opts.principal ? { principalEmail: opts.principal } : {}),
      })) as { accountId: string; address: string; created: boolean };
      // `POST /accounts` is idempotent since common/024: a retry ADOPTS the
      // existing mailbox and answers `created: false`. Printing "created"
      // unconditionally told an operator a second account had been built —
      // the exact thing that guard exists to prevent.
      report(res, opts, () =>
        out(
          res.created
            ? `account ${res.accountId} created for ${res.address}`
            : `account ${res.accountId} already exists for ${res.address} — nothing was created`,
        ),
      );
      return;
    }
    case "account list": {
      const params = new URLSearchParams();
      if (opts.tenant) params.set("tenant", opts.tenant);
      if (opts.includeDeleted) params.set("includeDeleted", "1");
      const qs = params.size > 0 ? `?${params}` : "";
      const res = (await api("GET", `/accounts${qs}`)) as {
        accounts: Array<Record<string, unknown>>;
      };
      collection(res.accounts, opts, "id", () => {
        for (const a of res.accounts) {
          const tomb = a.deleted_at ? `  DELETED ${new Date(a.deleted_at as number).toISOString().slice(0, 10)}` : "";
          out(
            `${a.id}  ${a.addresses ?? "(no identity)"}  "${a.display_name}"  shard=${a.shard}${tomb}`,
          );
        }
        if (res.accounts.length === 0) note("(no accounts)");
      });
      return;
    }
    case "account rename": {
      if (!arg || !opts.name) usage("bullmoose admin account rename <accountId> --name <display>");
      const res = await api("PATCH", `/accounts/${encodeURIComponent(arg)}`, {
        displayName: opts.name,
      });
      report(res, opts, () => out(`account ${arg} renamed to "${opts.name}"`));
      return;
    }
    case "account delete": {
      if (!arg) usage("bullmoose admin account delete <accountId> --yes");
      if (dryRun(opts, `delete account ${arg}`)) return;
      const res = (await api("DELETE", `/accounts/${encodeURIComponent(arg)}`)) as {
        deleted: boolean;
        addresses?: string[];
        steps?: Array<{ step: string; ok: boolean; detail?: string }>;
        retained?: string[];
        note?: string;
      };
      report(res, opts, () => {
        if (!res.deleted) {
          note(res.note ?? `${arg} was already deleted`);
          return;
        }
        printSteps(res.steps ?? []);
        out(`account ${arg} deleted (${(res.addresses ?? []).join(", ") || "no addresses"})`);
        // What a delete does NOT do is the part an operator has to know: the
        // data plane is a different database and R2 has no GC path at all.
        for (const line of res.retained ?? []) note(`  retained: ${line}`);
        if (res.note) note(res.note);
      });
      return;
    }
    case "agent bind": {
      if (!arg || !opts.name) {
        usage(
          "bullmoose admin agent bind <account-email> --name <binding> [--sla <seconds>]\n" +
            "                       [--allow a@b,c@d] [--reply-mode send|draft] [--config file.json]",
        );
      }
      // --config file is the base; --allow/--reply-mode flags win over it.
      const config: Record<string, unknown> = opts.config
        ? (JSON.parse(readFileSync(opts.config, "utf8")) as Record<string, unknown>)
        : {};
      if (opts.allow) config.allowedSenders = opts.allow.split(",").map((s) => s.trim());
      if (opts.replyMode) {
        if (opts.replyMode !== "send" && opts.replyMode !== "draft") usage("--reply-mode must be send or draft");
        config.replyMode = opts.replyMode;
      }
      const res = (await api("POST", "/agent-bindings", {
        email: arg,
        name: opts.name,
        ...(opts.sla ? { slaSeconds: Number(opts.sla) } : {}),
        ...(Object.keys(config).length > 0 ? { config } : {}),
      })) as { bindingId: string; watchdog: boolean };
      report(res, opts, () =>
        out(`binding ${res.bindingId} (${opts.name}) on ${arg}${res.watchdog ? " + watchdog responder" : ""}`),
      );
      return;
    }
    case "agent list": {
      const qs = arg ? `?email=${encodeURIComponent(arg)}` : "";
      const res = (await api("GET", `/agent-bindings${qs}`)) as { bindings: Array<Record<string, unknown>> };
      collection(res.bindings, opts, "id", () => {
        for (const b of res.bindings) {
          out(`${b.id}  ${b.name}  trigger=${b.trigger_on}  sla=${b.sla_seconds ?? "-"}  ${b.enabled ? "enabled" : "disabled"}`);
        }
        if (res.bindings.length === 0) note("(no bindings)");
      });
      return;
    }
    // ── the kill switch (.feedback/fromClaude/agentic/023) ──────────────
    // Two verbs, not `agent set-enabled <bool>`: mid-incident the dangerous
    // direction must be impossible to typo into its opposite.
    case "agent disable":
    case "agent enable": {
      const enable = verb === "enable";
      if (!arg) {
        usage(
          `bullmoose admin agent ${verb} <binding-id> [--account <account-email>]\n` +
            "                       (binding ids come from: bullmoose admin agent list)",
        );
      }
      if (dryRun(opts, `${verb} agent binding ${arg}`)) return;
      const res = (await api(
        "POST",
        `/agent-bindings/${encodeURIComponent(arg)}/${verb}${accountQuery(opts)}`,
      )) as { name: string; accountId: string; pendingInvocations: number; note: string };
      report(res, opts, () => {
        out(
          `binding ${arg} (${res.name}) on ${res.accountId} is now ${enable ? "ENABLED" : "DISABLED"}`,
        );
        // Queued work is held, never cancelled — surfacing the count is what
        // keeps that from becoming an invisible backlog.
        note(res.note);
        if (!enable) note(`re-enable with: bullmoose admin agent enable ${arg}`);
      });
      return;
    }
    case "agent unbind": {
      if (!arg) usage("bullmoose admin agent unbind <binding-id> [--account <account-email>] --yes");
      if (dryRun(opts, `unbind agent binding ${arg}`)) return;
      const res = (await api(
        "DELETE",
        `/agent-bindings/${encodeURIComponent(arg)}${accountQuery(opts)}`,
      )) as { name: string; steps: Array<{ step: string; ok: boolean; detail?: string }> };
      report(res, opts, () => {
        printSteps(res.steps);
        out(`binding ${arg} (${res.name}) removed`);
      });
      return;
    }
    case "grant create": {
      // args: grant create <grantee-email> <target-email>
      const target = args[3];
      if (!arg || !target) {
        usage(
          "bullmoose admin grant create <grantee-email> <target-email> [--scopes read,contacts]\n" +
            "                          [--book <addressBookId>] [--expires <days>]",
        );
      }
      const scopes = opts.scopes ? opts.scopes.split(",").map((s) => s.trim()) : ["read"];
      const res = (await api("POST", "/grants", {
        granteeEmail: arg,
        targetEmail: target,
        scopes,
        ...(opts.book ? { collection: "AddressBook", collectionId: opts.book } : {}),
        ...(opts.expires ? { expiresDays: Number(opts.expires) } : {}),
      })) as { grantId: string };
      report(res, opts, () =>
        out(
          `grant ${res.grantId}: ${arg} → ${target} [${scopes.join(",")}]` +
            (opts.book ? ` book=${opts.book}` : " (whole account)"),
        ),
      );
      return;
    }
    case "grant list": {
      const qs = arg ? `?email=${encodeURIComponent(arg)}` : "";
      const res = (await api("GET", `/grants${qs}`)) as { grants: Array<Record<string, unknown>> };
      collection(res.grants, opts, "id", () => {
        for (const g of res.grants) {
          const scopes = JSON.parse(g.scopes as string).join(",");
          const scope = g.collection ? `${g.collection}:${g.collection_id}` : "account";
          const exp = g.expires_at ? `  expires ${new Date(g.expires_at as number).toISOString().slice(0, 10)}` : "";
          out(`${g.id}  ${g.grantee_email ?? g.grantee_account_id} → ${g.target_email ?? g.target_account_id}  [${scopes}]  ${scope}${exp}`);
        }
        if (res.grants.length === 0) note("(no grants)");
      });
      return;
    }
    case "grant revoke": {
      if (!arg) usage("bullmoose admin grant revoke <grantId>");
      if (dryRun(opts, `revoke grant ${arg}`)) return;
      const res = (await api("DELETE", `/grants/${arg}`)) as { revoked: boolean };
      report(res, opts, () => {
        if (res.revoked) out(`revoked ${arg}`);
        else note(`${arg} not found`);
      });
      return;
    }
    case "token create": {
      if (!arg || !opts.name) usage("bullmoose admin token create <email> --name <n> --scopes <a,b,c>");
      // REQUIRED, and the operator vocabulary (TOKEN_SCOPES) is the only one
      // that includes `admin`. An operator minting a token for someone
      // else's device is the last place a silent ["mail"] default belongs.
      const parsed = parseScopeFlag(opts.scopes, TOKEN_SCOPES, true);
      if (!parsed.ok || !parsed.scopes) {
        usage(
          (parsed.ok ? "--scopes is required" : parsed.error) +
            "\n\nusage: bullmoose admin token create <email> --name <n> --scopes <a,b,c>",
        );
      }
      const scopes = parsed.scopes;
      const res = (await api("POST", "/tokens", { email: arg, name: opts.name, scopes })) as {
        token: string;
        tokenId: string;
      };
      // Same split as `token create`: the secret alone on stdout, so
      // `T=$(bullmoose admin token create …)` is the whole capture.
      report(res, opts, () => {
        note(`minted ${res.tokenId} for ${arg} [${scopes.join(",")}]`);
        out(res.token);
        note("shown once — deliver it to the device/agent now.");
      });
      return;
    }
    case "token list": {
      const qs = arg ? `?email=${encodeURIComponent(arg)}` : "";
      const res = (await api("GET", `/tokens${qs}`)) as { tokens: Array<Record<string, unknown>> };
      collection(res.tokens, opts, "id", () => {
        for (const t of res.tokens) {
          const scopes = JSON.parse(t.scopes as string).join(",");
          out(`${t.id}  ${t.login_email}  [${scopes}]  ${t.name}`);
        }
        if (res.tokens.length === 0) note("(no tokens)");
      });
      return;
    }
    case "token revoke": {
      if (!arg) usage("bullmoose admin token revoke <tokenId>");
      if (dryRun(opts, `revoke token ${arg}`)) return;
      const res = (await api("DELETE", `/tokens/${arg}`)) as { revoked: boolean };
      report(res, opts, () => {
        if (res.revoked) out(`revoked ${arg}`);
        else note(`${arg} not found`);
      });
      return;
    }
    default: {
      // `admin password <email>` — noun with no separate verb.
      if (noun === "password") {
        const email = verb;
        if (!email) usage("bullmoose admin password <email> [--password <pw>]");
        const password =
          opts.password ?? process.env.BULLMOOSE_PASSWORD ?? (await promptHidden(`new password for ${email}: `));
        // Client-side stretching: the server (and the wire) only ever see
        // the derived key, and the KDF cost stays off the 10ms CPU cap.
        const loginKey = await deriveLoginKey(email, password);
        const res = await api("POST", "/principals/password", { email, loginKey });
        report(res, opts, () => out(`password set for ${email}`));
        return;
      }
      usage(unknownAdminCommand(noun, verb));
    }
  }
}

/**
 * The usage text, DERIVED from the same arrays the dispatcher is checked
 * against. It used to be a hand-written string and went stale: it listed
 * `agent` as unbuilt while `agent bind` and `agent list` were live twenty lines
 * above it, so `admin grnat create` was answered with "grants do not exist".
 */
export function unknownAdminCommand(noun?: string, verb?: string): string {
  return (
    `unknown admin command: ${[noun, verb].filter(Boolean).join(" ") || "(none)"}\n` +
    `implemented: ${IMPLEMENTED.join(" | ")}\n` +
    `designed (not yet built): ${DESIGNED.join(", ")}\n` +
    "share links: see `bullmoose share list|revoke` (mail token, not admin)"
  );
}

function adminApi(db: DatabaseSync) {
  const url = getConfig(db, "adminUrl");
  const token = getConfig(db, "adminToken");
  if (!url || !token) {
    usage("admin not configured — run: bullmoose admin init --url <provision-url> --token <admin-token>");
  }
  return async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      fail(
        `admin API ${method} ${path} → HTTP ${res.status}: ${await res.text()}`,
        exitCodeForHttpStatus(res.status),
      );
    }
    return res.json();
  };
}

/** One JSON object under --json, the human rendering otherwise. */
function report(res: unknown, opts: AdminOpts, human: () => void): void {
  if (opts.json) emitJson(res);
  else human();
}

/** A list result: `--ids` first (§1.8), then NDJSON (§1.3), then the human table. */
function collection(
  rows: Array<Record<string, unknown>>,
  opts: AdminOpts,
  idKey: string,
  human: () => void,
): void {
  if (opts.ids) emitIds(rows.map((r) => String(r[idKey])));
  else if (opts.json) emitNdjson(rows);
  else human();
}

/** §1.7 `--dry-run` for the admin surface's destructive verbs. */
function dryRun(opts: AdminOpts, what: string): boolean {
  if (!opts.dryRun) return false;
  note(`dry run: would ${what}; nothing was written`);
  if (opts.json) emitJson({ dryRun: true, action: what });
  return true;
}

/**
 * Gate the irreversible verbs on `--yes`, before any request goes out.
 *
 * `--dry-run` is exempt: previewing a delete is how you decide to run it, and
 * a preview that itself demands the confirmation flag is a preview nobody uses.
 */
function requireConfirmation(command: string, opts: AdminOpts): void {
  if (!IRREVERSIBLE.has(command) || opts.yes || opts.dryRun) return;
  usage(
    `bullmoose admin ${command} cannot be undone — re-run with --yes\n` +
      `       (or --dry-run to see what it would do first)`,
  );
}

/** `?email=` narrows a binding id to one account; the worker 409s if an id is
 * ambiguous, which is the only case that needs it. */
function accountQuery(opts: AdminOpts): string {
  return opts.account ? `?email=${encodeURIComponent(opts.account)}` : "";
}

/** The `steps[]` ok/detail shape `POST /domains` established, shared by every
 * teardown route so create and delete read the same way. */
function printSteps(steps: Array<{ step: string; ok: boolean; detail?: string }>): void {
  for (const s of steps) out(`${s.ok ? "✓" : "✗"} ${s.step}${s.detail ? `  (${s.detail})` : ""}`);
}
