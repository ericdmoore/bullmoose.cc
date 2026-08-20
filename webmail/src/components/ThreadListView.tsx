/** @jsxImportSource preact */
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ThreadRow } from "../lib/mail/threadList";
import { computeWindow, scrollToIndex, shouldLoadMore } from "../lib/mail/virtual";
import {
  beginDrag,
  extendDrag,
  openWidth,
  settleDrag,
  swipeActionClasses,
  swipeRowClasses,
  swipeShellClasses,
  type SwipeDrag,
  type SwipeTone,
} from "../lib/ui/swipe";
import { ArchiveBoxIcon, TrashIcon, type IconProps } from "./icons";

/** Fixed row height — the assumption that makes O(1) windowing possible. */
export const ROW_HEIGHT = 68;

/** s25 T6 — one revealed triage verb. The surface decides WHICH exist (Mail
 *  omits Archive on an account with no Archive mailbox rather than offering a
 *  button that would collect a refusal); this file only draws them. */
export interface SwipeAction {
  id: "archive" | "trash";
  label: string;
  tone: SwipeTone;
}

const ACTION_ICON: Record<SwipeAction["id"], (p: IconProps) => preact.JSX.Element> = {
  archive: ArchiveBoxIcon,
  trash: TrashIcon,
};

interface Props {
  rows: ThreadRow[];
  total: number | undefined;
  cursor: number;
  selected: Set<string>;
  loading: boolean;
  onOpen: (row: ThreadRow) => void;
  onCursor: (index: number) => void;
  onToggleSelect: (row: ThreadRow) => void;
  onLoadMore: () => void;
  /**
   * s25 T3 — the detail URL for a row (`/mail?thread=<id>`). When present the
   * row's body renders as a real `<a>`, so a CLICK is MPA navigation and the
   * browser back button just works; `onOpen` remains the KEYBOARD path
   * (j/k + Enter stay in-page, no reload mid-triage). Two paths on purpose —
   * the URL is the click path — and neither touches history
   * (tokenInUrl.test.ts: MPA links are not history calls).
   */
  hrefFor?: (row: ThreadRow) => string;
  /**
   * s25 T6 — swipe triage, MAIL ONLY (the sprint plan refuses it for
   * Approvals by name). Omit, or pass an empty list, and this file renders
   * exactly what it did before: no wrappers, no pointer handlers, no gesture.
   * That is how the desktop and every non-touch path stay untouched.
   */
  swipeActions?: readonly SwipeAction[];
  /** Fired by a deliberate TAP on a revealed button — never by the gesture
   *  itself. See the interaction contract below. */
  onSwipeAction?: (row: ThreadRow, action: SwipeAction["id"]) => void;
}

