/** @jsxImportSource preact */
import { Fragment } from "preact";
import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { closeAnnotation, loadMarginAnnotations, type CloseStatus } from "../lib/annotations/api";
import { marginFor, personOpenItems } from "../lib/annotations/margin";
import type { Annotation } from "../lib/annotations/types";
import type { JmapClient } from "../lib/jmap/JmapClient";
import { renderMessage, threadAttachments, type ThreadDetail } from "../lib/mail/threadView";
import { displayName, formatAddress, isFlagged, type Email } from "../lib/mail/types";
import { armWatch, askAgent, type AskSpec, type VerbOutcome } from "../lib/verbs/api";
import { verbCounterparty } from "../lib/verbs/contract";
import AnnotationMargin from "./AnnotationMargin";
import PersonPanel from "./PersonPanel";

interface Props {
  detail: ThreadDetail;
  expanded: Set<string>;
  /** Ids the user has explicitly allowed remote content for. */
  imagesAllowed: Set<string>;
  showQuotes: boolean;
  /**
   * The margin's door (s18 A3). BOTH optional: without them the thread renders
   * exactly as before — no margin, no dead region — which is also the
   * plain-client floor when the shell has no agent session to offer. The shell
   * injects them (§6.1: components never resolve a client themselves).
   */
  client?: JmapClient;
  accountId?: string;
  onToggleExpand: (emailId: string) => void;
  onAllowImages: (emailId: string) => void;
  onToggleQuotes: () => void;
  onReply: (email: Email, all: boolean) => void;
  onForward: (email: Email) => void;
  onBack: () => void;
}

