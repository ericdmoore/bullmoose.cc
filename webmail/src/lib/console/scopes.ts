// Effective permissions, and the combinations that are dangerous only together.
//
// `readme.md` §Non-obvious 1 is a correctness requirement, not a styling note:
//
//   > Render *effective* permissions, not raw scopes. `hasScope` treats `mail`
//   > as a superset […] A chip labelled "mail" reads as innocuous while
//   > granting `send` and `delete`. Show what it *allows*.
//
// So the console never prints a scope list as if it were the whole truth. It
// prints the expansion, and shows the stored list beside it labelled as the
// understatement it is.
//
// The expansion mirrors `@bullmoose/auth-core`'s `hasScope` — the SAME function
// every gate in the tree calls, and the same one `services/agent`'s
// `effectiveScopes` expands through (`introspectTools.ts:114`), for the reason
// stated there: *"the one tool whose job is to explain authorization must not be
// the tool that misrepresents it."*
//
// Mirrored, not imported — see the header of `types.ts` for why a browser bundle
// cannot reach into a worker package here. `scopes.test.ts` closes the gap the
// only way that survives refactoring: it imports the REAL `hasScope` (test-only,
// through the vitest alias) and asserts agreement across every scope list that
// matters, so a change to the gate breaks this file's tests rather than quietly
// making the console lie.

import type { ConsoleBureauGrant, ConsoleCredential } from "./types";

/** MIRROR of `@bullmoose/auth-core` MAIL_SCOPES. */
export const MAIL_SCOPES = ["read", "annotate", "draft", "move", "send", "delete"] as const;

/** MIRROR of `@bullmoose/auth-core` REALM_SCOPES. */
export const REALM_SCOPES = ["contacts", "calendar", "vault", "files"] as const;

/**
 * Every scope that is a concrete permission rather than a bundle. `mail` is
 * excluded on purpose: it IS the bundle, and expanding it is the whole point.
 * MIRROR of `introspectTools.ts` CONCRETE_SCOPES.
 */
export const CONCRETE_SCOPES: readonly string[] = [...MAIL_SCOPES, ...REALM_SCOPES, "rules", "admin"];

const MAIL_COVERS = new Set<string>(MAIL_SCOPES);
const WRITE_VERBS = new Set<string>(MAIL_SCOPES.filter((s) => s !== "read"));
const REALMS = new Set<string>(REALM_SCOPES);

/**
 * MIRROR of `@bullmoose/auth-core`'s `hasScope`. Three rules, in order:
 * held verbatim; `mail` covers exactly the six mail verbs; and any write
 * capability implies `read` (common/027 — you cannot change what you cannot
 * see). Unknown strings are denied. Fail closed.
 */
export function hasScope(granted: readonly string[], required: string): boolean {
  if (granted.includes(required)) return true;
  if (granted.includes("mail") && MAIL_COVERS.has(required)) return true;
  if (required === "read") {
    return granted.some((g) => WRITE_VERBS.has(g) || REALMS.has(g) || g === "mail");
  }
  return false;
}

/** What a scope list ACTUALLY allows. MIRROR of `introspectTools.effectiveScopes`. */
export function effectiveScopes(granted: readonly string[]): string[] {
  return CONCRETE_SCOPES.filter((s) => hasScope(granted, s));
}

/**
 * Effective rights on a grant-reached account are `token ∩ grant` — never the
 * grant's scopes alone. A grant allowing `send` does nothing if the token
 * lacks it. (`introspectTools` whoami:746.)
 */
export function intersectEffective(tokenScopes: readonly string[], grantScopes: readonly string[]): string[] {
  return effectiveScopes(grantScopes).filter((s) => hasScope(tokenScopes, s));
}

/**
 * Scopes the stored list does NOT name but which it nonetheless confers. This
 * is the `mail`-is-a-superset case made visible: `["mail"]` hides five
 * permissions, two of them irreversible.
 */
export function hiddenScopes(granted: readonly string[]): string[] {
  return effectiveScopes(granted).filter((s) => !granted.includes(s));
}

/** One sentence per permission, so a chip is never the only explanation. */
export const PERMISSION_MEANING: Record<string, string> = {
  read: "read every message, contact and event this grant covers",
  annotate: "change flags and labels (read/unread, starred)",
  draft: "create and edit drafts",
  move: "move messages between mailboxes, including out of the inbox",
  send: "send mail from this account to third parties, with no human review step",
  delete: "permanently delete mail",
  contacts: "read and write the contacts realm",
  calendar: "read and write the calendar realm",
  vault: "act with third-party credentials stored in the vault",
  files: "read and write the files realm",
  rules: "rewrite the mail-filtering rulebook — standing filters that decide where future mail goes",
  admin: "control-plane access — this should never appear on a grant",
};

