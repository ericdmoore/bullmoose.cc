// s26 T4 — BYOK's shaping layer: every sentence and every derivation the two
// surfaces render, as pure functions with unit tests. The components below
// (`SettingsAgentsSection`, `AgentDossierPanel`) are markup over these values —
// the same bargain `lib/agents/dossier.ts` and `lib/settings/agentsPolicy.ts`
// already make, and the reason those components stay render-testable with
// preact-render-to-string and no jsdom.
//
// ── WHERE THIS SURFACE LIVES, AND WHY (the s26 discriminator) ─────────────
//
// Eric's rule: **"if this agent were deleted, would the value still mean
// anything?"** Yes → Settings realm (policy that outlives any one agent). No →
// the agent's own dossier.
//
// BYOK splits across it cleanly, and the split is not a compromise — it is the
// rule applied twice to two different values:
//
//   THE KEY belongs to the TENANT. Delete every agent on the account and the
//   sealed credential, its destination binding and its `fetch` grant are all
//   still true and still exactly as spendable. It is not even scoped to an
//   account — `vault_credentials` is keyed on the PRINCIPAL. So adding,
//   rotating and revoking a key live in **Settings → Agents**, beside the other
//   policy that outlives its subjects. s26's own table says the same
//   ("BYOK provider credentials (per tenant, via the Bureau)").
//
//   WHICH BINDING SPENDS IT is meaningless without the binding. It is a key in
//   that binding's `config_json`, it is the thing the Bureau checks before it
//   will proxy anything, and deleting the agent deletes it. So "this agent uses
//   your OpenRouter key / this agent is on the platform key / this agent is
//   REFUSING because its named credential does not resolve" is on **the
//   dossier**, with detach as its verb. Again s26's table: "which credential
//   this binding uses".
//
// The failure state lives on BOTH, deliberately, and that is the one place the
// split is loosened. `models.ts`' whole guarantee is that a binding naming a
// credential that does not resolve **refuses rather than spending the platform
// key** — correct, and silent. A person who has just sealed a key is looking at
// Settings; a person wondering why an agent went quiet is looking at the
// dossier. A status that only appeared on one of those pages would recreate the
// silence this feature exists to remove.

/** The wire shapes `ProviderCredential/get` returns.
 *
 *  Mirrored rather than imported, exactly as `lib/console/types.ts` mirrors the
 *  console's: those modules are Cloudflare Worker code (D1, service bindings,
 *  the vault master key's absence) and a bare `@bullmoose/*`-style reach into
 *  `services/` would drag a worker into the browser bundle. */
export type ByokRefStatus =
  | "live"
  | "no-credential"
  | "no-grant"
  | "grant-revoked"
  | "grant-expired"
  | "wrong-kind"
  | "no-destination";

export interface ByokBindingRef {
  bindingId: string;
  bindingName: string;
  enabled: boolean;
  provider: string;
  credRef: string;
  status: ByokRefStatus;
}

/** ⚠️ There is no value field, and there never will be one (bureau.md
 *  invariant 1). The server's own shape has none; this mirror having none is
 *  the client-side half of the same promise. */
export interface ByokCredential {
  credRef: string;
  kind: string;
  allow: string | null;
  provider: string | null;
  sealedAt: number;
  rotatedAt: number;
  grant: {
    grantId: string;
    live: boolean;
    createdAt: number;
    expiresAt: number | null;
    revokedAt: number | null;
  } | null;
}

export interface ByokStatus {
  accountId: string;
  credentials: ByokCredential[];
  refs: ByokBindingRef[];
  platformKeyBindings: Array<{ id: string; name: string; provider: string }>;
  keyReadable: boolean;
  mayWrite: boolean;
  writeRefusal: string | null;
  sealableProviders: string[];
}

// ── the explainer, said once ──────────────────────────────────────────────

