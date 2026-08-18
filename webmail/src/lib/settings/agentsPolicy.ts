// s26 T2 — Settings → Agents: the POLICY side of the dossier/Settings split.
//
// The discriminator (``.plans/s26-agent-config/devPlan.md``, Eric's rule):
//
//   "If this agent were deleted, would the value still mean anything?"
//   Yes → it belongs HERE, in Settings: platform policy that outlives any one
//         agent (defaults for NEW agents, tenant-wide credentials, learning
//         toggles).
//   No  → it lives on the agent's dossier, and changing it is a VERB on that
//         page (swap model, set budget, enable/disable) — settable is a verb,
//         not a location.
//
// This module is the pure half: constants, labels, and the roster shaping the
// Settings island renders. It deliberately REUSES `lib/agents/dossier.ts`'s
// row flattening — the Settings roster and the Agents realm list are the same
// rows, and two flatteners would drift.
//
// ── The defaults are MIRRORS, and the test pins them ───────────────────────
// The default budget and explore rate for a NEW agent are literals inside
// `services/provision/src/index.ts` (`provisionExtractor`). There is no
// session-reachable read for them and no write path at all short of
// re-provisioning, so v1 shows them read-only, labeled "set at provision
// time" — an honest display, not a dead form. Importing worker code into a
// browser bundle is not on (the lib/console/types.ts rule), so the values are
// restated here and `agentsPolicy.test.ts` reads the provision source off
// disk and fails if either side moves (the caveats.test.ts anti-drift shape).

import { microsLabel, type AgentListRow } from "../agents/dossier";

export const DISCRIMINATOR_QUESTION = "If this agent were deleted, would the value still mean anything?";
export const DISCRIMINATOR_YES = "Yes → it belongs here in Settings: platform policy that outlives any one agent.";
export const DISCRIMINATOR_NO =
  "No → it lives on the agent's own page in the Agents realm, where changing it is a verb — " +
  "swap model, set budget, enable or disable.";

/** Mirror of provisionExtractor's default `budgetMicros` (µUSD). */
export const PROVISION_DEFAULT_BUDGET_MICROS = 2_000_000;
/** Mirror of provisionExtractor's default frontier `exploreRate`. */
export const PROVISION_DEFAULT_EXPLORE_RATE = 0.2;

export interface PolicyDefault {
  /** Field label — "Default monthly budget". */
  label: string;
  /** The value, rendered — "$2.00 / month". */
  value: string;
  /** Why it is read-only here, said rather than implied. */
  note: string;
}

/** What a NEW agent gets unless provisioning says otherwise. Read-only in v1:
 *  these are provision-time literals with no session-reachable write door, and
 *  a form that collects a change the server must throw away is the failure the
 *  identity screen was already warned about. */
export function provisionDefaults(): PolicyDefault[] {
  return [
    {
      label: "Default monthly budget",
      value: `${microsLabel(PROVISION_DEFAULT_BUDGET_MICROS)} / month`,
      note:
        "Set at provision time (budgetMicros on the provisioning call); a paid pipeline never " +
        "ships uncapped. Changing one agent's budget is a dossier verb, not a setting.",
    },
    {
      label: "Default explore rate",
      value: `${Math.round(PROVISION_DEFAULT_EXPLORE_RATE * 100)}% of runs`,
      note:
        "Set at provision time, and only when explore models are configured — the frontier " +
        "program's A/B share across the model menu. 0% otherwise.",
    },
  ];
}

/** "3 agents · 2 enabled · 1 disabled" — the roster's one-line summary. */
export function rosterSummary(rows: readonly AgentListRow[]): string {
  if (rows.length === 0) return "No agent bindings on the accounts you own.";
  const enabled = rows.filter((r) => r.enabled).length;
  const disabled = rows.length - enabled;
  const agents = `${rows.length} ${rows.length === 1 ? "agent" : "agents"}`;
  return disabled === 0 ? `${agents} · all enabled` : `${agents} · ${enabled} enabled · ${disabled} disabled`;
}

/** Stable roster order: disabled first (they are the ones needing a decision),
 *  then by name — a POLICY page ordering, distinct from the realm's list. */
export function orderRoster(rows: readonly AgentListRow[]): AgentListRow[] {
  return [...rows].sort((a, b) => (a.enabled === b.enabled ? a.name.localeCompare(b.name) : a.enabled ? 1 : -1));
}
