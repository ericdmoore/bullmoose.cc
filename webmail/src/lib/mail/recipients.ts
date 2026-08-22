// The recipient fold — deciding who a long To/Cc line NAMES when there is no
// room to print all of it.
//
// The message this exists for is real: a forwarded tournament email whose Cc
// carries ~30 parents, nearly every one a bare address the forwarding client
// never had a name for. Printed inline it takes about a third of the reading
// pane before the first sentence of the mail — the envelope out-shouting the
// letter.
//
// Every decision is HERE and not in MessageView: how many names fit, which of
// them earn the slots, how someone with nothing but an address is written
// down, when folding is not worth the click. The component is markup over
// this, and the whole rule set is testable without a DOM.

import type { EmailAddress } from "./types";

/**
 * How many people the collapsed line names.
 *
 * Three still reads as a sentence — "Ada, Grace, jdwade7@aol.com and 27
 * others" — and survives the reading pane at its narrowest. It is a knob, not
 * a law: `foldRecipients` takes it as an argument for surfaces with more room.
 */
export const NAMES_SHOWN = 3;

/**
 * Below this, folding is the worse deal. "…and 1 other" is about as wide as
 * the name it replaced and costs a click to undo, so a line with one extra
 * recipient is simply printed whole. The rule has a second effect worth
 * knowing: a fold of one can never exist, so `overflow` is always plural.
 */
const MIN_HIDDEN = 2;

export interface Recipient {
  /** Their name when the header carried one, else their bare address. */
  label: string;
  /** The whole entry — `Ada Lovelace <ada@example.test>` — for the open list. */
  full: string;
  /** Lower-cased address: the dedupe key, and a stable key for rendering. */
  key: string;
  /** The header gave a name, and it was not just the address a second time. */
  named: boolean;
}

export interface RecipientFold {
  /** Everyone on the line, deduped, in header order. The expanded list. */
  all: Recipient[];
  /** True when the line was long enough to be worth hiding part of. */
  folded: boolean;
  /** The collapsed line's names, already joined. Everyone, when unfolded. */
  visible: string;
  /** How many of `all` the collapsed line does not name. 0 when unfolded. */
  hidden: number;
  /** "and 27 others" — empty when unfolded. */
  overflow: string;
}

export function foldRecipients(addresses: readonly EmailAddress[], shown: number = NAMES_SHOWN): RecipientFold {
  const all = dedupe(addresses);
  const room = Math.max(1, Math.trunc(shown));
  const hidden = all.length - room;

  if (hidden < MIN_HIDDEN) {
    return { all, folded: false, visible: all.map((r) => r.label).join(", "), hidden: 0, overflow: "" };
  }
  return {
    all,
    folded: true,
    visible: pick(all, room)
      .map((r) => r.label)
      .join(", "),
    hidden,
    // Always plural — MIN_HIDDEN means a one-person fold never happens.
    overflow: `and ${hidden} others`,
  };
}

/**
 * The same fold as one string, for a surface with nowhere to put a control:
 * the collapsed message header, which is itself one big click target, so a
 * button inside it would fight the row for the same press. Nothing is lost by
 * dropping the control there — expanding the message puts the full list, and
 * its own button, one row below.
 */
export function summarizeRecipients(addresses: readonly EmailAddress[], shown: number = NAMES_SHOWN): string {
  const fold = foldRecipients(addresses, shown);
  return fold.folded ? `${fold.visible} ${fold.overflow}` : fold.visible;
}

/**
 * Which ones get named. Named people first, bare addresses after — the wall
 * this file exists for is a Cc of thirty strangers' addresses, where naming
 * the first three of THOSE tells the reader nothing about who is in the room,
 * while one "Coach Dana" tells them what the mail is.
 *
 * The picks are then put back in header order, so the line still reads as a
 * subset of the header rather than a ranking of it.
 */
function pick(all: readonly Recipient[], room: number): Recipient[] {
  const order = new Map(all.map((r, i) => [r.key, i]));
  return [...all.filter((r) => r.named), ...all.filter((r) => !r.named)]
    .slice(0, room)
    .sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));
}

/**
 * One row per address. A forwarded chain re-lists people an earlier hop
 * already listed; "Sam, Sam and 28 others" reads as a bug, and the count
 * beside it would be wrong — which is worse, because a count is the one thing
 * the reader cannot check by looking.
 *
 * Where the same address arrives both bare and named, the name wins. It came
 * from this same header, so preferring it invents nothing.
 */
function dedupe(addresses: readonly EmailAddress[]): Recipient[] {
  const out: Recipient[] = [];
  const at = new Map<string, number>();
  for (const addr of addresses) {
    const next = toRecipient(addr);
    if (!next) continue;
    const seen = at.get(next.key);
    if (seen === undefined) {
      at.set(next.key, out.length);
      out.push(next);
      continue;
    }
    if (out[seen]?.named === false && next.named) out[seen] = next;
  }
  return out;
}

/**
 * How someone with only an address is written down: as that address, exactly.
 * `jdwade7@aol.com` stays `jdwade7@aol.com`. Deriving "Jd Wade" from a local
 * part puts a name in the header's mouth that nobody put there, and it is
 * wrong often enough (`info@`, `u12g-white`, `jdwade7`) to be a lie the reader
 * has no way to spot.
 *
 * A name that merely repeats the address is not a name either. Forwarding
 * clients fill the name slot with the address constantly, and spelling that
 * out as `jdwade7@aol.com <jdwade7@aol.com>` is double the width for none of
 * the information — and would let a bare address take a slot meant for
 * someone this header can actually name.
 *
 * Null when there is nothing at all to show: an entry with neither name nor
 * address cannot be rendered, and counting it would inflate "and N others"
 * past the number of people the list can actually produce.
 */
function toRecipient(addr: EmailAddress): Recipient | null {
  const email = addr.email.trim();
  const name = addr.name?.trim() ?? "";
  if (email === "" && name === "") return null;

  const named = name !== "" && name.toLowerCase() !== email.toLowerCase();
  const label = named ? name : email || name;
  return {
    label,
    full: named && email !== "" ? `${name} <${email}>` : label,
    key: (email || name).toLowerCase(),
    named,
  };
}
