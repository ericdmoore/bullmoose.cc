/** @jsxImportSource preact */
/**
 * Empty state of `01-decide-first`: one quiet primary, no three extra voids.
 *
 * Catalog: `feedback/empty-states/01-simple`, but WITHOUT a create button —
 * approving is not creating (CreateFab's "never invent a verb" rule). The
 * secondary "Around you" column is omitted when the feed would be empty;
 * Looking Ahead is not a dead region just because today is quiet.
 */
import { CheckIcon } from "../../_kit/heroicons/20-solid";

export default function Example() {
  return (
    <div className="min-h-full bg-white dark:bg-gray-900">
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <section aria-label="Waiting Approvals" className="mx-auto max-w-2xl">
          <div className="border-b border-gray-200 pb-5 sm:flex sm:items-center sm:justify-between dark:border-white/10">
            <h2 className="text-base font-semibold text-gray-900 dark:text-white">Waiting on you</h2>
            <a
              href="/approvals"
              className="mt-3 text-sm font-semibold text-brand-600 hover:text-brand-500 sm:mt-0 sm:ml-4 dark:text-brand-400"
            >
              Full queue
              <span aria-hidden="true"> →</span>
            </a>
          </div>
          <div className="px-4 py-16 text-center">
            <CheckIcon aria-hidden="true" className="mx-auto size-12 text-gray-400 dark:text-gray-500" />
            <h3 className="mt-2 text-sm font-semibold text-gray-900 dark:text-white">Nothing needs a decision</h3>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              New proposals land here. The full queue keeps hold-tray and due-soon views.
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}
