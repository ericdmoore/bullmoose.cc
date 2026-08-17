/** @jsxImportSource preact */
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ThreadRow } from "../lib/mail/threadList";
import { computeWindow, scrollToIndex, shouldLoadMore } from "../lib/mail/virtual";

/** Fixed row height — the assumption that makes O(1) windowing possible. */
export const ROW_HEIGHT = 68;

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
}

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
}: Props) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);

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
      onScroll={(ev) => setScrollTop((ev.currentTarget as HTMLDivElement).scrollTop)}
      role="listbox"
      aria-label="Conversations"
      tabIndex={-1}
    >
      <div style={{ height: `${window.topPad}px` }} aria-hidden="true" />
      {visible.map((row, i) => {
        const index = window.start + i;
        const isCursor = index === cursor;
        const isSelected = selected.has(row.threadId);
        return (
          <div
            key={row.threadId}
            role="option"
            aria-selected={isSelected}
            class={
              "thread-row" +
              (row.unread ? " is-unread" : "") +
              (isCursor ? " is-cursor" : "") +
              (isSelected ? " is-selected" : "")
            }
            style={{ height: `${ROW_HEIGHT}px` }}
            onClick={() => {
              onCursor(index);
              onOpen(row);
            }}
          >
            <button
              type="button"
              class="row-select"
              aria-label={isSelected ? "Deselect" : "Select"}
              onClick={(ev) => {
                ev.stopPropagation();
                onCursor(index);
                onToggleSelect(row);
              }}
            >
              {isSelected ? "▣" : "□"}
            </button>
            <div class="row-body">
              <div class="row-top">
                <span class="row-from">
                  {row.participants.join(", ") || "(unknown)"}
                  {row.loadedCount > 1 ? <span class="row-count"> {row.loadedCount}</span> : null}
                </span>
                <span class="row-date">{formatDate(row.receivedAt)}</span>
              </div>
              <div class="row-subject">
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
              <div class="row-preview">{row.latest.preview}</div>
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
