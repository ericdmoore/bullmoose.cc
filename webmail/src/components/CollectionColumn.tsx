/** @jsxImportSource preact */
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { Badge, Button, Column, IconButton, ListContainer, ListRow } from "./ui";
import CreateFab from "./CreateFab";
import { ChevronDoubleLeftIcon, ChevronRightIcon, ChevronUpIcon, PlusIcon } from "./icons";
import { createLabelClasses, cx, listRowClasses } from "../lib/ui/classes";
import {
  iconRailItems,
  stepSelection,
  toggleExpansion,
  type CollectionGroup,
  type CollectionItem,
} from "../lib/shell/collections";

/**
 * The Collection column (s24 T1, grown by s25 T2) — the second panel of the
 * quad: rail → COLLECTION → header list → detail. "Which subset am I in", the
 * same component in every realm: mailboxes, address books, approval lifecycle
 * states, saved queries. Assembled from the T0 primitives; the selection
 * model is `lib/shell/collections.ts`, tested pure.
 *
 * Owns exactly three pieces of UI state, all presentation-only: the collapsed
 * flag and the expansion Set (both remembered per surface via `storageKey`,
 * the ShellNav pattern — adopted on mount, never read during render, so SSR
 * and first paint agree) and nothing else. WHAT the collections are and WHICH
 * is selected belong to the surface; this renders them.
 *
 * s25 T2: one source, three renderings. The tree markup lives in
 * `<CollectionTree>` below so this column and the bottom `<CollectionSheet>`
 * render literally the same rows — inline-expandable children (one level),
 * and disabled rows greyed WITH their reason, stacked under the label (the
 * planned-section idiom: never a dead row, and never half of one either).
 *
 * s25 T5: the [New] gains a SECOND POSITION, not a second definition. Below
 * `lg` the same `newLabel`/`onNew`/`newDisabled` render as a `<CreateFab>` in
 * the thumb zone; at `lg` and up only the column's button exists. One source,
 * two placements — see CreateFab.tsx.
 *
 * CSP: collapse, expansion and every responsive behaviour are discrete class
 * swaps (w-56 ↔ w-12, rotate-90, max-lg:*), never inline style. The [New]
 * button is the standardized create affordance (Decision 8) — the primary
 * Button + PlusIcon, label supplied by the realm ("New contact"). Collapsed,
 * the same verb is an icon-only Plus on the rail (desktop) / FAB (phone), and
 * items that carry a glyph stay as an icon rail so Mail's Inbox/Drafts/Archive
 * remain reachable without expanding. Mail, Approvals, Contacts, and Agents
 * opt into `collapseMode="bar"` instead: the column leaves and a CollectionBar
 * sits above the list.
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
  /** Disable (not hide) the create — the realm exists, this session can't write. */
  newDisabled?: boolean;
  /** Surface-specific extras under the header (a second create, a hint). */
  actions?: ComponentChildren;
  /** Surface-specific block after the groups (Contacts' manage-books). */
  footer?: ComponentChildren;
  /** localStorage key for the collapse memory; omit = not collapsible.
   *  Expansion memory rides the same key (`<storageKey>.open`). */
  storageKey?: string;
  /** Test/SSR seam: the collapsed state before any stored preference lands. */
  defaultCollapsed?: boolean;
  /** Test/SSR seam: parent ids whose children start expanded. */
  defaultExpanded?: readonly string[];
  /**
   * What this column does below `lg` (s25 T1 — screens vs pickers):
   *
   * `stack` (default) — full-width and height-capped, stacked above the list
   * by the page's own narrow-screen CSS. The interim answer for surfaces that
   * have not adopted the collection sheet yet: a fixed `w-56` beside a list
   * at 390px leaves the list ~10ch wide, which is the bug, not a layout.
   *
   * `hidden` — not rendered below `lg` at all: the surface summons a
   * `<CollectionSheet>` from its list title instead (the T2 pattern —
   * a picker costs zero stack depth, so the column would be redundant).
   */
  narrow?: "stack" | "hidden";
  /**
   * Where the column goes when collapsed:
   * `rail` (default) — a thin icon strip beside the list (the s24 strip).
   * `bar` — the column leaves; the surface renders `<CollectionBar>` above
   * the list (a breadcrumb + collection popover). This column then renders
   * only the FAB so the create verb survives on the phone.
   */
  collapseMode?: "rail" | "bar";
  /** Controlled collapse. Omit both and the column owns the flag (and the
   *  storageKey memory). Surfaces that render CollectionBar lift this so
   *  the bar and the column agree. */
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  class?: string;
}

/** Tree indent as discrete classes, clamped (CSP: never inline style — this
 *  replaces MailboxSidebar's style={{paddingLeft}} violation). */
