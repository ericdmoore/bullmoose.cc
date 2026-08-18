/** @jsxImportSource preact */
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { lookupRecipient, type RecipientLookup } from "../lib/intent/lookup";
import { draftLooksBlank, parseIntent } from "../lib/intent/parse";
import {
  chooseRecipient,
  looksLikeAddress,
  resolveRecipient,
  type RecipientCandidate,
  type Resolution,
} from "../lib/intent/resolve";
import type { JmapClient } from "../lib/jmap/JmapClient";
import { parseAddressList, validateDraft, type DraftSpec } from "../lib/mail/compose";
import { formatAddress, type Identity } from "../lib/mail/types";
import { askCompose, type VerbOutcome } from "../lib/verbs/api";

/**
 * The composer (s20 T3) — one surface, two modes.
 *
 *   classic  the fields and the textarea. Untouched, complete, and always one
 *            keystroke away: Esc from intent mode lands here, and so does the
 *            "Write it myself" button that is on screen the whole time. Prose
 *            is the escape hatch AND the precision tool; removing it would be
 *            ideology (s20 readme).
 *   intent   one question — *what do you want to happen?* — routed through the
 *            same pipeline T2's verbs use: an ordinary `AgentInvocation`, run
 *            by `services/agent mailVerbs.ts`, whose output is an ordinary
 *            tier-1 proposal that applies into your own Drafts.
 *
 * ## What intent mode does before it spends anything
 *
 * The sentence is parsed deterministically and for free (`lib/intent/parse`),
 * and the name in it is resolved against your address book and your
 * correspondence history (`lib/intent/lookup` + `resolve`) — then all of it is
 * shown as an EDITABLE PLAN: recipient, tone, limits. That ordering is the
 * whole point. "Sergio" becoming an address is the one inference here that can
 * put the right words in front of the wrong person, so it happens in front of
 * the human, with its evidence attached, before the ask is sent — and when the
 * lead is not clear the plan says so and the button stays disabled until they
 * pick. Nothing here silently takes the top match.
 *
 * ## And what it never does
 *
 * It never sends. The ask ends at a proposal; approving that writes a draft
 * into your own Drafts; your own composer sends it. Three surfaces, and a
 * human at every one of them.
 */

interface Props {
  draft: DraftSpec;
  identities: Identity[];
  identityId: string;
  sending: boolean;
  error?: string | undefined;
  onChange: (draft: DraftSpec) => void;
  onIdentity: (identityId: string) => void;
  onSend: () => void;
  onSaveDraft: () => void;
  onDiscard: () => void;
  /**
   * Intent mode's door. BOTH optional, on the `MessageView` precedent (§6.1:
   * components never resolve a client themselves): without them the composer
   * is exactly the composer it has always been — no toggle, no agent surface,
   * no dead region. That is also the plain-client floor for a session with no
   * agent capability at all.
   */
  client?: JmapClient;
  accountId?: string;
}

type ComposerMode = "classic" | "intent";

/** How long the typist gets to keep typing before a name is looked up. Long
 *  enough that "Sergio" is one query rather than seven. */
const LOOKUP_DEBOUNCE_MS = 300;

const EMPTY_LOOKUP: RecipientLookup = { cards: [], history: [], degraded: [] };

