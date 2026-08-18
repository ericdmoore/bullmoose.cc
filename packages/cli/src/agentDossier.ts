import type { DatabaseSync } from "node:sqlite";
import { accountLabel, getConfig, pickAccount, requireSettings, type AccountRef } from "./db.js";
import {
  EXIT,
  emitIds,
  emitJson,
  exitFlushed,
  fail,
  failSetError,
  notFound,
  note,
  out,
  usage,
  type ExitCode,
  type IoOpts,
} from "./io.js";
import { JmapClient } from "./jmap.js";

/**
 * `bullmoose agent show|budget|model|backfill|enable|disable` — the DOSSIER
 * verbs (s26 T6, the CLI half of T1's read surface).
 *
 * The discriminator the plan fixes: *"just because the data is settable doesn't
 * make it a Settings."* A value that means nothing once this agent is deleted
 * lives on the agent's DOSSIER, and settable is a VERB on that dossier — the
 * way renaming a contact happens on the card. So these are verbs on ONE named
 * binding, never a config file and never a global preference. Eric: **"the CLI
 * is the claimant"** — the same terminal that runs `agent serve` must be able
 * to read and tune the agent it is running.
 *
 * ── The three planes, and why a verb lives on the one it does ───────────────
 *
 * There is no single door behind these verbs, and pretending otherwise is the
 * one thing this module must not do. What exists today:
 *
 *   READ      `GET {base}/console/agents/{accountId}` — the console projection
 *             (services/jmap/src/console.ts, s03.E + s26 T1). SESSION-reachable
 *             on the login's own mail token: `read` scope, owner-only, refused
 *             outright to agent-marked tokens. Every read verb here is that one
 *             document, sliced.
 *
 *   ENABLE    `AgentBinding/set` (services/jmap/src/methods/agentBinding.ts,
 *   DISABLE   landed #198). SESSION-reachable, gated on the `send` scope —
 *             which a plain human token holds and a supervisory grant does not.
 *             The kill switch is the ONE mutation a session can make.
 *
 *   BUDGET    the provision worker, behind its ADMIN_TOKEN (`adminUrl` /
 *   MODEL     `adminToken`, the credentials `bullmoose admin init` stores).
 *   BACKFILL  `AgentBinding/set` refuses `budgets` and `modelAliases` BY NAME
 *             and says where each lives (BINDING_MUTATION_OWNERS), and
 *             `PATCH /agent-bindings` refuses `config_json` by design. So the
 *             money and the menu are operator-plane, and this module says so
 *             in those words rather than failing with a shrug.
 *
 * A door the configured credentials cannot reach is reported as UNREACHABLE
 * with the exact call that would work — never attempted-and-swallowed, never
 * reported as success. `--json` carries the same answer as a `doors` block, so
 * an agent scripting this surface can decide before it tries.
 *
 * ── The re-provision hazard, surfaced rather than papered over ──────────────
 *
 * `POST /extractor` is the *sanctioned* model-swap path (devPlan: "swap model
 * (re-provision-in-place, the sanctioned path)"), and it rewrites the binding's
 * whole config from its arguments — including `enabled = 1`. Two consequences
 * this module refuses to let a caller walk into blind:
 *
 *   1. every field not re-sent is LOST, so `budget --set` and `model --set` are
 *      read-modify-writes: the current menu, explore arms, rate, maxTokens and
 *      budget are read back from the operator plane and re-sent unchanged;
 *   2. it RE-ENABLES a disabled binding. Pulling the kill switch and then
 *      tuning the budget would silently un-pull it, so a re-provision of a
 *      disabled binding is refused (exit 5) unless `--yes` says the re-enable
 *      is intended.
 */

// ── the wire shapes we consume ───────────────────────────────────────────────
//
// A CLI-side subset of the console projection (packages/cli has no workspace
// deps by design — package.json: `marked` only). Every field here is one the
// projection already serves; nothing is derived server-side that we re-derive.

export interface DossierBindingConfig {
  pipeline: string | null;
  replyMode: string | null;
  hasPersona?: boolean;
  senderAllowlist?: { active: boolean; count?: number };
  modelAliasCount?: number;
  configUnparseable?: boolean;
}

export interface DossierModelMenuEntry {
  alias: string;
  /** `host/model` strings in fallback order — names, never keys. */
  candidates: string[];
}

export interface DossierBindingEconomics {
  /** `$.budgets.spendPerMonth`, µUSD. null = no monthly cap configured. */
  budgetMicros: number | null;
  defaultModel: string | null;
  modelMenu: DossierModelMenuEntry[];
  /** `$.frontier.exploreRate` (s26 T5a). null = frontier assignment off. */
  exploreRate: number | null;
}

export interface DossierBinding {
  bindingId: string;
  name: string;
  triggerOn: string;
  slaSeconds: number | null;
  enabled: boolean;
  config: DossierBindingConfig;
  economics: DossierBindingEconomics;
}

export interface DossierLedger {
  bindingId: string;
  pending: number;
  running: number;
  done: number;
  failed: number;
  oldestPendingAt: number | null;
  monthSpendMicros: number;
  monthOverageMicros: number;
}

export interface DossierInvocation {
  invocationId: string;
  bindingId: string;
  bindingName: string;
  status: string;
  emailId: string | null;
  note: string | null;
  createdAt: number;
  doneAt: number | null;
  /** s07 T5, frozen at capture. NULL ≠ 0: null = undetermined, 0 = free. */
  costMicros: number | null;
  model: string | null;
}

export interface Dossier {
  accountId: string;
  principalId: string;
  principal: string;
  tokenScopes: string[];
  bindings: DossierBinding[];
  invocations: DossierInvocation[];
  ledgers: DossierLedger[];
  ledgerMonthStart: number;
}

/** The binding row `GET /agent-bindings` serves (operator plane, raw config). */
interface AdminBindingRow {
  id: string;
  account_id: string;
  name: string;
  enabled: number;
  config_json: string;
}

