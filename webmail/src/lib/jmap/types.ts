// JMAP wire types for the webmail client.
//
// These MIRROR `@bullmoose/jmap-core` (source of truth:
// packages/jmap-core/src/types.ts + capabilities.ts). They are copied here on
// purpose rather than imported: jmap-core is worker source that augments the
// global scope with `@cloudflare/workers-types`, and dragging that into a
// DOM/Preact browser bundle is exactly the lib-clash the repo already fights
// (see tsconfig.json's note on why packages/cli is excluded from the root
// program). Keep this file in sync when the server's session/changes shape
// moves — the one cross-check that this stays honest is the back-reference
// test, which runs the client's batch through jmap-core's REAL dispatcher.

export type Id = string;

/** A single method call or response: [name, arguments, callId]. (RFC 8620 §3.2) */
export type Invocation = [name: string, args: Record<string, unknown>, callId: string];

/** RFC 8620 §3.7 — a reference to a prior method call's result. */
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

/** RFC 8620 §2 session resource, as `GET /.well-known/jmap` returns it. */
export interface Session {
  capabilities: Record<string, unknown>;
  accounts: Record<Id, Account>;
  primaryAccounts: Record<string, Id>;
  username: string;
  apiUrl: string;
  downloadUrl: string;
  uploadUrl: string;
  /** Absent: the server serves no EventSource endpoint (mirrors jmap-core). */
  eventSourceUrl?: string;
  state: string;
}

/** Server → client push over `/api/ws` (RFC 8620 §7.1). */
export interface StateChange {
  "@type": "StateChange";
  /** accountId → (collection → newState). */
  changed: Record<Id, Record<string, string>>;
}

/** The result of a `Foo/changes` call (RFC 8620 §5.2). */
export interface ChangesResult {
  accountId: Id;
  oldState: string;
  newState: string;
  hasMoreChanges: boolean;
  created: Id[];
  updated: Id[];
  destroyed: Id[];
}

/** `POST /api/upload/{accountId}` reply. */
export interface UploadResult {
  blobId: string;
  size: number;
}
