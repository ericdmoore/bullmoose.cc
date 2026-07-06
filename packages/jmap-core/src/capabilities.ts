/** Capability URNs and the server's advertised core limits. */

export const CORE_CAP = "urn:ietf:params:jmap:core";
export const MAIL_CAP = "urn:ietf:params:jmap:mail";
export const SUBMISSION_CAP = "urn:ietf:params:jmap:submission";
export const WEBSOCKET_CAP = "urn:ietf:params:jmap:websocket";

/** RFC 8620 §2 core capability object. */
export const coreCapability = {
  maxSizeUpload: 50_000_000,
  maxConcurrentUpload: 4,
  maxSizeRequest: 10_000_000,
  maxConcurrentRequests: 4,
  maxCallsInRequest: 16,
  maxObjectsInGet: 500,
  maxObjectsInSet: 500,
  collationAlgorithms: ["i;ascii-numeric", "i;ascii-casemap", "i;unicode-casemap"],
} as const;

/** RFC 8621 §1.3 mail capability object (per-account). */
export const mailCapability = {
  maxMailboxesPerEmail: null,
  maxMailboxDepth: 10,
  maxSizeMailboxName: 200,
  maxSizeAttachmentsPerEmail: 50_000_000,
  emailQuerySortOptions: ["receivedAt", "size", "from", "to", "subject"],
  mayCreateTopLevelMailbox: true,
} as const;
