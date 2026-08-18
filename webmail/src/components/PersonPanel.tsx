/** @jsxImportSource preact */
import type { Annotation } from "../lib/annotations/types";
import { classLabel, speakClaim } from "../lib/annotations/margin";

// The person-panel (s18 A4's rider, shipped with the A3 margin — "the
// commitments and waits involving whoever's message is open"). v1 scope,
// stated plainly: the OPEN commitments and tasks anchored to messages in
// THIS thread. Cross-thread person indexing ("everything open with Bob,
// anywhere") needs a sender join the client cannot do cheaply yet — when the
// server grows a person filter, `personOpenItems` (lib/annotations/margin.ts)
// is the seam that widens.
//
// Deliberately compact: the s24 IA calls this a rider beside the message, not
// a realm. Display-only — the verbs live in the margin, at the claim's
// birthplace.

interface Props {
  /** Who the thread is with — the thread originator's display name. */
  person: string;
  /** Open commitment/task annotations in this thread (`personOpenItems`). */
  items: Annotation[];
}

export default function PersonPanel({ person, items }: Props) {
  if (items.length === 0) return null;
  return (
    <aside class="person-panel" aria-label={`Open items with ${person}`}>
      <p class="person-panel-head">
        <span class="person-panel-title">Open with {person}</span>
        <span class="person-panel-sub muted">in this thread</span>
      </p>
      <ul class="person-panel-list">
        {items.map((a) => (
          <li key={a.id} class={`person-item anno-${a.class}`}>
            <span class="person-item-class">{classLabel(a.class)}</span>
            <span class="person-item-body">{speakClaim(a.body, a.confidence)}</span>
          </li>
        ))}
      </ul>
    </aside>
  );
}
