import type { DatabaseSync } from "node:sqlite";
import { getConfig, setConfig } from "./db.js";
import { EXIT, emitIds, emitNdjson, fail, note, out, usage, type IoOpts } from "./io.js";

/**
 * The @local onboarding ladder (s26 — "@local is a PEER dependency"). @local
 * is a HOST: a machine whose LiteLLM/Ollama/vLLM/llama.cpp serve a model list
 * over OpenAI-compat `/v1/models`. The product is complete without one — the
 * ladder only ever DETECTS → CONNECTS → OFFERS → INSTALLS-WITH-CONSENT, in
 * that order, and never installs anything without an explicit yes.
 *
 *   bullmoose models [--host <url>]      the /v1/models sweep (rung-agnostic)
 *   bullmoose local connect --host <url> rung 2 — point at any compat endpoint
 *   bullmoose local setup                rung 1 — probe; connect if found;
 *                                        else offer the managed Ollama install
 *
 * Probe order is LiteLLM (:4000) → Ollama (:11434) → vLLM (:8000) →
 * llama.cpp (:8080): on a homelab that runs LiteLLM it IS the hub (nothing
 * talks to Ollama directly — `hermesModels` is the prior art), and every
 * OpenAI-compat host is equal once running. Ollama is the managed-install
 * choice only because it is the simplest single binary — not a blessed
 * runtime.
 *
 * Everything decisive is pure (probe parsing, the setup decision table, the
 * install plan); process execution and the consent prompt are injected — see
 * SetupDeps — so local.test.ts drives the whole ladder with fakes.
 */

export interface LadderHost {
  /** Human label for findings ("litellm", "ollama", …, or "custom"/"saved"). */
  name: string;
  /** Origin only — `/v1/models` is appended at probe time. */
  base: string;
}

/** The default rung-1 sweep, in the order the plan fixes. */
export const LADDER: LadderHost[] = [
  { name: "litellm", base: "http://localhost:4000" },
  { name: "ollama", base: "http://localhost:11434" },
  { name: "vllm", base: "http://localhost:8000" },
  { name: "llama.cpp", base: "http://localhost:8080" },
];

/** Managed-install starter model: small enough to be "a coffee's worth of
 * download", capable enough to be worth having. */
export const STARTER_MODEL = "llama3.2:3b";

/** Config keys (the CLI's sqlite config table, the admin.ts setConfig pattern). */
export const LOCAL_HOST_KEY = "localHost";
export const LOCAL_HOST_KEY_ENV = "localHostKeyEnv";

export interface HostFinding extends LadderHost {
  /** Something OpenAI-compat answered at `<base>/v1/models`. */
  up: boolean;
  /** It answered 401/403 — present, but wants a key (LiteLLM with a master key). */
  authRequired: boolean;
  models: string[];
  /** Why a host was not counted up (connection refused, timeout, HTTP n). */
  detail?: string;
}

type FetchLike = typeof fetch;

/** Normalize a user-supplied host URL to an origin base: strips trailing
 * slashes and a trailing `/v1` (people paste `http://host:11434/v1`). */
export function normalizeHostBase(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(trimmed)) usage(`--host must be an http(s) URL, got: ${url}`);
  return trimmed.replace(/\/v1$/, "");
}

/** GET `<base>/v1/models` and classify the answer. Never throws — a dead host
 * is a finding, not an exception (the ladder treats down as a quiet skip). */
