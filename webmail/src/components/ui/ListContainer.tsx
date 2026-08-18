/** @jsxImportSource preact */
import type { ComponentChildren } from "preact";
import { cx, listRowClasses } from "../../lib/ui/classes";

// The list family (s24 T0) — Tailwind UI layout/list-containers, the shape the
// approvals header list already uses. <ListContainer> is the ul; <ListRow> is
// one selectable row (button when onSelect, link when href, plain otherwise).

export function ListContainer({ class: cls, children }: { class?: string; children: ComponentChildren }) {
  return (
    <ul role="list" class={cx("space-y-0.5", cls)}>
      {children}
    </ul>
  );
}

export interface ListRowProps {
  active?: boolean;
  muted?: boolean;
  href?: string;
  onSelect?: () => void;
  class?: string;
  children: ComponentChildren;
}

export function ListRow({ active, muted, href, onSelect, class: cls, children }: ListRowProps) {
  const classes = cx(listRowClasses({ active, muted }), cls);
  const current = active ? "true" : undefined;
  if (href !== undefined) {
    return (
      <li>
        <a href={href} class={classes} aria-current={current}>
          {children}
        </a>
      </li>
    );
  }
  if (onSelect) {
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
