/** @jsxImportSource preact */
import { useEffect, useRef, useState } from "preact/hooks";
import { Breadcrumb, Button, IconButton } from "./ui";
import { ChevronDownIcon, ChevronDownMiniIcon, PlusIcon } from "./icons";
import { CollectionTree, useExpansion } from "./CollectionColumn";
import { findItem, type CollectionGroup } from "../lib/shell/collections";
import { createLabelClasses, cx } from "../lib/ui/classes";

/**
 * Collapsed CollectionColumn as a bar ABOVE the list: realm / current
 * collection breadcrumb, a popover to pick another, and a control that
 * restores the column. Desktop [New] lives here so collapsing the column does
 * not hide the create verb (the FAB remains the phone copy).
 */

export interface CollectionBarProps {
  title: string;
  groups: readonly CollectionGroup[];
  selectedId?: string;
  onSelect: (id: string) => void;
  onExpand: () => void;
  newLabel?: string;
  onNew?: () => void;
  newDisabled?: boolean;
  storageKey?: string;
  defaultExpanded?: readonly string[];
  /** Test/SSR seam: the picker starts open. */
  defaultOpen?: boolean;
  /** Extra classes on the bar (Approvals hides it below `lg` — the sheet is
   *  the phone picker there, and two pickers on one title is one too many). */
  class?: string;
}

export default function CollectionBar({
  title,
  groups,
  selectedId,
  onSelect,
  onExpand,
  newLabel,
  onNew,
  newDisabled,
  storageKey,
  defaultExpanded,
  defaultOpen = false,
  class: cls,
}: CollectionBarProps) {
  const [open, setOpen] = useState(defaultOpen);
  const rootRef = useRef<HTMLDivElement>(null);
  const { expanded, toggle } = useExpansion(storageKey, defaultExpanded);
  const current = findItem(groups, selectedId);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (id: string) => {
    onSelect(id);
    setOpen(false);
  };

  return (
    <div
      ref={rootRef}
      class={cx(
        "relative flex shrink-0 items-center gap-x-2 border-b border-gray-200 px-2 py-1.5 dark:border-white/10",
        cls,
      )}
    >
      <IconButton label={`Show ${title.toLowerCase()} collections as a column`} size="sm" onClick={onExpand}>
        <ChevronDownIcon class="size-4" strokeWidth={2} />
      </IconButton>
      <div class="flex min-w-0 grow items-center gap-x-1">
        <Breadcrumb
          aria-label={`${title} collections`}
          items={[
            { label: title, onSelect: () => setOpen(true) },
            {
              label: current?.label ?? title,
              current: true,
              onSelect: () => setOpen((v) => !v),
            },
          ]}
        />
        <IconButton
          label={`Choose ${title.toLowerCase()} collection`}
          size="sm"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <ChevronDownMiniIcon class={cx("size-4", open && "rotate-180")} />
        </IconButton>
      </div>
      {newLabel && onNew ? (
        <Button variant="primary" size="sm" disabled={newDisabled} class="max-lg:hidden" onClick={() => onNew()}>
          <PlusIcon class="size-4 shrink-0" strokeWidth={2} />
          {/* s34 — same one-line rule as the column's button (classes.ts). */}
          <span class={createLabelClasses()}>{newLabel}</span>
        </Button>
      ) : null}
      {open ? (
        <div
          role="dialog"
          aria-label={`${title} collections`}
          class="absolute top-full left-2 z-20 mt-1 w-64 max-h-80 overflow-y-auto rounded-md bg-white py-2 shadow-lg ring-1 ring-gray-200 dark:bg-gray-900 dark:ring-white/10"
        >
          <nav class="px-2">
            <CollectionTree
              groups={groups}
              selectedId={selectedId}
              onSelect={pick}
              expanded={expanded}
              onToggle={toggle}
            />
          </nav>
        </div>
      ) : null}
    </div>
  );
}
