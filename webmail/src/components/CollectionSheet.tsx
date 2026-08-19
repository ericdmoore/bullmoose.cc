/** @jsxImportSource preact */
import { useEffect, useRef } from "preact/hooks";
import { IconButton } from "./ui";
import { ChevronDownMiniIcon, XMarkIcon } from "./icons";
import { cx } from "../lib/ui/classes";
import type { CollectionGroup } from "../lib/shell/collections";
import { CollectionTree, useExpansion } from "./CollectionColumn";

/**
 * The collection sheet (s25 T2) — the SAME `CollectionGroup[]` tree the
 * desktop CollectionColumn renders, as a bottom sheet on small screens. The
 * mobile principle it exists for (s25 devPlan): the levels above the list are
 * PICKERS you summon, not screens you traverse — you tap the list's title,
 * the tree slides up into the thumb zone, you pick, it leaves. Zero stack
 * depth; the back button stays what it is.
 *
 * Markup seeded from the Tailwind UI dialog family
 * (`referenceTemplates/.../navigation/command-palettes/08-with-groups.html`'s
 * dialog/backdrop/panel shape); the `@headlessui`/`@tailwindplus/elements`
 * interactivity is hand-rolled instead (the ShellNav rule — those ship inline
 * styles the CSP correctly refuses). Everything animates by class swap:
 * translate-y-0 ↔ translate-y-full on the panel, opacity on the backdrop.
 *
 * Unlike the nav drawer this IS modal (it has a backdrop — a real <button>,
 * so "tap outside to dismiss" is reachable by keyboard and screen reader
 * too). Escape closes; focus moves into the panel on open (the drawer's
 * hand-rolled a11y pattern, plus the focus step it skips because it is not
 * modal). The component stays mounted either way so the slide can animate.
 *
 * The panel pads its bottom with `env(safe-area-inset-bottom)` (s25 T1):
 * bottom-anchored UI on a notched phone must clear the home indicator.
 */

export interface CollectionSheetProps {
  /** The realm's name — the sheet's heading ("Approvals"). */
  title: string;
  groups: readonly CollectionGroup[];
  selectedId?: string;
  /** Called with the picked id; the sheet closes itself after. */
  onSelect: (id: string) => void;
  open: boolean;
  onClose: () => void;
  /** localStorage key for expansion memory — pass the SAME key the surface's
   *  CollectionColumn uses and the two renderings remember one tree. */
  storageKey?: string;
  /** Test/SSR seam: parent ids whose children start expanded. */
  defaultExpanded?: readonly string[];
}

export default function CollectionSheet(props: CollectionSheetProps) {
  const { title, groups, selectedId, onSelect, open, onClose, storageKey, defaultExpanded } = props;
  const panelRef = useRef<HTMLDivElement>(null);
  const { expanded, toggle } = useExpansion(storageKey, defaultExpanded);

  // Escape closes — the ShellNav overlay pattern, scoped to while-open so the
  // listener is not a permanent global.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Focus into the sheet on open, so the next Tab lands on the tree rather
  // than whatever was behind the backdrop.
  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  const pick = (id: string) => {
    onSelect(id);
    onClose();
  };

  return (
    <div
      class={cx("fixed inset-0 z-50 lg:hidden", !open && "pointer-events-none")}
      role="dialog"
      aria-modal="true"
      aria-label={`${title} collections`}
      aria-hidden={!open}
    >
      {/* The backdrop is a BUTTON: tap-outside-to-dismiss as a real control. */}
      <button
        type="button"
        aria-label="Close collections"
        tabIndex={open ? 0 : -1}
        onClick={onClose}
        class={cx(
          "absolute inset-0 h-full w-full bg-gray-500/25 transition-opacity duration-200 dark:bg-gray-900/50",
          open ? "opacity-100" : "opacity-0",
        )}
      />

      <div
        ref={panelRef}
        tabIndex={-1}
        class={cx(
          "absolute inset-x-0 bottom-0 max-h-[80dvh] transform overflow-y-auto rounded-t-xl bg-white pb-[env(safe-area-inset-bottom)] shadow-2xl ring-1 ring-black/5 transition-transform duration-200 ease-out focus:outline-none dark:bg-gray-900 dark:ring-white/10",
          open ? "translate-y-0" : "translate-y-full",
        )}
      >
        {/* The grab-handle mark — the bottom-sheet affordance, decorative. */}
        <div aria-hidden="true" class="mx-auto mt-2 h-1 w-10 rounded-full bg-gray-300 dark:bg-white/20" />
        <header class="flex items-center justify-between px-4 pt-1 pb-1">
          <h2 class="text-sm font-semibold text-gray-900 dark:text-white">{title}</h2>
          <IconButton label="Close" size="sm" onClick={onClose}>
            <XMarkIcon class="size-5" />
          </IconButton>
        </header>
        <nav class="px-2 pb-2" aria-label={`${title} collections`}>
          <CollectionTree
            groups={groups}
            selectedId={selectedId}
            onSelect={pick}
            expanded={expanded}
            onToggle={toggle}
          />
        </nav>
      </div>
    </div>
  );
}

/**
 * The summon affordance (s25 T2) — the list header's title as a button, shown
 * only below `lg`. One component so every surface adopting the sheet gets the
 * same tappable title (T3–T4 inherit this, not a per-surface re-cut).
 */
export function CollectionSheetButton(props: { label: string; open: boolean; onOpen: () => void; class?: string }) {
  return (
    <button
      type="button"
      onClick={props.onOpen}
      aria-haspopup="dialog"
      aria-expanded={props.open}
      class={cx(
        "flex items-center gap-x-1 rounded-md px-2 py-1.5 text-left text-sm font-semibold text-gray-900 hover:bg-gray-50 lg:hidden dark:text-white dark:hover:bg-white/5",
        props.class,
      )}
    >
      <span class="min-w-0 truncate">{props.label}</span>
      <ChevronDownMiniIcon class="size-4 shrink-0 text-gray-400" />
    </button>
  );
}
