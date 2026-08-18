import { MethodError, type MethodRegistry } from "@bullmoose/jmap-core";
import { isAgentPrincipal } from "@bullmoose/auth-core/principal";
import { requireAccount, setError, type RequestContext, type SetError } from "./common";

/**
 * AgentBinding/set (urn:bullmoose:params:jmap:agent) — the session-reachable
 * half of the 008 kill switch (s26 T2).
 *
 * s26 T1 shipped the dossier as a READ surface and named the gap honestly: the
 * only enable/disable doors were the provision worker's (ADMIN_TOKEN, operator
 * plane) and nothing a `bm_` session token could reach, so the webmail rendered
 * the switch and pointed at a CLI verb. This method is that door. It allows
 * exactly ONE mutation in v1 — `enabled: true|false` on a binding of an account
 * the session reaches with owner-grade authority — and refuses everything else
 * BY NAME, so the refusal teaches where each config verb actually lives
 * (provision's PATCH route does the same for its blob remainder).
 *
 * ── WHY `send` is the gate ──────────────────────────────────────────────────
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
 *     throw (or un-throw) its kill switch. In particular, a token whose only
 *     path to an account is a supervisory grant cannot disable a supervisor
 *     binding living there — supervision is not custody, and custody of the
 *     off switch is what `enabled` is;
 *   • agent runtime tokens structurally lack `send` — the wall's own argument.
 *
 * NOT `draft` (supervisors hold it, and flipping the switch is no kind of
 * drafting), NOT `delete` (nothing is destroyed — disable is a PAUSE with a
 * matching enable), and NOT the `mail` bundle literal (hasScope can only test
 * membership for it — a token minted with the six verbs spelled out must
 * pass, and requiring the bundle string would refuse it dishonestly).
 *
 * ── The agent marker, belt beside the braces ───────────────────────────────
 *
 * The marker only ever NARROWS a token (auth-core AGENT_MARKER_SCOPE), so an
 * agent-marked token minted with wide scopes could still satisfy `send`. But
 * the kill switch GOVERNS agents: an agent re-enabling itself would defeat
 * the switch outright, and an agent disabling a peer is sabotage wearing a
 * legitimate audit row. So agent-marked principals and agent-provenance calls
 * (ctx.agent — the MCP bridge and the proposal executor set it) are refused
 * unconditionally, before any account is even resolved — an unconditional
 * refusal discloses nothing.
 *
 * ── Ownership ──────────────────────────────────────────────────────────────
 *
 * The binding must live on the authenticated account: resolution is
 * `WHERE account_id = ? AND id = ?`, so a binding id that exists on someone
 * else's account answers exactly like one that never existed (the same
 * notFound, verbatim), and an accountId the principal cannot reach is
 * `accountNotFound` before any binding is consulted. A tombstoned account
 * cannot be re-enabled through this door for free: `reachableAccounts`
 * filters `deleted_at IS NULL`, so the account resolves to accountNotFound
 * (the admin verb refuses the same case explicitly, with a sentence).
 *
 * ── Audit ──────────────────────────────────────────────────────────────────
 *
 * A real flip appends a `binding_lifecycle` row — event `enabled-changed`,
 * old/new in the column's own 0/1 convention, `actor` = the acting principal
 * (the same value grant_audit records), `via_proposal_id` NULL (a direct
 * human decision) — in the SAME `db.batch` as the flip, both statements
 * guarded on the same `enabled` pre-image (the s10 T4 CAS discipline: the
 * chain row and the change it describes commit together or not at all; a
 * lost race answers stateMismatch and writes nothing). A no-op writes
 * NOTHING — no UPDATE and no chain row, provision's own rule: a chain that
 * records non-events is a chain nobody can read. Grant-reached calls (a
 * deliberately widened grant carrying `send`) additionally land in
 * `grant_audit` via requireAccount, as every method's do.
 *
 * AgentBinding is NOT a synced collection: no changelog entry, no /changes.
 * The read surface is the console projection (`/console/agents/*`), which
 * recomputes from the row on every fetch, and the /set response itself
 * carries the server-confirmed `enabled` for the client's reconcile.
 */

/** Where every OTHER binding mutation lives — named in refusals so the 400
 *  teaches the map. Kept an object so the message and the test share it. */
export const BINDING_MUTATION_OWNERS: Record<string, string> = {
  enabled: "this method",
  replyMode: "the operator plane (PATCH /agent-bindings/{id})",
  allowedSenders: "the operator plane (PATCH /agent-bindings/{id})",
  recipientsBookId: "the operator plane (PATCH /agent-bindings/{id})",
  modelAliases: "re-provision-in-place (the sanctioned model-swap path)",
  budgets: "provision time (POST /extractor budgetMicros)",
};

