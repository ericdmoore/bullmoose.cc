// T1 — the per-agent view. *"Can Allen even do that?"*
//
// Forward-looking, before the fact: the authorization question a support person
// asks. `readme.md`: *"Support tools organize per-person"*.
//
// Everything here is a pure function over an `AgentDossier`, for the reason
// s03.C settled on: the `.tsx` islands are thin and hold no rules, so the rules
// are testable in plain Node with no browser. The component below this renders
// `buildAgentView(...)` and decides nothing.
//
// The one thing this file must not do is invent policy. Every value it shows
// comes from the dossier or from an expansion of it; where a policy value has
// nowhere to be read from, `readme.md` §The s04 line says that is a signal to go
// define it in s04, not to make one up here. Spend is rendered as the ledger's
// total, never as a budget — budgets are s04's to decide and enforce.

import {
  dangerousCombinations,
  effectiveScopes,
  grantWarnings,
  hiddenScopes,
  intersectEffective,
  PERMISSION_MEANING,
  type DangerousCombination,
} from "./scopes";
import type {
  AgentDossier,
  ConsoleBinding,
  ConsoleBureauGrant,
  ConsoleCredential,
  ConsoleGrant,
  ConsoleInvocation,
} from "./types";

/** A grant with its liveness resolved against a point in time. */
export interface GrantStatus {
  grant: ConsoleGrant;
  /** `live` | `expired` | `revoked` — derived from the s03.A tombstone FIRST. */
  state: "live" | "expired" | "revoked";
  /** Effective permissions this grant confers, expanded through the gate's rule. */
  allows: string[];
  /** Permissions it confers WITHOUT naming them. The `mail`-is-a-bundle case. */
  hidden: string[];
  warnings: string[];
  expiresIn: number | null;
}

/**
 * Liveness, tombstone first.
 *
 * `015`'s `renderGrant` computes `live` from `expires_at` alone and predates
 * s03.A, so it reports a revoked grant as live. Order matters here: a grant can
 * be both expired and revoked, and "revoked" is the more informative answer
 * because somebody did it deliberately.
 */
export function grantState(grant: ConsoleGrant, now: number): "live" | "expired" | "revoked" {
  if (grant.revokedAt !== null && grant.revokedAt <= now) return "revoked";
  if (grant.expiresAt !== null && grant.expiresAt <= now) return "expired";
  return "live";
}

export function bureauGrantState(
  grant: ConsoleBureauGrant,
  now: number,
): "live" | "expired" | "revoked" {
  if (grant.revokedAt !== null && grant.revokedAt <= now) return "revoked";
  if (grant.expiresAt !== null && grant.expiresAt <= now) return "expired";
  return "live";
}

export function describeGrant(grant: ConsoleGrant, now: number): GrantStatus {
  return {
    grant,
    state: grantState(grant, now),
    allows: effectiveScopes(grant.scopes),
    hidden: hiddenScopes(grant.scopes),
    warnings: grantWarnings(grant),
    expiresIn: grant.expiresAt === null ? null : grant.expiresAt - now,
  };
}

// ── the headline question ───────────────────────────────────────────────────

export interface CanAnswer {
  permission: string;
  /** The answer, in one word. */
  can: boolean;
  /**
   * On its OWN account, from the token alone. Kept separate from `via` because
   * "Allen can send" and "Allen can send *from Eric's account*" are different
   * facts, and a single boolean has to pick one of them to be wrong about.
   */
  onOwnAccount: boolean;
  /** Grants that extend the permission to somebody ELSE's account. */
  via: GrantStatus[];
  /** Why — the specific grants/scopes that decide it. */
  because: string;
  /** True when nothing NAMES the permission but something confers it anyway. */
  impliedOnly: boolean;
  meaning: string;
}

/**
 * *"Can Allen send?"* — answerable at a glance and correct, including the
 * `mail`-is-a-superset case, which is `devPlan.md` T1's done-when.
 *
 * The rule reproduced here is the real one: effective rights on a grant-reached
 * account are **token ∩ grant**, so a grant conferring `send` answers "no" if
 * the agent's own token lacks it. Reading only the grant is the mistake this
 * screen exists to stop someone making.
 */
