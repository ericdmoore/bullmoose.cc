import { MethodError, type MethodRegistry } from "@bullmoose/jmap-core";
import { isAgentPrincipal } from "@bullmoose/auth-core/principal";
import { describeBindingConfig, describeBindingEconomics } from "../console";
import { requireAccount, setError, type RequestContext, type SetError } from "./common";

/**
 * AgentBinding (urn:bullmoose:params:jmap:agent) — the session-reachable half
 * of an account's agent roster: `/get` reads it, `/set` throws the 008 kill
 * switch (s26 T2) and tunes the two economics knobs that decide what an agent
 * may spend and which models it may spend it on.
 *
 * ── What each half exists to close ─────────────────────────────────────────
 *
 * `/get` (this round). s26 T2 shipped `/set` alone, so NOTHING enumerated an
 * account's bindings over JMAP, and two shipped surfaces filled the hole with
 * the same convention instead of an API:
 *
 *   • `webmail/src/lib/verbs/contract.ts` `VERB_BINDING_NAME = "extractor"` —
 *     the s20 T2 verbs name the one binding an opted-in account reliably has,
 *     and its own comment says why: *"there is no JMAP method that LISTS an
 *     account's bindings… closing it properly means a binding-list read, which
 *     is named as follow-up work rather than smuggled in here."*
 *   • `packages/cli/src/agentDossier.ts` `REPROVISION_BINDING = "extractor"` —
 *     the only config-write door was `POST /extractor`, which provisions the
 *     binding literally named `extractor`, so every other binding's budget and
 *     menu had NO door at all.
 *
 * A convention standing in for an API in two places is one bug away from being
 * wrong in two places. This is the API.
 *
 * `/set`'s widening (this round). v1 wrote `enabled` and refused `budgets` and
 * `modelAliases` BY NAME, pointing at the INTERNAL_TOKEN provisioning plane —
 * which is why the CLI has to tell a human to run `admin init` before they can
 * change their own agent's monthly cap. Money and the model menu now have a
 * session door, held to the same discipline v1 established.
 *
 * ── ONE vocabulary for the read, the write and the audit chain ─────────────
 *
 * The read is not a new shape. `list[]` is the console dossier's own
 * `ConsoleBinding` — produced by literally calling `describeBindingConfig` and
 * `describeBindingEconomics` from `../console`, the same two functions
 * `GET /console/agents/{accountId}` calls, so the CLI's `DossierBinding` and
 * webmail's `ConsoleBinding` types already describe this response and nothing
 * had to be minted.
 *
 * The WRITE speaks that same vocabulary, which is the point:
 *
 *   /get economics            /set update patch          config_json
 *   ─────────────────────     ─────────────────────      ─────────────────────
 *   budgetMicros              budgetMicros               $.budgets.spendPerMonth
 *   defaultModel              defaultModel               $.defaultModel
 *   modelMenu                 modelMenu                  $.modelAliases
 *   exploreRate               exploreRate                $.frontier.exploreRate
 *   enabled                   enabled                    (column)
 *
 * So a client GETs, edits one field, and SETs it back — no translation layer,
 * and no second name for `spendPerMonth`. "Primary alias + explore arms" is
 * `modelMenu[].candidates`: `chooseArm` (services/agent/src/models.ts) treats
 * `candidates[0]` as the exploit arm and rotates one of the REST forward with
 * P(exploreRate), so the primary is position 0 and the arms are positions 1+.
 * The audit chain speaks it too — the old/new values on every `binding_lifecycle`
 * row below are computed by running `describeBindingEconomics` over the config
 * BEFORE and AFTER, so a chain reader and a `/get` reader see the same words.
 *
 * ── Scope: `read` to read, `send` to write ────────────────────────────────
 *
 * READ → `read`, the gate every sibling read uses (`Annotation/get`,
 * `Watch/get`, `ActionProposal/get`, `FileNode/get`) and the same one
 * `/console/agents/*` — the surface this projection is lifted from — already
 * serves this exact data under. A read method needs a read-ish scope; `read`
 * is the floor, and pricing a read at a write verb would be theatre while the
 * console answers the same question at `read`.
 *
 * It is grant-reachable, and that is a considered difference from the console
 * rather than a relaxation of it. The console is owner-only for a reason it
 * states in its own refusal: *"the console reports who ELSE can reach it —
 * rows about third parties who never granted you anything."* That reason does
 * not apply here. This method returns rows about the account's OWN bindings
 * and nothing about any third party, so a supervisor holding `read` may see
 * that the agent they supervise is disabled or out of budget — which is what
 * makes "it went quiet" diagnosable instead of mysterious — and every
 * grant-reached read writes its `grant_audit` row through `requireAccount`,
 * which the console's owner-only door never had to.
 *
 * WRITE → `send`, unchanged from v1 and deliberately NOT split per property.
 * The full argument is below under the capability wall; the short form is that
 * a budget is an authority to act, not a display preference: raising it arms
 * more autonomous work exactly as un-pulling the kill switch does, and the
 * model menu decides what that money buys. A second, cheaper gate for "just
 * the money" would be the extra policy layer #198 declined to grow.
 *
 * ── No agent hand on ANY of it ────────────────────────────────────────────
 *
 * Both halves refuse agent-marked principals and agent-provenance calls
 * (`ctx.agent`), unconditionally, before any account is resolved.
 *
 * For `/set` that is the kill switch's own logic (an agent re-enabling itself
 * defeats the switch; an agent raising its own budget is the same move with a
 * ledger entry), now extended to the money and the menu for the same reason.
 *
 * For `/get` it holds the line `015` Rule 4 drew: the agent-facing binding
 * summary (`services/agent/src/introspectTools.ts` `describeBinding`) reduces
 * the menu to a `modelAliasCount` and serves no budget at all, and
 * `describeBindingEconomics` is documented in `../console` as *"the OWNER's
 * read of their own agent's budget and menu, which the MCP surface
 * intentionally does not serve."* Serving it here to an agent's tool loop
 * would relax that decision through a side door. An agent that wants to know
 * what it may do has `whoami` / `my_access` over MCP.
 *
 * ── THE CAPABILITY WALL (`send`), the /set argument in full ───────────────
 *
 * Enabling a binding arms autonomous action: the drain resumes this agent's
 * work with no further human in the loop, and for a send-mode binding that
 * work EGRESSES. Disabling is the incident verb for the same authority. That
 * decision class is exactly what the capability wall already prices at `send`
 * (actionProposal.ts, tier-3 approve: "approving irreversible egress is a
 * human action every time — it requires the `send` scope, which an agent token
 * structurally lacks"). This door reuses that gate rather than growing a
 * second policy layer, and the scope arithmetic is the point:
 *
 *   • a plain human mail token (the `mail` mint default) covers `send`;
 *   • SUPERVISORY_GRANT_SCOPES = read + annotate + draft does NOT — so a
 *     session whose reach to an account derives from a supervisory grant can
 *     read that account's dossier and decide its proposals, but can never
 *     throw (or un-throw) its kill switch, raise its monthly cap, or swap the
 *     models it buys. In particular, a token whose only path to an account is
 *     a supervisory grant cannot disable a supervisor binding living there —
 *     supervision is not custody, and custody of the off switch and of the
 *     money is what these five properties are;
 *   • agent runtime tokens structurally lack `send` — the wall's own argument.
 *
 * NOT `draft` (supervisors hold it, and flipping the switch is no kind of
 * drafting), NOT `delete` (nothing is destroyed — disable is a PAUSE with a
 * matching enable), and NOT the `mail` bundle literal (hasScope can only test
 * membership for it — a token minted with the six verbs spelled out must
 * pass, and requiring the bundle string would refuse it dishonestly).
 *
 * ── Ownership ──────────────────────────────────────────────────────────────
 *
 * Every statement in this file is `WHERE account_id = ? AND id = ?`, so a
 * binding id that exists on someone else's account answers exactly like one
 * that never existed — the same `notFound` from `/set`, verbatim, and the same
 * `notFound[]` membership from `/get` — and an accountId the principal cannot
 * reach is `accountNotFound` before any binding is consulted. A tombstoned
 * account cannot be re-enabled through this door for free: `reachableAccounts`
 * filters `deleted_at IS NULL`, so the account resolves to accountNotFound
 * (the admin verb refuses the same case explicitly, with a sentence).
 *
 * ── Nothing secret leaves through /get ────────────────────────────────────
 *
 * The response is built ONLY from `describeBindingConfig` +
 * `describeBindingEconomics`, both of which enumerate derived fields and
 * neither of which can emit `config_json` itself. So persona text,
 * `allowedSenders`, `providerCredentials` (the s26 T4 BYOK binding→credential
 * map) and a candidate's per-route `credRef` are all structurally absent: the
 * menu renders as `provider/model` LABELS, and a credential handle is not part
 * of a label. There is no value field for a secret to hide in either — the
 * Bureau holds the master key and this worker is not bound to it (bureau.md
 * invariant 1). `agentBinding.test.ts` asserts the whole serialized response
 * against a config seeded with one of each.
 *
 * ── The read-modify-write hazard, and why the write is targeted ───────────
 *
 * s26 T6 discovered the failure this method must not reproduce: `POST
 * /extractor` REWRITES a binding's whole config from its arguments, so a naive
 * budget write there wipes the model menu and a naive menu write wipes the
 * budget. The CLI works around it by reading everything back from the operator
 * plane and re-sending it unchanged.
 *
 * This method cannot be worked around, so it does the targeted thing: parse
 * `config_json`, set ONLY the keys the patch named (and, for `budgets` and
 * `frontier`, only the one key inside each — sibling keys in those objects
 * survive too), re-serialize. Every unmentioned key — `persona`, `pipeline`,
 * `replyMode`, `allowedSenders`, `maxTokens`, `providerCredentials`,
 * `createdAt`, `historyFloor`, `digestTargets`, anything a future slice adds —
 * is carried through untouched because it is never read as a name at all.
 *
 * Two corollaries:
 *   • A `modelMenu` write REPLACES `$.modelAliases`, since the menu is the
 *     whole map the projection shows. Candidates arrive as labels, which carry
 *     no `credRef` — so a credRef on a prior candidate with the SAME
 *     `provider/model` label is carried forward. Without that, a human fixing
 *     their explore rate through the menu would silently move their tenant's
 *     BYOK traffic back onto the platform's key.
 *   • An UNPARSEABLE `config_json` refuses a config write rather than
 *     clobbering it: a targeted write cannot preserve keys it cannot read, and
 *     guessing is how the whole config gets lost. `enabled` still works — it
 *     is a column, and the kill switch must not be hostage to a bad blob.
 *
 * ── CAS + audit ────────────────────────────────────────────────────────────
 *
 * A real change appends one `binding_lifecycle` row PER changed property
 * (`enabled-changed`, `budget-changed`, `default-model-changed`,
 * `model-menu-changed`, `explore-rate-changed`; old/new in the read
 * projection's own vocabulary, `actor` = the acting principal — the same value
 * grant_audit records — `via_proposal_id` NULL for a direct human decision) in
 * the SAME `db.batch` as the write, every statement guarded on the SAME full
 * pre-image `(enabled, config_json)`: the s10 T4 CAS discipline widened from
 * one column to two. A concurrent write between the read and the batch makes
 * every statement match zero rows — no half-write, and no chain row describing
 * a change that never happened — and the call answers stateMismatch. A no-op
 * writes NOTHING — no UPDATE and no chain row, provision's own rule: a chain
 * that records non-events is a chain nobody can read. Grant-reached calls (a
 * deliberately widened grant carrying `send`) additionally land in
 * `grant_audit` via requireAccount, as every method's do.
 *
 * AgentBinding is NOT a synced collection: no changelog entry, no /changes,
 * and — unlike `Annotation/get` and `Watch/get`, whose `/set` halves DO commit
 * changelog entries — no `state` on the `/get` response. A state string that
 * never moved when a binding changed would be a sync anchor that lies. The
 * `/set` response carries the server-confirmed values for the client's
 * reconcile, which is the same reason it has no oldState/newState.
 *
 * ── Why no AgentBinding/query ─────────────────────────────────────────────
 *
 * The repo does not pair every entity with one, and the split is by size, not
 * by habit: `Annotation`, `Watch`, `ActionProposal` and `FileNode` have a
 * `/query` because they grow without bound and need filters; `Identity` and
 * `VacationResponse` have `/get` alone because the set is small and bounded.
 * A binding roster is `Identity`-shaped — a handful of rows per account, no
 * filter dimension worth a method — and `/get` with `ids: null` already
 * returns all of them, which is exactly the call both stranded consumers need
 * in order to stop guessing a name.
 */