/**
 * ## The tap-vs-swipe contract (s25 T6)
 *
 * Since #194 the row body is a real `<a href="/mail?thread=…">`, which is what
 * makes the browser back button work. A gesture layered on a link has to be
 * explicit about who wins, so:
 *
 *   TOUCH/PEN ONLY. `pointerdown` from a mouse is ignored outright. A mouse
 *   drag across a list is a text selection, and hijacking it would degrade the
 *   desktop this feature is not allowed to touch.
 *
 *   THE BROWSER KEEPS VERTICAL. The shell declares `touch-action: pan-y`
 *   (`swipeShellClasses`), so a vertical pan scrolls the list natively and
 *   never reaches this component. The axis test in `extendDrag` is the second
 *   guard, decided once at 10px and never revisited.
 *
 *   A TAP NAVIGATES. Under 10px of horizontal travel nothing is suppressed:
 *   the click reaches the anchor and the MPA navigation happens as always. We
 *   never synthesize navigation, and we never `preventDefault` a tap.
 *
 *   A SWIPE DOES NOT. Past 10px the release sets `suppressClick`, and the
 *   click the browser fires next is cancelled in the CAPTURE phase on the
 *   row's SHELL — an ancestor of both the anchor and the capture element, so
 *   the cancel lands wherever the browser chose to dispatch that click. (It
 *   varies: once a pointer has been captured the click may target the capture
 *   element rather than the link under the finger.) The flag is consumed by
 *   that one click, and cleared again by the next `pointerdown`, so a click
 *   that never arrives cannot eat a later tap.
 *
 *   AN OPEN ROW IS A MODE. While a row rests open, a tap on its body closes it
 *   instead of navigating (also cancelled in capture). Scrolling closes it
 *   too. The revealed buttons carry `data-swipe-action`, which is the one
 *   thing the capture handler lets through — a tap there is the commit.
 *
 *   THE GESTURE NEVER COMMITS. Swiping reveals labelled buttons and does
 *   nothing else — a full-swipe-to-archive shortcut is deliberately not
 *   implemented. Filing mail takes a second, deliberate tap, and what it does
 *   is then undoable (AppShell wires the toast's Undo). Destructive-by-flick
 *   with no recourse is the thing this design is avoiding.
 *
 *   THE KEYBOARD IS UNAFFECTED. `e` and `#` still triage from the cursor row;
 *   the revealed buttons are real `<button>`s, so once a row is open they are
 *   in tab order too.
 */