/** Scopes that deserve a sentence rather than a chip. MIRROR of SCOPE_WARNINGS. */
const SCOPE_WARNINGS: Record<string, string> = {
  send: "send — can send mail from this account to third parties, with no human review step",
  delete: "delete — can permanently delete mail",
  vault: "vault — can act with third-party credentials stored in the vault",
  admin: "admin — control-plane access; this should never appear on a grant",
};

export interface GrantLike {
  scopes: string[];
  collection: string | null;
  expiresAt: number | null;
}

/**
 * MIRROR of `introspectTools.grantWarnings` — the per-grant warnings `015`
 * already returns conversationally, rendered here instead of narrated.
 */
export function grantWarnings(grant: GrantLike): string[] {
  const eff = effectiveScopes(grant.scopes);
  const out: string[] = [];
  for (const s of eff) {
    const w = SCOPE_WARNINGS[s];
    if (w) out.push(w);
  }
  if (grant.collection === null) {
    out.push(
      "whole-account grant — not narrowed to one address book or calendar, so it covers " +
        "every domain its scopes allow",
    );
  }
  if (grant.expiresAt === null) {
    out.push("no expiry — this grant stays live until someone revokes it");
  }
  if (eff.includes("send") && eff.includes("read")) {
    out.push(
      "read + send together is an exfiltration path: the holder can read this account's mail " +
        "and send it anywhere, in one hop, without anyone approving the message",
    );
  }
  return out;
}

// ── dangerous combinations ──────────────────────────────────────────────────
//
// `readme.md` §Non-obvious 2: *"send + external MCP + WebFetch is an
// exfiltration path (`mcp-auth.md` §8) even though each part looks fine alone."*
// Each ingredient renders as routine on its own screen, which is exactly why a
// per-ingredient UI misses it — the finding only exists at the join.

export type CombinationSeverity = "critical" | "warning";

export interface DangerousCombination {
  id: string;
  severity: CombinationSeverity;
  title: string;
  /** The ingredients, each innocuous alone — named so the reader can check them. */
  ingredients: string[];
  /** What the combination makes possible. */
  consequence: string;
}

export interface CombinationInput {
  /** Effective permissions of the agent, already expanded. */
  allows: readonly string[];
  credentials: readonly ConsoleCredential[];
  bureauGrants: readonly ConsoleBureauGrant[];
  /** True when any enabled binding sends rather than drafts. */
  sendsWithoutReview: boolean;
  /** True when at least one enabled sending binding has no sender allowlist. */
  unrestrictedSenders: boolean;
  /** True when this agent reads inbound (untrusted) mail — bureau.md §5.2 last ¶. */
  readsUntrustedMail: boolean;
  now?: number;
}

const isLive = (g: ConsoleBureauGrant, now: number): boolean =>
  g.revokedAt === null && (g.expiresAt === null || g.expiresAt > now);

/**
 * The combinations worth interrupting someone over. Deliberately few: a screen
 * that flags everything flags nothing.
 */
