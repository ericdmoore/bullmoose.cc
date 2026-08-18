/** @jsxImportSource preact */
import { useEffect, useState } from "preact/hooks";
import { Badge, Button, Column, IconButton, ListContainer, ListRow } from "./ui";
import { ChevronDoubleLeftIcon, ChevronRightIcon, PlusIcon } from "./icons";
import { stepSelection, type CollectionGroup } from "../lib/shell/collections";

/**
 * The Collection column (s24 T1) — the second panel of the quad:
 * rail → COLLECTION → header list → detail. "Which subset am I in", the same
 * component in every realm: mailboxes, address books, approval lifecycle
 * states, saved queries. Assembled from the T0 primitives; the selection
 * model is `lib/shell/collections.ts`, tested pure.
 *
 * Owns exactly two pieces of UI state, both presentation-only: the collapsed
 * flag (remembered per surface via `storageKey`, the ShellNav pattern —
 * adopted on mount, never read during render, so SSR and first paint agree)
 * and nothing else. WHAT the collections are and WHICH is selected belong to
 * the surface; this renders them.
 *
 * CSP: collapse is a discrete class swap (w-56 ↔ w-10), never inline style.
 * The [New] button is the standardized create affordance (Decision 8) — the
 * primary Button + PlusIcon, label supplied by the realm ("New contact").
 */

export interface CollectionColumnProps {
  /** The realm's name for the column header — "Mail", "Contacts". */
  title: string;
  groups: readonly CollectionGroup[];
  selectedId?: string;
  onSelect: (id: string) => void;
  /** The standardized [New] (Decision 8): omit both to render no create. */
  newLabel?: string;
  onNew?: () => void;
  /** localStorage key for the collapse memory; omit = not collapsible. */
  storageKey?: string;
  /** Test/SSR seam: the collapsed state before any stored preference lands. */
  defaultCollapsed?: boolean;
  class?: string;
}

export default function CollectionColumn(props: CollectionColumnProps) {
  const { title, groups, selectedId, onSelect, newLabel, onNew, storageKey, defaultCollapsed } = props;
  const [collapsed, setCollapsed] = useState(defaultCollapsed ?? false);

  // Adopt the stored preference on mount (never during render — SSR parity).
  useEffect(() => {
    if (!storageKey) return;
    try {
      const stored = globalThis.localStorage?.getItem(storageKey);
      if (stored !== null) setCollapsed(stored === "1");
    } catch {
      /* a preference is a nicety, not a requirement */
    }
  }, [storageKey]);

  const toggle = (next: boolean) => {
    setCollapsed(next);
    if (!storageKey) return;
    try {
      globalThis.localStorage?.setItem(storageKey, next ? "1" : "0");
    } catch {
      /* same */
    }
  };

  // ArrowUp/Down move the selection in visual order (the pure model); the
  // rows are native buttons, so Tab/Enter/Space already work.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const next = stepSelection(groups, selectedId, e.key === "ArrowDown" ? 1 : -1);
    if (next !== undefined && next !== selectedId) onSelect(next);
  };

  if (collapsed) {
    return (
      <div class="flex h-full min-h-0 w-10 shrink-0 flex-col items-center border-r border-gray-200 pt-2 dark:border-white/10">
        <IconButton label={`Expand ${title.toLowerCase()} collections`} size="sm" onClick={() => toggle(false)}>
          <ChevronRightIcon class="size-4" />
        </IconButton>
      </div>
    );
  }

  return (
    <Column
      aria-label={`${title} collections`}
      class={props.class ?? "w-56 shrink-0 border-r border-gray-200 dark:border-white/10"}
      header={
        <div class="flex items-center gap-x-1 px-2 pt-2 pb-1">
          {newLabel && onNew ? (
            <Button variant="primary" size="sm" onClick={() => onNew()} class="grow">
              <PlusIcon class="size-4" strokeWidth={2} />
              {newLabel}
            </Button>
          ) : (
            <span class="grow px-1 text-sm font-semibold text-gray-900 dark:text-white">{title}</span>
          )}
          {storageKey ? (
            <IconButton label={`Collapse ${title.toLowerCase()} collections`} size="sm" onClick={() => toggle(true)}>
              <ChevronDoubleLeftIcon class="size-4" strokeWidth={2} />
            </IconButton>
          ) : null}
        </div>
      }
    >
      <nav class="px-2 pb-2" onKeyDown={onKeyDown}>
        {groups.map((g) => (
          <div key={g.id} class="mb-3">
            {g.label ? (
              <h3 class="px-2 pb-1 text-xs font-semibold tracking-wide text-gray-500 uppercase dark:text-gray-400">
                {g.label}
              </h3>
            ) : null}
            <ListContainer>
              {g.items.map((item) => (
                <ListRow
                  key={item.id}
                  active={item.id === selectedId}
                  muted={item.muted}
                  onSelect={() => onSelect(item.id)}
                >
                  <span class="min-w-0 grow truncate">{item.label}</span>
                  {item.count ? <Badge>{item.count}</Badge> : null}
                </ListRow>
              ))}
            </ListContainer>
          </div>
        ))}
      </nav>
    </Column>
  );
}
