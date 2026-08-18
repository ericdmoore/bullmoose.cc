import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cmdAdmin, type AdminOpts } from "./admin.js";
import { openDb, setConfig } from "./db.js";
import { EXIT, errorMessage, exitCodeFor } from "./io.js";

/**
 * `admin extractor on` and `admin byok seal` — the last two steps of onboarding
 * a person, which until now were `curl` in `docs/DEPLOY.md`.
 *
 * The properties worth pinning, in the order that would hurt most if they broke:
 *
 *   1. **a provider key is never in argv.** There is no `--key` flag and there
 *      must never be one: a key on the command line is in the shell history, in
 *      `ps`, and in whatever CI log echoed the invocation — and the platform is
 *      built so that nothing can read a sealed key back, which makes such a
 *      disclosure both permanent and unverifiable. It arrives by env-var
 *      REFERENCE or hidden prompt;
 *   2. **the key never comes back out** — not in stdout, not in stderr, not in
 *      the `--json` object. The server promises this (`keyReadable: false`);
 *      the CLI has to keep the same promise about its own rendering, so the
 *      test sweeps both streams for a canary and proves the sweep bites;
 *   3. **the CLI does not restate the server's defaults.** Omitting `--budget`
 *      and `--model` sends NEITHER key, so the $2.00/month cap and the model
 *      slug stay defined in exactly one place (`POST /extractor`). A CLI-side
 *      copy is how two defaults drift apart;
 *   4. `--dry-run` issues no request at all.
 */

const IO = { json: false, ids: false, dryRun: false };
const ADMIN_URL = "http://provision.test";
const ADDRESS = "partner@example.com";

/** A configured operator CLI — `admin init` already run. */
function freshDb() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "bm-onboard-")), "mail.db"));
  setConfig(db, "adminUrl", ADMIN_URL);
  setConfig(db, "adminToken", "admin_secret");
  return db;
}

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown>;
}

let calls: Call[] = [];
let stdout: string[] = [];
let stderr: string[] = [];

/** Stub the global fetch admin.ts reaches for, answering with `reply`. */
function stubApi(reply: Record<string, unknown>): void {
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({
      method: init.method ?? "GET",
      path: new URL(url).pathname,
      body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    });
    return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
  });
}

