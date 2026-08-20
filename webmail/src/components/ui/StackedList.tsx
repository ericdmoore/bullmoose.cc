/** @jsxImportSource preact */
import type { ComponentChildren } from "preact";
import { cx, stackedListClasses, stackedRowClasses } from "../../lib/ui/classes";

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
  href?: string;
  onSelect?: () => void;
  class?: string;
  children: ComponentChildren;
}

export function StackedRow({ active, href, onSelect, class: cls, children }: StackedRowProps) {
  const classes = cx(stackedRowClasses({ active }), cls);
  const current = active ? "true" : undefined;
  const inner = children;
  if (href !== undefined) {
    return (
      <li>
        <a href={href} class={classes} aria-current={current}>
          {inner}
        </a>
      </li>
    );
  }
  if (onSelect) {
    return (
      <li>
        <button type="button" onClick={onSelect} class={classes} aria-current={current}>
          {inner}
        </button>
      </li>
    );
  }
  return <li class={classes}>{inner}</li>;
}
