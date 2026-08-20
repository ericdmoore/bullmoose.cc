/** JMAP core wire types (RFC 8620). */

export type Id = string;

/** A single method call or response: [name, arguments, callId]. */
export type Invocation = [name: string, args: Record<string, unknown>, callId: string];

export interface JmapRequest {
  using: string[];
  methodCalls: Invocation[];
  createdIds?: Record<Id, Id>;
}

export interface JmapResponse {
  methodResponses: Invocation[];
  createdIds?: Record<Id, Id>;
  sessionState: string;
}

/** RFC 8620 §3.7 — reference to a prior method call's result. */
export interface ResultReference {
  resultOf: string;
  name: string;
  path: string;
}

export interface Account {
  name: string;
  isPersonal: boolean;
  isReadOnly: boolean;
  accountCapabilities: Record<string, unknown>;
}

export interface Session {
  capabilities: Record<string, unknown>;
  accounts: Record<Id, Account>;
  primaryAccounts: Record<string, Id>;
  username: string;
  apiUrl: string;
  downloadUrl: string;
  uploadUrl: string;
  /**
   * RFC 8620 §2 requires this (a URI Template with §7.3's `types`,
   * `closeafter`, `ping` variables), and strictly-typed clients refuse to
   * decode a Session without it — our server serves the route and advertises
   * it (services/jmap/src/eventsource.ts). Optional HERE only because this
   * type also decodes third-party sessions, which a lenient client must
   * tolerate; session.test.ts pins that OUR session always carries it.
   */
  eventSourceUrl?: string;
  state: string;
}

/** Server → client push (RFC 8620 §7.1). */
export interface StateChange {
  "@type": "StateChange";
  changed: Record<Id, Record<string, string>>;
}
