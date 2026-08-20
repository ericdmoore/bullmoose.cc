import {
  AGENT_CAP,
  CALENDARS_CAP,
  CONTACTS_CAP,
  CORE_CAP,
  FILENODE_CAP,
  MAIL_CAP,
  SUBMISSION_CAP,
  VACATION_CAP,
  contactsCapability,
  coreCapability,
  mailCapability,
  submissionCapability,
  type Session,
} from "@bullmoose/jmap-core";
import { authorizeAccount, type Principal } from "./auth";

/**
 * The agent capability, PER ACCOUNT — and the two facts a multi-account
 * approvals queue cannot render honestly without (s10 T7).
 *
 * The queue now spans every account the principal can reach (owned AND
 * grant-reached: an agent lives on its own account under its own principal,
 * so its proposals are only visible to its owner through a supervisory
 * grant). Reach is not authority, though: `ActionProposal/set` demands
 * `draft`, and a tier-3 approve additionally demands `send` — the capability
 * wall (actionProposal.ts). A client that renders a decide button per row has
 * no way to know either without asking, and guessing produces exactly the
 * dishonesty this repo refuses: a button that fails at the round trip.
 *
 * So the SERVER answers it, with the same `authorizeAccount` call the method
 * gate itself runs — one decision function, two readers, no second policy
 * layer to drift. Both flags are computed for owned accounts too: a read-only
 * TOKEN cannot decide on its own account either, and a client that assumed
 * "mine ⇒ decidable" would be wrong there in exactly the same way.
 */
function agentAccountCapability(principal: Principal, accountId: string): Record<string, boolean> {
  return {
    /** `ActionProposal/set` — approve, decline, needsInfo, correct a due date. */
    mayDecide: authorizeAccount(principal, accountId, "draft", "mail").ok,
    /** The tier-3 wall: approving an irreversible egress needs `send`. */
    mayApproveIrreversible: authorizeAccount(principal, accountId, "send", "mail").ok,
  };
}

/** Build the RFC 8620 Session object for an authenticated principal. */
export function buildSession(origin: string, principal: Principal): Session {
  const accounts: Session["accounts"] = {};
  for (const a of principal.accounts) {
    if (a.granted) {
      // Grant-reached account (sharing / delegation): a book-scoped
      // grant exposes only the contacts capability; a whole-account
      // grant exposes the full surface (its scopes still gate).
      const wholeAccount = a.granted.some((g) => g.collection === null);
      accounts[a.accountId] = {
        name: a.name,
        isPersonal: false,
        isReadOnly: !a.granted.some((g) => g.scopes.some((s) => s !== "read")),
        accountCapabilities: wholeAccount
          ? {
              [MAIL_CAP]: mailCapability,
              [SUBMISSION_CAP]: submissionCapability,
              [VACATION_CAP]: {},
              [CONTACTS_CAP]: contactsCapability,
              [CALENDARS_CAP]: {},
              [FILENODE_CAP]: {},
              [AGENT_CAP]: agentAccountCapability(principal, a.accountId),
            }
          : { [CONTACTS_CAP]: contactsCapability },
      };
      continue;
    }
    accounts[a.accountId] = {
      name: a.name,
      isPersonal: true,
      isReadOnly: false,
      accountCapabilities: {
        [MAIL_CAP]: mailCapability,
        [SUBMISSION_CAP]: submissionCapability,
        [VACATION_CAP]: {},
        [CONTACTS_CAP]: contactsCapability,
        [CALENDARS_CAP]: {},
        [FILENODE_CAP]: {},
        [AGENT_CAP]: agentAccountCapability(principal, a.accountId),
      },
    };
  }

  const primary = principal.accounts.find((a) => !a.granted)?.accountId ?? "";

  return {
    capabilities: {
      [CORE_CAP]: coreCapability,
      [MAIL_CAP]: {},
      [SUBMISSION_CAP]: {},
      [VACATION_CAP]: {},
      [CONTACTS_CAP]: {},
      [CALENDARS_CAP]: {},
      [FILENODE_CAP]: {},
      [AGENT_CAP]: {},
      // ⚠️ Deliberately NOT advertised: `urn:ietf:params:jmap:websocket`
      // (RFC 8887). The socket at /api/ws is real but PUSH-ONLY — it does not
      // handle Request frames and does not select the `jmap` subprotocol, so
      // an RFC 8887-conformant client that trusted the advertisement connected,
      // aborted with 1006, and retried forever. Our own clients (`bullmoose
      // watch`, agent serve, cli-go) dial /api/ws directly and never read this
      // capability. Re-add WEBSOCKET_CAP when the socket actually implements
      // RFC 8887 (subprotocol negotiation + Request/Response frames).
    },
    accounts,
    primaryAccounts: {
      [MAIL_CAP]: primary,
      [SUBMISSION_CAP]: primary,
      [CONTACTS_CAP]: primary,
      [CALENDARS_CAP]: primary,
      [FILENODE_CAP]: primary,
    },
    username: principal.username,
    apiUrl: `${origin}/api/jmap`,
    downloadUrl: `${origin}/api/download/{accountId}/{blobId}/{name}?type={type}`,
    uploadUrl: `${origin}/api/upload/{accountId}`,
    // ⚠️ No eventSourceUrl: this worker serves no /api/eventsource route, and
    // advertising a URL that 404s made push-capable clients (RFC 8620 §7.3)
    // hammer a dead endpoint instead of falling back to polling. Absent beats
    // dead; restore it together with a real SSE endpoint.
    // Bump `state` when the account list / capabilities change shape.
    state: "0",
  };
}
