/** @jsxImportSource preact */
import type { ComponentChildren } from "preact";
import { cx, stackedListClasses, stackedRowClasses } from "../../lib/ui/classes";
import { isUnmodifiedPrimaryClick } from "../../lib/ui/navigation";

/** Tailwind UI `lists/stacked-lists/01-simple` — a divided list of rows. */
export function StackedList({ class: cls, children }: { class?: string; children: ComponentChildren }) {
  return (
    <ul role="list" class={cx(stackedListClasses(), cls)}>
      {children}
    </ul>
  );
}

export interface StackedRowProps {
  active?: boolean;
  /** Where this row lives. Give it whenever the item has a URL — it is what
   *  makes the row cmd-clickable and its link copyable. */
  href?: string;
  /** Open it in-page. Give it alongside `href` and the plain click stays here
   *  while cmd/middle-click still open a tab. */
  onSelect?: () => void;
  class?: string;
  children: ComponentChildren;
}

/**
 * A list row.
 *
 * ⚠️ `href` and `onSelect` are NOT alternatives — pass BOTH for anything that
 * has a URL. This component used to treat them as mutually exclusive, and that
 * quietly forced every realm into one of two broken halves: the `href` branch
 * full-page-reloaded on every click (Contacts, Approvals), and the `onSelect`
 * branch had no shareable URL and no cmd-click at all (Files, Notes, Calendar,
 * Goals, Agents, Activity). Mail was the only surface with both because it
 * hand-rolled the anchor in `ThreadListView` instead of using this.
 *
 * With both, the row is a real link that behaves like one for every modified
 * click, and stays in-page for the plain one.
 */
export function StackedRow({ active, href, onSelect, class: cls, children }: StackedRowProps) {
  const classes = cx(stackedRowClasses({ active }), cls);
  const current = active ? "true" : undefined;

  if (href !== undefined) {
    return (
      <li>
        <a
          href={href}
          class={classes}
          aria-current={current}
          onClick={
            onSelect
              ? (ev) => {
                  // Modified clicks belong to the browser — see navigation.ts.
                  if (!isUnmodifiedPrimaryClick(ev)) return;
                  ev.preventDefault();
                  onSelect();
                }
              : undefined
          }
        >
          {children}
        </a>
      </li>
    );
  }

  if (onSelect) {
    // No URL for this item (a transient row, an unsaved draft) — a button is
    // the honest element, since there is nowhere for a link to point.
    return (
      <li>
        <button type="button" onClick={onSelect} class={classes} aria-current={current}>
          {children}
        </button>
      </li>
    );
  }

  return <li class={classes}>{children}</li>;
}