const DEPTH_PAD = ["", "pl-4", "pl-8", "pl-12", "pl-16"] as const;

const depthPad = (depth: number | undefined) => DEPTH_PAD[Math.min(depth ?? 0, DEPTH_PAD.length - 1)];

/**
 * The row's inner content — leading icon, label, count/note badge. Shared by
 * every row shape below.
 *
 * A disabled row's REASON goes UNDER its label, not beside it, and that is a
 * fix rather than a preference. Side by side, the two are truncating flex
 * siblings inside a `w-56` column: at the real width there is room for about
 * one of them, so flexbox shrinks both and the Finder's empty states read
 * "No saved que… save a find to k…" — a planned-row idiom that renders as two
 * fragments says less than a dead row would. Stacked, the label gets the
 * column's full width and the hint wraps beneath it in the smaller, muted
 * type, which is what it always meant to be. `CollectionColumn.test.tsx`
 * asserts the structure, since the collision is invisible to a DOM query.
 */
function RowBody({ item, extraDepth = 0 }: { item: CollectionItem; extraDepth?: number }) {
  const hint = item.disabled && item.reason ? item.reason : undefined;
  return (
    <>
      <span
        class={`flex min-w-0 grow gap-x-1.5 ${hint ? "items-start" : "items-center"} ${depthPad((item.depth ?? 0) + extraDepth)}`}
      >
        {item.icon ? <item.icon class="size-4 shrink-0 text-gray-400" /> : null}
        <span class="flex min-w-0 grow flex-col">
          <span class="truncate">{item.label}</span>
          {hint ? <span class="text-xs font-normal break-words text-gray-400 dark:text-gray-500">{hint}</span> : null}
        </span>
      </span>
      {item.count ? <Badge>{item.count}</Badge> : item.note ? <Badge>{item.note}</Badge> : null}
    </>
  );
}

/** A greyed planned row (s25 T2): disabled, its reason visible UNDER the
 *  label AND on `title` — never a dead row, never a hidden one, and (since
 *  the Finder's empty states proved it) never half a row either: see
 *  `RowBody` for why the hint stacks rather than sits beside. A native
 *  `disabled` button, so selection and keyboard order skip it for free. */
function DisabledRow({ item, extraDepth = 0 }: { item: CollectionItem; extraDepth?: number }) {
  return (
    <li>
      <button
        type="button"
        disabled
        title={item.reason}
        class={`${listRowClasses({ muted: true })} cursor-not-allowed opacity-60`}
      >
        <RowBody item={item} extraDepth={extraDepth} />
      </button>
    </li>
  );
}

/**
 * The tree, rendered (s25 T2) — ONE source for the three renderings: the
 * desktop column below, the bottom CollectionSheet, and whatever T4's realm
 * tray grows into. Groups of rows; a row with `children` gets a chevron
 * toggle (its own button BESIDE the select button — a button inside a button
 * is invalid HTML); expanded children render inline, indented one step.
 */
