import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import { getConfig, requireSettings, setConfig } from "./db.js";
import {
  emitJson,
  emitNdjson,
  exitCodeForHttpStatus,
  fail,
  note,
  out,
  usage,
  type IoOpts,
} from "./io.js";
import { promptHidden } from "./tokens.js";

/**
 * bullmoose creds — the CLI face of the credential vault (Phase 3).
 * Secrets go UP to the vault (write-only API on the agent worker) and
 * never come back down; `list` shows names/kinds/meta only.
 *
 *   creds init --url <agent-worker-url>       point at the vault host
 *   creds set <name> --kind api-key           secret via --secret,
 *            [--secret-env VAR] [--meta k=v]  $VAR, or hidden prompt
 *   creds list
 *   creds rm <name>
 *   creds oauth <name> --authorize-url U --token-url U --client-id ID
 *            [--client-secret S] [--oauth-scopes "a b"] [--port 8976]
 *     Runs the browser + localhost-callback PKCE flow locally — the CLI
 *     is only the conduit: the refresh token is uploaded to the vault
 *     (kind oauth-refresh, token_url/client_id in meta) and discarded.
 */

export interface CredsOpts extends IoOpts {
  url?: string;
  kind?: string;
  secret?: string;
  secretEnv?: string;
  meta?: string;
  authorizeUrl?: string;
  tokenUrl?: string;
  clientId?: string;
  clientSecret?: string;
  oauthScopes?: string;
  port?: string;
}

export async function cmdCreds(
  db: DatabaseSync,
  positionals: string[],
  opts: CredsOpts,
): Promise<void> {
  const [sub, name] = positionals;

  if (sub === "init") {
    if (!opts.url) usage("bullmoose creds init --url <agent-worker-url>");
    setConfig(db, "vaultUrl", opts.url.replace(/\/$/, ""));
    if (opts.json) emitJson({ vaultUrl: opts.url });
    else out(`vault configured: ${opts.url}`);
    return;
  }

  const settings = requireSettings(db);
  const vaultUrl = getConfig(db, "vaultUrl");
  if (!vaultUrl) {
    fail("vault not configured — run: bullmoose creds init --url <agent-worker-url>");
  }
  const api = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const res = await fetch(`${vaultUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${settings.token}`,
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      fail(
        `vault ${method} ${path} → HTTP ${res.status}: ${await res.text()}`,
        exitCodeForHttpStatus(res.status),
      );
    }
    return res.json();
  };

  switch (sub) {
    case "set": {
      if (!name) usage("bullmoose creds set <name> --kind api-key|oauth-refresh");
      const kind = opts.kind ?? "api-key";
      if (kind !== "api-key" && kind !== "oauth-refresh") {
        usage("--kind must be api-key or oauth-refresh");
      }
      const secret =
        opts.secret ??
        (opts.secretEnv ? process.env[opts.secretEnv] : undefined) ??
        (await promptHidden(`secret for ${name}: `));
      if (!secret) usage("no secret provided");
      const res = await api("PUT", "/vault/credentials", {
        name,
        kind,
        secret,
        meta: parseMeta(opts.meta),
      });
      report(res, opts, () => out(`stored ${name} (${kind}) — write-only, never shown again`));
      return;
    }
    case "list": {
      const res = (await api("GET", "/vault/credentials")) as {
        credentials: Array<{ name: string; kind: string; meta: Record<string, unknown> }>;
      };
      if (opts.json) {
        emitNdjson(res.credentials);
        return;
      }
      for (const c of res.credentials) {
        const meta = Object.keys(c.meta).length > 0 ? `  ${JSON.stringify(c.meta)}` : "";
        out(`${c.name.padEnd(24)} ${c.kind}${meta}`);
      }
      if (res.credentials.length === 0) note("(no credentials)");
      return;
    }
    case "rm": {
      if (!name) usage("bullmoose creds rm <name>");
      if (opts.dryRun) {
        note(`dry run: would delete credential ${name}; nothing was written`);
        if (opts.json) emitJson({ dryRun: true, name });
        return;
      }
      const res = (await api("DELETE", `/vault/credentials/${encodeURIComponent(name)}`)) as {
        deleted: boolean;
      };
      report(res, opts, () => {
        if (res.deleted) out(`deleted ${name}`);
        else note(`${name} not found`);
      });
      return;
    }
    case "oauth": {
      if (!name || !opts.authorizeUrl || !opts.tokenUrl || !opts.clientId) {
        usage(
          "bullmoose creds oauth <name> --authorize-url <url> --token-url <url>\n" +
            '                 --client-id <id> [--client-secret <s>] [--oauth-scopes "a b"] [--port 8976]',
        );
      }
      const refreshToken = await runPkceFlow({
        authorizeUrl: opts.authorizeUrl,
        tokenUrl: opts.tokenUrl,
        clientId: opts.clientId,
        clientSecret: opts.clientSecret,
        scopes: opts.oauthScopes,
        port: Number(opts.port ?? 8976),
      });
      const res = await api("PUT", "/vault/credentials", {
        name,
        kind: "oauth-refresh",
        secret: refreshToken,
        meta: {
          ...parseMeta(opts.meta),
          token_url: opts.tokenUrl,
          client_id: opts.clientId,
          ...(opts.oauthScopes ? { scopes: opts.oauthScopes } : {}),
        },
      });
      report(res, opts, () =>
        out(`refresh token for ${name} uploaded to the vault — not kept locally`),
      );
      return;
    }
    default:
      usage(`unknown creds subcommand: ${sub ?? "(none)"} (init|set|list|rm|oauth)`);
  }
}

