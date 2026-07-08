/** Capability URNs and the server's advertised core limits. */

export const CORE_CAP = "urn:ietf:params:jmap:core";
export const MAIL_CAP = "urn:ietf:params:jmap:mail";
export const SUBMISSION_CAP = "urn:ietf:params:jmap:submission";
export const WEBSOCKET_CAP = "urn:ietf:params:jmap:websocket";
export const VACATION_CAP = "urn:ietf:params:jmap:vacationresponse";
export const CONTACTS_CAP = "urn:ietf:params:jmap:contacts";
/** Vendor capability: AgentInvocation queue etc. (agent-integration.md). */
export const AGENT_CAP = "urn:bullmoose:params:jmap:agent";

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

/**
 * RFC 9610 §1.3 contacts capability object (per-account).
 * maxAddressBooksPerCard: 1 advertises the v1 single-book-per-card
 * constraint (spec-legal: any integer >= 1); the schema keeps the full
 * addressBookIds set in the blob so lifting it later is a backfill.
 */
export const contactsCapability = {
  maxAddressBooksPerCard: 1,
  mayCreateAddressBook: true,
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