beforeEach(() => {
  calls = [];
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const outText = () => stdout.join("");
const errText = () => stderr.join("");

const run = (db: ReturnType<typeof openDb>, args: string[], opts: Partial<AdminOpts> = {}) =>
  cmdAdmin(db, args, { ...IO, ...opts });

// ---- extractor on ----------------------------------------------------------

const EXTRACTOR_OK = {
  ok: true,
  created: true,
  accountId: "t_home__a_partner",
  bindingId: "bind_ex1",
  model: "openrouter/minimax/minimax-m3",
};

describe("admin extractor on", () => {
  it("sends only the address when no knob is named — the defaults stay on the server", async () => {
    stubApi(EXTRACTOR_OK);
    await run(freshDb(), ["extractor", "on", ADDRESS]);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", path: "/extractor" });
    // Exactly one key. A CLI that helpfully re-sent `budgetMicros: 2000000`
    // would fork the default: change the route and the CLI keeps the old one.
    expect(calls[0]!.body).toEqual({ email: ADDRESS });
  });

  it("still tells the operator about the cap it did not set", async () => {
    stubApi(EXTRACTOR_OK);
    await run(freshDb(), ["extractor", "on", ADDRESS]);
    // The cap is what makes a paid pipeline safe to turn on; an operator who
    // never sees the number cannot know it is there.
    expect(errText()).toContain("$2.00/month default");
    expect(outText()).toContain("extractor provisioned");
    expect(outText()).toContain("bind_ex1");
  });

  it("maps --provider/--model/--budget/--explore onto the route's own body", async () => {
    stubApi(EXTRACTOR_OK);
    await run(freshDb(), ["extractor", "on", ADDRESS], {
      provider: "workers-ai",
      model: "@cf/qwen/qwen1.5-14b-chat-awq",
      budget: "500000",
      explore: ["openrouter/minimax/minimax-m3", "openrouter/qwen/qwen-2.5-72b-instruct"],
    });

    expect(calls[0]!.body).toEqual({
      email: ADDRESS,
      provider: "workers-ai",
      model: "@cf/qwen/qwen1.5-14b-chat-awq",
      budgetMicros: 500_000,
      // The host is the FIRST segment; everything after it is the model id,
      // which is why a bare `split("/")` would have mangled both of these.
      exploreModels: [
        { provider: "openrouter", model: "minimax/minimax-m3" },
        { provider: "openrouter", model: "qwen/qwen-2.5-72b-instruct" },
      ],
    });
  });

  it("--budget 0 is sent, not treated as absent (0 refuses every paid claim)", async () => {
    stubApi(EXTRACTOR_OK);
    await run(freshDb(), ["extractor", "on", ADDRESS], { budget: "0" });
    expect(calls[0]!.body).toMatchObject({ budgetMicros: 0 });
  });

  it("--dry-run issues no request", async () => {
    stubApi(EXTRACTOR_OK);
    await run(freshDb(), ["extractor", "on", ADDRESS], { dryRun: true });
    expect(calls).toHaveLength(0);
    expect(errText()).toContain("provision the extractor on partner@example.com");
  });

  it("names the re-provision for what it is when the binding already existed", async () => {
    stubApi({ ...EXTRACTOR_OK, created: false, updated: true, model: "openrouter/qwen/qwen-2.5-72b-instruct" });
    await run(freshDb(), ["extractor", "on", ADDRESS], { model: "qwen/qwen-2.5-72b-instruct" });
    expect(outText()).toContain("re-provisioned (model swapped in place)");
  });
});

// ---- byok seal -------------------------------------------------------------

const CANARY = "sk-or-v1-THIS-IS-THE-CANARY-VALUE";

const SEAL_OK = {
  ok: true,
  created: true,
  rotated: false,
  credRef: "openrouter",
  provider: "openrouter",
  allow: "https://openrouter.ai",
  grantId: "grant_1",
  bindings: [{ id: "bind_ex1", name: "extractor" }],
  keyStored: true,
  keyReadable: false,
};

describe("admin byok seal", () => {
  it("takes the key from the env var --key-env NAMES, and sends it once", async () => {
    stubApi(SEAL_OK);
    vi.stubEnv("OR_KEY", CANARY);
    await run(freshDb(), ["byok", "seal", ADDRESS], { keyEnv: "OR_KEY" });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", path: "/provider-keys" });
    expect(calls[0]!.body).toMatchObject({ email: ADDRESS, key: CANARY });
  });

  it("falls back to $BULLMOOSE_PROVIDER_KEY when no variable is named", async () => {
    stubApi(SEAL_OK);
    vi.stubEnv("BULLMOOSE_PROVIDER_KEY", CANARY);
    await run(freshDb(), ["byok", "seal", ADDRESS]);
    expect(calls[0]!.body).toMatchObject({ key: CANARY });
  });

  it("never renders the key — not on stdout, not on stderr, not under --json", async () => {
    stubApi(SEAL_OK);
    vi.stubEnv("OR_KEY", CANARY);
    await run(freshDb(), ["byok", "seal", ADDRESS], { keyEnv: "OR_KEY" });
    await run(freshDb(), ["byok", "seal", ADDRESS], { keyEnv: "OR_KEY", json: true });

    const everything = outText() + errText();
    expect(everything).not.toContain(CANARY);
    // …and not a PREFIX of it either. Four characters of an API key is not a
    // redaction; it is the substring that confirms which key a dump holds.
    expect(everything).not.toContain(CANARY.slice(0, 12));
    // The sweep bites: it would have caught a leak of this shape.
    expect(`whoops ${CANARY} leaked`).toContain(CANARY.slice(0, 12));
    // What IS shown is the handle and the destination — the security-relevant
    // facts, neither of which is a secret.
    expect(outText()).toContain('as "openrouter"');
    expect(outText()).toContain("https://openrouter.ai");
  });

  it("maps --provider/--allow/--name/--expires onto the route's body", async () => {
    stubApi({ ...SEAL_OK, provider: "gateway", allow: "https://gw.example.com", credRef: "gateway" });
    vi.stubEnv("OR_KEY", CANARY);
    await run(freshDb(), ["byok", "seal", ADDRESS], {
      keyEnv: "OR_KEY",
      provider: "gateway",
      allow: "https://gw.example.com",
      name: "extractor",
      expires: "90",
    });
    expect(calls[0]!.body).toMatchObject({
      provider: "gateway",
      allow: "https://gw.example.com",
      bindingName: "extractor",
      expiresDays: 90,
    });
  });

  it("refuses a non-numeric --expires instead of coercing it into 'never expires'", async () => {
    stubApi(SEAL_OK);
    vi.stubEnv("OR_KEY", CANARY);
    // `Number("ninety")` is NaN, which JSON.stringify writes as `null`, which
    // the route reads as no expiry — a grant that outlives its own request.
    const err = await run(freshDb(), ["byok", "seal", ADDRESS], { keyEnv: "OR_KEY", expires: "ninety" }).catch(
      (e: unknown) => e,
    );
    expect(exitCodeFor(err)).toBe(EXIT.USAGE);
    expect(calls).toHaveLength(0);
  });

  it("says ROTATED when the credential already existed — the swap path is the same call", async () => {
    stubApi({ ...SEAL_OK, created: false, rotated: true });
    vi.stubEnv("OR_KEY", CANARY);
    await run(freshDb(), ["byok", "seal", ADDRESS], { keyEnv: "OR_KEY" });
    expect(outText()).toContain("rotated the openrouter key");
  });

  it("surfaces the server's 'nothing names it' note — sealed and unused looks like success", async () => {
    stubApi({ ...SEAL_OK, bindings: [], note: "sealed and granted, but NO binding on … names it yet" });
    vi.stubEnv("OR_KEY", CANARY);
    await run(freshDb(), ["byok", "seal", ADDRESS], { keyEnv: "OR_KEY" });
    expect(errText()).toContain("NO binding");
  });

  it("refuses when the named variable is empty, and sends nothing", async () => {
    stubApi(SEAL_OK);
    vi.stubEnv("OR_KEY", "");

    const err = await run(freshDb(), ["byok", "seal", ADDRESS], { keyEnv: "OR_KEY" }).catch((e: unknown) => e);
    // The message names the VARIABLE, because "--key-env names a variable, not
    // a key" is exactly the mistake this catches — and an operator who passed
    // the key itself would otherwise have sealed the literal string "OR_KEY".
    expect(errorMessage(err)).toContain("$OR_KEY is empty");
    expect(exitCodeFor(err)).toBe(EXIT.USAGE);
    expect(calls).toHaveLength(0);
  });
});