/**
 * The honest empty state, in three sentences that are each load-bearing.
 *
 * The middle one is the whole feature and the easiest to get wrong. bullmoose
 * does not implement, mirror or even read a provider's guardrails; they apply
 * because the request authenticates as the tenant. Writing "we apply your
 * redaction rules" would be a claim this codebase cannot keep and would drift
 * from the provider console the moment either side changed. Writing "your
 * guardrails apply because the request is yours" is exactly true and stays true
 * for features OpenRouter has not shipped yet.
 */
export const BYOK_EXPLAINER: readonly string[] = [
  "Bring your own provider key and your agents' model calls authenticate as YOU, at your provider, on your invoice.",
  "Whatever you have switched on there rides along automatically — OpenRouter's guardrails and PII redaction, your route and model allowlists, your own spend cap, your own usage log. bullmoose does not implement, mirror or read any of it: it applies because the request is yours.",
  "With no key of your own, agents use the platform's key and the platform's provider settings.",
];

/** What the value actually is here, stated where someone is about to paste one
 *  in. Not reassurance — the specific mechanism, because that is what makes it
 *  checkable. */
export const BYOK_WRITE_ONLY_NOTE =
  "The key is write-only: it is sealed in the credential vault on the way in, and no page, API or export ever shows it again — not even the first few characters. To change it, paste a new one; to stop it being used, revoke it.";

// ── per-reference status copy ─────────────────────────────────────────────

export type ByokTone = "success" | "warn" | "error" | "neutral";

export interface RefCopy {
  /** Short chip text. */
  label: string;
  tone: ByokTone;
  /** The sentence beneath it: what is actually happening, and what to do. */
  detail: string;
}

/**
 * One entry per status the server can report, and every one of the failures
 * says the same load-bearing thing: **the agent refuses; it does not quietly
 * fall back to the platform key.** That is the guarantee #203 exists for, and a
 * status page that let a person assume "well, it probably just used the default"
 * would give the guarantee away in the UI after the server had kept it.
 */
export const REF_COPY: Record<ByokRefStatus, RefCopy> = {
  live: {
    label: "your key",
    tone: "success",
    detail: "This agent's model calls authenticate as you, so your provider-side settings apply to them.",
  },
  "no-credential": {
    label: "refusing",
    tone: "error",
    detail:
      "This agent names a credential that is not in your vault, so it REFUSES every model call rather than " +
      "spending the platform's key on your work. Add the key below, or detach it here to fall back to the platform key.",
  },
  "no-grant": {
    label: "refusing",
    tone: "error",
    detail:
      "The key is sealed but nothing authorizes this agent to spend it — sealing a credential grants no one. " +
      "The agent REFUSES every call rather than falling back. Re-adding the key restores the grant.",
  },
  "grant-revoked": {
    label: "refusing",
    tone: "error",
    detail:
      "Permission to spend this key was revoked, so the agent REFUSES every model call rather than falling back " +
      "to the platform's key. Detach it to put this agent back on the platform key, or re-add your key.",
  },
  "grant-expired": {
    label: "refusing",
    tone: "error",
    detail:
      "Permission to spend this key has expired. The agent REFUSES every model call rather than falling back to " +
      "the platform's key. Re-add your key to renew it.",
  },
  "wrong-kind": {
    label: "refusing",
    tone: "error",
    detail:
      "The stored credential is not a kind that can authenticate an outbound request, so the agent REFUSES " +
      "rather than falling back. Re-add the key.",
  },
  "no-destination": {
    label: "refusing",
    tone: "error",
    detail:
      "This credential has no allowed destination, and a credential that could be sent anywhere is refused " +
      "outright. The agent REFUSES every call rather than falling back. Re-add the key to rebuild its destination.",
  },
};

// ── the dossier's view: ONE binding ───────────────────────────────────────

