/** @jsxImportSource preact */
import { useState } from "preact/hooks";
import { parseAddressList, validateDraft, type DraftSpec } from "../lib/mail/compose";
import { formatAddress, type Identity } from "../lib/mail/types";

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
}

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
}: Props) {
  const [showCc, setShowCc] = useState(draft.cc.length > 0 || draft.bcc.length > 0);
  const problems = validateDraft(draft);

  return (
    <section class="composer" aria-label="Compose">
      <header class="composer-header">
        <h2>{draft.subject || "New message"}</h2>
        <button type="button" class="icon-button" onClick={onDiscard} aria-label="Discard">
          ×
        </button>
      </header>

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
          <span class="notice-detail">{draft.droppedAttachments.map((a) => a.name ?? "attachment").join(", ")}</span>
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
    </section>
  );
}