export default function Composer({
  draft,
  identities,
  identityId,
  sending,
  error,
  onChange,
  onIdentity,
  onSend,
  onSaveDraft,
  onDiscard,
  client,
  accountId,
}: Props) {
  const [showCc, setShowCc] = useState(draft.cc.length > 0 || draft.bcc.length > 0);
  const problems = validateDraft(draft);

  // ── the agent's capability gate (§8.6), same as the thread view ──────────
  const [agentReady, setAgentReady] = useState(false);
  const [mode, setMode] = useState<ComposerMode>("classic");
  /** Set the moment a human picks a mode — after which nothing picks for them. */
  const modeTouched = useRef(false);

  useEffect(() => {
    if (!client || !accountId) return;
    let cancelled = false;
    void (async () => {
      if (!(await client.hasAgentCapability())) return;
      if (!cancelled) setAgentReady(true);
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client, accountId]);

  // Intent mode opens by DEFAULT only on a blank draft — never over a reply, a
  // forward, or a draft someone came back to (s20 T3 constraint 1). The check
  // is made at the moment the capability lands and never again, so a mode can
  // never be yanked out from under someone mid-sentence.
  useEffect(() => {
    if (!agentReady || modeTouched.current) return;
    if (draftLooksBlank(draft)) setMode("intent");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately not
    // reactive to `draft`: this is a one-time decision about how to OPEN.
  }, [agentReady]);

  const chooseMode = useCallback((next: ComposerMode) => {
    modeTouched.current = true;
    setMode(next);
  }, []);

  const intentAvailable = agentReady && !!client && !!accountId;

  return (
    <section class="composer" aria-label="Compose">
      <header class="composer-header">
        <h2>{draft.subject || (mode === "intent" ? "What do you want to happen?" : "New message")}</h2>
        <button type="button" class="icon-button" onClick={onDiscard} aria-label="Discard">
          ×
        </button>
      </header>

      {intentAvailable ? (
        <div class="composer-modes" role="group" aria-label="Composer mode">
          <button
            type="button"
            class={`composer-mode${mode === "intent" ? " is-on" : ""}`}
            aria-pressed={mode === "intent"}
            onClick={() => chooseMode("intent")}
          >
            Say what you want
          </button>
          <button
            type="button"
            class={`composer-mode${mode === "classic" ? " is-on" : ""}`}
            aria-pressed={mode === "classic"}
            onClick={() => chooseMode("classic")}
          >
            Write it myself
          </button>
        </div>
      ) : null}

      {mode === "intent" && client && accountId ? (
        <IntentPanel
          client={client}
          accountId={accountId}
          identities={identities}
          onWriteItMyself={() => chooseMode("classic")}
        />
      ) : (
        <>
          <label class="composer-field">
            <span>From</span>
            <select value={identityId} onChange={(ev) => onIdentity((ev.currentTarget as HTMLSelectElement).value)}>
              {identities.map((identity) => (
                <option key={identity.id} value={identity.id}>
                  {formatAddress({ name: identity.name || null, email: identity.email })}
                </option>
              ))}
            </select>
          </label>

          <label class="composer-field">
            <span>To</span>
            <input
              type="text"
              value={draft.to.map(formatAddress).join(", ")}
              placeholder="someone@example.com"
              onInput={(ev) =>
                onChange({
                  ...draft,
                  to: parseAddressList((ev.currentTarget as HTMLInputElement).value),
                })
              }
            />
            {!showCc ? (
              <button type="button" class="link-button" onClick={() => setShowCc(true)}>
                Cc/Bcc
              </button>
            ) : null}
          </label>

          {showCc ? (
            <>
              <label class="composer-field">
                <span>Cc</span>
                <input
                  type="text"
                  value={draft.cc.map(formatAddress).join(", ")}
                  onInput={(ev) =>
                    onChange({
                      ...draft,
                      cc: parseAddressList((ev.currentTarget as HTMLInputElement).value),
                    })
                  }
                />
              </label>
              <label class="composer-field">
                <span>Bcc</span>
                <input
                  type="text"
                  value={draft.bcc.map(formatAddress).join(", ")}
                  onInput={(ev) =>
                    onChange({
                      ...draft,
                      bcc: parseAddressList((ev.currentTarget as HTMLInputElement).value),
                    })
                  }
                />
              </label>
            </>
          ) : null}

          <label class="composer-field">
            <span>Subject</span>
            <input
              type="text"
              value={draft.subject}
              onInput={(ev) => onChange({ ...draft, subject: (ev.currentTarget as HTMLInputElement).value })}
            />
          </label>

          <textarea
            class="composer-body"
            value={draft.text}
            rows={16}
            onInput={(ev) => onChange({ ...draft, text: (ev.currentTarget as HTMLTextAreaElement).value })}
          />

          {draft.droppedAttachments && draft.droppedAttachments.length > 0 ? (
            <div class="notice notice-warn">
              {draft.droppedAttachments.length} attachment
              {draft.droppedAttachments.length === 1 ? "" : "s"} from the original message will
              <strong> not </strong>
              be included — this server builds outgoing MIME from text only.
              <span class="notice-detail">
                {draft.droppedAttachments.map((a) => a.name ?? "attachment").join(", ")}
              </span>
            </div>
          ) : null}

          {error ? <div class="notice notice-error">{error}</div> : null}

          <footer class="composer-actions">
            <button type="button" class="primary" disabled={sending || problems.length > 0} onClick={onSend}>
              {sending ? "Sending…" : "Send"}
            </button>
            <button type="button" onClick={onSaveDraft} disabled={sending}>
              Save draft
            </button>
            <span class="composer-hint">{problems.length > 0 ? problems[0] : "Cmd/Ctrl+Enter to send"}</span>
          </footer>
        </>
      )}
    </section>
  );
}

interface IntentPanelProps {
  client: JmapClient;
  accountId: string;
  identities: Identity[];
  onWriteItMyself: () => void;
}

/**
 * The intent surface: one box, one plan, one button — and the classic editor
 * one keystroke away the whole time.
 *
 * Exported for its own tests: the rules worth asserting (an ambiguous name
 * disables the ask; a resolved one names its evidence; Esc leaves) are rules
 * about this panel, not about the mail app around it.
 */
export function IntentPanel({ client, accountId, identities, onWriteItMyself }: IntentPanelProps) {
  const [intent, setIntent] = useState("");
  const [lookup, setLookup] = useState<RecipientLookup>(EMPTY_LOOKUP);
  const [looking, setLooking] = useState(false);
  /** An address the human typed or picked. Beats every inference. */
  const [chosenAddress, setChosenAddress] = useState<string | null>(null);
  const [typedAddress, setTypedAddress] = useState("");
  const [toneOverride, setToneOverride] = useState<string | null>(null);
  const [dropped, setDropped] = useState<string[]>([]);
  const [asking, setAsking] = useState(false);
  const [outcome, setOutcome] = useState<VerbOutcome | null>(null);

  const plan = useMemo(() => parseIntent(intent), [intent]);
  const selves = useMemo(() => identities.map((i) => i.email), [identities]);

  // Look the name up, debounced, and only when there is a name to look up: an
  // address in the sentence is already an answer, and a chosen one is a human's.
  const query = plan.whoIsAddress ? null : plan.who;
  useEffect(() => {
    if (!query) {
      setLookup(EMPTY_LOOKUP);
      return;
    }
    let cancelled = false;
    setLooking(true);
    const timer = setTimeout(() => {
      void lookupRecipient(client, accountId, query)
        .then((found) => {
          if (!cancelled) setLookup(found);
        })
        .catch(() => {
          // `lookupRecipient` already degrades per source; this is the belt.
          if (!cancelled) setLookup(EMPTY_LOOKUP);
        })
        .finally(() => {
          if (!cancelled) setLooking(false);
        });
    }, LOOKUP_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      setLooking(false);
    };
  }, [client, accountId, query]);

  const resolution: Resolution = useMemo(
    () => resolveRecipient(plan.who, lookup.cards, lookup.history, { exclude: selves }),
    [plan.who, lookup, selves],
  );

  const tone = toneOverride ?? plan.tone;
  const constraints = plan.constraints.filter((c) => !dropped.includes(c));

  // WHO this goes to — the precedence rule, tested as a rule
  // (`lib/intent/resolve.chooseRecipient`). An AMBIGUOUS resolution yields
  // null on purpose, and that null is what disables the button below.
  const recipient = chooseRecipient(plan, resolution, chosenAddress);

  const canAsk = intent.trim().length > 0 && recipient !== null && !asking && !outcome?.ok;

  const ask = useCallback(() => {
    if (!recipient || !intent.trim() || asking) return;
    setAsking(true);
    setOutcome(null);
    void askCompose(client, accountId, {
      to: recipient.to,
      intent: intent.trim(),
      ...(tone ? { tone } : {}),
      ...(constraints.length > 0 ? { constraints } : {}),
      recipientVia: recipient.via,
      ...(recipient.anchorEmailId ? { anchorEmailId: recipient.anchorEmailId } : {}),
    })
      .then((res) => setOutcome(res))
      .catch(() => setOutcome({ ok: false, message: "The ask did not reach the server. Try again.", forbidden: false }))
      .finally(() => setAsking(false));
  }, [client, accountId, recipient, intent, tone, constraints, asking]);

  return (
    <section class="intent-panel" aria-label="Intent">
      <label class="intent-label" for="intent-text">
        What do you want to happen?
      </label>
      {/* Deliberately not a <form>: a navigating form is the one thing this
          shell may never contain (the tokenInUrl invariant). Enter is a
          newline here — this is prose — and Cmd/Ctrl+Enter sends the ask. */}
      <textarea
        id="intent-text"
        class="intent-box"
        rows={3}
        value={intent}
        placeholder="ask Sergio whether he's comfortable with me selling assembled boards — supportive tone, no big commitment"
        onInput={(ev) => {
          setIntent((ev.currentTarget as HTMLTextAreaElement).value);
          setOutcome(null);
        }}
        onKeyDown={(ev) => {
          if (ev.key === "Escape") onWriteItMyself();
          if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey) && canAsk) ask();
        }}
      />

      {intent.trim() ? (
        <div class="intent-plan">
          <RecipientRow
            resolution={resolution}
            looking={looking}
            chosen={recipient?.to ?? null}
            typed={typedAddress}
            onType={(value) => {
              setTypedAddress(value);
              setChosenAddress(looksLikeAddress(value) ? value.trim() : null);
            }}
            onPick={(candidate) => {
              setChosenAddress(candidate.email);
              setTypedAddress(candidate.email);
            }}
          />

          <div class="intent-row">
            <span class="intent-row-label">Tone</span>
            <input
              type="text"
              class="intent-inline-input"
              aria-label="Tone"
              value={tone ?? ""}
              placeholder="however you usually write to them"
              onInput={(ev) => setToneOverride((ev.currentTarget as HTMLInputElement).value)}
            />
          </div>

          {constraints.length > 0 ? (
            <div class="intent-row">
              <span class="intent-row-label">Limits</span>
              <span class="intent-chips">
                {constraints.map((c) => (
                  <button
                    key={c}
                    type="button"
                    class="intent-chip"
                    title="Drop this limit"
                    onClick={() => setDropped((prev) => [...prev, c])}
                  >
                    {c} ×
                  </button>
                ))}
              </span>
            </div>
          ) : null}

          {lookup.degraded.map((sentence) => (
            <p key={sentence} class="notice intent-note">
              {sentence}
            </p>
          ))}
        </div>
      ) : null}

      {outcome ? (
        <p class={`notice intent-note${outcome.ok ? "" : " notice-error"}`} role={outcome.ok ? "status" : "alert"}>
          {outcome.message}
        </p>
      ) : null}

      <footer class="composer-actions">
        <button type="button" class="primary" disabled={!canAsk} onClick={ask}>
          {asking ? "Asking…" : "Draft this"}
        </button>
        <button type="button" onClick={onWriteItMyself}>
          Write it myself
        </button>
        <span class="composer-hint">
          {resolution.status === "ambiguous"
            ? "Pick who you mean and I will draft it."
            : recipient
              ? "Cmd/Ctrl+Enter to ask · Esc to write it yourself · nothing is sent"
              : "Esc to write it yourself"}
        </span>
      </footer>
    </section>
  );
}

