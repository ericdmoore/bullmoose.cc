/** @jsxImportSource preact */
import type { ComponentChildren } from "preact";

/** Connecting / capability-floor / fatal shells — one reading column, no H1
 *  (the chrome nav already names the realm). */
export default function PageNotice({
  title,
  error,
  children,
}: {
  title?: string;
  error?: boolean;
  children: ComponentChildren;
}) {
  return (
    <div class="mx-auto max-w-xl px-6 py-12">
      {title ? <h2 class="text-base font-semibold text-gray-900 dark:text-white">{title}</h2> : null}
      <div
        class={error ? "mt-2 text-sm text-red-700 dark:text-red-300" : "mt-2 text-sm text-gray-500 dark:text-gray-400"}
      >
        {children}
      </div>
    </div>
  );
}
