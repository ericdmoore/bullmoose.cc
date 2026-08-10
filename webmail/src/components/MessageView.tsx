/** @jsxImportSource preact */
import { useMemo, useState } from "preact/hooks";
import { renderMessage, threadAttachments, type ThreadDetail } from "../lib/mail/threadView";
import { displayName, formatAddress, isFlagged, type Email } from "../lib/mail/types";

interface Props {
  detail: ThreadDetail;
  expanded: Set<string>;
  /** Ids the user has explicitly allowed remote content for. */
  imagesAllowed: Set<string>;
  showQuotes: boolean;
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
  onToggleExpand,
  onAllowImages,
  onToggleQuotes,
  onReply,
  onForward,
  onBack,
}: Props) {
  const attachments = useMemo(() => threadAttachments(detail.emails), [detail]);
  const subject = detail.emails[0]?.subject || "(no subject)";

  return (
    <article class="thread-view">
      <header class="thread-header">
        <button type="button" class="back-button" onClick={onBack}>
          ← Back
        </button>
        <h1>{subject}</h1>
        <p class="thread-meta">
          {detail.emails.length} message{detail.emails.length === 1 ? "" : "s"}
          {detail.notFound.length > 0
            ? ` · ${detail.notFound.length} could not be loaded`
            : ""}
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

      {detail.emails.map((email) => (
        <MessageCard
          key={email.id}
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
  const rendered = useMemo(
    () => renderMessage(email, { allowRemoteContent: allowImages }),
    [email, allowImages],
  );
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
                {rendered.blockedRemoteCount === 1 ? "" : "s"} blocked. Loading them tells the
                sender you opened this message.
              </span>
              <button type="button" onClick={onAllowImages}>
                Show images
              </button>
            </div>
          ) : null}

          {rendered.truncated ? (
            <div class="notice">This message was truncated by the server.</div>
          ) : null}

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