export function answerCan(dossier: AgentDossier, permission: string, now = Date.now()): CanAnswer {
  const meaning = PERMISSION_MEANING[permission] ?? permission;
  const live = dossier.grantsHeld.filter((g) => grantState(g, now) === "live");
  const via = live
    .filter((g) => intersectEffective(dossier.tokenScopes, g.scopes).includes(permission))
    .map((g) => describeGrant(g, now));

  const ownAccount = effectiveScopes(dossier.tokenScopes).includes(permission);
  const can = ownAccount || via.length > 0;

  // Named anywhere? If a grant confers it only through the `mail` bundle or the
  // write⇒read edge, say so — that is the case a scope-chip UI gets wrong.
  const namedByToken = dossier.tokenScopes.includes(permission);
  const namedByGrant = via.some((v) => v.grant.scopes.includes(permission));
  const impliedOnly = can && !namedByToken && !namedByGrant;

  let because: string;
  if (!can) {
    because =
      live.length > 0
        ? `No. The token ${fmt(dossier.tokenScopes)} does not expand to ${permission}, and no ` +
          "live grant can supply it — effective rights are token ∩ grant, so a grant cannot " +
          "exceed the token."
        : `No. Nothing confers ${permission}: the token does not hold it and there are no live grants.`;
  } else if (ownAccount && via.length === 0) {
    because =
      `Yes, on its own account: the token's scopes ${fmt(dossier.tokenScopes)} expand to ` +
      `include ${permission}. No grant extends it to anyone else's account.`;
  } else if (!ownAccount) {
    because = `Yes, but only through ${fmt(via.map((v) => v.grant.grantId))}.`;
  } else {
    const ids = via.map((v) => v.grant.grantId);
    because =
      `Yes, on its own account — and ${via.length === 1 ? "grant" : "grants"} ${fmt(ids)} ` +
      `${via.length === 1 ? "extends" : "extend"} ${permission} to ` +
      `${fmt(via.map((v) => v.grant.target?.address ?? v.grant.target?.accountId ?? "another account"))}. ` +
      "Effective rights there are token ∩ grant, so both halves had to be true.";
  }
  if (impliedOnly) {
    because +=
      ` Nothing NAMES "${permission}" — it is implied. A screen that listed only the stored ` +
      "scope strings would have shown this as absent.";
  }
  return { permission, can, onOwnAccount: ownAccount, because, via, impliedOnly, meaning };
}

const fmt = (xs: readonly string[]): string =>
  xs.length === 0 ? "(none)" : xs.map((x) => `\`${x}\``).join(", ");

// ── bindings ────────────────────────────────────────────────────────────────

export interface BindingStatus {
  binding: ConsoleBinding;
  warnings: string[];
  /** Credential handles this binding references — names only, never values. */
  credentialRefs: string[];
}

/** MIRROR of `introspectTools.bindingWarnings`. */
export function bindingWarnings(b: ConsoleBinding): string[] {
  const out: string[] = [];
  if (!b.enabled) out.push("disabled — it will not fire, and ingest creates no invocation for it");
  if (b.config.replyMode === "send") {
    out.push(
      "replyMode is SEND: this agent sends mail to the original sender itself. Nothing is " +
        "queued for you to approve.",
    );
  }
  if (b.config.senderAllowlist?.active === false && b.config.replyMode === "send") {
    out.push(
      "no sender allowlist AND replyMode send: anyone who can get a human-looking message " +
        "into this mailbox can make this account send mail. That combination is the " +
        "exfiltration shape worth reviewing even though each half looks routine.",
    );
  }
  if (b.triggerOn !== "mailbox-delivery") {
    out.push(
      `trigger_on is "${b.triggerOn}", and mailbox delivery is the only trigger the system ` +
        "actually implements — so nothing fires this binding today.",
    );
  }
  if (b.config.configUnparseable) {
    out.push("this binding's config could not be parsed, so none of the above could be checked");
  }
  return out;
}

// ── credentials ─────────────────────────────────────────────────────────────

export interface CredentialStatus {
  credential: ConsoleCredential;
  /** Live Bureau verbs this agent holds on it — the capability, not "access". */
  verbs: string[];
  /** Bureau grants, including tombstoned ones, so a revocation is visible. */
  grants: { grant: ConsoleBureauGrant; state: "live" | "expired" | "revoked" }[];
  /** True when only our own code narrows this credential (bureau.md §5.2 rung 3). */
  selfEnforcedOnly: boolean;
  notes: string[];
}

const ENFORCEMENT_NOTE: Record<string, string> = {
  federated:
    "federated — the provider issues a scoped, expiring credential per invocation (STS session " +
    "policy or equivalent). Rung 1: narrowest, and no root secret is stored.",
  narrow:
    "narrow — a provider-side key limited to this capability. Rung 2: the provider enforces the " +
    "narrowing independently of our code.",
  broad:
    "broad — ONE key with the provider's full policy, narrowed only by our own code. Rung 3: a " +
    "missing check in the verb gate reaches the key's entire policy, and revoking it stops " +
    "everything that uses it. Recorded so this is visible rather than tribal knowledge.",
};

