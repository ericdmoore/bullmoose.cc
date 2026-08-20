/** @jsxImportSource preact */
import { cx } from "../../lib/ui/classes";

export interface BreadcrumbItem {
  label: string;
  current?: boolean;
  onSelect?: () => void;
}

/** Tailwind UI `navigation/breadcrumbs/04-simple-with-slashes`.
 *  Steps are buttons (Files folder nav is not an `<a href>`). */
export default function Breadcrumb({
  items,
  "aria-label": ariaLabel = "Breadcrumb",
}: {
  items: readonly BreadcrumbItem[];
  "aria-label"?: string;
}) {
  return (
    <nav aria-label={ariaLabel} class="flex min-w-0 overflow-x-auto">
      <ol role="list" class="flex items-center space-x-4">
        {items.map((item, i) => (
          <li key={`${item.label}-${i}`} class="flex items-center">
            {i > 0 ? (
              <svg
                fill="currentColor"
                viewBox="0 0 20 20"
                aria-hidden="true"
                class="size-5 shrink-0 text-gray-300 dark:text-gray-600"
              >
                <path d="M5.555 17.776l8-16 .894.448-8 16-.894-.448z" />
              </svg>
            ) : null}
            {item.current || !item.onSelect ? (
              <span
                aria-current={item.current ? "page" : undefined}
                class={cx(
                  "text-sm font-medium whitespace-nowrap",
                  i > 0 ? "ml-4" : "",
                  item.current ? "text-gray-900 dark:text-white" : "text-gray-500 dark:text-gray-400",
                )}
              >
                {item.label}
              </span>
            ) : (
              <button
                type="button"
                onClick={item.onSelect}
                class={cx(
                  "text-sm font-medium whitespace-nowrap text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200",
                  i > 0 ? "ml-4" : "",
                )}
              >
                {item.label}
              </button>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