export interface DossierOpts extends IoOpts {
  account?: string;
  /** `budget --set <µUSD>` / `model --set <host>/<model>`. */
  set?: string;
  /** `model --explore <host>/<model>` — repeatable; REPLACES the arms. */
  explore?: string[];
  /** `backfill --since <YYYY-MM-DD|ISO|Nd>` — required; never defaulted. */
  since?: string;
  /** `backfill --budget <µUSD>` — the backfill's own envelope. */
  budget?: string;
  /** `backfill --request-floor` — mint the approval INSTEAD of backfilling. */
  requestFloor?: boolean;
  /** Consent to the re-provision's re-enable of a disabled binding. */
  yes?: boolean;
}

/** Every effect, injected — so the whole surface is testable with no network
 *  (agentDossier.test.ts drives all six verbs against fakes). */
export interface DossierDeps {
  fetchImpl?: typeof fetch;
  /** The seam `enable`/`disable` drive; defaults to a real JmapClient. */
  jmap?: { one(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> };
  now?: () => number;
}

const DAY_MS = 86_400_000;

// ── reads: one document, sliced ──────────────────────────────────────────────

/** An error carrying the transport status, so `io.exitCodeFor` maps it (§1.5). */
function httpError(message: string, status: number): Error {
  const err = new Error(message) as Error & { httpStatus: number };
  err.httpStatus = status;
  return err;
}

/** The console dossier's URL — also the `_self` every `--json` payload carries. */
export function dossierHref(base: string, accountId: string): string {
  return `${base.replace(/\/+$/, "")}/console/agents/${encodeURIComponent(accountId)}`;
}

/**
 * `GET /console/agents/{accountId}` on the login's own token.
 *
 * The refusal body is surfaced VERBATIM: the console answers a scope failure,
 * an agent-marked token and a non-owned account with three different sentences,
 * and re-wording any of them into "forbidden" would throw away the only part a
 * human needs.
 */
export async function fetchDossier(
  base: string,
  token: string,
  accountId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Dossier> {
  const href = dossierHref(base, accountId);
  const res = await fetchImpl(href, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  if (!res.ok) {
    let detail = text.trim();
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (typeof parsed.error === "string") detail = parsed.error;
    } catch {
      /* not JSON — the raw body is the best we have */
    }
    throw httpError(`GET /console/agents/${accountId} → HTTP ${res.status}: ${detail}`, res.status);
  }
  return JSON.parse(text) as Dossier;
}

/**
 * `<binding>` names either the binding id or its name, resolved ON ONE ACCOUNT
 * (cli/009: the account comes from `--account` through `pickAccount`, exactly
 * as everywhere else — this verb acts on one agent, so it never fans out).
 *
 * Id first, then exact name, then case-insensitive name. Two bindings sharing a
 * name on one account is refused rather than picked from: silently choosing by
 * enumeration order is the cli/009 bug in a different noun.
 */
export function findBinding(dossier: Dossier, selector: string): DossierBinding {
  const byId = dossier.bindings.find((b) => b.bindingId === selector);
  if (byId) return byId;
  const exact = dossier.bindings.filter((b) => b.name === selector);
  const matches =
    exact.length > 0 ? exact : dossier.bindings.filter((b) => b.name.toLowerCase() === selector.toLowerCase());
  if (matches.length > 1) {
    usage(
      `"${selector}" matches ${matches.length} bindings on ${dossier.accountId}; name one by id:\n` +
        matches.map((b) => `  ${b.bindingId}  ${b.name}`).join("\n"),
    );
  }
  if (matches.length === 0) {
    notFound(
      `no binding "${selector}" on ${dossier.accountId}. This account carries: ` +
        (dossier.bindings.length === 0
          ? "(none)"
          : dossier.bindings.map((b) => `${b.name} (${b.bindingId})`).join(", ")) +
        `\nAnother account's agent needs --account <selector>.`,
    );
  }
  return matches[0]!;
}

/** The ledger row for a binding. Absent means all-zero, NOT unknown — the
 *  projection omits a binding that has never been invoked (console.ts). */
export function ledgerFor(dossier: Dossier, bindingId: string): DossierLedger {
  return (
    dossier.ledgers.find((l) => l.bindingId === bindingId) ?? {
      bindingId,
      pending: 0,
      running: 0,
      done: 0,
      failed: 0,
      oldestPendingAt: null,
      monthSpendMicros: 0,
      monthOverageMicros: 0,
    }
  );
}

/**
 * The budget envelope, in the SAME arithmetic the claim gate enforces
 * (`budgetExhaustedSql`, mirrored by the console's `readLedgers`): completed
 * spend this cycle, plus approved overage headroom (s11 T9), against the cap.
 *
 * `remainingMicros` is null when no cap is configured — "unbounded" and "zero
 * left" must never render the same, and NULL-cost invocations (undetermined,
 * never a flattering 0) are excluded from `spent` upstream, so the number here
 * is the one that actually decides when paid claims stop.
 */
export function budgetView(binding: DossierBinding, ledger: DossierLedger, monthStartMs: number) {
  const capMicros = binding.economics.budgetMicros;
  return {
    currency: "USD",
    capMicros,
    spentMicros: ledger.monthSpendMicros,
    overageMicros: ledger.monthOverageMicros,
    remainingMicros: capMicros === null ? null : capMicros + ledger.monthOverageMicros - ledger.monthSpendMicros,
    monthStartMs,
  };
}

/**
 * The binding's effective history floor — a MIRROR of provision's
 * `effectiveHistoryFloor` (services/provision/src/index.ts, s26 T3). Kept in
 * sync by intent, not by import: the two workers share no module and the CLI
 * has no workspace deps.
 *
 * `historyFloor` (an APPROVED widening) wins over `createdAt` (the binding's
 * birth, the default floor); neither means the floor is UNKNOWN, and unknown is
 * not "unbounded" — backfill fails closed there and points at floor-request.
 */
export function effectiveFloor(config: Record<string, unknown>): {
  floorMs: number | null;
  source: "historyFloor" | "createdAt" | null;
} {
  if (typeof config.historyFloor === "number" && Number.isFinite(config.historyFloor)) {
    return { floorMs: config.historyFloor, source: "historyFloor" };
  }
  if (typeof config.createdAt === "number" && Number.isFinite(config.createdAt)) {
    return { floorMs: config.createdAt, source: "createdAt" };
  }
  return { floorMs: null, source: null };
}

// ── the doors table: what this credential can actually open ──────────────────

export interface Door {
  /** The exact call behind the verb. */
  door: string;
  plane: "session" | "operator";
  /** What the door itself gates on, in the server's own vocabulary. */
  requires: string;
  /** Whether the CLI HOLDS a credential for that plane. Not a prediction about
   *  the server's answer — a statement about configuration. */
  configured: boolean;
  /** Present when this verb cannot reach this binding at all. */
  unavailable?: string;
}

/** `POST /extractor` provisions the binding literally named `extractor`; it is
 *  the only config-write door that exists, so any other binding's budget and
 *  menu have NO door. Named here once so the refusal and the doors block agree. */
export const REPROVISION_BINDING = "extractor";

export function noConfigDoor(bindingName: string): string {
  return (
    `no door writes config for binding "${bindingName}": AgentBinding/set v1 writes only \`enabled\`, ` +
    `PATCH /agent-bindings refuses config_json by design, and POST /extractor provisions the ` +
    `"${REPROVISION_BINDING}" binding only`
  );
}

export function doorsFor(binding: DossierBinding, adminConfigured: boolean): Record<string, Door> {
  const reprovisionable = binding.name === REPROVISION_BINDING;
  const configDoor = (): Door => ({
    door: "POST {adminUrl}/extractor (re-provision-in-place)",
    plane: "operator",
    requires: "ADMIN_TOKEN",
    configured: adminConfigured,
    ...(reprovisionable ? {} : { unavailable: noConfigDoor(binding.name) }),
  });
  return {
    show: {
      door: "GET {base}/console/agents/{accountId}",
      plane: "session",
      requires: "read scope, account owner",
      configured: true,
    },
    enable: {
      door: "AgentBinding/set { update: { <id>: { enabled } } }",
      plane: "session",
      requires: "send scope (supervisory grants and agent tokens lack it)",
      configured: true,
    },
    disable: {
      door: "AgentBinding/set { update: { <id>: { enabled } } }",
      plane: "session",
      requires: "send scope (supervisory grants and agent tokens lack it)",
      configured: true,
    },
    budget: configDoor(),
    model: configDoor(),
    backfill: {
      door: "POST {adminUrl}/agent-bindings/{id}/backfill",
      plane: "operator",
      requires: "ADMIN_TOKEN",
      configured: adminConfigured,
    },
  };
}

// ── formatting ───────────────────────────────────────────────────────────────

/** µUSD → dollars. Sub-cent amounts keep six places: a per-invocation cost of
 *  2100µ is $0.0021, and rounding it to $0.00 is the money-honesty failure. */
export function usd(micros: number | null | undefined): string {
  if (micros === null || micros === undefined) return "—";
  return `$${(micros / 1_000_000).toFixed(micros !== 0 && Math.abs(micros) < 10_000 ? 6 : 2)}`;
}

const stamp = (ms: number | null | undefined): string =>
  ms === null || ms === undefined || !Number.isFinite(ms)
    ? "—"
    : new Date(ms).toISOString().slice(0, 16).replace("T", " ");

const field = (label: string, value: string): void => out(`${label.padEnd(12)}${value}`);

// ── agent show ───────────────────────────────────────────────────────────────

export interface ShowContext {
  base: string;
  account: AccountRef;
  adminUrl?: string;
  /** From the operator plane when it is reachable; null when it is not. */
  floor: { floorMs: number | null; source: string | null } | null;
  /** Why the floor is absent, when it is. */
  floorNote: string;
  /** How many recent invocations to carry. */
  limit: number;
}

/**
 * The whole dossier as one object (§1.3: `--json` on a show-style command is
 * exactly one JSON value).
 *
 * HAL follows the house convention — the explorer's (services/jmap/src/explore):
 * `_self` is the document this was read from, and `_links` entries are DERIVED
 * FROM IDS THE PAYLOAD ALREADY CARRIES, never invented. A link whose id is
 * absent is omitted rather than fabricated, which is why `lifecycle` appears
 * only when the operator plane is configured: a link nobody can follow is worse
 * than no link.
 */
export function buildShow(dossier: Dossier, binding: DossierBinding, ctx: ShowContext): Record<string, unknown> {
  const ledger = ledgerFor(dossier, binding.bindingId);
  const invocations = dossier.invocations.filter((i) => i.bindingId === binding.bindingId).slice(0, ctx.limit);
  const self = dossierHref(ctx.base, dossier.accountId);
  const links: Record<string, unknown> = {
    account: { href: self, type: "AgentDossier", id: dossier.accountId },
    agents: { href: `${ctx.base.replace(/\/+$/, "")}/console/agents`, type: "AgentDossier", list: true },
  };
  if (ctx.adminUrl) {
    links.lifecycle = {
      href: `${ctx.adminUrl.replace(/\/+$/, "")}/agent-bindings/${encodeURIComponent(binding.bindingId)}/lifecycle`,
      type: "BindingLifecycle",
      id: binding.bindingId,
    };
  }
  return {
    _self: self,
    accountId: dossier.accountId,
    account: accountLabel(ctx.account),
    address: ctx.account.address ?? null,
    principal: dossier.principal,
    binding: {
      bindingId: binding.bindingId,
      name: binding.name,
      enabled: binding.enabled,
      triggerOn: binding.triggerOn,
      slaSeconds: binding.slaSeconds,
      pipeline: binding.config.pipeline,
      replyMode: binding.config.replyMode,
      hasPersona: binding.config.hasPersona ?? null,
      senderAllowlist: binding.config.senderAllowlist ?? null,
      configUnparseable: binding.config.configUnparseable ?? false,
    },
    models: {
      defaultModel: binding.economics.defaultModel,
      menu: binding.economics.modelMenu,
      exploreRate: binding.economics.exploreRate,
    },
    budget: budgetView(binding, ledger, dossier.ledgerMonthStart),
    ledger: {
      pending: ledger.pending,
      running: ledger.running,
      done: ledger.done,
      failed: ledger.failed,
      oldestPendingAt: ledger.oldestPendingAt,
    },
    invocations,
    backfill: {
      floorMs: ctx.floor?.floorMs ?? null,
      floorSource: ctx.floor?.source ?? null,
      note: ctx.floorNote,
    },
    doors: doorsFor(binding, !!ctx.adminUrl),
    _links: links,
  };
}

function renderShow(view: Record<string, unknown>): void {
  const b = view.binding as Record<string, unknown>;
  const m = view.models as { defaultModel: string | null; menu: DossierModelMenuEntry[]; exploreRate: number | null };
  const bud = view.budget as ReturnType<typeof budgetView>;
  const led = view.ledger as {
    pending: number;
    running: number;
    done: number;
    failed: number;
    oldestPendingAt: number | null;
  };
  const back = view.backfill as { floorMs: number | null; floorSource: string | null; note: string };
  const invs = view.invocations as DossierInvocation[];

  field("binding", `${String(b.name)}  (${String(b.bindingId)})`);
  field("account", `${String(view.account)}  (${String(view.accountId)})`);
  field("enabled", b.enabled ? "yes" : "NO — disabled (queued work is held, not cancelled)");
  field(
    "pipeline",
    `${String(b.pipeline ?? "—")}   reply mode: ${String(b.replyMode ?? "—")}   trigger: ${String(b.triggerOn)}`,
  );
  if (m.menu.length === 0) {
    field("model", "— (no menu configured)");
  } else {
    for (const [i, entry] of m.menu.entries()) {
      const primary = entry.candidates[0] ?? "—";
      const mark = entry.alias === m.defaultModel ? "*" : " ";
      field(i === 0 ? "model" : "", `${mark}${entry.alias}: ${primary}`);
      for (const arm of entry.candidates.slice(1)) field("", `  explore → ${arm}`);
    }
    if (m.exploreRate !== null) field("", `  explore rate ${m.exploreRate}`);
  }
  field(
    "budget",
    bud.capMicros === null
      ? `no monthly cap configured — spent ${usd(bud.spentMicros)} this cycle`
      : `${usd(bud.capMicros)}/month · spent ${usd(bud.spentMicros)} · overage ${usd(bud.overageMicros)} · ` +
          `remaining ${usd(bud.remainingMicros)}`,
  );
  field("", `cycle from ${stamp(bud.monthStartMs)} UTC`);
  field(
    "queue",
    `pending ${led.pending} · running ${led.running} · done ${led.done} · failed ${led.failed}` +
      (led.oldestPendingAt === null ? "" : `   oldest pending ${stamp(led.oldestPendingAt)}`),
  );
  field("backfill", back.floorMs === null ? back.note : `floor ${stamp(back.floorMs)} (${back.floorSource})`);
  if (invs.length === 0) {
    field("recent", "(no invocations)");
    return;
  }
  field("recent", `${invs.length} most recent invocation(s)`);
  for (const inv of invs) {
    out(
      `  ${inv.invocationId}  ${inv.status.padEnd(7)}  ` +
        `${(inv.costMicros === null ? "not recorded" : usd(inv.costMicros)).padStart(12)}  ` +
        `${(inv.model ?? "—").padEnd(28)}  ${stamp(inv.createdAt)}`,
    );
  }
}

// ── the operator plane ───────────────────────────────────────────────────────

interface AdminApi {
  url: string;
  call(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }>;
}

/** The provision worker's credentials, as `bullmoose admin init` stored them.
 *  Absent is not an error here — it decides what the doors block reports. */
function adminApi(db: DatabaseSync, fetchImpl: typeof fetch): AdminApi | null {
  const url = getConfig(db, "adminUrl");
  const token = getConfig(db, "adminToken");
  if (!url || !token) return null;
  const root = url.replace(/\/+$/, "");
  return {
    url: root,
    async call(method, path, body) {
      const res = await fetchImpl(`${root}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      let parsed: Record<string, unknown> = {};
      try {
        parsed = (JSON.parse(text) ?? {}) as Record<string, unknown>;
      } catch {
        parsed = { error: text.trim() };
      }
      return { status: res.status, body: parsed };
    },
  };
}

/**
 * The refusal when a verb's door is on a plane this CLI holds no credential
 * for. Exit 4 (auth), not 2 (usage): no way of retyping the command reaches
 * it — a credential the caller does not have is what stands in the way — and
 * the message names the exact call that would.
 *
 * Under `--json` the refusal is a RECORD (the doors block, so a script gets the
 * same answer the text gives) and the exit goes through `exitFlushed`: a
 * payload written and then `process.exit`ed is truncated at 64 KiB for any
 * piped reader, which is the bug #192 found the hard way.
 */
async function refuse(
  message: string,
  code: ExitCode,
  opts: DossierOpts,
  record: Record<string, unknown>,
): Promise<never> {
  if (!opts.json) fail(message, code);
  note(message);
  emitJson(record);
  return exitFlushed(code);
}

/** The binding row on the operator plane, for a read-modify-write. */
async function adminBinding(api: AdminApi, address: string, binding: DossierBinding): Promise<AdminBindingRow> {
  const res = await api.call("GET", `/agent-bindings?email=${encodeURIComponent(address)}`);
  if (res.status !== 200) {
    fail(
      `GET ${api.url}/agent-bindings → HTTP ${res.status}: ${String(res.body.error ?? "")}`,
      res.status === 401 || res.status === 403 ? EXIT.AUTH : EXIT.FAIL,
    );
  }
  const rows = (res.body.bindings ?? []) as AdminBindingRow[];
  const row = rows.find((r) => r.id === binding.bindingId) ?? rows.find((r) => r.name === binding.name);
  if (!row) {
    notFound(
      `the operator plane has no binding ${binding.bindingId} for ${address} — the console projection and ` +
        `${api.url} disagree about this account; nothing was written`,
    );
  }
  return row;
}

function parseConfig(row: AdminBindingRow): Record<string, unknown> {
  try {
    const parsed = JSON.parse(row.config_json || "{}") as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** A `host/model` candidate — the string `show` prints, split at the FIRST
 *  slash so `openrouter/minimax/minimax-m3` keeps its vendor-qualified id. */
export function parseCandidate(raw: string, flag: string): { provider: string; model: string } {
  const at = raw.indexOf("/");
  const provider = at < 0 ? "" : raw.slice(0, at).trim();
  const model = at < 0 ? "" : raw.slice(at + 1).trim();
  if (!provider || !model) {
    usage(
      `${flag} takes <host>/<model> — the same string the dossier prints, e.g. ` +
        `openrouter/minimax/minimax-m3 (host is the first segment; the rest is the model id). Got: "${raw}"`,
    );
  }
  return { provider, model };
}

/** µUSD, strictly. Dollars are a display format; the wire is micro-USD, and
 *  guessing which one "2" meant would be a two-orders-of-magnitude spend bug. */
export function parseMicros(raw: string, flag: string): number {
  if (!/^\d+$/.test(raw.trim())) {
    usage(`${flag} takes micro-USD as a whole number (2000000 = $2.00). Got: "${raw}"`);
  }
  return Number(raw.trim());
}

/**
 * `--since` as an instant. Accepts `YYYY-MM-DD`, any ISO datetime, or `<n>d`.
 *
 * There is deliberately NO default (cli/007's rule applied to a window rather
 * than a scope): the backfill route happily assumes 90 days when the caller
 * names none, and a CLI that silently inherits that has chosen how far into
 * someone's archive an agent reads. Naming it is the point of the verb.
 */
export function parseSince(raw: string, now: number): { startMs: number; sinceDays: number } {
  const trimmed = raw.trim();
  const rel = /^(\d+)d$/.exec(trimmed);
  const startMs = rel
    ? now - Number(rel[1]) * DAY_MS
    : /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
      ? Date.parse(`${trimmed}T00:00:00Z`)
      : Date.parse(trimmed);
  if (!Number.isFinite(startMs)) {
    usage(`--since takes YYYY-MM-DD, an ISO datetime, or <n>d (e.g. 30d). Got: "${raw}"`);
  }
  if (startMs >= now) usage(`--since ${raw} is not in the past — a backfill window bounds history`);
  return { startMs, sinceDays: (now - startMs) / DAY_MS };
}

// ── the command ──────────────────────────────────────────────────────────────

/** The verbs this module owns; `main.ts` routes the rest of `agent` elsewhere. */
export const DOSSIER_VERBS = ["show", "budget", "model", "backfill", "enable", "disable"] as const;

export function isDossierVerb(v: string | undefined): boolean {
  return (DOSSIER_VERBS as readonly string[]).includes(v ?? "");
}

const SYNOPSIS =
  "bullmoose agent show <binding> | budget <binding> [--set <µUSD>] | model <binding> [--set <host>/<model>] " +
  "[--explore <host>/<model>]… | backfill <binding> --since <date> [--budget <µUSD>] [--request-floor] | " +
  "enable|disable <binding>";

export async function cmdAgentDossier(
  db: DatabaseSync,
  args: string[],
  opts: DossierOpts,
  deps: DossierDeps = {},
): Promise<void> {
  const [verb, selector] = args;
  if (!selector) usage(SYNOPSIS);

  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const settings = requireSettings(db);
  // cli/009 — ONE account-resolution rule, the same `pickAccount` every
  // single-account command uses: a selector matching several accounts is an
  // error, not a choice.
  const account = pickAccount(settings, opts.account);
  const dossier = await fetchDossier(settings.base, settings.token, account.accountId, fetchImpl);
  const binding = findBinding(dossier, selector);
  const api = adminApi(db, fetchImpl);

  switch (verb) {
    case "show":
      return showBinding(dossier, binding, { settings, account, api, opts });
    case "budget":
      return budgetVerb(dossier, binding, { settings, account, api, opts, now });
    case "model":
      return modelVerb(dossier, binding, { settings, account, api, opts, now });
    case "backfill":
      return backfillVerb(binding, { settings, account, api, opts, now });
    case "enable":
    case "disable":
      return killSwitch(settings, dossier, binding, verb === "enable", opts, deps);
    default:
      usage(SYNOPSIS);
  }
}

interface VerbCtx {
  settings: { base: string; token: string };
  account: AccountRef;
  api: AdminApi | null;
  opts: DossierOpts;
  now?: () => number;
}

// ---- show ------------------------------------------------------------------

async function showBinding(dossier: Dossier, binding: DossierBinding, ctx: VerbCtx): Promise<void> {
  const { opts, api } = ctx;
  if (opts.ids) {
    emitIds([binding.bindingId]);
    return;
  }

  // The history floor is NOT on the console projection — `describeBindingConfig`
  // enumerates the fields it serves and `createdAt`/`historyFloor` are not among
  // them. So it is read from the operator plane when that is configured, and
  // reported as unknown-and-why when it is not. Inventing a floor from the
  // binding's first invocation would be a guess wearing a number.
  let floor: { floorMs: number | null; source: string | null } | null = null;
  let floorNote =
    "not on the session read surface (the console projection carries no historyFloor/createdAt) — " +
    "configure the operator plane to read it: bullmoose admin init --url <provision-url> --token <admin-token>";
  const address = ctx.account.address ?? dossier.principal;
  if (api && address) {
    try {
      const parsed = effectiveFloor(parseConfig(await adminBinding(api, address, binding)));
      floor = parsed;
      floorNote =
        parsed.floorMs === null
          ? "no floor stamped (pre-s26 binding): backfill fails closed until a floor-request establishes one"
          : `backfill may reach back to ${new Date(parsed.floorMs).toISOString()} (from ${parsed.source})`;
    } catch (err) {
      // A read-only enrichment must never fail the read it decorates.
      floorNote = `operator plane unreachable: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  const view = buildShow(dossier, binding, {
    base: ctx.settings.base,
    account: ctx.account,
    adminUrl: api?.url,
    floor,
    floorNote,
    limit: 5,
  });
  if (opts.json) {
    emitJson(view);
    return;
  }
  renderShow(view);
  // Backfill PROGRESS is not separable on this surface: minted rows are ordinary
  // pending invocations and the projection does not serve `context_json`, so the
  // queue counts above cover backfill and live delivery together. Said out loud
  // rather than implied by a number that looks specific.
  note("queue counts cover backfill and live delivery together — the projection does not separate them");
}

// ---- budget ----------------------------------------------------------------

async function budgetVerb(dossier: Dossier, binding: DossierBinding, ctx: VerbCtx): Promise<void> {
  const { opts } = ctx;
  const ledger = ledgerFor(dossier, binding.bindingId);
  const view = budgetView(binding, ledger, dossier.ledgerMonthStart);

  if (opts.set === undefined) {
    if (opts.json) {
      emitJson({
        _self: dossierHref(ctx.settings.base, dossier.accountId),
        accountId: dossier.accountId,
        bindingId: binding.bindingId,
        name: binding.name,
        ...view,
        door: doorsFor(binding, !!ctx.api).budget,
      });
      return;
    }
    field("binding", `${binding.name}  (${binding.bindingId})`);
    field(
      "budget",
      view.capMicros === null
        ? "no monthly cap configured"
        : `${usd(view.capMicros)}/month · spent ${usd(view.spentMicros)} · overage ${usd(view.overageMicros)} · ` +
            `remaining ${usd(view.remainingMicros)}`,
    );
    field("", `cycle from ${stamp(view.monthStartMs)} UTC`);
    return;
  }

  const micros = parseMicros(opts.set, "--set");
  await reprovision(binding, ctx, { budgetMicros: micros }, (body, res) => {
    if (opts.json) {
      emitJson({ bindingId: binding.bindingId, name: binding.name, budgetMicros: micros, via: body.via, ...res });
      return;
    }
    out(`budget for ${binding.name} set to ${usd(micros)}/month`);
  });
}

// ---- model -----------------------------------------------------------------

async function modelVerb(dossier: Dossier, binding: DossierBinding, ctx: VerbCtx): Promise<void> {
  const { opts } = ctx;
  const explore = opts.explore ?? [];
  if (opts.set === undefined && explore.length === 0) {
    const menu = binding.economics.modelMenu;
    if (opts.json) {
      emitJson({
        _self: dossierHref(ctx.settings.base, dossier.accountId),
        accountId: dossier.accountId,
        bindingId: binding.bindingId,
        name: binding.name,
        defaultModel: binding.economics.defaultModel,
        menu,
        exploreRate: binding.economics.exploreRate,
        door: doorsFor(binding, !!ctx.api).model,
      });
      return;
    }
    field("binding", `${binding.name}  (${binding.bindingId})`);
    if (menu.length === 0) field("model", "— (no menu configured)");
    for (const entry of menu) {
      field("menu", `${entry.alias === binding.economics.defaultModel ? "*" : " "}${entry.alias}`);
      for (const [i, c] of entry.candidates.entries()) field("", `  ${i === 0 ? "primary" : "explore"} → ${c}`);
    }
    if (binding.economics.exploreRate !== null) field("", `  explore rate ${binding.economics.exploreRate}`);
    return;
  }

  const primary = opts.set === undefined ? undefined : parseCandidate(opts.set, "--set");
  const arms = explore.map((a) => parseCandidate(a, "--explore"));
  await reprovision(binding, ctx, { primary, ...(explore.length > 0 ? { arms } : {}) }, (body, res) => {
    if (opts.json) {
      emitJson({
        bindingId: binding.bindingId,
        name: binding.name,
        model: `${body.provider}/${body.model}`,
        exploreModels: (body.exploreModels ?? []).map((m) => `${m.provider}/${m.model}`),
        ...res,
      });
      return;
    }
    out(`model for ${binding.name}: ${body.provider}/${body.model}`);
    for (const m of body.exploreModels ?? []) out(`  explore → ${m.provider}/${m.model}`);
  });
}

// ---- the shared re-provision (budget + model) -------------------------------

interface ExtractorBody {
  email: string;
  provider: string;
  model: string;
  budgetMicros: number;
  exploreModels?: Array<{ provider: string; model: string }>;
  exploreRate?: number;
  maxTokens?: number;
  /** Not sent — carried for the report. */
  via?: string;
}

/**
 * The sanctioned model/budget write: `POST /extractor`, which REWRITES the
 * binding's config from its arguments. Everything the caller did not name is
 * read back from the operator plane and re-sent unchanged, so a budget change
 * cannot silently reset the menu (or vice versa) — the failure mode a naive
 * "just POST the new value" would have shipped.
 */
async function reprovision(
  binding: DossierBinding,
  ctx: VerbCtx,
  patch: {
    budgetMicros?: number;
    primary?: { provider: string; model: string };
    arms?: Array<{ provider: string; model: string }>;
  },
  report: (body: ExtractorBody, res: Record<string, unknown>) => void,
): Promise<void> {
  const { opts, api } = ctx;
  const doors = doorsFor(binding, !!api);
  const door = patch.budgetMicros === undefined ? doors.model! : doors.budget!;

  if (door.unavailable) {
    await refuse(door.unavailable, EXIT.USAGE, opts, {
      bindingId: binding.bindingId,
      name: binding.name,
      written: false,
      door,
    });
  }
  if (!api) {
    await refuse(
      `${door.door} is operator-plane (ADMIN_TOKEN) and this CLI holds no provision credential. ` +
        `What would work: bullmoose admin init --url <provision-url> --token <admin-token>, then re-run. ` +
        `Nothing was written.`,
      EXIT.AUTH,
      opts,
      { bindingId: binding.bindingId, name: binding.name, written: false, door },
    );
    return;
  }

  const address = ctx.account.address;
  if (!address) {
    fail(
      `POST /extractor addresses an account by EMAIL and this login stored none for ${ctx.account.accountId} ` +
        `(re-run \`bullmoose login\` to refresh it). Nothing was written.`,
      EXIT.FAIL,
    );
  }

  // The kill switch outranks a tuning knob: `POST /extractor` sets enabled = 1,
  // so re-provisioning a DISABLED binding would quietly un-pull the switch
  // somebody deliberately pulled.
  if (!binding.enabled && !opts.yes) {
    await refuse(
      `${binding.name} is DISABLED, and the only budget/model door (${door.door}) re-enables a binding as a ` +
        `side effect of writing its config. Re-run with --yes to accept the re-enable, or leave it off and ` +
        `nothing changes. Nothing was written.`,
      EXIT.CONFLICT,
      opts,
      { bindingId: binding.bindingId, name: binding.name, written: false, enabled: false, door },
    );
  }

  const row = await adminBinding(api, address, binding);
  const config = parseConfig(row);
  const aliases = (config.modelAliases ?? {}) as Record<string, unknown>;
  const aliasName = typeof config.defaultModel === "string" ? config.defaultModel : Object.keys(aliases)[0];
  const current = (aliasName === undefined ? [] : ((aliases[aliasName] ?? []) as unknown[])).filter(
    (c): c is { provider: string; model: string } =>
      typeof (c as { provider?: unknown })?.provider === "string" &&
      typeof (c as { model?: unknown })?.model === "string",
  );
  const budgets = (config.budgets ?? {}) as Record<string, unknown>;
  const frontier = (config.frontier ?? {}) as Record<string, unknown>;

  const primary = patch.primary ?? current[0];
  if (!primary) {
    fail(
      `${binding.name} has no primary model candidate to preserve, and a re-provision that names none takes the ` +
        `server's paid default — a spend decision this command will not make for you. Name it: ` +
        `bullmoose agent model ${binding.name} --set <host>/<model>. Nothing was written.`,
      EXIT.USAGE,
    );
  }
  const budgetMicros =
    patch.budgetMicros ??
    (typeof budgets.spendPerMonth === "number" && Number.isFinite(budgets.spendPerMonth)
      ? budgets.spendPerMonth
      : undefined);
  if (budgetMicros === undefined) {
    fail(
      `${binding.name} has no monthly budget to preserve, and a re-provision that names none takes the server's ` +
        `$2.00 default — a spend decision this command will not make for you. Set it first: ` +
        `bullmoose agent budget ${binding.name} --set <µUSD>. Nothing was written.`,
      EXIT.USAGE,
    );
  }
  const arms = patch.arms ?? current.slice(1);

  const body: ExtractorBody = {
    email: address,
    provider: primary.provider,
    model: primary.model,
    budgetMicros,
    ...(arms.length > 0 ? { exploreModels: arms } : {}),
    ...(arms.length > 0 && typeof frontier.exploreRate === "number" ? { exploreRate: frontier.exploreRate } : {}),
    ...(typeof config.maxTokens === "number" ? { maxTokens: config.maxTokens } : {}),
  };

  if (opts.dryRun) {
    note(`dry run: would POST ${api.url}/extractor; nothing was written`);
    if (opts.json) emitJson({ dryRun: true, bindingId: binding.bindingId, request: body, door });
    else out(JSON.stringify(body));
    return;
  }

  const res = await api.call("POST", "/extractor", body);
  if (res.status !== 200) {
    // The provision worker's sentence, verbatim — it names the account, the
    // binding and the reason far better than a status code does.
    fail(
      `POST ${api.url}/extractor → HTTP ${res.status}: ${String(res.body.error ?? JSON.stringify(res.body))}`,
      res.status === 401 || res.status === 403 ? EXIT.AUTH : res.status === 404 ? EXIT.NOT_FOUND : EXIT.FAIL,
    );
  }
  report({ ...body, via: "POST /extractor (re-provision-in-place)" }, res.body);
  if (!opts.json) {
    note(`via ${api.url}/extractor — the sanctioned re-provision-in-place path`);
    if (!binding.enabled) note(`${binding.name} was disabled and is now ENABLED again (the door's side effect)`);
  }
}

// ---- backfill --------------------------------------------------------------

async function backfillVerb(binding: DossierBinding, ctx: VerbCtx): Promise<void> {
  const { opts, api } = ctx;
  const now = (ctx.now ?? Date.now)();
  const doors = doorsFor(binding, !!api);
  const door = doors.backfill!;

  if (!opts.since) {
    usage(
      `bullmoose agent backfill <binding> --since <YYYY-MM-DD|ISO|Nd> [--budget <µUSD>] [--request-floor]\n` +
        `--since is required: the route defaults to 90 days when nobody names a window, and how far into an ` +
        `archive an agent reads is not a default this CLI will pick for you.`,
    );
  }
  const since = parseSince(opts.since, now);
  const budgetMicros = opts.budget === undefined ? null : parseMicros(opts.budget, "--budget");

  if (!api) {
    await refuse(
      `${door.door} is operator-plane (ADMIN_TOKEN) and this CLI holds no provision credential. ` +
        `What would work: bullmoose admin init --url <provision-url> --token <admin-token>, then re-run. ` +
        `Nothing was queued.`,
      EXIT.AUTH,
      opts,
      { bindingId: binding.bindingId, name: binding.name, minted: 0, queued: false, door },
    );
    return;
  }

  // The floor-request is the APPROVAL, not a louder backfill: it mints a tier-1
  // proposal and queues no work at all. Opt-in only — a command that escalated
  // to it on its own would be asking for archive access nobody typed.
  if (opts.requestFloor) {
    if (opts.dryRun) {
      note(
        `dry run: would ask to move ${binding.name}'s history floor back to ${new Date(since.startMs).toISOString()}`,
      );
      if (opts.json) emitJson({ dryRun: true, bindingId: binding.bindingId, toEpochMs: since.startMs });
      return;
    }
    const res = await api.call("POST", `/agent-bindings/${encodeURIComponent(binding.bindingId)}/floor-request`, {
      toEpochMs: since.startMs,
    });
    if (res.status !== 200) {
      fail(
        `POST ${api.url}/agent-bindings/${binding.bindingId}/floor-request → HTTP ${res.status}: ` +
          `${String(res.body.error ?? JSON.stringify(res.body))}`,
        res.status === 409 ? EXIT.CONFLICT : res.status === 400 ? EXIT.USAGE : EXIT.FAIL,
      );
    }
    if (opts.json) {
      emitJson({ bindingId: binding.bindingId, name: binding.name, backfilled: false, ...res.body });
      return;
    }
    out(
      `floor-request ${String(res.body.proposalId)} — ${res.body.minted === false ? "already pending" : "pending a human"}`,
    );
    note("no backfill ran: this is the approval. Decide it in approvals, then re-run the backfill.");
    return;
  }

  if (opts.dryRun) {
    note(
      `dry run: would POST ${api.url}/agent-bindings/${binding.bindingId}/backfill ` +
        `{sinceDays: ${since.sinceDays.toFixed(3)}${budgetMicros === null ? "" : `, budgetMicros: ${budgetMicros}`}}; ` +
        `nothing was queued`,
    );
    if (opts.json) {
      emitJson({ dryRun: true, bindingId: binding.bindingId, sinceDays: since.sinceDays, budgetMicros });
    }
    return;
  }

  if (budgetMicros === null) {
    note(
      "no --budget: minted rows carry no envelope, so paid claims draw on the binding's MONTHLY budget " +
        "(a free @local claimant still eats them at $0)",
    );
  }
  const res = await api.call("POST", `/agent-bindings/${encodeURIComponent(binding.bindingId)}/backfill`, {
    sinceDays: since.sinceDays,
    ...(budgetMicros === null ? {} : { budgetMicros }),
  });

  if (res.status === 409) {
    // The two 409s that matter read differently and must not be flattened: a
    // window behind the floor is an APPROVAL question (rule 1), a disabled
    // binding is the kill switch doing its job. The server's sentence carries
    // both, so it is printed verbatim and nothing is claimed to have started.
    const message = String(res.body.error ?? "refused");
    const askable = typeof res.body.requestedStartMs === "number";
    await refuse(
      `${message}\n\nNothing was queued.` +
        (askable
          ? `\nTo ask for the floor move: bullmoose agent backfill ${binding.name} --since ${opts.since} --request-floor`
          : ""),
      EXIT.CONFLICT,
      opts,
      { bindingId: binding.bindingId, name: binding.name, minted: 0, queued: false, ...res.body },
    );
  }
  if (res.status !== 200) {
    fail(
      `POST ${api.url}/agent-bindings/${binding.bindingId}/backfill → HTTP ${res.status}: ` +
        `${String(res.body.error ?? JSON.stringify(res.body))}`,
      res.status === 401 || res.status === 403 ? EXIT.AUTH : res.status === 404 ? EXIT.NOT_FOUND : EXIT.FAIL,
    );
  }

  if (opts.json) {
    emitJson({
      bindingId: binding.bindingId,
      name: binding.name,
      since: new Date(since.startMs).toISOString(),
      ...res.body,
    });
    return;
  }
  const minted = Number(res.body.minted ?? 0);
  out(
    `backfill ${binding.name}: minted ${minted} invocation(s), skipped ${String(res.body.skipped ?? 0)} already covered`,
  );
  field("window", `${stamp(Number(res.body.windowStartMs))} → ${stamp(Number(res.body.windowEndMs))} UTC`);
  field(
    "floor",
    `${stamp(Number(res.body.floorMs))} (${String(res.body.floorSource)})${res.body.floorClamped ? " — window CLAMPED to it" : ""}`,
  );
  field("envelope", budgetMicros === null ? "none (draws on the monthly budget)" : usd(budgetMicros));
  if (res.body.capped === true) {
    note("the mint cap was reached — the window's far edge was NOT reached; re-run to walk further back");
  }
  note(String(res.body.note ?? ""));
}

// ---- enable / disable ------------------------------------------------------

/**
 * The kill switch, over `AgentBinding/set` — the ONE mutation a session token
 * can make (s26 T2 / #198). Refusals are printed as the server wrote them:
 * "insufficient scope", "not your account", "the binding's enabled state moved
 * under this call" each say something different, and re-wording any of them
 * into a guess is how a CLI teaches the wrong mental model.
 */
async function killSwitch(
  settings: { base: string; token: string },
  dossier: Dossier,
  binding: DossierBinding,
  enabled: boolean,
  opts: DossierOpts,
  deps: DossierDeps,
): Promise<void> {
  const verb = enabled ? "enable" : "disable";
  if (opts.dryRun) {
    note(
      `dry run: would ${verb} ${binding.name} (${binding.bindingId}); it is currently ` +
        `${binding.enabled ? "enabled" : "disabled"}. Nothing was written.`,
    );
    if (opts.json) emitJson({ dryRun: true, bindingId: binding.bindingId, enabled });
    return;
  }

  const client = deps.jmap ?? new JmapClient(settings.base, settings.token);
  const res = await client.one("AgentBinding/set", {
    accountId: dossier.accountId,
    update: { [binding.bindingId]: { enabled } },
  });
  const updated = (res.updated ?? {}) as Record<string, { enabled?: boolean }>;
  if (!(binding.bindingId in updated)) {
    failSetError(`${verb} ${binding.name}`, (res.notUpdated as Record<string, unknown>)?.[binding.bindingId]);
  }

  if (opts.json) {
    emitJson({
      accountId: dossier.accountId,
      bindingId: binding.bindingId,
      name: binding.name,
      enabled: updated[binding.bindingId]?.enabled ?? enabled,
      wasEnabled: binding.enabled,
    });
    return;
  }
  out(`${binding.name} (${binding.bindingId}) is now ${enabled ? "ENABLED" : "DISABLED"}`);
  if (binding.enabled === enabled) note("(already in that state — nothing was written and no audit row was added)");
  else if (!enabled) note("queued invocations are HELD, not cancelled — they resume on enable");
}
