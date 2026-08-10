/** @jsxImportSource preact */
import { buildMailboxTree, flattenTree } from "../lib/mail/mailboxes";
import type { Mailbox } from "../lib/mail/types";

interface Props {
  mailboxes: Mailbox[];
  selectedId: string | undefined;
  onSelect: (mailbox: Mailbox) => void;
  onCompose: () => void;
}

const ROLE_ICON: Record<string, string> = {
  inbox: "✉",
  drafts: "✎",
  sent: "➤",
  archive: "▤",
  junk: "⊘",
  trash: "⌦",
};

export default function MailboxSidebar({ mailboxes, selectedId, onSelect, onCompose }: Props) {
  const nodes = flattenTree(buildMailboxTree(mailboxes));

  return (
    <nav class="sidebar" aria-label="Mailboxes">
      <button type="button" class="compose-button" onClick={onCompose}>
        Compose
      </button>
      <ul class="mailbox-list">
        {nodes.map((node) => (
          <li key={node.id}>
            <button
              type="button"
              class={`mailbox-row${node.id === selectedId ? " is-selected" : ""}`}
              style={{ paddingLeft: `${12 + node.depth * 14}px` }}
              aria-current={node.id === selectedId ? "true" : undefined}
              onClick={() => onSelect(node)}
            >
              <span class="mailbox-icon" aria-hidden="true">
                {node.role ? (ROLE_ICON[node.role] ?? "○") : "○"}
              </span>
              <span class="mailbox-name">{node.name}</span>
              {node.unreadEmails > 0 ? (
                <span class="mailbox-unread" aria-label={`${node.unreadEmails} unread`}>
                  {node.unreadEmails}
                </span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
