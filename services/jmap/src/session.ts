import {
  AGENT_CAP,
  CONTACTS_CAP,
  CORE_CAP,
  MAIL_CAP,
  SUBMISSION_CAP,
  VACATION_CAP,
  WEBSOCKET_CAP,
  contactsCapability,
  coreCapability,
  mailCapability,
  type Session,
} from "@bullmoose/jmap-core";
import type { Principal } from "./auth";

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
              [SUBMISSION_CAP]: { maxDelayedSend: 0, submissionExtensions: {} },
              [VACATION_CAP]: {},
              [CONTACTS_CAP]: contactsCapability,
              [AGENT_CAP]: {},
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
        [SUBMISSION_CAP]: { maxDelayedSend: 0, submissionExtensions: {} },
        [VACATION_CAP]: {},
        [CONTACTS_CAP]: contactsCapability,
        [AGENT_CAP]: {},
      },
    };
  }

  const primary = principal.accounts.find((a) => !a.granted)?.accountId ?? "";
  const wsOrigin = origin.replace(/^http/, "ws");

  return {
    capabilities: {
      [CORE_CAP]: coreCapability,
      [MAIL_CAP]: {},
      [SUBMISSION_CAP]: {},
      [VACATION_CAP]: {},
      [CONTACTS_CAP]: {},
      [AGENT_CAP]: {},
      [WEBSOCKET_CAP]: { url: `${wsOrigin}/api/ws`, supportsPush: true },
    },
    accounts,
    primaryAccounts: { [MAIL_CAP]: primary, [SUBMISSION_CAP]: primary, [CONTACTS_CAP]: primary },
    username: principal.username,
    apiUrl: `${origin}/api/jmap`,
    downloadUrl: `${origin}/api/download/{accountId}/{blobId}/{name}?type={type}`,
    uploadUrl: `${origin}/api/upload/{accountId}`,
    eventSourceUrl: `${origin}/api/eventsource`,
    // Bump when the account list / capabilities change shape.
    state: "0",
  };
}