/** Where every OTHER binding mutation lives — named in refusals so the 400
 *  teaches the map. Kept an object so the message and the test share it. */
export const BINDING_MUTATION_OWNERS: Record<string, string> = {
  enabled: "this method",
  budgetMicros: "this method",
  defaultModel: "this method",
  modelMenu: "this method",
  exploreRate: "this method",
  // The config_json key names, for a client that patched the storage shape
  // instead of the projection's. Both point HERE now — the door exists, it is
  // just spelled the way `/get` spells it.
  budgets: "this method, as `budgetMicros` (µUSD — the name /get returns)",
  modelAliases: "this method, as `modelMenu` (the name /get returns)",
  frontier: "this method, as `exploreRate` (the name /get returns)",
  replyMode: "the operator plane (PATCH /agent-bindings/{id})",
  allowedSenders: "the operator plane (PATCH /agent-bindings/{id})",
  recipientsBookId: "the operator plane (PATCH /agent-bindings/{id})",
  persona: "the operator plane (POST /agent-bindings, at provision time)",
  maxTokens: "the operator plane (POST /extractor maxTokens)",
};

/** The properties `/set` writes. Everything else is refused by name. */
const WRITABLE = ["enabled", "budgetMicros", "defaultModel", "modelMenu", "exploreRate"] as const;

