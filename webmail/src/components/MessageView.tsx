/** @jsxImportSource preact */
import { Fragment } from "preact";
import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { closeAnnotation, loadMarginAnnotations, type CloseStatus } from "../lib/annotations/api";
import { marginFor, personOpenItems } from "../lib/annotations/margin";
import type { Annotation } from "../lib/annotations/types";
import type { JmapClient } from "../lib/jmap/JmapClient";
import { renderMessage, threadAttachments, type ThreadDetail } from "../lib/mail/threadView";
import { displayName, formatAddress, isFlagged, type Email } from "../lib/mail/types";
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

  useEffect(() => {
    setAnnotations([]);
    setVerbError(null);
    if (!client || !accountId) return;
    let cancelled = false;
    void (async () => {
      // The capability gate (§8.6): a session without the agent capability
      // must see NO agent surface — the fetch is never even sent.
      if (!(await client.hasAgentCapability())) return;
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
        </>
      ) : (
        <p class="message-collapsed">{email.preview}</p>
      )}
    </section>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