export interface BindingByokView {
  /** null = this binding names no credential at all — the platform-key case. */
  ref: ByokBindingRef | null;
  credential: ByokCredential | null;
  copy: RefCopy;
  /** "openrouter.ai" — where this key may be spent, and nowhere else. */
  host: string | null;
  /** "sealed 12 Aug" / "rotated 18 Aug", or null when there is nothing sealed. */
  sealedLabel: string | null;
  rotatedLabel: string | null;
  /** Would this binding actually reach a provider that takes a key? A binding
   *  with no such route cannot use BYOK at all, and saying "on the platform
   *  key" there would be misleading rather than merely terse. */
  byokCapable: boolean;
  /** True when the detach verb makes sense: something is attached to detach. */
  canDetach: boolean;
}

/** The platform-key case, said plainly rather than as an absence. */
export const PLATFORM_KEY_COPY: RefCopy = {
  label: "platform key",
  tone: "neutral",
  detail:
    "This agent uses the platform's provider key, so the platform's provider-side settings apply — not yours. " +
    "Add your own key in Settings → Agents to change that.",
};

const NOT_APPLICABLE: RefCopy = {
  label: "no provider key needed",
  tone: "neutral",
  detail: "This agent's models run on bullmoose's own infrastructure, so there is no provider key to bring.",
};

export function bindingByokView(
  status: ByokStatus | undefined,
  bindingId: string,
  now: number = Date.now(),
): BindingByokView {
  const ref = status?.refs.find((r) => r.bindingId === bindingId) ?? null;
  const credential = ref ? (status?.credentials.find((c) => c.credRef === ref.credRef) ?? null) : null;
  const byokCapable = !!ref || !!status?.platformKeyBindings.some((b) => b.id === bindingId);
  return {
    ref,
    credential,
    copy: ref ? REF_COPY[ref.status] : byokCapable ? PLATFORM_KEY_COPY : NOT_APPLICABLE,
    host: credential?.allow ? hostOf(credential.allow) : null,
    sealedLabel: credential ? `sealed ${dayLabel(credential.sealedAt, now)}` : null,
    rotatedLabel:
      credential && credential.rotatedAt > credential.sealedAt
        ? `rotated ${dayLabel(credential.rotatedAt, now)}`
        : null,
    byokCapable,
    canDetach: !!ref,
  };
}

// ── the Settings view: the TENANT's keys ──────────────────────────────────

export interface TenantKeyRow {
  credRef: string;
  /** "openrouter.ai" — the only place this key may be spent. */
  host: string | null;
  provider: string | null;
  sealedLabel: string;
  rotatedLabel: string | null;
  /** live | revoked | expired | ungranted, as one word plus a tone. */
  state: RefCopy;
  /** The agents currently naming it, with their per-binding verdict. */
  usedBy: ByokBindingRef[];
}

export interface TenantByokView {
  keys: TenantKeyRow[];
  /** One sentence over the whole account — what is true right now. */
  summary: string;
  /** Agents that could carry a key and are on the platform's. */
  onPlatformKey: Array<{ id: string; name: string; provider: string }>;
  /** Any binding currently refusing, so the headline cannot be quietly wrong. */
  refusing: ByokBindingRef[];
  mayWrite: boolean;
  writeRefusal: string | null;
  sealableProviders: string[];
}

const KEY_STATE_LIVE: RefCopy = {
  label: "in use",
  tone: "success",
  detail: "Sealed, authorized, and spendable only at the destination below.",
};
const KEY_STATE_UNUSED: RefCopy = {
  label: "not used by any agent",
  tone: "warn",
  detail:
    "Sealed and authorized, but no agent names it — nothing is spending it. It is not lost; attach it to an agent.",
};
const KEY_STATE_REVOKED: RefCopy = {
  label: "revoked",
  tone: "neutral",
  detail:
    "Permission to spend this key is revoked, so nothing can use it. The sealed value itself was not deleted, so " +
    "adding the key again reinstates the same permission — this is a stop, not an erase.",
};
const KEY_STATE_EXPIRED: RefCopy = {
  label: "expired",
  tone: "warn",
  detail: "Permission to spend this key has expired. Add the key again to renew it.",
};
const KEY_STATE_UNGRANTED: RefCopy = {
  label: "not authorized",
  tone: "error",
  detail: "The key is sealed but nothing authorizes its use — sealing a credential grants no one. Add it again.",
};