export default function ThreadListView({
  rows,
  total,
  cursor,
  selected,
  loading,
  onOpen,
  onCursor,
  onToggleSelect,
  onLoadMore,
  hrefFor,
  swipeActions,
  onSwipeAction,
}: Props) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);

  // s25 T6 — the gesture's only state: which row a finger is on, which row
  // rests open, and whether the click the browser is about to fire belongs to
  // a swipe rather than a tap. The maths is pure (`lib/ui/swipe.ts`).
  const swipeOn = (swipeActions?.length ?? 0) > 0 && onSwipeAction !== undefined;
  const openPx = -openWidth(swipeActions?.length ?? 0);
  const [drag, setDrag] = useState<SwipeDrag | undefined>(undefined);
  const [openId, setOpenId] = useState<string | undefined>(undefined);
  const suppressClick = useRef(false);
  // The drag lives in a REF as well as in state. State is what paints; the ref
  // is what the next `pointermove` reads, because two moves can land inside
  // one batched render and the second would otherwise extend a stale drag —
  // the row stutters and the axis verdict is computed from the wrong start.
  const dragRef = useRef<SwipeDrag | undefined>(undefined);
  const putDrag = (next: SwipeDrag | undefined): void => {
    dragRef.current = next;
    setDrag(next);
  };

  // Track the viewport so the window math has a real height to work with.
  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const measure = (): void => setViewportHeight(node.clientHeight || 600);
    measure();
    globalThis.addEventListener?.("resize", measure);
    return () => globalThis.removeEventListener?.("resize", measure);
  }, []);

  const window = useMemo(
    () =>
      computeWindow({
        scrollTop,
        viewportHeight,
        rowHeight: ROW_HEIGHT,
        count: rows.length,
      }),
    [scrollTop, viewportHeight, rows.length],
  );

  // Keyboard navigation drives the scroll, not the other way round.
  useEffect(() => {
    const node = viewportRef.current;
    if (!node || rows.length === 0) return;
    const next = scrollToIndex(cursor, {
      scrollTop: node.scrollTop,
      viewportHeight: node.clientHeight || viewportHeight,
      rowHeight: ROW_HEIGHT,
      count: rows.length,
    });
    if (next !== node.scrollTop) node.scrollTop = next;
  }, [cursor, rows.length, viewportHeight]);

  // Pull the next page as the window approaches the loaded end.
  useEffect(() => {
    if (!loading && shouldLoadMore(window, rows.length, total)) onLoadMore();
  }, [window.end, rows.length, total, loading]);

  if (rows.length === 0) {
    return (
      <div class="thread-list is-empty">
        <p>{loading ? "Loading…" : "Nothing here."}</p>
      </div>
    );
  }

  const visible = rows.slice(window.start, window.end);

  return (
    <div
      class="thread-list"
      ref={viewportRef}
      onScroll={(ev) => {
        setScrollTop((ev.currentTarget as HTMLDivElement).scrollTop);
        // Scrolling away closes an open row: a revealed Trash button that
        // outlives the screen it was revealed on is a trap.
        if (openId !== undefined) setOpenId(undefined);
      }}
      role="listbox"
      aria-label="Conversations"
      tabIndex={-1}
    >
      <div style={{ height: `${window.topPad}px` }} aria-hidden="true" />
      {visible.map((row, i) => {
        const index = window.start + i;
        const isCursor = index === cursor;
        const isSelected = selected.has(row.threadId);
        // The row's readable body. With `hrefFor` it is a real link — the
        // MPA click path (native back); without it, the container's onClick
        // opens in-page as before. The select checkbox stays a sibling
        // button either way: interactive content may not nest inside an <a>.
        const body = (
          <>
            <div class="row-top flex items-baseline justify-between gap-x-3">
              <span class="row-from min-w-0 truncate text-sm/6 font-medium text-gray-900 dark:text-white">
                {row.participants.join(", ") || "(unknown)"}
                {row.loadedCount > 1 ? <span class="row-count text-gray-500"> {row.loadedCount}</span> : null}
              </span>
              <span class="row-date shrink-0 text-xs/5 text-gray-500 dark:text-gray-400">
                {formatDate(row.receivedAt)}
              </span>
            </div>
            <div class="row-subject truncate text-sm/6 text-gray-900 dark:text-white">
              {row.flagged ? (
                <span class="row-flag" aria-label="Flagged">
                  {"★"}
                </span>
              ) : null}
              {row.subject}
              {row.hasAttachment ? (
                <span class="row-clip" aria-label="Has attachment">
                  {"\u{1F4CE}"}
                </span>
              ) : null}
            </div>
            <div class="row-preview truncate text-xs/5 text-gray-500 dark:text-gray-400">{row.latest.preview}</div>
          </>
        );
        const isDragging = drag?.id === row.threadId;
        const isOpen = openId === row.threadId;
        const offset = isDragging ? drag.offset : isOpen ? openPx : 0;

        const rowEl = (
          <div
            key={row.threadId}
            role="option"
            aria-selected={isSelected}
            class={
              "thread-row flex items-start gap-x-3 overflow-hidden border-b border-gray-100 px-4 py-2 dark:border-white/5" +
              (row.unread ? " is-unread" : "") +
              (isCursor ? " is-cursor bg-gray-50 dark:bg-white/5" : "") +
              (isSelected
                ? " is-selected bg-brand-50 dark:bg-brand-500/10"
                : " hover:bg-gray-50 dark:hover:bg-white/[0.03]") +
              (swipeOn ? " w-full shrink-0" : "")
            }
            style={swipeOn ? undefined : { height: `${ROW_HEIGHT}px` }}
            onClick={() => {
              onCursor(index);
              // Link present → the anchor navigates; opening here too would
              // race the load against the unload.
              if (!hrefFor) onOpen(row);
            }}
          >
            <button
              type="button"
              class="row-select mt-0.5 text-gray-400"
              aria-label={isSelected ? "Deselect" : "Select"}
              onClick={(ev) => {
                ev.stopPropagation();
                onCursor(index);
                onToggleSelect(row);
              }}
            >
              {isSelected ? "▣" : "□"}
            </button>
            {hrefFor ? (
              <a class="row-body" href={hrefFor(row)}>
                {body}
              </a>
            ) : (
              <div class="row-body">{body}</div>
            )}
          </div>
        );

        // No swipe configured → the pre-T6 markup, to the character. Adding a
        // wrapper for a feature that is switched off would change the DOM (and
        // the ARIA listbox→option relationship) on every desktop.
        if (!swipeOn) return rowEl;

        return (
          <div
            key={row.threadId}
            role="presentation"
            class={swipeShellClasses()}
            style={{ height: `${ROW_HEIGHT}px` }}
            onPointerDown={(ev) => {
              // Touch and pen only — see the contract above.
              if (ev.pointerType !== "touch" && ev.pointerType !== "pen") return;
              // A new gesture clears any verdict the last one left behind. If
              // a swipe ended without the browser firing the click we expected
              // (it can, once the pointer was captured), the stale flag would
              // otherwise eat the NEXT tap — a link that ignores you once.
              suppressClick.current = false;
              putDrag(beginDrag(row.threadId, ev.clientX, ev.clientY, isOpen ? openPx : 0, openPx));
            }}
            onPointerMove={(ev) => {
              const current = dragRef.current;
              if (!current || current.id !== row.threadId) return;
              const next = extendDrag(current, ev.clientX, ev.clientY);
              // Claim the pointer the moment the gesture is ours, so a finger
              // that slides off the row still finishes the swipe it started.
              if (next.axis === "horizontal" && current.axis !== "horizontal") {
                (ev.currentTarget as HTMLElement).setPointerCapture?.(ev.pointerId);
              }
              putDrag(next);
            }}
            onPointerUp={() => {
              const current = dragRef.current;
              if (!current || current.id !== row.threadId) return;
              const settled = settleDrag(current);
              suppressClick.current = settled.suppressClick;
              setOpenId(settled.open ? row.threadId : undefined);
              putDrag(undefined);
            }}
            onPointerCancel={() => {
              const current = dragRef.current;
              if (!current || current.id !== row.threadId) return;
              // A cancelled gesture is not a decision: snap back to rest, and
              // do not eat a click that was never coming.
              putDrag(undefined);
            }}
            onClickCapture={(ev) => {
              // THE CONTRACT, ENFORCED HERE AND ONLY HERE — on the shell
              // rather than on the row, because once a pointer has been
              // captured the browser may dispatch the click at the capture
              // element instead of at the anchor underneath the finger. The
              // shell is an ancestor of both, so a capture-phase
              // `preventDefault` here cancels the navigation either way.
              const target = ev.target as Element | null;
              // A tap on a revealed button is the COMMIT. Never swallowed.
              if (target?.closest?.("[data-swipe-action]")) return;
              if (suppressClick.current) {
                suppressClick.current = false;
                ev.preventDefault();
                ev.stopPropagation();
                return;
              }
              // An open row is a mode: the next tap on it closes, it does not
              // navigate. Everything else falls through and the link works.
              if (isOpen) {
                ev.preventDefault();
                ev.stopPropagation();
                setOpenId(undefined);
              }
            }}
          >
            <div class={swipeRowClasses(offset, !isDragging)}>
              {rowEl}
              {/* Rendered only for the row in play, so a closed list has no
                  off-screen buttons sitting in the tab order. */}
              {isDragging || isOpen ? (
                <div class="flex h-full shrink-0" role="presentation">
                  {(swipeActions ?? []).map((action) => {
                    const Glyph = ACTION_ICON[action.id];
                    return (
                      <button
                        key={action.id}
                        type="button"
                        // The marker the shell's click-capture looks for: a
                        // tap here is the commit and must reach the button.
                        data-swipe-action={action.id}
                        class={swipeActionClasses(action.tone)}
                        onClick={(ev) => {
                          ev.preventDefault();
                          ev.stopPropagation();
                          setOpenId(undefined);
                          onSwipeAction?.(row, action.id);
                        }}
                      >
                        <Glyph class="size-5" />
                        <span>{action.label}</span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          </div>
        );
      })}
      <div style={{ height: `${window.bottomPad}px` }} aria-hidden="true" />
    </div>
  );
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
