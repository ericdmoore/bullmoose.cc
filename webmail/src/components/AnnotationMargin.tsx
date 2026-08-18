/** @jsxImportSource preact */
import { useState } from "preact/hooks";
import type { Annotation } from "../lib/annotations/types";
import type { CloseStatus } from "../lib/annotations/api";
import { classLabel, speakClaim, statusLabel, whyLine } from "../lib/annotations/margin";

// The margin (s18 A3) — the medium.com surface. Renders one message's
// annotations below its card: class-styled, the claim spoken in its voice
// (confidence is register, never a number), "Why: not stated" for a null
// rationale, and — on an OPEN claim only — the two verbs:
//
//   Resolve          it came true / was handled
//   Not a real one   dismiss — the labeled negative the extractor trains on
//
// Collapsed by default behind a small "N notes" chip, so the reading surface
// stays calm (s20 T4: "collapsed gutter markers by default"). A closed claim
// renders muted with its epitaph and no verbs: the judgment is the record.

interface Props {
  /** This message's annotations, already grouped + ordered (`marginFor`). */
  annotations: Annotation[];
  /** Ids with a write in flight — their verbs go quiet. */
  busy: ReadonlySet<string>;
  /** A refusal already told us the session lacks `annotate` — grey the verbs
   *  instead of inviting the same refusal again. */
  verbsDisabled?: boolean;
  /** The last verb refusal, surfaced in place. */
  error?: string | null;
  /** Start expanded — for tests and the demo walk-through. Default false. */
  initiallyOpen?: boolean;
  onClose: (id: string, status: CloseStatus) => void;
}

export default function AnnotationMargin({
  annotations,
  busy,
  verbsDisabled = false,
  error = null,
  initiallyOpen = false,
  onClose,
}: Props) {
  const [open, setOpen] = useState(initiallyOpen);
  if (annotations.length === 0) return null;

  const n = annotations.length;
  return (
    <aside class="anno-margin" aria-label="Notes in the margin">
      <button type="button" class="anno-chip" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "▾" : "▸"} {n} note{n === 1 ? "" : "s"}
      </button>

      {open ? (
        <>
          <ul class="anno-list">
            {annotations.map((a) => (
              <MarginNote
                key={a.id}
                a={a}
                busy={busy.has(a.id)}
                verbsDisabled={verbsDisabled}
                onClose={(status) => onClose(a.id, status)}
              />
            ))}
          </ul>
          {error ? (
            <p class="anno-error" role="alert">
              {error}
            </p>
          ) : null}
        </>
      ) : null}
    </aside>
  );
}

function MarginNote({
  a,
  busy,
  verbsDisabled,
  onClose,
}: {
  a: Annotation;
  busy: boolean;
  verbsDisabled: boolean;
  onClose: (status: CloseStatus) => void;
}) {
  const isOpen = a.status === "open";
  return (
    <li class={`anno-note anno-${a.class}${isOpen ? "" : " anno-closed"}`}>
      <p class="anno-head">
        <span class="anno-class">{classLabel(a.class)}</span>
        <span class="anno-author muted">— {a.author}</span>
        {isOpen ? null : <span class="anno-status">{statusLabel(a.status)}</span>}
      </p>
      <p class="anno-claim">{speakClaim(a.body, a.confidence)}</p>
      <p class="anno-why muted">{whyLine(a.rationale)}</p>
      {isOpen ? (
        <p class="anno-verbs">
          <button type="button" disabled={busy || verbsDisabled} onClick={() => onClose("resolved")}>
            Resolve
          </button>
          <button type="button" disabled={busy || verbsDisabled} onClick={() => onClose("dismissed")}>
            Not a real one
          </button>
        </p>
      ) : null}
    </li>
  );
}
