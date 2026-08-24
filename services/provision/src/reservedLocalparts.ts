// s33's 🔴 — reserved local-parts, previously enforced NOWHERE. A
// self-serve address picker without this lets a stranger claim
// `postmaster@` (RFC 2142 says that address must reach the operator) or —
// worse here — an AGENT ROLE address: a human holding `bouncer@` receives
// the boundary agent's mail, and a human holding `help@` IS the first
// conversation every new user has. The plan's rule: this lands BEFORE any
// self-serve signup ships.
//
// Two callers, two postures — and the test corpus is what taught the
// split (51 failures when the first draft refused everything): creating an
// AGENT ROLE address is the operator's routine job (`editor@` + a binding
// IS how an agent comes to exist), so the admin-authed API refuses only
// the classes that are near-never legitimate accounts (RFC 2142,
// infrastructure, operator-shaped) unless `{"allowReserved": true}` states
// the intent. A future SELF-SERVE picker refuses EVERY class with no
// override — use `reservedReason` (all classes) there, never
// `adminRefusalReason`.

/** Why a local-part is reserved, by name — the refusal quotes this. */
const RESERVED: Record<string, string> = {
  // RFC 2142 — addresses the internet expects to reach the OPERATOR.
  postmaster: "RFC 2142 operations address",
  abuse: "RFC 2142 operations address",
  hostmaster: "RFC 2142 operations address",
  webmaster: "RFC 2142 operations address",
  security: "RFC 2142 operations address",
  noc: "RFC 2142 operations address",
  support: "RFC 2142 role address",
  info: "RFC 2142 role address",
  sales: "RFC 2142 role address",
  marketing: "RFC 2142 role address",
  // Mail infrastructure — senders and bounce paths machines rely on.
  "mailer-daemon": "mail infrastructure",
  bounce: "mail infrastructure (the SES MAIL FROM path)",
  noreply: "mail infrastructure",
  "no-reply": "mail infrastructure",
  dmarc: "mail infrastructure (aggregate-report target)",
  // Operator-shaped names people assume carry authority.
  admin: "operator-shaped address",
  administrator: "operator-shaped address",
  root: "operator-shaped address",
  // The agent roles (s33's own list): a human holding one of these
  // receives an agent's mail — or worse, SPEAKS as it.
  help: "bullmoose agent role",
  analyst: "bullmoose agent role",
  bouncer: "bullmoose agent role",
  hr: "bullmoose agent role",
  editor: "bullmoose agent role",
  remind: "bullmoose agent role",
  corey: "bullmoose agent role",
};

/**
 * The reason `localpart` is reserved, or null when it is free. Callers
 * normalize case; this normalizes again anyway (a guard that trusts its
 * caller's normalization is two bugs away from useless) and also strips a
 * plus-suffix, because delivery does (`route resolution: exact →
 * plus-strip → catch-all`) — `postmaster+x@` must not be a way to receive
 * postmaster's mail.
 */
export function reservedReason(localpart: string): string | null {
  const bare = localpart.toLowerCase().split("+")[0] ?? "";
  return RESERVED[bare] ?? null;
}

/**
 * The admin path's subset: everything EXCEPT agent roles (whose creation is
 * the operator's normal job). Self-serve must not use this.
 */
export function adminRefusalReason(localpart: string): string | null {
  const reason = reservedReason(localpart);
  return reason === null || reason === "bullmoose agent role" ? null : reason;
}
