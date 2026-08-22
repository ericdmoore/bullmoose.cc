/** @jsxImportSource preact */
import { useState } from "preact/hooks";
import type { ActionProposal, RejectReason } from "../lib/approvals/types";
import { rowAuthority, type ApprovalsAccount } from "../lib/approvals/accounts";

/**
 * Offers, rendered beside the message that caused them (s36 V1 item 5).
 *
 * A SECOND UI OVER THE SAME DATA — both halves deliberate. Second UI: this is
 * not the queue compressed into a sidebar; the queue's job is clearing a
 * backlog, this one's is judging a claim against the sentence that caused it,
 * so it renders small and stays out of the reading line. Same data: there is
 * exactly ONE proposal record, decided through the SAME `decide()` the queue
 * calls, gated by the SAME `rowAuthority` wall. If this surface and the queue
 * can ever disagree about whether something was approved, the design is wrong.
 *
 * ⚠️ `rowAuthority` is not optional decoration. A margin that rendered
 * approve for a watch-only account would be a privilege escalation with a
 * nice animation — the server would refuse, but offering the button invites
 * the attempt and buries the refusal. The wall renders its own words instead.
 *
 * The reader APPROVES here; they never initiate. There is deliberately no
 * "+ Cal" creation path in this component — an offer that does not exist is
 * the extractor's miss, recorded by the manual path (V1's labelled negative),
 * not papered over by this surface.
 */

interface Props {
  offers: readonly ActionProposal[];
  account: ApprovalsAccount | undefined;
  /** Proposal ids with a decision in flight — their verbs go quiet. */
  busy: ReadonlySet<string>;
  /** The last refusal, rendered in place. A stale approve on a proposal
   *  decided elsewhere lands here as the server's own words. */
  error?: string | null;
  onApprove: (id: string) => void;
  onDecline: (id: string, reason: RejectReason | undefined) => void;
}

/** What a schedule offer says about itself, in one line. */
function offerLine(p: ActionProposal): string {
  if (p.kind === "verb-schedule-update") {
    // A merge offer's line IS the diff — approval must never be assent to
    // something unseen. Same-day moves compress the right side to the time,
    // so what changed is what the eye lands on.
    const payload = (p.payload ?? {}) as { targetTitle?: unknown; changes?: unknown };
    const title = typeof payload.targetTitle === "string" && payload.targetTitle !== "" ? payload.targetTitle : "Hold";
    const st = ((payload.changes ?? {}) as Record<string, { from?: unknown; to?: unknown }>).start;
    if (!st || typeof st.from !== "string" || typeof st.to !== "string") return title;
    const from = st.from.replace("T", " ").slice(0, 16);
    const to = st.from.slice(0, 10) === st.to.slice(0, 10) ? st.to.slice(11, 16) : st.to.replace("T", " ").slice(0, 16);
    return `${title} — ${from} → ${to}`;
  }
  const payload = (p.payload ?? {}) as { title?: unknown; start?: unknown };
  const title = typeof payload.title === "string" && payload.title !== "" ? payload.title : "Hold";
  const start = typeof payload.start === "string" ? payload.start : undefined;
  if (!start) return title;
  // The stored start is ISO local; render the human half without inventing a
  // timezone the payload does not carry.
  const when = start.replace("T", " ").slice(0, 16);
  return `${title} — ${when}`;
}

export default function MarginOffers({ offers, account, busy, error = null, onApprove, onDecline }: Props) {
  // Decline is two taps — the verb, then "my slip" vs "wrong" — because a
  // one-tap decline cannot say WHICH negative it is, and an unlabelled decline
  // is exactly the mislabelled training data the taxonomy exists to prevent.
  const [declining, setDeclining] = useState<string | undefined>(undefined);

  if (offers.length === 0) return null;

  return (
    <aside class="margin-offers" aria-label="Offers from this message">
      {offers.map((p) => {
        const authority = rowAuthority(p, account);
        const isBusy = busy.has(p.id);
        return (
          <div key={p.id} class="margin-offer">
            <p class="margin-offer-line">
              <span class="margin-offer-kind">
                {p.kind === "verb-schedule"
                  ? "Add to calendar?"
                  : p.kind === "verb-schedule-update"
                    ? "Move on calendar?"
                    : "Offer"}
              </span>{" "}
              {offerLine(p)}
            </p>
            {authority.note !== "" ? (
              // The capability wall, in its own words — not greyed buttons the
              // reader has to guess about.
              <p class="margin-offer-wall">{authority.note}</p>
            ) : declining === p.id ? (
              <div class="margin-offer-verbs" role="group" aria-label="Why decline?">
                <button
                  type="button"
                  class="margin-verb"
                  disabled={isBusy}
                  onClick={() => {
                    setDeclining(undefined);
                    onDecline(p.id, "unintendedInvocation");
                  }}
                >
                  My slip
                </button>
                <button
                  type="button"
                  class="margin-verb"
                  disabled={isBusy}
                  onClick={() => {
                    setDeclining(undefined);
                    onDecline(p.id, "wrongContent");
                  }}
                >
                  Wrong offer
                </button>
                <button type="button" class="margin-verb" onClick={() => setDeclining(undefined)}>
                  Back
                </button>
              </div>
            ) : (
              <div class="margin-offer-verbs">
                <button
                  type="button"
                  class="margin-verb margin-verb-approve"
                  disabled={isBusy || !authority.canApprove}
                  onClick={() => onApprove(p.id)}
                >
                  {isBusy ? "Deciding…" : "Approve"}
                </button>
                <button
                  type="button"
                  class="margin-verb"
                  disabled={isBusy || !authority.canDecline}
                  onClick={() => setDeclining(p.id)}
                >
                  Decline
                </button>
                <a class="margin-offer-more" href={`/approvals?p=${encodeURIComponent(p.id)}`}>
                  details
                </a>
              </div>
            )}
          </div>
        );
      })}
      {error ? (
        <p class="margin-offer-error" role="alert">
          {error}
        </p>
      ) : null}
    </aside>
  );
}
