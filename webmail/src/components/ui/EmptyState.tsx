/** @jsxImportSource preact */
import type { ComponentChildren } from "preact";
import { InboxIcon } from "../icons";

/** Tailwind UI `feedback/empty-states/01-simple`. */
export default function EmptyState({
  title,
  icon,
  action,
  children,
}: {
  title: string;
  icon?: ComponentChildren;
  action?: ComponentChildren;
  children?: ComponentChildren;
}) {
  return (
    <div class="px-4 py-12 text-center">
      {icon === undefined ? <InboxIcon class="mx-auto size-12 text-gray-400 dark:text-gray-500" /> : icon}
      <h3 class="mt-2 text-sm font-semibold text-gray-900 dark:text-white">{title}</h3>
      {children ? <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">{children}</p> : null}
      {action ? <div class="mt-6">{action}</div> : null}
    </div>
  );
}