export default function MessageView({
  detail,
  expanded,
  imagesAllowed,
  showQuotes,
  client,
  accountId,
  onToggleExpand,
  onAllowImages,
  onToggleQuotes,
  onReply,
  onForward,
  onBack,
}: Props) {
  const attachments = useMemo(() => threadAttachments(detail.emails), [detail]);
  const subject = detail.emails[0]?.subject || "(no subject)";

  // ── The margin's data (s18 A3) ──────────────────────────────────────────
  // Fetched per thread open, batched (loadMarginAnnotations: one POST). The
  // margin is AMBIENT commentary: a failed or refused fetch leaves the mail
  // reading surface exactly as it was — never an error banner over your mail.
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [verbError, setVerbError] = useState<string | null>(null);
  const [verbsBlocked, setVerbsBlocked] = useState(false);

  // ── The agent verbs (s20 T2) ────────────────────────────────────────────
  // Beside Reply/Forward, not instead of them. `agentReady` rides the SAME
  // capability gate the margin does (§8.6): a session with no agent capability
  // sees no agent surface at all, and the plain-client floor is unchanged.
  const [agentReady, setAgentReady] = useState(false);
  const [askState, setAskState] = useState<Record<string, AskCell>>({});
  const [asksBlocked, setAsksBlocked] = useState(false);

  useEffect(() => {
    setAnnotations([]);
    setVerbError(null);
    setAgentReady(false);
    setAskState({});
    if (!client || !accountId) return;
    let cancelled = false;
    void (async () => {
      // The capability gate (§8.6): a session without the agent capability
      // must see NO agent surface — the fetch is never even sent.
      if (!(await client.hasAgentCapability())) return;
      if (!cancelled) setAgentReady(true);
      const res = await loadMarginAnnotations(
        client,
        accountId,
        detail.emails.map((e) => e.id),
      );
      if (!cancelled) setAnnotations(res.annotations);
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client, accountId, detail]);

  /**
   * One runner for every verb. The ask is optimistic about NOTHING: the row
   * goes busy, the server's own answer — armed, queued, or refused — replaces
   * it verbatim, and a refusal that names a missing scope greys the verbs
   * rather than inviting the same wall again (the margin's `closeOne` shape).
   */
  const runVerb = useCallback((emailId: string, run: () => Promise<VerbOutcome>) => {
    setAskState((prev) => ({ ...prev, [emailId]: { busy: true } }));
    void run()
      .then((res) => {
        setAskState((prev) => ({ ...prev, [emailId]: { busy: false, ok: res.ok, message: res.message } }));
        if (!res.ok && res.forbidden) setAsksBlocked(true);
      })
      .catch(() => {
        setAskState((prev) => ({
          ...prev,
          [emailId]: { busy: false, ok: false, message: "The ask did not reach the server. Try again." },
        }));
      });
  }, []);

  const closeOne = useCallback(
    (id: string, status: CloseStatus) => {
      if (!client || !accountId) return;
      // Optimistic: the row moves to its closed state now; a refusal reverts
      // it to open (the only state a verb is offered from) and says why.
      setBusy((prev) => new Set(prev).add(id));
      setAnnotations((rows) => rows.map((r) => (r.id === id ? { ...r, status } : r)));
      void closeAnnotation(client, accountId, id, status)
        .then((res) => {
          if (res.ok) {
            setVerbError(null);
            return;
          }
          setAnnotations((rows) => rows.map((r) => (r.id === id ? { ...r, status: "open" } : r)));
          setVerbError(res.message);
          if (res.forbidden) setVerbsBlocked(true);
        })
        .catch(() => {
          setAnnotations((rows) => rows.map((r) => (r.id === id ? { ...r, status: "open" } : r)));
          setVerbError("The write did not reach the server. Try again.");
        })
        .finally(() => {
          setBusy((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
        });
    },
    [client, accountId],
  );

  const emailIds = detail.emails.map((e) => e.id);
  const margin = useMemo(() => marginFor(annotations, emailIds), [annotations, detail]);
  const personItems = useMemo(() => personOpenItems(annotations, emailIds), [annotations, detail]);
  // The thread originator — v1's "whoever this thread is with".
  const person = displayName(detail.emails[0]?.from[0]);

  return (
    <article class="thread-view">
      <header class="thread-header">
        <button type="button" class="back-button" onClick={onBack}>
          ← Back
        </button>
        <h1>{subject}</h1>
        <p class="thread-meta">
          {detail.emails.length} message{detail.emails.length === 1 ? "" : "s"}
          {detail.notFound.length > 0 ? ` · ${detail.notFound.length} could not be loaded` : ""}
        </p>
      </header>

      {attachments.length > 0 ? (
        <section class="attachment-tray" aria-label="Attachments">
          {attachments.map((att) => (
            <span key={att.blobId} class="attachment-chip">
              {"\u{1F4CE}"} {att.name ?? "attachment"}
              <span class="attachment-size"> ({formatSize(att.size)})</span>
            </span>
          ))}
        </section>
      ) : null}

      <PersonPanel person={person} items={personItems} />

      {detail.emails.map((email) => (
        <Fragment key={email.id}>
          <MessageCard
            email={email}
            expanded={expanded.has(email.id)}
            allowImages={imagesAllowed.has(email.id)}
            showQuotes={showQuotes}
            onToggleExpand={() => onToggleExpand(email.id)}
            onAllowImages={() => onAllowImages(email.id)}
            onToggleQuotes={onToggleQuotes}
            onReply={(all) => onReply(email, all)}
            onForward={() => onForward(email)}
            verbs={
              agentReady && client && accountId
                ? {
                    cell: askState[email.id],
                    blocked: asksBlocked,
                    onWatch: () => runVerb(email.id, () => armWatch(client, accountId, email)),
                    onAsk: (spec: AskSpec) => runVerb(email.id, () => askAgent(client, accountId, email, spec)),
                  }
                : undefined
            }
          />
          {/* The margin binds to the ORIGINAL message: `marginFor` keys on the
              anchor's objectId, so a quoted copy never grows a duplicate. */}
          <AnnotationMargin
            annotations={margin.get(email.id) ?? []}
            busy={busy}
            verbsDisabled={verbsBlocked}
            error={verbError}
            onClose={closeOne}
          />
        </Fragment>
      ))}
    </article>
  );
}

/** One message's verb state: in flight, or the server's last word on it. */
interface AskCell {
  busy?: boolean;
  ok?: boolean;
  message?: string;
}

interface VerbHandlers {
  cell: AskCell | undefined;
  /** A refusal already told us this session lacks the scope. */
  blocked: boolean;
  onWatch: () => void;
  onAsk: (spec: AskSpec) => void;
}

interface CardProps {
  email: Email;
  expanded: boolean;
  allowImages: boolean;
  showQuotes: boolean;
  onToggleExpand: () => void;
  onAllowImages: () => void;
  onToggleQuotes: () => void;
  onReply: (all: boolean) => void;
  onForward: () => void;
  /** Absent = no agent session; the card renders exactly as a plain client's. */
  verbs?: VerbHandlers;
}

function MessageCard({
  email,
  expanded,
  allowImages,
  showQuotes,
  onToggleExpand,
  onAllowImages,
  onToggleQuotes,
  onReply,
  onForward,
  verbs,
}: CardProps) {
  const [quoteOpen, setQuoteOpen] = useState(false);
  const rendered = useMemo(() => renderMessage(email, { allowRemoteContent: allowImages }), [email, allowImages]);
  const quoteVisible = quoteOpen || showQuotes;

  return (
    <section class={`message-card${expanded ? " is-expanded" : ""}`}>
      <header class="message-header" onClick={onToggleExpand}>
        <span class="message-from">{displayName(email.from[0])}</span>
        <span class="message-to">to {email.to.map((a) => displayName(a)).join(", ") || "…"}</span>
        {isFlagged(email) ? <span class="message-flag">★</span> : null}
        <time class="message-date" dateTime={email.receivedAt}>
          {new Date(email.receivedAt).toLocaleString()}
        </time>
      </header>

      {expanded ? (
        <>
          <div class="message-addresses">
            <div>From: {email.from.map(formatAddress).join(", ")}</div>
            {email.cc.length > 0 ? <div>Cc: {email.cc.map(formatAddress).join(", ")}</div> : null}
          </div>

          {rendered.blockedRemoteCount > 0 && !allowImages ? (
            <div class="notice notice-blocked">
              <span>
                {rendered.blockedRemoteCount} remote image
                {rendered.blockedRemoteCount === 1 ? "" : "s"} blocked. Loading them tells the sender you opened this
                message.
              </span>
              <button type="button" onClick={onAllowImages}>
                Show images
              </button>
            </div>
          ) : null}

          {rendered.truncated ? <div class="notice">This message was truncated by the server.</div> : null}

          {/* Sanitized in `renderMessage` — this is the ONLY place sender HTML
              reaches the DOM, and it never arrives unsanitized (invariant §6.3). */}
          <div class="message-body" dangerouslySetInnerHTML={{ __html: rendered.html }} />

          {rendered.quotedHtml ? (
            <div class="quoted-block">
              <button
                type="button"
                class="quote-toggle"
                aria-expanded={quoteVisible}
                onClick={() => {
                  setQuoteOpen(!quoteVisible);
                  if (showQuotes) onToggleQuotes();
                }}
              >
                {quoteVisible ? "Hide quoted text" : "··· Show quoted text"}
              </button>
              {quoteVisible ? (
                <div class="message-quote" dangerouslySetInnerHTML={{ __html: rendered.quotedHtml }} />
              ) : null}
            </div>
          ) : null}

          <footer class="message-actions">
            <button type="button" onClick={() => onReply(false)}>
              Reply
            </button>
            <button type="button" onClick={() => onReply(true)}>
              Reply all
            </button>
            <button type="button" onClick={onForward}>
              Forward
            </button>
          </footer>

          {/* The agent verbs, in their own bar BELOW the classic three. The
              ordering is the claim: Reply/Reply all/Forward keep their place
              and their behaviour, and the agent asks live beside them. */}
          {verbs ? <AgentVerbs email={email} {...verbs} /> : null}
        </>
      ) : (
        <p class="message-collapsed">{email.preview}</p>
      )}
    </section>
  );
}

/**
 * The verbs (s20 T2) — the human asking, in place, on the message in front of
 * them. Three asks, and each is a door into machinery that already exists:
 *
 *   Answer     an agent invocation whose output is a draft-reply proposal.
 *   Watch      an ordinary `no-reply-from` Watch, armed with T1's default
 *              contract. NOT a flag: nothing is filed, nothing is starred —
 *              the human states a condition and the sweep does the noticing.
 *   Bring in…  an agent invocation that decides forward / summarize / cc and
 *              drafts to the person named. The address is asked for, never
 *              guessed: picking which "Sergio" was meant is exactly the
 *              confident wrongness the queue exists to catch.
 *
 * Schedule and Delegate are deliberately absent — see the PR body. A verb
 * whose approval has nowhere to land would wedge the tray, and shipping fewer
 * verbs is the cheaper mistake.
 */
export function AgentVerbs({
  email,
  cell,
  blocked,
  onWatch,
  onAsk,
  initiallyBringOpen = false,
}: VerbHandlers & { email: Email; initiallyBringOpen?: boolean }): preact.JSX.Element {
  const [bringOpen, setBringOpen] = useState(initiallyBringOpen);
  const [person, setPerson] = useState("");
  const busy = cell?.busy === true;
  const who = verbCounterparty(email);

  const submitBring = () => {
    onAsk({ verb: "bring-in", person });
    setBringOpen(false);
    setPerson("");
  };

  return (
    <div class="agent-verbs">
      <div class="message-actions">
        <button type="button" class="agent-verb" disabled={busy || blocked} onClick={() => onAsk({ verb: "answer" })}>
          Answer
        </button>
        <button
          type="button"
          class="agent-verb"
          disabled={busy || blocked || !who}
          title={who ? `Watch for a reply from ${who}` : "No address to wait on"}
          onClick={onWatch}
        >
          Watch
        </button>
        <button
          type="button"
          class="agent-verb"
          disabled={busy || blocked}
          aria-expanded={bringOpen}
          onClick={() => setBringOpen(!bringOpen)}
        >
          Bring in…
        </button>
      </div>

      {/* Deliberately not a <form>: a navigating form is the one thing this
          shell may never contain (the tokenInUrl invariant). Enter submits
          through the key handler instead. */}
      {bringOpen ? (
        <div class="message-actions agent-bring-in">
          <input
            type="email"
            class="agent-verb-input"
            placeholder="Who should I bring in? (email address)"
            aria-label="Email address of the person to bring in"
            value={person}
            onInput={(e) => setPerson((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitBring();
              if (e.key === "Escape") setBringOpen(false);
            }}
          />
          <button type="button" class="agent-verb" disabled={busy} onClick={submitBring}>
            Ask
          </button>
          <button type="button" class="agent-verb" onClick={() => setBringOpen(false)}>
            Cancel
          </button>
        </div>
      ) : null}

      {busy ? <p class="notice agent-verb-note">Asking…</p> : null}
      {!busy && cell?.message ? (
        <p class={`notice agent-verb-note${cell.ok ? "" : " notice-error"}`} role={cell.ok ? undefined : "alert"}>
          {cell.message}
        </p>
      ) : null}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
