// Public surface of the webmail JMAP layer. Components receive a `JmapClient`
// (arch.md §2, invariant §6.1: never imported as a singleton) — inject
// `FetchJmapClient` in the app, `FakeJmapClient` in tests and the deferred
// T2/T3 UI.
export type {
  JmapClient,
  RequestOptions,
  WatchOptions,
  WebSocketLike,
  WebSocketFactory,
  FetchJmapClientOptions,
} from "./JmapClient";
export { FetchJmapClient, JmapRequestError, backReference } from "./JmapClient";
export { FakeJmapClient } from "./FakeJmapClient";
export type { FakeJmapClientOptions, MethodHandler } from "./FakeJmapClient";
export {
  AGENT_CAP,
  CORE_CAP,
  MAIL_CAP,
  SUBMISSION_CAP,
  CONTACTS_CAP,
  CALENDARS_CAP,
  FILENODE_CAP,
  WEBSOCKET_CAP,
  VACATION_CAP,
  hasCapability,
  hasAgentCapability,
  capabilityForMethod,
} from "./capabilities";
export type * from "./types";
