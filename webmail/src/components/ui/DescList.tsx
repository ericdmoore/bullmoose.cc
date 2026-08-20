/** @jsxImportSource preact */
import type { ComponentChildren } from "preact";
import { cx } from "../../lib/ui/classes";

/** Tailwind UI `data-display/description-lists/01-left-aligned`. */
export function DescList({
  title,
  description,
  class: cls,
  children,
}: {
  title?: string;
  description?: string;
  class?: string;
  children: ComponentChildren;
}) {
  return (
    <div class={cls}>
      {title ? (
        <div class="px-4 sm:px-0">
          <h3 class="text-base/7 font-semibold text-gray-900 dark:text-white">{title}</h3>
          {description ? <p class="mt-1 max-w-2xl text-sm/6 text-gray-500 dark:text-gray-400">{description}</p> : null}
        </div>
      ) : null}
      <div class={title ? "mt-4 border-t border-gray-100 dark:border-white/10" : ""}>
        <dl class="divide-y divide-gray-100 dark:divide-white/10">{children}</dl>
      </div>
    </div>
  );
}

export function DescRow({ term, class: cls, children }: { term: string; class?: string; children: ComponentChildren }) {
  return (
    <div class={cx("px-4 py-3 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-0", cls)}>
      <dt class="text-sm/6 font-medium text-gray-900 dark:text-gray-100">{term}</dt>
      <dd class="mt-1 text-sm/6 break-words text-gray-700 sm:col-span-2 sm:mt-0 dark:text-gray-400">{children}</dd>
    </div>
  );
}