// ---- OAuth 2.0 authorization-code + PKCE (RFC 7636) ------------------------

interface PkceFlow {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  scopes?: string;
  port: number;
}

async function runPkceFlow(flow: PkceFlow): Promise<string> {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("base64url");
  const redirectUri = `http://127.0.0.1:${flow.port}/callback`;

  const authUrl = new URL(flow.authorizeUrl);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", flow.clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("access_type", "offline"); // Google: ask for a refresh token
  authUrl.searchParams.set("prompt", "consent");
  if (flow.scopes) authUrl.searchParams.set("scope", flow.scopes);

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", redirectUri);
      if (u.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const err = u.searchParams.get("error");
      const gotState = u.searchParams.get("state");
      const gotCode = u.searchParams.get("code");
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<h3>bullmoose: you can close this tab.</h3>");
      server.close();
      if (err) reject(new Error(`authorization failed: ${err}`));
      else if (gotState !== state) reject(new Error("state mismatch — aborting"));
      else if (!gotCode) reject(new Error("no code in callback"));
      else resolve(gotCode);
    });
    server.on("error", reject);
    server.listen(flow.port, "127.0.0.1", () => {
      note(`listening on ${redirectUri} — opening browser…`);
      note(`if it doesn't open: ${authUrl.toString()}`);
      const opener =
        process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      spawn(opener, [authUrl.toString()], { stdio: "ignore", detached: true }).unref();
    });
    setTimeout(() => {
      server.close();
      reject(new Error("timed out waiting for the OAuth callback (5 min)"));
    }, 300_000).unref();
  });

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: flow.clientId,
    code_verifier: verifier,
    ...(flow.clientSecret ? { client_secret: flow.clientSecret } : {}),
  });
  const res = await fetch(flow.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    fail(
      `token exchange failed: HTTP ${res.status}: ${await res.text()}`,
      exitCodeForHttpStatus(res.status),
    );
  }
  const tokens = (await res.json()) as { refresh_token?: string; access_token?: string };
  if (!tokens.refresh_token) {
    fail(
      "provider returned no refresh_token (check offline access / consent settings); " +
        "nothing was stored",
    );
  }
  return tokens.refresh_token;
}

function parseMeta(raw?: string): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const pair of (raw ?? "").split(",")) {
    const [k, v] = pair.split("=");
    if (k?.trim() && v !== undefined) meta[k.trim()] = v.trim();
  }
  return meta;
}

/** One JSON object under --json, the human rendering otherwise. */
function report(res: unknown, opts: CredsOpts, human: () => void): void {
  if (opts.json) emitJson(res);
  else human();
}
