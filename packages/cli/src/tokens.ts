import type { DatabaseSync } from "node:sqlite";
import { isFileUrl, loadBootstrap, setConfig } from "./db.js";

/**
 * `bullmoose login` + `bullmoose token` — password-based bootstrap and
 * self-service token management. The password is used once, to mint the
 * device token; only the token is stored (0600 db).
 */

export interface LoginOpts {
  base?: string;
  password?: string;
  name?: string;
  json: boolean;
}

export async function cmdLogin(db: DatabaseSync, email: string | undefined, opts: LoginOpts): Promise<void> {
  // A file:// base is a bootstrap bundle carrying the real server URL
  // (login still goes over the network — it exists to mint a token).
  if (isFileUrl(opts.base)) {
    const boot = loadBootstrap(opts.base);
    opts.base = boot.base ?? boot.url;
  }
  if (!email || !opts.base) {
    console.error("usage: bullmoose login <email> --base <url> [--name <device-name>]");
    process.exit(1);
  }
  const password = opts.password ?? process.env.BULLMOOSE_PASSWORD ?? (await promptHidden("password: "));
  // Stretching happens HERE — the raw password never leaves this process.
  const loginKey = await deriveLoginKey(email, password);

  const res = await fetch(`${opts.base}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, loginKey, name: opts.name ?? deviceName() }),
  });
  if (!res.ok) {
    console.error(`login failed: HTTP ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const body = (await res.json()) as {
    token: string;
    tokenId: string;
    username: string;
    accounts: Array<{ accountId: string; tenantId: string; name: string }>;
  };

  const primary = body.accounts[0];
  if (!primary) {
    console.error(`login ok but ${email} has no accounts — provision one first`);
    process.exit(1);
  }
  setConfig(db, "base", opts.base);
  setConfig(db, "token", body.token);
  setConfig(db, "accountId", primary.accountId);

  console.log(
    `logged in as ${body.username} (token ${body.tokenId}, this device only)\n` +
      `primary account: ${primary.accountId}` +
      (body.accounts.length > 1 ? ` (+${body.accounts.length - 1} more)` : ""),
  );
}

export interface TokenOpts {
  name?: string;
  scopes?: string;
  json: boolean;
}

export async function cmdToken(
  db: DatabaseSync,
  settings: { base: string; token: string },
  args: string[],
  opts: TokenOpts,
): Promise<void> {
  const [verb, arg] = args;
  const headers = { Authorization: `Bearer ${settings.token}`, "content-type": "application/json" };

  if (verb === "create") {
    const scopes = opts.scopes ? opts.scopes.split(",").map((s) => s.trim()) : ["mail"];
    const res = await fetch(`${settings.base}/auth/tokens`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: opts.name ?? "token", scopes }),
    });
    if (!res.ok) fail(`token create failed: HTTP ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { token: string; tokenId: string; scopes: string[] };
    console.log(`created ${body.tokenId} [${body.scopes.join(",")}]`);
    console.log(`\n  ${body.token}\n`);
    console.log("shown once — store it now.");
    return;
  }

  if (verb === "list") {
    const res = await fetch(`${settings.base}/auth/tokens`, { headers });
    if (!res.ok) fail(`token list failed: HTTP ${res.status} ${await res.text()}`);
    const body = (await res.json()) as {
      tokens: Array<{ id: string; name: string; scopes: string; created_at: number; last_used_at: number | null }>;
    };
    if (opts.json) {
      console.log(JSON.stringify(body.tokens, null, 2));
      return;
    }
    for (const t of body.tokens) {
      const lastUsed = t.last_used_at ? new Date(t.last_used_at).toISOString().slice(0, 10) : "never";
      console.log(`${t.id}  ${JSON.parse(t.scopes).join(",").padEnd(20)}  last-used=${lastUsed}  ${t.name}`);
    }
    if (body.tokens.length === 0) console.log("(no tokens)");
    return;
  }

  if (verb === "revoke") {
    if (!arg) fail("usage: bullmoose token revoke <tokenId>");
    const res = await fetch(`${settings.base}/auth/tokens/${arg}`, { method: "DELETE", headers });
    if (!res.ok) fail(`revoke failed: HTTP ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { revoked: boolean };
    console.log(body.revoked ? `revoked ${arg}` : `${arg} not found (or not yours)`);
    return;
  }

  fail("usage: bullmoose token create --name <n> [--scopes a,b] | list | revoke <id>");
}

function deviceName(): string {
  return `${process.env.USER ?? "user"}@${process.env.HOSTNAME ?? "host"}`;
}

/**
 * Client-side key stretching — MUST match packages/auth-core exactly
 * (duplicated here because the CLI can't import workspace TS at runtime):
 *   salt     = SHA-256("bullmoose-login-v1:" + lowercase(email))
 *   loginKey = hex(PBKDF2-HMAC-SHA256(password, salt, 600_000, 256 bits))
 * The server only ever sees/stores (a hash of) the derived key. The
 * ~200-400ms of local CPU is the point: offline crackers pay it per guess,
 * and the Workers Free 10ms CPU cap never does.
 */
export async function deriveLoginKey(email: string, password: string): Promise<string> {
  const enc = new TextEncoder();
  const salt = await crypto.subtle.digest("SHA-256", enc.encode(`bullmoose-login-v1:${email.toLowerCase()}`));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: 600_000 },
    key,
    256,
  );
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Hidden terminal prompt (no echo); falls back to plain stdin when piped. */
export async function promptHidden(msg: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const { readFileSync } = await import("node:fs");
    return readFileSync(0, "utf8").trim();
  }
  process.stderr.write(msg);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve) => {
    let value = "";
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off("data", onData);
          process.stderr.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\x03") process.exit(130); // ^C
        if (ch === "\x7f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    process.stdin.on("data", onData);
  });
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}