/**
 * The hosts a menu candidate may name — `ModelCandidate["provider"]`
 * (services/agent/src/models.ts), which is a TS union and therefore erased at
 * runtime. MIRRORED rather than imported — and there was nothing to import
 * even if a worker boundary allowed it, because provision does NOT validate
 * the menu at provision time: `POST /extractor` takes `provider` as a free
 * string and writes it, so an unknown host survives all the way to
 * `callModel`, falls off the end of its provider dispatch and fails the
 * invocation at spend time. A session door that accepts the same
 * garbage would ship that failure to a human who cannot see it. This list is
 * the whole of that dispatch, and a new provider added there must be added
 * here — which the refusal message makes obvious the first time it bites.
 */
const MENU_PROVIDERS = ["workers-ai", "gateway", "openrouter", "mock"] as const;

interface BindingRow {
  id: string;
  name: string;
  trigger_on: string;
  sla_seconds: number | null;
  enabled: number;
  config_json: string;
}

/** One menu entry, in the projection's own shape: alias → `provider/model`
 *  labels in fallback order, primary first. */
interface MenuEntry {
  alias: string;
  candidates: string[];
}

/** A candidate as it is STORED. `credRef` is the s26 T4 BYOK handle — never on
 *  the wire in either direction, carried forward from the prior config. */
