import type { JmapClient } from "../jmap/JmapClient";
import type { FilesRefusal } from "./types";

/**
 * Copy-link for a file (#339, s03.C T3's leftover).
 *
 * The API has minted expiring public links since s03.B (`POST
 * /api/share/{accountId}/{blobId}`); the Files browser was the one surface
 * with no action for it, so the capability existed and no human could
 * reach it.
 *
 * Two things this deliberately does NOT do:
 *
 *   It does not invent a TTL. The server owns the default and returns the
 *   real `expiresAt`, which the caller shows — a UI that printed its own
 *   guess would eventually disagree with the link it just handed out.
 *
 *   It does not mint for a FOLDER or a file with no bytes. A FileNode's
 *   `blobId` is null for both, and a link to nothing is worse than a
 *   disabled action: it looks like it worked.
 */
export interface ShareLink {
  url: string;
  shareId: string;
  expiresAt: number;
}

export async function mintFileLink(
  client: JmapClient,
  accountId: string,
  node: { name: string; type?: string | null; blobId: string | null },
): Promise<{ link: ShareLink } | { refusal: FilesRefusal }> {
  if (!node.blobId) {
    return {
      refusal: {
        type: "invalidArguments",
        message: "There is nothing to link to: folders and empty files have no stored bytes.",
      },
    };
  }
  let res: Response;
  try {
    res = await client.mintShare(accountId, node.blobId, {
      name: node.name,
      ...(node.type ? { type: node.type } : {}),
    });
  } catch (err) {
    return {
      refusal: { type: "serverFail", message: `The link could not be minted: ${String(err)}` },
    };
  }
  if (res.status === 501) {
    // The honest one: an install without SHARE_SIGNING_KEY cannot sign
    // links at all, and saying "try again" would be a lie.
    return {
      refusal: {
        type: "forbidden",
        message: "Sharing is not configured on this server (no signing key), so no link can be minted.",
      },
    };
  }
  if (!res.ok) {
    return {
      refusal: { type: "serverFail", message: `The server refused to mint a link (${res.status}).` },
    };
  }
  const body = (await res.json()) as Partial<ShareLink>;
  if (!body.url || !body.shareId || typeof body.expiresAt !== "number") {
    return {
      refusal: { type: "serverFail", message: "The server minted a link but did not return it." },
    };
  }
  return { link: { url: body.url, shareId: body.shareId, expiresAt: body.expiresAt } };
}

/**
 * Put text on the clipboard, honestly. `navigator.clipboard` needs a secure
 * context and a user gesture, and it REJECTS rather than throwing
 * synchronously — a caller that assumed success would tell someone their
 * link was copied when it was not, and they would paste whatever was there
 * before.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await globalThis.navigator?.clipboard?.writeText(text);
    return true;
  } catch {
    return false;
  }
}