export async function probeHost(
  host: LadderHost,
  opts: { fetchImpl?: FetchLike; apiKey?: string; timeoutMs?: number } = {},
): Promise<HostFinding> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base: HostFinding = { ...host, up: false, authRequired: false, models: [] };
  try {
    const res = await fetchImpl(`${host.base}/v1/models`, {
      headers: opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {},
      signal: AbortSignal.timeout(opts.timeoutMs ?? 2500),
    });
    if (res.status === 401 || res.status === 403) return { ...base, up: true, authRequired: true };
    if (!res.ok) return { ...base, detail: `HTTP ${res.status} — not an OpenAI-compatible /v1/models` };
    const data = (await res.json()) as { data?: Array<{ id?: unknown }> };
    const models = (data.data ?? []).map((m) => String(m.id ?? "")).filter((id) => id.length > 0);
    return { ...base, up: true, models };
  } catch (err) {
    return { ...base, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Probe a list of hosts, preserving order (the ladder is an ORDER, not a set). */
export async function probeLadder(
  hosts: LadderHost[],
  opts: { fetchImpl?: FetchLike; apiKeyFor?: (h: LadderHost) => string | undefined; timeoutMs?: number } = {},
): Promise<HostFinding[]> {
  return Promise.all(hosts.map((h) => probeHost(h, { ...opts, apiKey: opts.apiKeyFor?.(h) })));
}

// ---- the setup decision table (pure) ---------------------------------------

export type SetupDecision =
  | { kind: "connect"; finding: HostFinding }
  | { kind: "needs-key"; finding: HostFinding }
  | { kind: "offer-install" };

/**
 * Rung 1's brain: FIRST host that answers with a model list wins (probe order
 * is preference order). A host that answers but wants a key still counts as
 * "something is running here" — the ladder will not install a second runtime
 * beside it; it tells the human how to connect instead. Only a silent sweep
 * reaches the offer.
 */
export function decideSetup(findings: HostFinding[]): SetupDecision {
  const open = findings.find((f) => f.up && !f.authRequired);
  if (open) return { kind: "connect", finding: open };
  const keyed = findings.find((f) => f.up && f.authRequired);
  if (keyed) return { kind: "needs-key", finding: keyed };
  return { kind: "offer-install" };
}

// ---- the managed install (plan pure, execution injected) -------------------

export interface InstallPlan {
  /** What gets installed (only ever Ollama — the simplest single binary). */
  runtime: "ollama";
  /** The exact commands, in order — printed verbatim before consent. */
  steps: Array<{ argv: string[]; why: string }>;
  /** Pulled after the runtime answers. */
  starter: string;
  /** Where the runtime will answer once up. */
  base: string;
}

export function installPlan(platform: string): InstallPlan {
  const steps: InstallPlan["steps"] =
    platform === "darwin"
      ? [
          { argv: ["brew", "install", "ollama"], why: "install the Ollama runtime (Homebrew)" },
          { argv: ["brew", "services", "start", "ollama"], why: "start it as a background service" },
        ]
      : platform === "win32"
        ? [{ argv: ["winget", "install", "-e", "--id", "Ollama.Ollama"], why: "install the Ollama runtime (winget)" }]
        : [
            {
              argv: ["sh", "-c", "curl -fsSL https://ollama.com/install.sh | sh"],
              why: "install the Ollama runtime (official installer)",
            },
          ];
  return { runtime: "ollama", steps, starter: STARTER_MODEL, base: "http://localhost:11434" };
}

/** Everything effectful in `local setup`, injected so the ladder is testable
 * end to end without touching the machine. */
export interface SetupDeps {
  fetchImpl?: FetchLike;
  platform?: string;
  /** Run one command, chrome to stderr; resolves to the exit code. */
  exec: (argv: string[]) => Promise<number>;
  /** The consent gate. MUST return false unless a human (or --yes) said yes. */
  confirm: (question: string) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  /** Poll budget for the freshly installed runtime to come up. */
  waitMs?: number;
}

export interface LocalOpts extends IoOpts {
  host?: string;
  keyEnv?: string;
  yes: boolean;
}

// ---- shared bits -----------------------------------------------------------

function resolveKey(keyEnv: string | undefined): string | undefined {
  if (!keyEnv) return undefined;
  const value = process.env[keyEnv];
  if (!value) usage(`--key-env ${keyEnv}: that environment variable is empty (the flag names a reference, not a key)`);
  return value;
}

function savedHost(db: DatabaseSync): { base: string; keyEnv?: string } | null {
  const base = getConfig(db, LOCAL_HOST_KEY);
  if (!base) return null;
  const keyEnv = getConfig(db, LOCAL_HOST_KEY_ENV);
  return { base, keyEnv: keyEnv || undefined };
}

function saveHost(db: DatabaseSync, base: string, keyEnv: string | undefined): void {
  setConfig(db, LOCAL_HOST_KEY, base);
  setConfig(db, LOCAL_HOST_KEY_ENV, keyEnv ?? "");
}

/** Records (arch.md §1.1): the models are the data; everything about finding
 * them is chrome. One line per model, host beside it for the multi-host sweep. */
function emitModels(findings: HostFinding[], io: IoOpts): void {
  const up = findings.filter((f) => f.up && !f.authRequired);
  if (io.ids) {
    emitIds(up.flatMap((f) => f.models));
    return;
  }
  if (io.json) {
    emitNdjson(up.flatMap((f) => f.models.map((id) => ({ host: f.name, base: f.base, id }))));
    return;
  }
  for (const f of up) {
    for (const id of f.models) out(`${id.padEnd(40)} ${f.name}  ${f.base}`);
  }
}

function summarize(findings: HostFinding[]): void {
  const parts = findings.map((f) =>
    f.up
      ? f.authRequired
        ? `${f.name} up (needs a key)`
        : `${f.name} up (${f.models.length} model${f.models.length === 1 ? "" : "s"})`
      : `${f.name} down`,
  );
  note(`probed ${findings.length} host${findings.length === 1 ? "" : "s"}: ${parts.join(", ")}`);
}

// ---- bullmoose models ------------------------------------------------------

export async function cmdModels(db: DatabaseSync, opts: LocalOpts, fetchImpl?: FetchLike): Promise<void> {
  const saved = savedHost(db);
  if (opts.host) {
    // Explicit host: you asked about THIS one, so a dead host is an answer
    // you need to hear — an error, unlike the ladder's quiet skips.
    const base = normalizeHostBase(opts.host);
    const keyEnv = opts.keyEnv ?? (saved && saved.base === base ? saved.keyEnv : undefined);
    const finding = await probeHost({ name: "host", base }, { fetchImpl, apiKey: resolveKey(keyEnv) });
    if (finding.authRequired) {
      fail(`${base} answers but requires a key — retry with --key-env <NAME>`, EXIT.AUTH);
    }
    if (!finding.up) fail(`${base}: ${finding.detail ?? "no answer"}`, EXIT.FAIL);
    emitModels([finding], opts);
    note(`${base}: ${finding.models.length} model(s)`);
    return;
  }

  // The sweep: the saved @local host first (it is the one you USE), then the
  // ladder's defaults, deduped. A host down is a quiet skip, not an error.
  const hosts: LadderHost[] = [];
  if (saved) hosts.push({ name: "@local (saved)", base: saved.base });
  for (const h of LADDER) if (!hosts.some((x) => x.base === h.base)) hosts.push(h);
  const findings = await probeLadder(hosts, {
    fetchImpl,
    apiKeyFor: (h) => (saved && h.base === saved.base ? resolveKey(saved.keyEnv) : undefined),
  });
  emitModels(findings, opts);
  summarize(findings);
  if (!findings.some((f) => f.up)) {
    note("no local model host found — `bullmoose local setup` can install one (with your consent)");
  }
}

// ---- bullmoose local -------------------------------------------------------

export async function cmdLocal(db: DatabaseSync, args: string[], opts: LocalOpts, deps?: SetupDeps): Promise<void> {
  const verb = args[0];
  if (verb === "connect") {
    await localConnect(db, opts, deps?.fetchImpl);
    return;
  }
  if (verb === "setup") {
    await localSetup(db, opts, deps ?? { exec: execToStderr, confirm: defaultConfirm(opts) });
    return;
  }
  usage("bullmoose local setup [--yes] | connect --host <url> [--key-env <NAME>]");
}

/** Rung 2: point at ANY OpenAI-compat endpoint; discovery does the rest. */
async function localConnect(db: DatabaseSync, opts: LocalOpts, fetchImpl?: FetchLike): Promise<void> {
  if (!opts.host) usage("bullmoose local connect --host <url> [--key-env <NAME>]");
  const base = normalizeHostBase(opts.host);
  const finding = await probeHost({ name: "host", base }, { fetchImpl, apiKey: resolveKey(opts.keyEnv) });
  if (finding.authRequired) {
    fail(
      `${base} answers but requires a key — pass --key-env <NAME> (an env reference; the key is never stored)`,
      EXIT.AUTH,
    );
  }
  if (!finding.up) fail(`${base}: ${finding.detail ?? "no answer at /v1/models"}`, EXIT.FAIL);
  if (opts.dryRun) {
    note(`dry run: would save ${base} as the @local host (${finding.models.length} models); nothing written`);
    if (opts.json) emitNdjson([{ dryRun: true, base, models: finding.models.length }]);
    return;
  }
  saveHost(db, base, opts.keyEnv);
  emitModels([finding], opts);
  note(`connected: ${base} is the @local host (${finding.models.length} models) — saved`);
}

/** Rung 1: probe first; connect if anything answers; only then OFFER. */
async function localSetup(db: DatabaseSync, opts: LocalOpts, deps: SetupDeps): Promise<void> {
  const fetchImpl = deps.fetchImpl;
  const saved = savedHost(db);
  const hosts: LadderHost[] = [];
  if (saved) hosts.push({ name: "@local (saved)", base: saved.base });
  for (const h of LADDER) if (!hosts.some((x) => x.base === h.base)) hosts.push(h);

  note("probing for a local model host (LiteLLM :4000 → Ollama :11434 → vLLM :8000 → llama.cpp :8080)…");
  const findings = await probeLadder(hosts, {
    fetchImpl,
    apiKeyFor: (h) => (saved && h.base === saved.base ? resolveKey(saved.keyEnv) : undefined),
  });
  summarize(findings);

  const decision = decideSetup(findings);
  if (decision.kind === "connect") {
    const f = decision.finding;
    saveHost(db, f.base, saved && f.base === saved.base ? saved.keyEnv : undefined);
    emitModels([f], opts);
    note(
      `connected: ${f.name} at ${f.base} (${f.models.length} models) — saved as the @local host. Nothing to install.`,
    );
    return;
  }
  if (decision.kind === "needs-key") {
    const f = decision.finding;
    fail(
      `${f.name} is running at ${f.base} but wants a key — not installing a second runtime beside it.\n` +
        `Connect it instead:  bullmoose local connect --host ${f.base} --key-env <NAME>`,
      EXIT.AUTH,
    );
  }

  // Nothing answered → the OFFER. Print exactly what would run, then ask.
  const plan = installPlan(deps.platform ?? process.platform);
  note("");
  note("No local model host found. I can install Ollama — one program, and a");
  note(`starter model (${plan.starter}, ~a coffee's worth of download). It would run:`);
  note("");
  for (const s of plan.steps) note(`  $ ${s.argv.join(" ")}    # ${s.why}`);
  note(`  $ ollama pull ${plan.starter}    # fetch the starter model`);
  note("");
  const consent = await deps.confirm("proceed with the install? [y/N] ");
  if (!consent) {
    note("nothing installed. The cloud staff keeps working without @local;");
    note("re-run `bullmoose local setup` any time, or `--yes` to pre-approve.");
    return;
  }

  for (const s of plan.steps) {
    note(`running: ${s.argv.join(" ")}`);
    const code = await deps.exec(s.argv);
    if (code !== 0) fail(`"${s.argv.join(" ")}" exited ${code} — install incomplete, nothing connected`, EXIT.FAIL);
  }

  // Wait for the runtime to answer, then pull the starter and connect.
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (deps.waitMs ?? 120_000);
  let ready = await probeHost({ name: plan.runtime, base: plan.base }, { fetchImpl });
  while (!ready.up && Date.now() < deadline) {
    await sleep(2000);
    ready = await probeHost({ name: plan.runtime, base: plan.base }, { fetchImpl });
  }
  if (!ready.up) {
    fail(
      `${plan.runtime} installed but ${plan.base} never answered — start it, then: bullmoose local connect --host ${plan.base}`,
      EXIT.FAIL,
    );
  }

  note(`pulling starter model ${plan.starter}…`);
  const pull = await deps.exec(["ollama", "pull", plan.starter]);
  if (pull !== 0) fail(`"ollama pull ${plan.starter}" exited ${pull}`, EXIT.FAIL);

  const finding = await probeHost({ name: plan.runtime, base: plan.base }, { fetchImpl });
  saveHost(db, plan.base, undefined);
  emitModels([finding], opts);
  note(`connected: ${plan.runtime} at ${plan.base} (${finding.models.length} models) — saved as the @local host`);
}

// ---- default effect implementations (main.ts wires these) ------------------

/** Child stdout goes to OUR stderr — an installer's chatter is chrome, and
 * stdout stays reserved for records (§1.1). stdin inherits for sudo prompts. */
export async function execToStderr(argv: string[]): Promise<number> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ["inherit", process.stderr, process.stderr] });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

/** The consent gate: `--yes` is explicit consent (the plan was printed first);
 * otherwise a TTY gets the y/N question and a pipe gets a refusal — an install
 * must never ride in on a script that did not say so. */
export function defaultConfirm(opts: { yes: boolean }): (question: string) => Promise<boolean> {
  return async (question: string) => {
    if (opts.yes) return true;
    if (!process.stdin.isTTY) {
      note("not a terminal and no --yes: treating that as a no");
      return false;
    }
    const { createInterface } = await import("node:readline/promises");
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const answer = await rl.question(question);
      return /^y(es)?$/i.test(answer.trim());
    } finally {
      rl.close();
    }
  };
}