interface StoredCandidate {
  provider: string;
  model: string;
  credRef?: string;
}

/**
 * The dossier row for one binding — `ConsoleBinding` (webmail
 * `lib/console/types.ts`, CLI `DossierBinding`) with JMAP's mandatory `id` in
 * place of `bindingId`. Same value, and the rename is not a choice: a `/get`
 * response's objects are matched to `ids` and addressed by back-references on
 * `id`, so a projection that called it something else would not be a JMAP
 * object. Every other field is the projection's name, and both derived blocks
 * are produced by the console's own functions rather than re-derived here.
 */
function toJmap(r: BindingRow): Record<string, unknown> {
  return {
    id: r.id,
    name: r.name,
    triggerOn: r.trigger_on,
    slaSeconds: r.sla_seconds,
    enabled: r.enabled === 1,
    config: describeBindingConfig(r.config_json),
    economics: describeBindingEconomics(r.config_json),
  };
}

/** No agent hand on the roster or the switch — see the header. Unconditional
 *  and BEFORE account resolution, so a marked token cannot even distinguish a
 *  reachable account from an unreachable one here. */
function refuseAgents(ctx: RequestContext, what: string): void {
  if (ctx.agent || isAgentPrincipal(ctx.principal)) {
    throw new MethodError("forbidden", what);
  }
}

function parseConfig(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw || "{}") as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** `provider/model` → the stored candidate's credRef, for carry-forward. The
 *  label is the identity: a candidate is the same route iff it names the same
 *  host and model, which is exactly what the projection shows. */
function credRefsByLabel(cfg: Record<string, unknown>): Map<string, string> {
  const out = new Map<string, string>();
  const aliases = (cfg.modelAliases ?? {}) as Record<string, unknown>;
  for (const cands of Object.values(aliases)) {
    if (!Array.isArray(cands)) continue;
    for (const c of cands) {
      const cc = (c ?? {}) as Record<string, unknown>;
      if (typeof cc.provider !== "string" || typeof cc.model !== "string") continue;
      if (typeof cc.credRef !== "string" || cc.credRef === "") continue;
      const label = `${cc.provider}/${cc.model}`;
      if (!out.has(label)) out.set(label, cc.credRef);
    }
  }
  return out;
}

/** Split a `provider/model` label at the FIRST slash. Models carry slashes of
 *  their own (`minimax/minimax-m3`, `@cf/meta/llama-3.1-8b-instruct`), so the
 *  first one is the only unambiguous boundary. */
function splitLabel(label: string): { provider: string; model: string } | null {
  const i = label.indexOf("/");
  if (i <= 0 || i === label.length - 1) return null;
  return { provider: label.slice(0, i), model: label.slice(i + 1) };
}

type Validated<T> = { ok: true; value: T } | { ok: false; error: SetError };

const invalid = (description: string, ...properties: string[]): { ok: false; error: SetError } => ({
  ok: false,
  error: { type: "invalidProperties", description, properties },
});