interface RecipientRowProps {
  resolution: Resolution;
  looking: boolean;
  chosen: string | null;
  typed: string;
  onType: (value: string) => void;
  onPick: (candidate: RecipientCandidate) => void;
}

/**
 * The recipient, and the evidence for it. Four states, and the third is the
 * one this whole task turns on:
 *
 *   resolved   the address, and WHY — "in your address book · 14 messages
 *              between you" — plus a box to overrule it.
 *   ambiguous  the candidates, and no choice made. The ask cannot leave.
 *   unknown    a sentence saying so, and a box.
 *   address    the human already wrote an address; nothing to show but it.
 */
export function RecipientRow({ resolution, looking, chosen, typed, onType, onPick }: RecipientRowProps) {
  return (
    <div class="intent-row">
      <span class="intent-row-label">To</span>
      <div class="intent-row-body">
        {looking ? <p class="intent-evidence">Looking “{resolution.query}” up…</p> : null}

        {resolution.status === "resolved" && resolution.chosen ? (
          <p class="intent-evidence">
            <strong>{resolution.chosen.name ?? resolution.chosen.email}</strong>{" "}
            {resolution.chosen.name ? `<${resolution.chosen.email}>` : ""} — {resolution.chosen.evidence}.
          </p>
        ) : null}

        {resolution.status === "ambiguous" ? (
          <>
            <p class="intent-evidence" role="alert">
              {resolution.message}
            </p>
            <span class="intent-chips">
              {resolution.candidates.map((candidate) => (
                <button
                  key={candidate.email}
                  type="button"
                  class={`intent-chip${chosen === candidate.email ? " is-on" : ""}`}
                  aria-pressed={chosen === candidate.email}
                  onClick={() => onPick(candidate)}
                >
                  {candidate.name ? `${candidate.name} <${candidate.email}>` : candidate.email}
                  <span class="intent-evidence"> — {candidate.evidence}</span>
                </button>
              ))}
            </span>
          </>
        ) : null}

        {resolution.status === "unknown" ? <p class="intent-evidence">{resolution.message}</p> : null}

        {resolution.status === "address" ? <p class="intent-evidence">{resolution.message}</p> : null}

        {resolution.status !== "address" ? (
          <input
            type="email"
            class="intent-inline-input"
            aria-label="Recipient address"
            placeholder={chosen ?? "or type an address"}
            value={typed}
            onInput={(ev) => onType((ev.currentTarget as HTMLInputElement).value)}
          />
        ) : null}
      </div>
    </div>
  );
}