interface BindingRow {
  id: string;
  name: string;
  enabled: number;
}

export function registerAgentBindingMethods(registry: MethodRegistry<RequestContext>): void {
  registry.register("AgentBinding/set", async (args, ctx) => {
    // The unconditional refusal first: no agent hand on the kill switch (see
    // header). Checked before account resolution so a marked token cannot
    // even distinguish reachable accounts from unreachable ones here.
    if (ctx.agent || isAgentPrincipal(ctx.principal)) {
      throw new MethodError(
        "forbidden",
        "the binding kill switch is a human control: an agent-driven call may not enable or " +
          "disable a binding (an agent re-enabling itself would defeat the switch; disabling a " +
          "peer or supervisor is not its call to make)",
      );
    }

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

    const updated: Record<string, { enabled: boolean }> = {};
    const notUpdated: Record<string, SetError> = {};
    const update = (args.update as Record<string, Record<string, unknown>> | undefined) ?? {};

    for (const [id, patch] of Object.entries(update)) {
      if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
        notUpdated[id] = setError("invalidProperties", "the patch must be an object");
        continue;
      }
      // v1 mutates exactly `enabled`; refuse the rest by name so the refusal
      // teaches where each verb lives instead of just enforcing the gate.
      const unknown = Object.keys(patch).filter((k) => k !== "enabled");
      if (unknown.length > 0) {
        const owners = unknown
          .map((k) => `${k} → ${BINDING_MUTATION_OWNERS[k] ?? "no session-reachable door (yet)"}`)
          .join("; ");
        notUpdated[id] = {
          type: "invalidProperties",
          description:
            `AgentBinding/set v1 writes exactly one property, "enabled" (the kill switch). ` + `Refused: ${owners}`,
          properties: unknown,
        };
        continue;
      }
      if (typeof patch.enabled !== "boolean") {
        notUpdated[id] = {
          type: "invalidProperties",
          description: "enabled must be true or false",
          properties: ["enabled"],
        };
        continue;
      }
      const next = patch.enabled;

      // Ownership: resolved on THIS account only — a binding on any other
      // account answers with this same notFound, indistinguishably.
      const binding = await ctx.env.DB.prepare(
        `SELECT id, name, enabled FROM agent_bindings WHERE account_id = ? AND id = ?`,
      )
        .bind(access.accountId, id)
        .first<BindingRow>();
      if (!binding) {
        notUpdated[id] = setError("notFound", "no such binding on this account");
        continue;
      }

      const prior = binding.enabled === 1;
      if (prior === next) {
        // Idempotent no-op: succeed (the state IS what was asked for), but
        // write nothing — no UPDATE, and above all no lifecycle row.
        updated[id] = { enabled: next };
        continue;
      }

      // The flip and its chain row, all-or-nothing: both statements carry the
      // same `enabled` pre-image, so a concurrent flip between the read above
      // and this batch makes BOTH match zero rows — no half-write, and no
      // chain row describing a change that never happened. INSERT ordered
      // first (provision's s10 T4 ordering): it reads the pre-image the
      // UPDATE is about to consume.
      const now = Date.now();
      const results = await ctx.env.DB.batch([
        ctx.env.DB.prepare(
          `INSERT INTO binding_lifecycle
             (account_id, binding_id, event, old_value, new_value, actor, via_proposal_id, at)
           SELECT ?, ?, 'enabled-changed', ?, ?, ?, NULL, ?
            WHERE EXISTS (SELECT 1 FROM agent_bindings
                          WHERE account_id = ? AND id = ? AND enabled = ?)`,
        ).bind(
          access.accountId,
          binding.id,
          prior ? "1" : "0",
          next ? "1" : "0",
          ctx.principal.username,
          now,
          access.accountId,
          binding.id,
          prior ? 1 : 0,
        ),
        ctx.env.DB.prepare(
          `UPDATE agent_bindings SET enabled = ? WHERE account_id = ? AND id = ? AND enabled = ?`,
        ).bind(next ? 1 : 0, access.accountId, binding.id, prior ? 1 : 0),
      ]);
      const flipped = (results[1]?.meta.changes ?? 0) > 0;
      if (!flipped) {
        notUpdated[id] = setError(
          "stateMismatch",
          "the binding's enabled state moved under this call — re-read and decide again",
        );
        continue;
      }
      updated[id] = { enabled: next };
    }

    // No oldState/newState: AgentBinding is not a synced collection (header).
    return { accountId: access.accountId, updated, notUpdated };
  });
}