/** Budgets are µUSD integers and never negative — and never NULL through this
 *  door. Clearing the cap would make the binding uncapped, and provision's own
 *  rule is that *"a paid pipeline never ships uncapped"*; `0` is the hard floor
 *  that refuses every paid claim, which is what "stop spending" means here. */
function validateBudget(v: unknown): Validated<number> {
  if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v) || v < 0) {
    return invalid(
      "budgetMicros must be a non-negative integer number of micro-USD (1 USD = 1,000,000). " +
        "There is no session door to REMOVE the cap: a paid pipeline never ships uncapped, and 0 is " +
        "the hard floor that refuses every paid claim.",
      "budgetMicros",
    );
  }
  return { ok: true, value: v };
}

/** `chooseArm` treats <= 0 as pure exploit, so 0 IS "exploration off" and no
 *  null is needed to express it. Above 1 is not a rate. */
function validateExploreRate(v: unknown): Validated<number> {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
    return invalid(
      "exploreRate must be a number between 0 and 1 — the probability that an invocation is " +
        "assigned a non-primary arm of its menu. 0 turns frontier exploration off; there is no null.",
      "exploreRate",
    );
  }
  return { ok: true, value: v };
}

function validateMenu(v: unknown): Validated<MenuEntry[]> {
  if (!Array.isArray(v) || v.length === 0) {
    return invalid(
      "modelMenu must be a non-empty array of {alias, candidates} — the same shape AgentBinding/get " +
        "returns under economics.modelMenu. An empty menu leaves every pipeline with no route at all.",
      "modelMenu",
    );
  }
  const seen = new Set<string>();
  const out: MenuEntry[] = [];
  for (const raw of v) {
    const e = (raw ?? {}) as Record<string, unknown>;
    const alias = typeof e.alias === "string" ? e.alias.trim() : "";
    if (!alias) return invalid("every modelMenu entry needs a non-empty `alias`", "modelMenu");
    if (seen.has(alias)) {
      return invalid(`modelMenu names the alias "${alias}" twice — an alias resolves to one chain`, "modelMenu");
    }
    seen.add(alias);
    const cands = e.candidates;
    if (!Array.isArray(cands) || cands.length === 0) {
      return invalid(
        `alias "${alias}" has no candidates — an alias with an empty fallback chain is a dead route`,
        "modelMenu",
      );
    }
    const labels: string[] = [];
    for (const c of cands) {
      if (typeof c !== "string") {
        return invalid(`alias "${alias}": every candidate is a "provider/model" string`, "modelMenu");
      }
      const parts = splitLabel(c);
      if (!parts) {
        return invalid(
          `alias "${alias}": candidate "${c}" is not a "provider/model" label ` +
            `(e.g. "openrouter/minimax/minimax-m3")`,
          "modelMenu",
        );
      }
      if (!(MENU_PROVIDERS as readonly string[]).includes(parts.provider)) {
        // Refused BY NAME, the #198 habit: the message is the map.
        return invalid(
          `alias "${alias}": no provider named "${parts.provider}" — a candidate's host must be one of ` +
            `${MENU_PROVIDERS.join(" | ")}. An unknown host is accepted at provision time and only ` +
            `fails later, mid-invocation, where nobody sees it.`,
          "modelMenu",
        );
      }
      labels.push(c);
    }
    out.push({ alias, candidates: labels });
  }
  return { ok: true, value: out };
}

