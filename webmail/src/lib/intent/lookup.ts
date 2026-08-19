// s20 T3 — where the two sources of "who is Sergio?" are actually read.
//
// The address book and your correspondence history, in ONE batched pass, with
// a rule about failure: neither source is required. A mailbox whose token has
// no contacts scope, a demo backend that does not implement `ContactCard/*`,
// an account with an empty address book — each degrades to the other source
// and SAYS so, because "I could not read your address book" and "you have no
// Sergio" are different sentences and only one of them is an instruction to
// the human.
//
// The reading is deliberately kept apart from the ranking (`resolve.ts`): the
// rule that decides who a name means is worth testing without a server, and
// the fetch is worth testing without a rule.

import { buildContactFilter, entryValues, displayName, loadCards } from "../contacts/cards";
import type { ContactCard } from "../contacts/types";
import type { JmapClient } from "../jmap/JmapClient";
import type { Email } from "../mail/types";
import type { CardSighting, HistorySighting } from "./resolve";

export interface RecipientLookup {
  cards: CardSighting[];
  history: HistorySighting[];
  /** Sources that could not be read, each as a sentence. Shown, never hidden:
   *  a resolution made from half the evidence must say which half. */
  degraded: string[];
}

/** How many address-book hits to consider. A name matching more than a handful
 *  of cards is ambiguous by any definition, and the composer will say so. */
export const CARD_LOOKUP_LIMIT = 10;

/**
 * How many recent messages the history leg reads. Enough to tell "you write to
 * this Sergio constantly" from "you mailed that one once", and small enough to
 * stay one cheap query — this runs while someone is typing.
 */
export const HISTORY_LOOKUP_LIMIT = 40;

/** The Email properties the history leg needs. Never bodies: this is an
 *  address-book question and a body fetch would be a page of data per hit. */
const HISTORY_PROPERTIES = ["id", "from", "to", "cc", "receivedAt"] as const;

/**
 * Look one name up in both places. Never throws: every refusal is caught and
 * reported as a degraded source, because a lookup that fails must leave the
 * composer usable (type the address yourself) rather than blocking the ask.
 */
export async function lookupRecipient(
  client: JmapClient,
  accountId: string,
  query: string,
  opts: { cardLimit?: number; historyLimit?: number } = {},
): Promise<RecipientLookup> {
  const q = query.trim();
  if (!q) return { cards: [], history: [], degraded: [] };

  const [cards, history] = await Promise.all([
    lookupCards(client, accountId, q, opts.cardLimit ?? CARD_LOOKUP_LIMIT),
    lookupHistory(client, accountId, q, opts.historyLimit ?? HISTORY_LOOKUP_LIMIT),
  ]);

  return {
    cards: cards.sightings,
    history: history.sightings,
    degraded: [...cards.degraded, ...history.degraded],
  };
}

async function lookupCards(
  client: JmapClient,
  accountId: string,
  query: string,
  limit: number,
): Promise<{ sightings: CardSighting[]; degraded: string[] }> {
  try {
    const page = await loadCards(client, accountId, {
      filter: buildContactFilter({ text: query }),
      limit,
    });
    return { sightings: page.cards.flatMap(cardSightings), degraded: [] };
  } catch {
    // A token without the `contacts` scope, or a server without the methods.
    // Named, not swallowed — the resolution below it is made on mail alone.
    return { sightings: [], degraded: ["Your address book could not be read, so this is from your mail alone."] };
  }
}

/** Every address on a card, each carrying the card's display name. A person
 *  with a work and a home address is one person, and the ranking merges them
 *  by address — but both must be offered, or "Sergio" resolves to whichever
 *  one happens to be first. */
export function cardSightings(card: ContactCard): CardSighting[] {
  const name = displayName(card);
  return entryValues(card.emails)
    .map((entry) => (typeof entry.address === "string" ? entry.address.trim() : ""))
    .filter((address) => address.length > 0)
    .map((address) => ({ email: address, name: name === "(unnamed)" ? null : name }));
}

async function lookupHistory(
  client: JmapClient,
  accountId: string,
  query: string,
  limit: number,
): Promise<{ sightings: HistorySighting[]; degraded: string[] }> {
  try {
    // The same `text` condition the search box uses (`../mail/search.ts`) —
    // FTS5-backed, whole-word, and it reaches senders and recipients as well
    // as bodies. That last part is why `resolve.ts` re-checks every address it
    // is handed: a message that merely mentions Sergio is a hit here, and its
    // sender is not a candidate.
    const { get } = await client.queryThenGet(
      accountId,
      "Email/query",
      {
        filter: { text: query },
        sort: [{ property: "receivedAt", isAscending: false }],
        limit,
      },
      "Email/get",
      [...HISTORY_PROPERTIES],
    );
    const list = (get.list as Array<Partial<Email>> | undefined) ?? [];
    const sightings: HistorySighting[] = [];
    for (const email of list) {
      const at = Date.parse(email.receivedAt ?? "");
      if (!email.id || !Number.isFinite(at)) continue;
      for (const person of [...(email.from ?? []), ...(email.to ?? []), ...(email.cc ?? [])]) {
        if (!person?.email) continue;
        sightings.push({ email: person.email, name: person.name ?? null, emailId: email.id, at });
      }
    }
    return { sightings, degraded: [] };
  } catch {
    return {
      sightings: [],
      degraded: ["Your mail history could not be searched, so this is from your address book alone."],
    };
  }
}