export function CollectionTree(props: {
  groups: readonly CollectionGroup[];
  selectedId?: string;
  onSelect: (id: string) => void;
  expanded: ReadonlySet<string>;
  onToggle: (id: string) => void;
}) {
  const { groups, selectedId, onSelect, expanded, onToggle } = props;
  return (
    <>
      {groups.map((g) => (
        <div key={g.id} class="mb-3">
          {g.label ? (
            <h3 class="px-2 pb-1 text-xs font-semibold tracking-wide text-gray-500 uppercase dark:text-gray-400">
              {g.label}
            </h3>
          ) : null}
          <ListContainer>
            {g.items.map((item) => {
              if (item.disabled) return <DisabledRow key={item.id} item={item} />;
              const kids = item.children ?? [];
              if (kids.length === 0) {
                return (
                  <ListRow
                    key={item.id}
                    active={item.id === selectedId}
                    muted={item.muted}
                    onSelect={() => onSelect(item.id)}
                  >
                    <RowBody item={item} />
                  </ListRow>
                );
              }
              const open = expanded.has(item.id);
              return (
                <li key={item.id}>
                  <div class="flex items-center gap-x-0.5">
                    <button
                      type="button"
                      onClick={() => onToggle(item.id)}
                      aria-expanded={open}
                      aria-label={`${open ? "Collapse" : "Expand"} ${item.label}`}
                      class="shrink-0 rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/10 dark:hover:text-gray-300"
                    >
                      <ChevronRightIcon
                        class={`size-3.5 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
                        strokeWidth={2}
                      />
                    </button>
                    <button
                      type="button"
                      onClick={() => onSelect(item.id)}
                      aria-current={item.id === selectedId ? "true" : undefined}
                      class={listRowClasses({ active: item.id === selectedId, muted: item.muted })}
                    >
                      <RowBody item={item} />
                    </button>
                  </div>
                  {open ? (
                    <ListContainer>
                      {kids.map((child) =>
                        child.disabled ? (
                          <DisabledRow key={child.id} item={child} extraDepth={1} />
                        ) : (
                          <ListRow
                            key={child.id}
                            active={child.id === selectedId}
                            muted={child.muted}
                            onSelect={() => onSelect(child.id)}
                          >
                            <RowBody item={child} extraDepth={1} />
                          </ListRow>
                        ),
                      )}
                    </ListContainer>
                  ) : null}
                </li>
              );
            })}
          </ListContainer>
        </div>
      ))}
    </>
  );
}

/** The expansion Set as remembered state — the CollectionColumn's second
 *  memory, and the sheet's too (one hook, so the two renderings agree). */
export function useExpansion(storageKey: string | undefined, defaultExpanded: readonly string[] | undefined) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(defaultExpanded ?? []));
  const memoryKey = storageKey ? `${storageKey}.open` : undefined;

  // Adopt the stored expansion on mount (never during render — SSR parity).
  useEffect(() => {
    if (!memoryKey) return;
    try {
      const stored = globalThis.localStorage?.getItem(memoryKey);
      if (stored !== null) setExpanded(new Set(JSON.parse(stored) as string[]));
    } catch {
      /* a preference is a nicety, not a requirement */
    }
  }, [memoryKey]);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = toggleExpansion(prev, id);
      if (memoryKey) {
        try {
          globalThis.localStorage?.setItem(memoryKey, JSON.stringify([...next]));
        } catch {
          /* same */
        }
      }
      return next;
    });
  };

  return { expanded, toggle };
}

/** Collapse memory — the same hook the surface uses when it lifts the flag
 *  so a CollectionBar and this column cannot disagree. */
export function useCollapsed(storageKey: string | undefined, defaultCollapsed = false) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

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

  return { collapsed, toggle };
}

export default function CollectionColumn(props: CollectionColumnProps) {
  const {
    title,
    groups,
    selectedId,
    onSelect,
    newLabel,
    onNew,
    newDisabled,
    storageKey,
    defaultCollapsed,
    defaultExpanded,
    narrow = "stack",
    collapseMode = "rail",
    collapsed: collapsedProp,
    onCollapsedChange,
    actions,
    footer,
  } = props;
  const internal = useCollapsed(collapsedProp === undefined ? storageKey : undefined, defaultCollapsed ?? false);
  const collapsed = collapsedProp ?? internal.collapsed;
  const { expanded, toggle: toggleNode } = useExpansion(storageKey, defaultExpanded);

  const toggle = (next: boolean) => {
    if (onCollapsedChange) onCollapsedChange(next);
    else internal.toggle(next);
  };

  // ArrowUp/Down move the selection in visual order (the pure model, which
  // skips disabled rows and walks expanded children); the rows are native
  // buttons, so Tab/Enter/Space already work.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const next = stepSelection(groups, selectedId, e.key === "ArrowDown" ? 1 : -1, expanded);
    if (next !== undefined && next !== selectedId) onSelect(next);
  };

  // s25 T5 — the SAME create verb, in the thumb zone. Rendered from these very
  // props (not a re-declaration), so the label, the handler and the disabled
  // reason cannot drift from the column's button; `lg:hidden` inside
  // `CreateFab` keeps the desktop showing exactly one of them. A realm that
  // passes no `newLabel`/`onNew` gets no FAB, which is the whole of the
  // "never invent a verb" rule.
  const fab = newLabel && onNew ? <CreateFab label={newLabel} onClick={onNew} disabled={newDisabled} /> : null;
  const railItems = iconRailItems(groups, expanded);

  if (collapsed) {
    // `bar` mode: the surface draws `<CollectionBar>` above the list. This
    // column contributes only the FAB (phone create verb). The rail is the
    // default for every other realm.
    if (collapseMode === "bar") return <>{fab}</>;

    // Below lg the strip turns horizontal — a slim full-width bar (a 48px-wide
    // vertical sliver makes no sense stacked). `narrow="hidden"` removes it
    // there entirely: the surface's collection sheet is the picker instead.
    // The FAB is a SIBLING of that strip, not a child: when the column is
    // hidden below lg, the create verb must still be there — that is exactly
    // the screen the FAB exists for.
    //
    // Items with glyphs stay as icon-only buttons (Mail: Inbox, Drafts,
    // Archive, …). Realms that never set `icon` keep the expand-only strip.
    // Desktop [New] lives here too: the header button is gone with the labels,
    // and the FAB is phone-only.
    return (
      <>
        <div
          class={cx(
            narrow === "hidden" && "max-lg:hidden",
            "flex min-h-0 shrink-0 items-center self-stretch border-gray-200 max-lg:w-full max-lg:flex-row max-lg:gap-x-1 max-lg:border-b max-lg:px-2 max-lg:py-1 lg:w-12 lg:flex-col lg:gap-y-1 lg:border-r lg:pt-2 dark:border-white/10",
          )}
        >
          <IconButton label={`Expand ${title.toLowerCase()} collections`} size="sm" onClick={() => toggle(false)}>
            <ChevronRightIcon class="size-4" />
          </IconButton>
          <span class="text-xs text-gray-500 lg:hidden dark:text-gray-400">{title}</span>
          {newLabel && onNew ? (
            <IconButton label={newLabel} size="sm" disabled={newDisabled} class="max-lg:hidden" onClick={() => onNew()}>
              <PlusIcon class="size-4" strokeWidth={2} />
            </IconButton>
          ) : null}
          {railItems.length > 0 ? (
            <nav
              class="flex min-h-0 min-w-0 flex-1 items-center gap-x-1 max-lg:overflow-x-auto lg:w-full lg:flex-col lg:overflow-y-auto lg:gap-y-1"
              aria-label={`${title} collections`}
              onKeyDown={onKeyDown}
            >
              {railItems.map((item) => {
                const Icon = item.icon;
                if (Icon === undefined) return null;
                const label = item.count ? `${item.label}, ${item.count}` : item.label;
                return (
                  <IconButton
                    key={item.id}
                    label={label}
                    size="sm"
                    active={item.id === selectedId}
                    onClick={() => onSelect(item.id)}
                  >
                    <span class="relative">
                      <Icon class="size-4" />
                      {item.count ? (
                        <span
                          class="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-brand-600"
                          aria-hidden="true"
                        />
                      ) : null}
                    </span>
                  </IconButton>
                );
              })}
            </nav>
          ) : null}
        </div>
        {fab}
      </>
    );
  }

  // Narrow-screen defaults (s25 T1): stacked = full-width, height-capped in
  // dvh (the small-viewport unit — the URL bar collapsing must not resize
  // the cap) so the list below keeps most of the screen.
  const defaultClass =
    narrow === "hidden"
      ? "w-56 shrink-0 border-r border-gray-200 max-lg:hidden dark:border-white/10"
      : "w-full shrink-0 border-gray-200 max-lg:max-h-[45dvh] max-lg:border-b lg:w-56 lg:border-r dark:border-white/10";

  return (
    <>
      <Column
        aria-label={`${title} collections`}
        class={props.class ?? defaultClass}
        header={
          /* s34 — `py-1` rather than `pt-2 pb-1`: with the label no longer
             wrapping to two lines this row is a single control tall, and the
             extra top padding was pushing the first collection down for
             nothing (Eric: "tighten up the spacing here"). */
          <div class="flex items-center gap-x-1 px-2 py-1">
            {newLabel && onNew ? (
              <>
                {/* Below `lg` the same verb is already reachable as the FAB, so the
                    header button hides rather than doubling it — one create
                    affordance per viewport, which is the whole point of the FAB.
                    The column keeps a heading there instead, since a tray of
                    collections with no name reads as orphaned. */}
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => onNew()}
                  disabled={newDisabled}
                  class="grow max-lg:hidden"
                >
                  <PlusIcon class="size-4 shrink-0" strokeWidth={2} />
                  {/* One line, ellipsis if it must — never "+ New / contact". */}
                  <span class={createLabelClasses()}>{newLabel}</span>
                </Button>
                <span class="grow px-1 text-sm font-semibold text-gray-900 lg:hidden dark:text-white">{title}</span>
              </>
            ) : (
              <span class="grow px-1 text-sm font-semibold text-gray-900 dark:text-white">{title}</span>
            )}
            {storageKey ? (
              <IconButton label={`Collapse ${title.toLowerCase()} collections`} size="sm" onClick={() => toggle(true)}>
                {collapseMode === "bar" ? (
                  <ChevronUpIcon class="size-4" strokeWidth={2} />
                ) : (
                  <ChevronDoubleLeftIcon class="size-4" strokeWidth={2} />
                )}
              </IconButton>
            ) : null}
          </div>
        }
      >
        {actions ? <div class="px-2 pb-1">{actions}</div> : null}
        <nav class="px-2 pb-2" onKeyDown={onKeyDown}>
          <CollectionTree
            groups={groups}
            selectedId={selectedId}
            onSelect={onSelect}
            expanded={expanded}
            onToggle={toggleNode}
          />
        </nav>
        {footer ? <div class="border-t border-gray-200 px-2 py-2 dark:border-white/10">{footer}</div> : null}
      </Column>
      {fab}
    </>
  );
}