export function tenantByokView(status: ByokStatus | undefined, now: number = Date.now()): TenantByokView {
  const refs = status?.refs ?? [];
  const keys: TenantKeyRow[] = (status?.credentials ?? []).map((c) => {
    const usedBy = refs.filter((r) => r.credRef === c.credRef);
    return {
      credRef: c.credRef,
      host: c.allow ? hostOf(c.allow) : null,
      provider: c.provider,
      sealedLabel: `sealed ${dayLabel(c.sealedAt, now)}`,
      rotatedLabel: c.rotatedAt > c.sealedAt ? `rotated ${dayLabel(c.rotatedAt, now)}` : null,
      state: keyState(c, usedBy),
      usedBy,
    };
  });
  const refusing = refs.filter((r) => r.status !== "live");
  const onPlatformKey = status?.platformKeyBindings ?? [];
  return {
    keys,
    summary: summarize(keys.length, refs, onPlatformKey.length),
    onPlatformKey,
    refusing,
    mayWrite: status?.mayWrite ?? false,
    writeRefusal: status?.writeRefusal ?? null,
    sealableProviders: status?.sealableProviders ?? [],
  };
}

function keyState(c: ByokCredential, usedBy: readonly ByokBindingRef[]): RefCopy {
  if (!c.grant) return KEY_STATE_UNGRANTED;
  if (c.grant.revokedAt !== null) return KEY_STATE_REVOKED;
  if (!c.grant.live) return KEY_STATE_EXPIRED;
  if (c.allow === null) return REF_COPY["no-destination"];
  return usedBy.length > 0 ? KEY_STATE_LIVE : KEY_STATE_UNUSED;
}

/**
 * The one-line truth about this account, and the ORDER matters: a refusal
 * outranks a count, because "2 keys configured" beside three silently refusing
 * agents is the reassuring-and-wrong sentence this whole surface exists to
 * avoid printing.
 */
function summarize(keyCount: number, refs: readonly ByokBindingRef[], platformCount: number): string {
  const refusing = refs.filter((r) => r.status !== "live").length;
  if (refusing > 0) {
    return `${refusing} ${plural(refusing, "agent is", "agents are")} refusing every model call — a key ${plural(refusing, "it names", "they name")} does not resolve. Nothing falls back to the platform key.`;
  }
  if (keyCount === 0) {
    return platformCount === 0
      ? "No provider key of your own, and no agent that could use one yet."
      : `No provider key of your own: ${platformCount} ${plural(platformCount, "agent uses", "agents use")} the platform's key and the platform's provider settings.`;
  }
  const using = refs.length;
  const tail = platformCount > 0 ? `; ${platformCount} still on the platform key` : "";
  return `${keyCount} ${plural(keyCount, "key", "keys")} of your own, used by ${using} ${plural(using, "agent", "agents")}${tail}.`;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

// ── small shared derivations ──────────────────────────────────────────────

/** The host a key may be spent at. Falls back to the raw allow string rather
 *  than to nothing: an unparseable destination is still the destination that
 *  will be enforced, and hiding it would be worse than showing it oddly. */
export function hostOf(allow: string): string {
  try {
    return new URL(allow).host;
  } catch {
    return allow.replace(/^https?:\/\//, "");
  }
}

const DAY_MS = 86_400_000;

/** "today" / "yesterday" / "6 days ago" / an absolute date beyond a week.
 *  Deliberately day-grained: a credential's age is a "when did I last touch
 *  this" question, and minute precision on a rotation date is noise. */
export function dayLabel(at: number, now: number): string {
  const days = Math.floor((startOfDay(now) - startOfDay(at)) / DAY_MS);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(at).toISOString().slice(0, 10);
}

function startOfDay(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}