export function registerAgentBindingMethods(registry: MethodRegistry<RequestContext>): void {
  /**
   * `AgentBinding/get` — the roster read both stranded surfaces need. `ids:
   * null` (or absent) returns every binding on the account, ordered by name,
   * which is the call that lets a client resolve a binding BY NAME instead of
   * assuming one is called `extractor`.
   */
  registry.register("AgentBinding/get", async (args, ctx) => {
    refuseAgents(
      ctx,
      "the binding roster is a human read: an agent-driven call may not enumerate an account's " +
        "agents, their budgets or their model menus (`015` Rule 4 — the agent-facing summary is " +
        "`describeBinding` over MCP, which serves a modelAliasCount and no budget at all; " +
        "`whoami` / `my_access` answer what this agent itself may do)",
    );
    // A READ verb for a read method — see the header for why `read` and why
    // this one is grant-reachable where the console projection is not.
    const access = await requireAccount(ctx, args, "read");

    const ids = args.ids === null || args.ids === undefined ? undefined : (args.ids as string[]);
    const cols = `id, name, trigger_on, sla_seconds, enabled, config_json`;
    let rows: BindingRow[];
    if (ids === undefined) {
      rows = (
        await ctx.env.DB.prepare(`SELECT ${cols} FROM agent_bindings WHERE account_id = ? ORDER BY name`)
          .bind(access.accountId)
          .all<BindingRow>()
      ).results;
    } else if (ids.length === 0) {
      rows = [];
    } else {
      const marks = ids.map(() => "?").join(",");
      rows = (
        await ctx.env.DB.prepare(
          `SELECT ${cols} FROM agent_bindings WHERE account_id = ? AND id IN (${marks}) ORDER BY name`,
        )
          .bind(access.accountId, ...ids)
          .all<BindingRow>()
      ).results;
    }

    // The account's address, under the dossier's own name for it: the console
    // returns the owner's `login_email` as `principal`, and the CLI's
    // `ctx.account.address` falls back to exactly that field. Restated here so
    // a client that only calls this method can say WHICH MAILBOX these agents
    // sit on without a second fetch. `deleted_at IS NULL` matches every other
    // resolution path; a principal with no account row (the local-dev
    // bootstrap) answers null rather than a fabricated address.
    const owner = await ctx.env.DB.prepare(
      `SELECT p.login_email FROM accounts a JOIN principals p ON p.id = a.principal_id
        WHERE a.id = ? AND a.deleted_at IS NULL`,
    )
      .bind(access.accountId)
      .first<{ login_email: string }>();

    const found = new Set(rows.map((r) => r.id));
    return {
      accountId: access.accountId,
      principal: owner?.login_email ?? null,
      // No `state`: AgentBinding is not a synced collection (header).
      list: rows.map(toJmap),
      notFound: (ids ?? []).filter((id) => !found.has(id)),
    };
  });

  registry.register("AgentBinding/set", async (args, ctx) => {
    // The unconditional refusal first (see header). Checked before account
    // resolution so a marked token cannot even distinguish reachable accounts
    // from unreachable ones here.
    refuseAgents(
      ctx,
      "the binding kill switch and its budget are human controls: an agent-driven call may not " +
        "enable or disable a binding, raise what it may spend, or change the models it spends on " +
        "(an agent re-enabling or re-funding itself would defeat the switch; disabling a peer or " +
        "supervisor is not its call to make)",
    );

    // THE CAPABILITY WALL, reused (see header for the full why): `send` is
    // what a plain human token holds and what supervisory grants and agent
    // tokens do not. Grant-reached calls that DO pass carried a deliberately
    // widened grant, and requireAccount writes the grant_audit row for them.
    const access = await requireAccount(ctx, args, "send");

    if (args.create && Object.keys(args.create as object).length > 0) {
      throw new MethodError(
        "invalidArguments",
        "AgentBinding has no create over JMAP: provisioning an agent is an operator flow " +
          "(POST /agent-bindings on the provision worker)",
      );
    }
    if (args.destroy && (args.destroy as unknown[]).length > 0) {
      throw new MethodError(
        "invalidArguments",
        "AgentBinding has no destroy over JMAP: disable is the reversible pause (this method); " +
          "removal is an operator flow on the provision worker",
      );
    }

    const updated: Record<string, Record<string, unknown>> = {};
    const notUpdated: Record<string, SetError> = {};
    const update = (args.update as Record<string, Record<string, unknown>> | undefined) ?? {};

    for (const [id, patch] of Object.entries(update)) {
      if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
        notUpdated[id] = setError("invalidProperties", "the patch must be an object");
        continue;
      }
      // Refuse the rest BY NAME so the refusal teaches where each verb lives
      // instead of just enforcing the gate.
      const unknown = Object.keys(patch).filter((k) => !(WRITABLE as readonly string[]).includes(k));
      if (unknown.length > 0) {
        const owners = unknown
          .map((k) => `${k} → ${BINDING_MUTATION_OWNERS[k] ?? "no session-reachable door (yet)"}`)
          .join("; ");
        notUpdated[id] = {
          type: "invalidProperties",
          description:
            `AgentBinding/set writes the kill switch and the economics knobs — ` +
            `${WRITABLE.join(", ")}. Refused: ${owners}`,
          properties: unknown,
        };
        continue;
      }
      const named = Object.keys(patch);
      if (named.length === 0) {
        notUpdated[id] = setError(
          "invalidProperties",
          `the patch named no writable property (one of ${WRITABLE.join(", ")})`,
        );
        continue;
      }

      // ---- pure validation, before any row is read ----
      let nextEnabled: boolean | undefined;
      if ("enabled" in patch) {
        if (typeof patch.enabled !== "boolean") {
          notUpdated[id] = {
            type: "invalidProperties",
            description: "enabled must be true or false",
            properties: ["enabled"],
          };
          continue;
        }
        nextEnabled = patch.enabled;
      }
      let budget: number | undefined;
      if ("budgetMicros" in patch) {
        const v = validateBudget(patch.budgetMicros);
        if (!v.ok) {
          notUpdated[id] = v.error;
          continue;
        }
        budget = v.value;
      }
      let exploreRate: number | undefined;
      if ("exploreRate" in patch) {
        const v = validateExploreRate(patch.exploreRate);
        if (!v.ok) {
          notUpdated[id] = v.error;
          continue;
        }
        exploreRate = v.value;
      }
      let menu: MenuEntry[] | undefined;
      if ("modelMenu" in patch) {
        const v = validateMenu(patch.modelMenu);
        if (!v.ok) {
          notUpdated[id] = v.error;
          continue;
        }
        menu = v.value;
      }
      let defaultModel: string | undefined;
      if ("defaultModel" in patch) {
        const v = typeof patch.defaultModel === "string" ? patch.defaultModel.trim() : "";
        if (!v) {
          notUpdated[id] = {
            type: "invalidProperties",
            description: "defaultModel must be the name of an alias on this binding's modelMenu",
            properties: ["defaultModel"],
          };
          continue;
        }
        defaultModel = v;
      }
      const touchesConfig =
        budget !== undefined || exploreRate !== undefined || menu !== undefined || defaultModel !== undefined;

      // Ownership: resolved on THIS account only — a binding on any other
      // account answers with this same notFound, indistinguishably.
      const binding = await ctx.env.DB.prepare(
        `SELECT id, name, trigger_on, sla_seconds, enabled, config_json
           FROM agent_bindings WHERE account_id = ? AND id = ?`,
      )
        .bind(access.accountId, id)
        .first<BindingRow>();
      if (!binding) {
        notUpdated[id] = setError("notFound", "no such binding on this account");
        continue;
      }

      // ---- the targeted config write: set what was named, keep everything else ----
      const prior = parseConfig(binding.config_json);
      if (touchesConfig && prior === null) {
        // Refuse rather than clobber — see the header. `enabled` is a column
        // and is deliberately still reachable on such a binding.
        notUpdated[id] = setError(
          "serverFail",
          "this binding's config_json is not a JSON object, so a targeted write cannot preserve the " +
            "keys it cannot read — and rewriting it whole is exactly the data loss this door exists " +
            "to avoid. Repair it on the operator plane first. (`enabled` still works: it is a column.)",
        );
        continue;
      }
      const next: Record<string, unknown> = { ...(prior ?? {}) };
      if (budget !== undefined) {
        // Only `$.budgets.spendPerMonth` — any sibling budget key survives.
        const budgets = (next.budgets ?? {}) as Record<string, unknown>;
        next.budgets = { ...budgets, spendPerMonth: budget };
      }
      if (exploreRate !== undefined) {
        const frontier = (next.frontier ?? {}) as Record<string, unknown>;
        next.frontier = { ...frontier, exploreRate };
      }
      if (menu !== undefined) {
        // BYOK carry-forward: a label carries no credRef, so the prior config's
        // credRef for the same `provider/model` route rides along. Indexed off
        // `prior`, never off the request — a client cannot name a credential.
        const creds = credRefsByLabel(prior ?? {});
        const aliases: Record<string, StoredCandidate[]> = {};
        for (const entry of menu) {
          aliases[entry.alias] = entry.candidates.map((label) => {
            const parts = splitLabel(label)!;
            const credRef = creds.get(label);
            return credRef ? { ...parts, credRef } : parts;
          });
        }
        next.modelAliases = aliases;
      }
      if (defaultModel !== undefined) next.defaultModel = defaultModel;

      // The alias the pipelines resolve by default must NAME a chain that
      // exists — checked against the POST-patch menu, so it catches both a
      // defaultModel that names nothing and a modelMenu write that drops the
      // alias the binding already resolves by.
      const finalAliases = Object.keys((next.modelAliases ?? {}) as Record<string, unknown>);
      const finalDefault = typeof next.defaultModel === "string" ? next.defaultModel : null;
      if (touchesConfig && finalDefault !== null && !finalAliases.includes(finalDefault)) {
        notUpdated[id] = {
          type: "invalidProperties",
          description:
            `no alias named "${finalDefault}" on this binding's menu — the default model must name one of ` +
            `${finalAliases.length > 0 ? finalAliases.map((a) => `"${a}"`).join(", ") : "(the menu is empty)"}. ` +
            (defaultModel !== undefined
              ? "Name an alias the menu has, or send the menu that has it in the same patch."
              : "This modelMenu drops the alias the binding resolves by; send defaultModel in the same patch."),
          properties: defaultModel !== undefined ? ["defaultModel"] : ["modelMenu"],
        };
        continue;
      }

      const priorEnabled = binding.enabled === 1;
      const enabledNext = nextEnabled ?? priorEnabled;
      const nextJson = JSON.stringify(next);
      const configChanged = touchesConfig && nextJson !== JSON.stringify(prior ?? {});
      const enabledChanged = enabledNext !== priorEnabled;

      // The audit chain speaks the READ's vocabulary: both sides of every
      // old→new pair are what `/get` would have said before and after.
      const before = describeBindingEconomics(binding.config_json);
      const after = configChanged ? describeBindingEconomics(nextJson) : before;

      const confirm = (): Record<string, unknown> => {
        const out: Record<string, unknown> = {};
        if ("enabled" in patch) out.enabled = enabledNext;
        if ("budgetMicros" in patch) out.budgetMicros = after.budgetMicros;
        if ("defaultModel" in patch) out.defaultModel = after.defaultModel;
        if ("modelMenu" in patch) out.modelMenu = after.modelMenu;
        if ("exploreRate" in patch) out.exploreRate = after.exploreRate;
        return out;
      };

      if (!enabledChanged && !configChanged) {
        // Idempotent no-op: succeed (the state IS what was asked for), but
        // write nothing — no UPDATE, and above all no lifecycle row.
        updated[id] = confirm();
        continue;
      }

      // One chain row per property that actually moved, old→new.
      const events: Array<{ event: string; old: string | null; next: string | null }> = [];
      if (enabledChanged) {
        events.push({ event: "enabled-changed", old: priorEnabled ? "1" : "0", next: enabledNext ? "1" : "0" });
      }
      if (before.budgetMicros !== after.budgetMicros) {
        events.push({
          event: "budget-changed",
          old: before.budgetMicros === null ? null : String(before.budgetMicros),
          next: after.budgetMicros === null ? null : String(after.budgetMicros),
        });
      }
      if (before.defaultModel !== after.defaultModel) {
        events.push({ event: "default-model-changed", old: before.defaultModel, next: after.defaultModel });
      }
      if (JSON.stringify(before.modelMenu) !== JSON.stringify(after.modelMenu)) {
        events.push({
          event: "model-menu-changed",
          old: JSON.stringify(before.modelMenu),
          next: JSON.stringify(after.modelMenu),
        });
      }
      if (before.exploreRate !== after.exploreRate) {
        events.push({
          event: "explore-rate-changed",
          old: before.exploreRate === null ? null : String(before.exploreRate),
          next: after.exploreRate === null ? null : String(after.exploreRate),
        });
      }

      // The write and its chain rows, all-or-nothing: EVERY statement carries
      // the same full `(enabled, config_json)` pre-image, so a concurrent write
      // between the read above and this batch makes all of them match zero rows
      // — no half-write, and no chain row describing a change that never
      // happened. INSERTs ordered first (provision's s10 T4 ordering): they
      // read the pre-image the UPDATE is about to consume.
      const now = Date.now();
      const guard = [access.accountId, binding.id, binding.enabled, binding.config_json];
      const statements = events.map((e) =>
        ctx.env.DB.prepare(
          `INSERT INTO binding_lifecycle
             (account_id, binding_id, event, old_value, new_value, actor, via_proposal_id, at)
           SELECT ?, ?, ?, ?, ?, ?, NULL, ?
            WHERE EXISTS (SELECT 1 FROM agent_bindings
                          WHERE account_id = ? AND id = ? AND enabled = ? AND config_json = ?)`,
        ).bind(access.accountId, binding.id, e.event, e.old, e.next, ctx.principal.username, now, ...guard),
      );
      statements.push(
        ctx.env.DB.prepare(
          `UPDATE agent_bindings SET enabled = ?, config_json = ?
            WHERE account_id = ? AND id = ? AND enabled = ? AND config_json = ?`,
        ).bind(enabledNext ? 1 : 0, configChanged ? nextJson : binding.config_json, ...guard),
      );
      const results = await ctx.env.DB.batch(statements);
      const wrote = (results[results.length - 1]?.meta.changes ?? 0) > 0;
      if (!wrote) {
        notUpdated[id] = setError(
          "stateMismatch",
          "the binding moved under this call — its enabled state or its config was written by " +
            "something else between the read and the write. Re-read and decide again.",
        );
        continue;
      }
      updated[id] = confirm();
    }

    // No oldState/newState: AgentBinding is not a synced collection (header).
    return { accountId: access.accountId, updated, notUpdated };
  });
}