export function dangerousCombinations(input: CombinationInput): DangerousCombination[] {
  const now = input.now ?? Date.now();
  const out: DangerousCombination[] = [];
  const liveBureau = input.bureauGrants.filter((g) => isLive(g, now));
  const byRef = new Map(input.credentials.map((c) => [c.name, c]));
  const egressGrants = liveBureau.filter((g) => g.verb === "fetch");
  const canSend = input.allows.includes("send");

  // 1. The one `readme.md` names: send + an external credential + an egress verb.
  if (canSend && egressGrants.length > 0) {
    const refs = egressGrants.map((g) => g.credRef);
    out.push({
      id: "send-plus-egress",
      severity: "critical",
      title: "Exfiltration path: can send mail AND make credentialed outbound calls",
      ingredients: [
        "effective permission `send` — mail leaves this account with no human review",
        `Bureau \`fetch\` grant on ${refs.join(", ")} — credentialed calls to an external service`,
        ...(input.readsUntrustedMail
          ? ["this agent's input is inbound email, which is attacker-controlled by design"]
          : []),
      ],
      consequence:
        "Read here, send there, in one hop. Each half is a normal capability; together they " +
        "are an egress channel that no approval step sits in front of." +
        (input.readsUntrustedMail ? " Because the trigger is untrusted email, a prompt injection is the request." : ""),
    });
  }

  // Verbs held per credential. Keyed by credential rather than by grant on
  // purpose: the findings below are properties of the CREDENTIAL, and emitting
  // one per grant produced the same warning twice for a credential held with
  // two verbs — noise that trains people to skim exactly this panel.
  const verbsByRef = new Map<string, string[]>();
  for (const g of liveBureau) {
    verbsByRef.set(g.credRef, [...(verbsByRef.get(g.credRef) ?? []), g.verb]);
  }
  const held = (ref: string): string[] => verbsByRef.get(ref) ?? [];
  const fmtVerbs = (vs: string[]): string => vs.map((v) => `\`${v}\``).join(" and ");

  // 2. `enforcement: broad` — bureau.md §5.2 rung 3. The whole reason the field
  //    is on the credential is so this is visible rather than tribal knowledge.
  for (const [ref, verbs] of verbsByRef) {
    const cred = byRef.get(ref);
    if (!cred || cred.enforcement !== "broad") continue;
    out.push({
      id: `broad-enforcement:${ref}`,
      severity: "warning",
      title: `\`${ref}\` is enforcement=broad — only our own code narrows it`,
      ingredients: [
        `credential \`${ref}\` (${cred.kind}) records enforcement \`broad\``,
        `live ${verbs.length === 1 ? "grant" : "grants"} let this agent use it: ${fmtVerbs(verbs)}`,
        cred.allow === null
          ? "no destination allowlist — unusable by design until one is set (fails closed)"
          : `destination allowlist \`${cred.allow}\``,
      ],
      consequence:
        "Rung 3 of bureau.md §5.2's ladder: the provider enforces nothing, so a missing check " +
        "in the verb gate reaches the key's entire policy. Policy is our opinion; the " +
        "capability wall is the guarantee — and there is no wall here.",
    });
  }

  // 3. Wildcard destination binding — §6.4 says render it as the widening it is.
  for (const cred of input.credentials) {
    if (cred.allow === null || !cred.allow.includes("*.")) continue;
    if (held(cred.name).length === 0) continue;
    out.push({
      id: `wildcard-allow:${cred.name}`,
      severity: "warning",
      title: `\`${cred.name}\` is bound to a wildcard destination (${cred.allow})`,
      ingredients: [
        `destination binding \`${cred.allow}\` matches every host under that suffix`,
        "destination binding is the PRIMARY control (bureau.md §6) — egress redaction ranks below it",
      ],
      consequence:
        "Any host under the wildcard receives this credential. That is sometimes unavoidable " +
        "(a real service spans hosts), but it is a widening and should be a decision, not a default.",
    });
  }

  // 4. Sends without review AND accepts any sender — `bindingWarnings`' sharpest case.
  if (input.sendsWithoutReview && input.unrestrictedSenders) {
    out.push({
      id: "send-without-allowlist",
      severity: "critical",
      title: "Sends without review AND accepts mail from anyone",
      ingredients: [
        "a binding with replyMode `send` — it mails the original sender itself, nothing is queued for approval",
        "no sender allowlist on that binding",
      ],
      consequence:
        "Anyone who can get a human-looking message into this mailbox can make this account " +
        "send mail. That combination is the exfiltration shape worth reviewing even though " +
        "each half looks routine.",
    });
  }

  // 5. A credential whose kind permits the verb it was granted, but with no
  //    allowlist at all. Fails closed today; say so rather than implying breach.
  for (const [ref, verbs] of verbsByRef) {
    const cred = byRef.get(ref);
    if (!cred || cred.allow !== null) continue;
    out.push({
      id: `unbound-credential:${ref}`,
      severity: "warning",
      title: `\`${ref}\` has no destination allowlist`,
      ingredients: [
        `live ${verbs.length === 1 ? "grant" : "grants"} exist for it: ${fmtVerbs(verbs)}`,
        "the credential records no `allow` origin",
      ],
      consequence:
        "bureau.md §6.5 fails closed: with no allowlist the Bureau refuses to inject, so this " +
        "grant cannot currently be used. It is dead weight rather than exposure — but it reads " +
        "as a working capability on every other screen.",
    });
  }

  return out;
}