export function describeCredential(
  credential: ConsoleCredential,
  bureauGrants: readonly ConsoleBureauGrant[],
  now: number,
): CredentialStatus {
  const mine = bureauGrants.filter((g) => g.credRef === credential.name);
  const grants = mine.map((g) => ({ grant: g, state: bureauGrantState(g, now) }));
  const verbs = grants.filter((g) => g.state === "live").map((g) => g.grant.verb);
  const notes: string[] = [];
  const enf = ENFORCEMENT_NOTE[credential.enforcement];
  if (enf) notes.push(enf);
  if (credential.allow === null) {
    notes.push(
      "no destination allowlist — the Bureau fails closed and will refuse to inject this " +
        "credential at all (bureau.md §6.5). Unusable by design until one is set.",
    );
  } else if (credential.allow.includes("*.")) {
    notes.push(
      `destination \`${credential.allow}\` is a wildcard: every host under that suffix receives ` +
        "this credential. Render it as the widening it is (§6.4).",
    );
  } else {
    notes.push(
      `destination \`${credential.allow}\` — matched on scheme+host+port, never as a substring, ` +
        "and dropped across any cross-origin redirect (§6.2, §6.3).",
    );
  }
  notes.push(
    "The value is not shown here and cannot be: no vault route returns one, and the master key " +
      "is not bound to the worker this console talks to (bureau.md invariant 1).",
  );
  return {
    credential,
    verbs,
    grants,
    selfEnforcedOnly: credential.enforcement === "broad",
    notes,
  };
}

// ── the assembled view ──────────────────────────────────────────────────────

export interface AgentView {
  dossier: AgentDossier;
  now: number;
  /** Everything the token itself allows, expanded. */
  tokenAllows: string[];
  /** Permissions the token confers without naming — shown as such. */
  tokenHidden: string[];
  bindings: BindingStatus[];
  credentials: CredentialStatus[];
  grantsHeld: GrantStatus[];
  grantsGiven: GrantStatus[];
  /** The headline row: one answer per irreversible permission. */
  headline: CanAnswer[];
  combinations: DangerousCombination[];
  recent: ConsoleInvocation[];
  spendLine: string | null;
  notes: string[];
}

/** The permissions worth answering up front — the irreversible ones. */
export const HEADLINE_PERMISSIONS = ["send", "delete", "vault", "admin"] as const;

export function buildAgentView(dossier: AgentDossier, now = Date.now()): AgentView {
  const bindings = dossier.bindings.map((b) => ({
    binding: b,
    warnings: bindingWarnings(b),
    credentialRefs: b.credentialRefs ?? [],
  }));
  const credentials = dossier.credentials.map((c) =>
    describeCredential(c, dossier.bureauGrants, now),
  );
  const tokenAllows = effectiveScopes(dossier.tokenScopes);

  const enabledSending = bindings.filter(
    (b) => b.binding.enabled && b.binding.config.replyMode === "send",
  );
  const combinations = dangerousCombinations({
    allows: tokenAllows,
    credentials: dossier.credentials,
    bureauGrants: dossier.bureauGrants,
    sendsWithoutReview: enabledSending.length > 0,
    unrestrictedSenders: enabledSending.some(
      (b) => b.binding.config.senderAllowlist?.active === false,
    ),
    readsUntrustedMail: bindings.some(
      (b) => b.binding.enabled && b.binding.triggerOn === "mailbox-delivery",
    ),
    now,
  });

  return {
    dossier,
    now,
    tokenAllows,
    tokenHidden: hiddenScopes(dossier.tokenScopes),
    bindings,
    credentials,
    grantsHeld: dossier.grantsHeld.map((g) => describeGrant(g, now)),
    grantsGiven: dossier.grantsGiven.map((g) => describeGrant(g, now)),
    headline: HEADLINE_PERMISSIONS.map((p) => answerCan(dossier, p, now)),
    combinations,
    recent: [...dossier.invocations].sort((a, b) => b.createdAt - a.createdAt),
    spendLine: spendLine(dossier),
    notes: [
      "A binding is not a grant: it runs INSIDE this account, so it does not appear in anyone's " +
        "grant list and its activity is never written to the delegated-access log.",
      "Binding config is a derived summary. The persona text, the model aliases and the " +
        "allowlisted addresses are deliberately not returned by any surface this console reads.",
      'Bureau grants are capability-shaped — (principal, credential, verb). "May use ' +
        '`sign_sigv4` with `aws-mcp`" is the whole permission; there is no "may read aws-mcp".',
    ],
  };
}

/**
 * The ledger's own total, phrased as a fact rather than a limit. Budgets are
 * s04's — `readme.md`: *"If this slice starts inventing budget semantics […] it
 * has crossed into s04 and should stop."*
 */
function spendLine(dossier: AgentDossier): string | null {
  const s = dossier.spend;
  if (!s) return null;
  const amount = (s.totalCents / 100).toFixed(2);
  const window =
    s.since === null
      ? "all recorded time"
      : `since ${new Date(s.since).toISOString().slice(0, 10)}`;
  return `${s.currency} ${amount} across ${s.rows} recorded ${s.rows === 1 ? "fact" : "facts"} (${window}). This is the ledger, not a budget — no limit is enforced here.`;
}
